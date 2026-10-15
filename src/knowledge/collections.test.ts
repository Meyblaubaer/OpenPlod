import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { RecordingCollections } from './collections';
import { KnowledgeIndex } from './retrieval';
import { KnowledgeSuggestions } from './suggestions';
import { createKnowledgeApi } from '../api/knowledge';
import { addRecording, knowledgeVault } from './fixtures';
import { initializeKnowledge } from './schema';

let database: Database, collections: RecordingCollections;
beforeEach(() => { database = knowledgeVault(); collections = new RecordingCollections(database); });
afterEach(() => database.close());
const api = () => {
  const index = new KnowledgeIndex(database, async () => { throw new Error('offline'); });
  return createKnowledgeApi({ collections, index, suggestions: new KnowledgeSuggestions(database, index) });
};
const json = (method: string, body: unknown) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('collections round-trip with unique names and revision checks (KB-01)', () => {
  const created = collections.create({ name: 'Client Alpha', description: 'Calls with Alpha' });
  expect(created).toMatchObject({ name: 'Client Alpha', description: 'Calls with Alpha', revision: 1, recordingCount: 0 });
  expect(() => collections.create({ name: 'client alpha' })).toThrow('already exists');
  const renamed = collections.update(created.id, { name: 'Alpha', revision: 1 });
  expect(renamed.revision).toBe(2);
  expect(() => collections.update(created.id, { name: 'Stale', revision: 1 })).toThrow('changed elsewhere');
  expect(() => collections.delete(created.id, 1)).toThrow('changed elsewhere');
  collections.delete(created.id, 2);
  expect(collections.list()).toEqual([]);
  expect(() => collections.get(created.id)).toThrow('not found');
});

test('membership is revision checked, survives Trash, and is removed on purge', () => {
  const a = addRecording(database, { title: 'a', recordedAt: '2026-10-01T10:00:00Z' }), b = addRecording(database, { title: 'b', recordedAt: '2026-10-02T10:00:00Z' });
  const collection = collections.create({ name: 'Project' });
  const added = collections.add(collection.id, { recordingIds: [a.id, b.id, a.id], revision: 1 });
  expect(added).toMatchObject({ revision: 2, recordingCount: 2, recordingIds: [b.id, a.id] });
  expect(() => collections.add(collection.id, { recordingIds: [a.id], revision: 1 })).toThrow('changed elsewhere');
  expect(() => collections.add(collection.id, { recordingIds: [crypto.randomUUID()], revision: 2 })).toThrow('active recordings');
  expect(collections.membership([a.id, b.id]).get(a.id)).toEqual([collection.id]);

  database.query("UPDATE recordings SET retention_state='trash' WHERE id=?").run(a.id);
  expect(collections.get(collection.id)).toMatchObject({ recordingCount: 1, recordingIds: [b.id] });
  database.query("UPDATE recordings SET retention_state='active' WHERE id=?").run(a.id);
  expect(collections.get(collection.id).recordingCount).toBe(2);

  database.query('DELETE FROM recordings WHERE id=?').run(a.id);
  expect(collections.membership([a.id]).size).toBe(0);
  const removed = collections.remove(collection.id, { recordingIds: [b.id], revision: 2 });
  expect(removed).toMatchObject({ recordingCount: 0, recordingIds: [], revision: 3 });
  expect(database.query('SELECT count(*) AS count FROM recordings').get()).toEqual({ count: 1 });
});

test('collections HTTP contract and re-initialization are safe', async () => {
  initializeKnowledge(database); initializeKnowledge(database);
  const app = api();
  const recording = addRecording(database);
  const created = await app.request('/collections', json('POST', { name: 'Interviews' }));
  expect(created.status).toBe(201);
  const { data } = await created.json();
  expect((await app.request('/collections', json('POST', { name: 'INTERVIEWS' }))).status).toBe(409);
  expect((await app.request('/collections', json('POST', { name: '' }))).status).toBe(400);
  const added = await app.request(`/collections/${data.id}/recordings`, json('POST', { recordingIds: [recording.id], revision: 1 }));
  expect((await added.json()).data).toMatchObject({ recordingIds: [recording.id], revision: 2 });
  expect((await (await app.request('/collections')).json()).data).toMatchObject([{ name: 'Interviews', recordingCount: 1 }]);
  expect((await app.request(`/collections/${data.id}`, json('DELETE', { revision: 1 }))).status).toBe(409);
  expect((await app.request(`/collections/${data.id}`, json('DELETE', { revision: 2 }))).status).toBe(200);
  expect((await app.request(`/collections/${crypto.randomUUID()}`)).status).toBe(404);
  expect(database.query('SELECT count(*) AS count FROM recordings').get()).toEqual({ count: 1 });
});
