import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { JobQueue } from './queue';
import { RetryableError } from '../transcription/long-audio';
import { assemblyAiCancelHook } from '../transcription/remote-cancel';

const wait = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));

test('retries only retryable errors with nothing in flight, at most twice, with backoff', async () => {
  const db = new Database(':memory:'), queue = new JobQueue(db, [10, 20]);
  let runs = 0;
  queue.register('task', async (_data, context) => { runs++; context.saveCheckpoint({ phase: 'chunk-extracting', inFlight: false }); throw new RetryableError('split failed'); });
  const job = await queue.add('task', { recordingId: 'one' });
  await wait(5); expect(runs).toBe(1); expect(queue.getJob(job.id)).toMatchObject({ status: 'pending', attempts: 1 });
  await wait(60); expect(runs).toBe(3);
  expect(queue.getJob(job.id)).toMatchObject({ status: 'failed', attempts: 2 }); expect(queue.getJob(job.id)!.completedAt).toBeDefined();
  db.close();
});

test('never retries after a possible remote submission or a non-retryable error', async () => {
  const db = new Database(':memory:'), queue = new JobQueue(db, [1, 1]);
  let runs = 0;
  queue.register('sent', async (_data, context) => { runs++; context.saveCheckpoint({ phase: 'submitting', inFlight: true }); throw new RetryableError('timeout'); });
  queue.register('plain', async (_data, context) => { runs++; context.saveCheckpoint({ phase: 'chunk-extracting', inFlight: false }); throw new Error('bad key'); });
  await queue.add('sent', { recordingId: 'a' }); await queue.add('plain', { recordingId: 'b' });
  await wait(30); expect(runs).toBe(2); expect(queue.getStats().failed).toBe(2);
  db.close();
});

test('restart resumes work whose checkpoint shows nothing in flight, but not uncertain submissions', () => {
  const db = new Database(':memory:'); new JobQueue(db);
  const insert = (checkpoint: object) => { const id = crypto.randomUUID(); db.query('INSERT INTO processing_jobs VALUES(?,?)').run(id, JSON.stringify({ id, type: 'task', data: { recordingId: id }, priority: 0, status: 'running', createdAt: new Date(), checkpoint })); return id; };
  const safe = insert({ phase: 'chunk-done', inFlight: false, progress: { done: 2, total: 5 } }), unsafe = insert({ phase: 'submitting', inFlight: true });
  const recovered = new JobQueue(db);
  expect(recovered.getJob(safe)!.status).toBe('pending'); expect(recovered.getJob(unsafe)!.status).toBe('failed');
  db.close();
});

test('cancel reports the AssemblyAI remote deletion outcome without claiming billing stopped', async () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE user_settings(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT); CREATE TABLE recordings(id TEXT PRIMARY KEY, fingerprint TEXT, status TEXT, error_message TEXT, retention_state TEXT)');
  db.query('INSERT INTO user_settings(key,value) VALUES(?,?)').run('assemblyaiApiKey', 'synthetic-key');
  const requests: { url: string; method?: string; key?: string }[] = [];
  let status = 200;
  const queue = new JobQueue(db);
  queue.onCancel(assemblyAiCancelHook(db, (async (url: string, init: RequestInit) => { requests.push({ url, method: init.method, key: (init.headers as Record<string, string>).authorization }); return new Response(null, { status }); }) as typeof fetch));
  queue.register('process-recording', async (_data, context) => { context.saveCheckpoint({ phase: 'polling', remoteId: 'abc-123', provider: 'assemblyai' }); await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true })); });
  const job = await queue.add('process-recording', { recordingId: 'one', config: {} });
  await wait(); expect(queue.cancel(job.id)).toBe(true); await wait();
  expect(requests).toEqual([{ url: 'https://api.assemblyai.com/v2/transcript/abc-123', method: 'DELETE', key: 'synthetic-key' }]);
  expect(queue.getJob(job.id)!.error).toContain('accepted the request to delete');
  expect(queue.getJob(job.id)!.error).toContain('does not confirm that billing stopped');
  expect(queue.getJob(job.id)!.status).toBe('cancelled');
  status = 400;
  const hook = assemblyAiCancelHook(db, (async () => new Response(null, { status })) as unknown as typeof fetch);
  expect(await hook({ ...queue.getJob(job.id)! })).toContain('refused');
  expect(await hook({ ...queue.getJob(job.id)!, checkpoint: { phase: 'submitting' } })).toBeNull();
  db.close();
});
