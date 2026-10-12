import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { JobQueue } from '../jobs/queue';
import { createJobsApi } from './jobs';

const tick = () => new Promise(resolve => setTimeout(resolve, 5));
function fixture() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE recordings (id TEXT PRIMARY KEY, fingerprint TEXT); CREATE TABLE transcript_versions (id TEXT PRIMARY KEY, recording_id TEXT)');
  const queue = new JobQueue(db);
  return { db, queue, api: createJobsApi(queue, db) };
}

test('v1 job list is newest first, filterable, paginated, and carries result refs', async () => {
  const { db, queue, api } = fixture();
  const recordingId = crypto.randomUUID();
  queue.register('process-recording', async (_data, context) => { db.query('INSERT INTO transcript_versions VALUES(?,?)').run(context.id, recordingId); });
  const processed = await queue.add('process-recording', { recordingId, config: { transcriptionEngine: 'mistral' } });
  await tick();
  const pending = await queue.add('forward-recording', { recordingId: crypto.randomUUID() });
  const list = await (await api.request('/')).json();
  expect(list.data.jobs.map((job: { id: string }) => job.id)).toEqual([pending.id, processed.id]);
  expect(list.data.jobs[1]).toMatchObject({
    type: 'process-recording', state: 'complete', recordingId, provider: 'mistral', error: null,
    resultRefs: { transcriptVersionIds: [processed.id] },
  });
  expect(list.data.jobs[1].startedAt).toBeString();
  expect(list.data.jobs[0]).toMatchObject({ state: 'pending', startedAt: null, resultRefs: { transcriptVersionIds: [] } });
  expect((await (await api.request('/?state=complete')).json()).data.total).toBe(1);
  expect((await (await api.request(`/?recordingId=${recordingId}`)).json()).data.jobs).toHaveLength(1);
  expect((await (await api.request('/?limit=1&offset=1')).json()).data).toMatchObject({ total: 2, jobs: [{ id: processed.id }] });
  expect((await api.request('/?limit=0')).status).toBe(400);
  db.close();
});

test('get and cancel use explicit errors and cancel only the named job', async () => {
  const { db, queue, api } = fixture();
  const recordingId = crypto.randomUUID();
  const forward = await queue.add('forward-recording', { recordingId });
  const other = await queue.add('process-recording', { recordingId });
  expect((await api.request(`/${crypto.randomUUID()}`)).status).toBe(404);
  expect(await (await api.request(`/${forward.id}`)).json()).toMatchObject({ data: { id: forward.id, state: 'pending' } });
  expect((await api.request(`/${crypto.randomUUID()}/cancel`, { method: 'POST' })).status).toBe(404);
  const cancelled = await api.request(`/${forward.id}/cancel`, { method: 'POST' });
  expect(await cancelled.json()).toMatchObject({ data: { state: 'cancelled' } });
  expect(queue.getJob(other.id)?.status).toBe('pending');
  const again = await api.request(`/${forward.id}/cancel`, { method: 'POST' });
  expect(again.status).toBe(409); expect(await again.json()).toMatchObject({ code: 'job_not_cancellable' });
  db.close();
});

test('a retried submission for the same recording reuses the pending job', async () => {
  const { db, queue } = fixture();
  const recordingId = crypto.randomUUID();
  const first = await queue.add('process-recording', { recordingId });
  expect((await queue.add('process-recording', { recordingId })).id).toBe(first.id);
  expect(queue.getAllJobs()).toHaveLength(1);
  db.close();
});

test('restart prunes old finished jobs but keeps recent and unfinished ones', () => {
  const db = new Database(':memory:'); new JobQueue(db);
  const old = new Date(Date.now() - 40 * 86400000).toISOString(), recent = new Date().toISOString();
  const insert = (status: string, completedAt: string | undefined) => {
    const id = crypto.randomUUID();
    db.query('INSERT INTO processing_jobs VALUES(?,?)').run(id, JSON.stringify({ id, type: 'task', data: {}, priority: 0, status, createdAt: old, completedAt }));
    return id;
  };
  const expired = insert('complete', old), kept = insert('failed', recent), waiting = insert('pending', undefined);
  const ids = new JobQueue(db).getAllJobs().map(job => job.id);
  expect(ids).toEqual([kept, waiting]);
  expect(db.query('SELECT id FROM processing_jobs WHERE id=?').get(expired)).toBeNull();
  db.close();
});

test('restart marks the recording of an interrupted uncertain job as failed', () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE recordings (id TEXT PRIMARY KEY, status TEXT, error_message TEXT, retention_state TEXT DEFAULT 'active')");
  new JobQueue(db);
  const recordingId = crypto.randomUUID(), id = crypto.randomUUID();
  db.query("INSERT INTO recordings(id, status) VALUES(?, 'transcribing')").run(recordingId);
  db.query('INSERT INTO processing_jobs VALUES(?,?)').run(id, JSON.stringify({ id, type: 'process-recording', data: { recordingId }, priority: 0, status: 'running', createdAt: new Date(), checkpoint: { phase: 'submitting' } }));
  expect(new JobQueue(db).getJob(id)?.status).toBe('failed');
  expect(db.query('SELECT status FROM recordings').get()).toEqual({ status: 'failed' });
  db.close();
});
