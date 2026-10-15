import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initializeOrganizer, OrganizerStore } from './store';
import { DocumentGenerationService, type GenerationFetch } from './generation';

test('document generations store who answered, reported usage and timing (AI-09), and the column migration is idempotent', async () => {
  const database = new Database(':memory:'); initializeOrganizer(database);
  database.exec(`CREATE TABLE user_settings(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT);
    CREATE TABLE recordings(id TEXT,original_filename TEXT,recorded_at TEXT,source_provider TEXT,retention_state TEXT);
    CREATE TABLE transcripts(recording_id TEXT,current_version_id TEXT,full_text TEXT,origin TEXT);
    CREATE TABLE transcript_versions(id TEXT,recording_id TEXT,full_text TEXT,origin TEXT);`);
  database.query('INSERT INTO user_settings(key,value) VALUES(?,?)').run('aiConfig', JSON.stringify({ documentProvider: 'openai', documentFallback: [{ provider: 'mistral', model: '' }] }));
  for (const [key, value] of [['openaiApiKey', 'o'], ['mistralApiKey', 'm']]) database.query('INSERT INTO user_settings(key,value) VALUES(?,?)').run(key, value);
  const recordingId = crypto.randomUUID(), versionId = crypto.randomUUID(), source = 'We decided to keep the original recordings.';
  database.query('INSERT INTO recordings VALUES(?,?,?,?,?)').run(recordingId, 'Meeting.wav', '2026-09-05', 'plaud', 'active');
  database.query('INSERT INTO transcripts VALUES(?,?,?,?)').run(recordingId, versionId, source, 'edited');
  database.query('INSERT INTO transcript_versions VALUES(?,?,?,?)').run(versionId, recordingId, source, 'edited');
  const store = new OrganizerStore(database);
  const fetcher = (async (url: string) => url.includes('openai') ? new Response('down', { status: 500 })
    : Response.json({ model: 'mistral-small-test', choices: [{ finish_reason: 'stop', message: { content: '# Meeting\n\n## Decision\nKeep originals.' } }], usage: { prompt_tokens: 12, completion_tokens: 6 } })) as GenerationFetch;
  new DocumentGenerationService(store, fetcher);
  const service = new DocumentGenerationService(store, fetcher);
  const generated = await service.generate({ recordingId, versionId, title: 'Meeting', idempotencyKey: crypto.randomUUID() }, async () => {});
  expect(generated.provider).toBe('mistral');
  expect(generated.provenance).toMatchObject({ provider: 'mistral', model: 'mistral-small-test', usage: { prompt_tokens: 12, completion_tokens: 6 }, fallbackFrom: [{ provider: 'openai' }] });
  expect(generated.provenance!.startedAt! <= generated.provenance!.completedAt!).toBe(true);
  expect(service.save(generated.id, {}).sourceOrigin).toBe('ai:mistral:mistral-small-test');
  database.close();
});
