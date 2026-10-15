import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initializeOrganizer, OrganizerStore } from '../organizer/store';
import { DocumentGenerationService, type GenerationFetch } from '../organizer/generation';
import { BatchManager, summarize } from './batch';
import { assertFolder, documentBatchOptionsSchema, documentBatchRunner, documentCandidates, estimateDocumentBatch } from './batch-documents';

let database: Database, store: OrganizerStore;
const ids = { a: crypto.randomUUID(), b: crypto.randomUUID(), untranscribed: crypto.randomUUID(), trashed: crypto.randomUUID() };
const versions: Record<string, string> = {};

beforeEach(() => {
  database = new Database(':memory:');
  database.exec('PRAGMA foreign_keys=ON');
  initializeOrganizer(database);
  store = new OrganizerStore(database);
  database.exec(`CREATE TABLE recordings(id TEXT,original_filename TEXT,recorded_at TEXT,source_provider TEXT,retention_state TEXT);
    CREATE TABLE transcripts(recording_id TEXT,current_version_id TEXT,full_text TEXT,origin TEXT);
    CREATE TABLE transcript_versions(id TEXT,recording_id TEXT,full_text TEXT,origin TEXT);
    CREATE TABLE user_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  database.query('INSERT INTO user_settings VALUES(?,?)').run('mistralApiKey', 'private-key');
  for (const [name, id] of Object.entries(ids)) {
    database.query('INSERT INTO recordings VALUES(?,?,?,?,?)').run(id, `${name}.wav`, '2026-09-05', 'plaud', name === 'trashed' ? 'trash' : 'active');
    if (name === 'untranscribed') continue;
    versions[id] = crypto.randomUUID();
    const text = `Transcript of ${name}. We decided to keep the originals.`;
    database.query('INSERT INTO transcripts VALUES(?,?,?,?)').run(id, versions[id], text, 'generated');
    database.query('INSERT INTO transcript_versions VALUES(?,?,?,?)').run(versions[id], id, text, 'generated');
  }
});
afterEach(() => database.close());

const reply = () => Response.json({ model: 'mistral-small-test', choices: [{ finish_reason: 'stop', message: { content: '# Notes\n\n## Decision\nKeep the originals.' } }] });
const service = (fetcher: GenerationFetch) => new DocumentGenerationService(store, fetcher, () => 'private-key', 1000);
const options = (overrides: Record<string, unknown> = {}) => documentBatchOptionsSchema.parse({ style: 'meeting', expectedProvider: 'mistral', ...overrides });

async function until(predicate: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe('document batch scope and estimate', () => {
  test('only active recordings with transcript text are candidates', () => {
    expect(documentCandidates(database, Object.values(ids))).toEqual(new Set([ids.a, ids.b]));
  });

  test('estimate names the provider, says text is sent, and invents no cost', () => {
    const estimate = estimateDocumentBatch(database, Object.values(ids));
    expect(estimate).toEqual({
      kind: 'document', recordings: 4, wouldRun: 2, skipped: 2, provider: 'mistral', model: 'mistral-small-latest',
      usesCloudProvider: true, sendsTranscriptText: true, providerError: null, estimatedCost: null,
    });
  });

  test('estimate explains an unusable provider instead of hiding it', () => {
    database.query('DELETE FROM user_settings').run();
    const previous = process.env.MISTRAL_API_KEY;
    delete process.env.MISTRAL_API_KEY;
    try { expect(estimateDocumentBatch(database, [ids.a]).providerError).toContain('API key'); }
    finally { if (previous !== undefined) process.env.MISTRAL_API_KEY = previous; }
  });

  test('a missing folder is refused before any provider call', () => {
    expect(() => assertFolder(database, crypto.randomUUID())).toThrow('folder');
    const folder = store.createFolder({ name: 'Batch' });
    expect(() => assertFolder(database, folder.id)).not.toThrow();
    expect(() => assertFolder(database, null)).not.toThrow();
  });

  test('options are validated', () => {
    expect(() => documentBatchOptionsSchema.parse({ style: 'novel' })).toThrow();
    expect(() => documentBatchOptionsSchema.parse({ instructions: 'x'.repeat(2001) })).toThrow();
  });
});

describe('document batch execution', () => {
  test('creates one document per item in the chosen folder with source provenance', async () => {
    const folder = store.createFolder({ name: 'Meetings' });
    const sent: string[] = [];
    const generator = service(async (_url, init) => { sent.push(JSON.parse(JSON.parse(String(init.body)).messages[1].content).transcript); return reply(); });
    const manager = new BatchManager(1);
    const job = manager.start({ kind: 'document', recordingIds: [ids.a, ids.b], runner: documentBatchRunner(database, generator, options({ folderId: folder.id })) });
    await until(() => manager.get(job.id)?.active === false);
    expect(summarize(manager.get(job.id)!)).toMatchObject({ total: 2, complete: 2, failed: 0 });
    expect(sent).toHaveLength(2);
    const listed = store.list({ folderId: folder.id });
    expect(listed.total).toBe(2);
    const document = store.get(listed.documents.find(row => row.title === 'a')!.id);
    expect(document.sourceRecordingId).toBe(ids.a);
    expect(document.sourceVersionId).toBe(versions[ids.a]!);
    expect(document.sourceOrigin).toBe('ai:mistral:mistral-small-test');
  });

  test('retry runs only the failed items, so a succeeded one is never sent twice', async () => {
    let failFor: string | null = 'Transcript of a.';
    const sent: string[] = [];
    const generator = service(async (_url, init) => {
      const transcript: string = JSON.parse(JSON.parse(String(init.body)).messages[1].content).transcript;
      sent.push(transcript);
      if (failFor && transcript.startsWith(failFor)) return new Response('provider down', { status: 503 });
      return reply();
    });
    const manager = new BatchManager(1);
    const runner = documentBatchRunner(database, generator, options());
    const first = manager.start({ kind: 'document', recordingIds: [ids.a, ids.b], runner });
    await until(() => manager.get(first.id)?.active === false);
    const failed = manager.get(first.id)!;
    expect(summarize(failed)).toMatchObject({ complete: 1, failed: 1 });
    expect(failed.items.find(item => item.recordingId === ids.a)?.error).toBeTruthy();
    expect(failed.items.find(item => item.recordingId === ids.a)?.error).not.toContain('private-key');
    failFor = null;
    const retry = manager.start({ kind: 'document', recordingIds: [], retryOf: first.id, runner });
    await until(() => manager.get(retry.id)?.active === false);
    expect(manager.get(retry.id)!.items.map(item => item.recordingId)).toEqual([ids.a]);
    expect(sent.filter(text => text.startsWith('Transcript of b.'))).toHaveLength(1);
    expect(store.list().total).toBe(2);
  });

  test('cancelling stops the running item and saves nothing for it', async () => {
    let started = false;
    const generator = service(((_url, init) => new Promise((_resolve, reject) => {
      started = true;
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })) as GenerationFetch);
    const manager = new BatchManager(1);
    const job = manager.start({ kind: 'document', recordingIds: [ids.a, ids.b], runner: documentBatchRunner(database, generator, options()) });
    await until(() => started);
    expect(manager.cancel(job.id)).toBe(true);
    await until(() => manager.get(job.id)?.active === false);
    expect(summarize(manager.get(job.id)!)).toMatchObject({ complete: 0, cancelled: 2 });
    expect(store.list().total).toBe(0);
  });

  test('a provider change since confirmation fails the item without sending', async () => {
    let calls = 0;
    const generator = service(async () => { calls += 1; return reply(); });
    const manager = new BatchManager(1);
    const job = manager.start({ kind: 'document', recordingIds: [ids.a], runner: documentBatchRunner(database, generator, options({ expectedProvider: 'openai' })) });
    await until(() => manager.get(job.id)?.active === false);
    expect(manager.get(job.id)!.items[0]).toMatchObject({ state: 'failed' });
    expect(manager.get(job.id)!.items[0]!.error).toContain('provider changed');
    expect(calls).toBe(0);
  });
});
