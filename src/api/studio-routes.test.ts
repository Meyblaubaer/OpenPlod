import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

/**
 * Route-level tests for the Studio additions (TS-06, TS-09, TS-10, TS-11).
 *
 * They use the shared vault client that `src/test-setup.ts` points at a
 * throwaway database. No test here reaches a network: the one AI path is
 * exercised through an injected fetch, and every batch/compare test either
 * stops at validation or queues work that no handler runs.
 */
const { sqlite } = await import('../db/client');
const { initializeDatabase } = await import('../db/setup');
const { default: recordingsApi } = await import('./recordings');
const { jobQueue } = await import('../jobs/queue');
const { StructureStore } = await import('../library/structure-store');

const recordingId = crypto.randomUUID();
const versionId = crypto.randomUUID();
const untranscribedId = crypto.randomUUID();
const segments = [
  { start: 0, end: 4, text: 'We open the budget review.', speaker: 0 },
  { start: 64, end: 70, text: 'Someone should book the venue.', speaker: 1 },
];
let originalFetch: typeof fetch;

beforeAll(() => {
  initializeDatabase();
  originalFetch = globalThis.fetch;
  for (const [id, name] of [[recordingId, 'Budget review.wav'], [untranscribedId, 'Untranscribed.wav']] as const) {
    sqlite.query(`INSERT INTO recordings(id, file_path, original_filename, recording_type, recorded_at, source_provider, fingerprint, status)
      VALUES(?,?,?,?,?,?,?,?)`).run(id, `/vault/${id}.wav`, name, 'meeting', '2026-09-05T10:00:00Z', 'plaud', `fp-${id}`, 'complete');
  }
  const text = segments.map(segment => segment.text).join(' ');
  sqlite.query(`INSERT INTO transcript_versions(id, recording_id, full_text, segments, origin, provenance, created_at) VALUES(?,?,?,?,?,?,?)`)
    .run(versionId, recordingId, text, JSON.stringify(segments), 'generated', JSON.stringify({ provider: 'mistral', model: 'voxtral-mini-latest' }), '2026-09-05T10:05:00Z');
  sqlite.query(`INSERT INTO transcripts(id, recording_id, full_text, segments, origin, current_version_id) VALUES(?,?,?,?,?,?)`)
    .run(crypto.randomUUID(), recordingId, text, JSON.stringify(segments), 'generated', versionId);
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  for (const job of jobQueue.getAllJobs()) if (job.dedupeKey?.includes(recordingId)) jobQueue.cancel(job.id);
  sqlite.query('DELETE FROM recordings WHERE id IN (?, ?)').run(recordingId, untranscribedId);
  sqlite.query("DELETE FROM user_settings WHERE key IN ('aiConfig', 'mistralApiKey', 'deepgramApiKey')").run();
});

const post = (path: string, body: unknown) => recordingsApi.request(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const setting = (key: string, value: string) =>
  sqlite.query('INSERT INTO user_settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

describe('saved structure (TS-06)', () => {
  test('extract proposes, save persists, regenerate keeps history, delete removes one', async () => {
    setting('mistralApiKey', 'test-key');
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return Response.json({ model: 'mistral-small-test', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
        chapters: [{ title: 'Budget', segmentIndex: 0 }],
        actionItems: [{ text: 'Book the venue.', owner: 'unknown', due: null, segmentIndex: 1 }],
        decisions: [{ text: 'Invented citation.', segmentIndex: 99 }],
      }) } }] });
    }) as unknown as typeof fetch;
    try {
      const extracted = await (await post(`/${recordingId}/transcript/structure`, {})).json();
      expect(extracted.success).toBe(true);
      expect(extracted.data.proposalId).toBeString();
      expect(extracted.data.versionId).toBe(versionId);
      // Nothing is saved by extracting.
      expect((await (await recordingsApi.request(`/${recordingId}/transcript/structures`)).json()).data).toHaveLength(0);

      const saved = await post(`/${recordingId}/transcript/structures`, { proposalId: extracted.data.proposalId });
      expect(saved.status).toBe(201);
      const row = (await saved.json()).data;
      expect(row).toMatchObject({ versionId, current: true, provider: 'mistral' });
      // Times come from our segments; an invented index links nowhere; unknown owners stay unset.
      expect(row.structure.chapters[0]).toMatchObject({ startSeconds: 0, segmentIndex: 0 });
      expect(row.structure.actionItems[0]).toMatchObject({ startSeconds: 64, owner: null, due: null });
      expect(row.structure.decisions[0]).toMatchObject({ startSeconds: null, segmentIndex: null });
      expect((await post(`/${recordingId}/transcript/structures`, { proposalId: extracted.data.proposalId })).status).toBe(404);

      const again = await (await post(`/${recordingId}/transcript/structure`, { versionId })).json();
      await post(`/${recordingId}/transcript/structures`, { proposalId: again.data.proposalId });
      const listed = (await (await recordingsApi.request(`/${recordingId}/transcript/structures`)).json()).data;
      expect(listed).toHaveLength(2);
      expect(calls).toBe(2);

      expect((await recordingsApi.request(`/${recordingId}/transcript/structures/${row.id}`, { method: 'DELETE' })).status).toBe(200);
      expect((await (await recordingsApi.request(`/${recordingId}/transcript/structures`)).json()).data).toHaveLength(1);
      expect((await recordingsApi.request(`/${recordingId}/transcript/structures/${row.id}`)).status).toBe(404);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('save requires a proposal, not a client-supplied structure', async () => {
    const response = await post(`/${recordingId}/transcript/structures`, { structure: { chapters: [] } });
    expect(response.status).toBe(400);
  });

  test('a saved structure exports to every format without calling a provider', async () => {
    const store = new StructureStore(sqlite);
    const saved = store.save(recordingId, store.propose({ recordingId, versionId, sourceHash: 'h', structure: {
      chapters: [], decisions: [{ text: 'Keep originals.', startSeconds: 64, segmentIndex: 1 }],
      actionItems: [{ text: 'Book the venue.', owner: null, due: null, startSeconds: null, segmentIndex: null }],
      openQuestions: [], provider: 'mistral', model: 'm', usage: null, timestampsAvailable: true,
    } }).proposalId);
    const pdf = await recordingsApi.request(`/${recordingId}/transcript/structures/${saved.id}?format=pdf`);
    expect(pdf.headers.get('Content-Type')).toBe('application/pdf');
    expect((await pdf.text()).startsWith('%PDF-1.4')).toBe(true);
    const csv = await recordingsApi.request(`/${recordingId}/transcript/structures/${saved.id}?format=csv`);
    expect(csv.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(await csv.text()).toContain('Book the venue.,,');
    const markdown = await (await recordingsApi.request(`/${recordingId}/transcript/structures/${saved.id}?format=markdown`)).text();
    expect(markdown).toContain('# Budget review');
    expect((await recordingsApi.request(`/${recordingId}/transcript/structures/${saved.id}?format=docx`)).status).toBe(400);
  });
});

describe('transcript PDF (TS-09)', () => {
  test('renders the current version server-side as application/pdf', async () => {
    const response = await recordingsApi.request(`/${recordingId}/transcript/pdf`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/pdf');
    const pdf = await response.text();
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    const drawn = [...pdf.matchAll(/<([0-9A-F]+)> Tj/g)].map(match => Buffer.from(match[1]!, 'hex').toString('latin1')).join('\n');
    expect(drawn).toContain('[1:04] Speaker 1: ');
    expect(drawn).toContain(`Transcript version: ${versionId} (generated)`);
    expect(drawn).toContain('Transcribed by: mistral voxtral-mini-latest');
  });

  test('a missing version or transcript is a 404, not an empty PDF', async () => {
    expect((await recordingsApi.request(`/${recordingId}/transcript/pdf?versionId=${crypto.randomUUID()}`)).status).toBe(404);
    expect((await recordingsApi.request(`/${untranscribedId}/transcript/pdf`)).status).toBe(404);
  });
});

describe('batch documents (TS-10)', () => {
  test('estimate reports scope, provider and that text is sent', async () => {
    setting('mistralApiKey', 'test-key');
    const estimate = (await (await post('/batch/estimate', { kind: 'document', recordingIds: [recordingId, untranscribedId] })).json()).data;
    expect(estimate).toMatchObject({ kind: 'document', recordings: 2, wouldRun: 1, skipped: 1, provider: 'mistral', sendsTranscriptText: true, estimatedCost: null });
  });

  test('refuses to start without confirmation, a confirmed provider, or anything to send', async () => {
    expect((await post('/batch', { kind: 'document', recordingIds: [recordingId] })).status).toBe(400);
    expect((await (await post('/batch', { kind: 'document', confirm: true, recordingIds: [recordingId] })).json()).error).toContain('provider');
    expect((await post('/batch', { kind: 'document', confirm: true, expectedProvider: 'mistral', recordingIds: [untranscribedId] })).status).toBe(400);
    expect((await post('/batch', { kind: 'document', confirm: true, expectedProvider: 'mistral', style: 'novel', recordingIds: [recordingId] })).status).toBe(400);
    const changed = await post('/batch', { kind: 'document', confirm: true, expectedProvider: 'openai', recordingIds: [recordingId] });
    expect(changed.status).toBe(409);
    const folder = await post('/batch', { kind: 'document', confirm: true, expectedProvider: 'mistral', folderId: crypto.randomUUID(), recordingIds: [recordingId] });
    expect((await folder.json()).error).toContain('folder');
    expect((await post('/batch', { kind: 'document', confirm: true, retryOf: crypto.randomUUID() })).status).toBe(404);
  });
});

describe('provider comparison (TS-11)', () => {
  test('requires confirmation and a configured provider', async () => {
    expect((await post(`/${recordingId}/transcript/provider-comparisons`, { provider: 'deepgram' })).status).toBe(400);
    sqlite.query("DELETE FROM user_settings WHERE key = 'deepgramApiKey'").run();
    const previous = process.env.DEEPGRAM_API_KEY;
    delete process.env.DEEPGRAM_API_KEY;
    try {
      const unconfigured = await post(`/${recordingId}/transcript/provider-comparisons`, { provider: 'deepgram', confirm: true });
      expect(unconfigured.status).toBe(400);
    } finally { if (previous !== undefined) process.env.DEEPGRAM_API_KEY = previous; }
    expect((await post(`/${untranscribedId}/transcript/provider-comparisons`, { provider: 'deepgram', confirm: true })).status).toBe(409);
  });

  test('queues an independent run alongside normal processing and reports it', async () => {
    setting('deepgramApiKey', 'test-key');
    const queued = await post(`/${recordingId}/transcript/provider-comparisons`, { provider: 'deepgram', confirm: true });
    expect(queued.status).toBe(202);
    const { jobId, alreadyQueued } = (await queued.json()).data;
    expect(alreadyQueued).toBe(false);
    expect(jobQueue.activeJob('process-recording', recordingId)).toBeUndefined();
    const listed = (await (await recordingsApi.request(`/${recordingId}/transcript/provider-comparisons`)).json()).data;
    expect(listed.available.deepgram).toBe(true);
    expect(listed.runs[0]).toMatchObject({ jobId, provider: 'deepgram', versionId: null });
    jobQueue.cancel(jobId);
    expect(sqlite.query('SELECT status FROM recordings WHERE id = ?').get(recordingId)).toEqual({ status: 'complete' });
  });
});
