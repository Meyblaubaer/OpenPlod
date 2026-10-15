import { afterAll, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { purgeRecordingData } from './purge';
import { registerPurgeHook } from './purge-hooks';

const root = mkdtempSync(join(tmpdir(), 'openplod-purge-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function vault() {
  const database = new Database(':memory:');
  database.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE recordings (id TEXT PRIMARY KEY, file_path TEXT NOT NULL, source_provider TEXT, source_recording_id TEXT,
      source_transport TEXT, fingerprint TEXT, retention_state TEXT NOT NULL DEFAULT 'active');
    CREATE TABLE transcripts (id TEXT PRIMARY KEY, recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE, full_text TEXT);
    CREATE TABLE processing_jobs (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE plaud_import_events (id INTEGER PRIMARY KEY, recording_id TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE ai_turns (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, request_hash TEXT NOT NULL, recording_ids TEXT NOT NULL,
      question TEXT NOT NULL, state TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL);
    CREATE TABLE note_documents (id TEXT PRIMARY KEY, content TEXT, source_recording_id TEXT, source_version_id TEXT, source_origin TEXT);
    CREATE TABLE note_generations (id TEXT PRIMARY KEY, recording_id TEXT NOT NULL);
    CREATE TABLE search_passages (id TEXT PRIMARY KEY, recording_id TEXT NOT NULL, text TEXT);`);
  return database;
}

test('purge removes audio, sidecars, resume parts, derived rows, redacts AI turns and records a tombstone', async () => {
  const library = join(root, 'a', 'recordings'), id = '11111111-2222-4333-8444-555555555555';
  mkdirSync(join(library, 'originals', id), { recursive: true });
  mkdirSync(join(root, 'a', 'incoming', 'plaud-resume'), { recursive: true });
  const audio = join(library, `${id}.m4a`);
  writeFileSync(audio, 'audio');
  writeFileSync(join(library, 'originals', id, 'device-original.plaud'), 'device');
  const part = join(root, 'a', 'incoming', 'plaud-resume', 'SN123-42-100.part');
  const unrelated = join(root, 'a', 'incoming', 'plaud-resume', 'SN123-43-100.part');
  writeFileSync(part, 'p'); writeFileSync(unrelated, 'keep');

  const database = vault();
  database.query("INSERT INTO recordings VALUES(?,?,'plaud','SN123:42','ble','abc','trash')").run(id, audio);
  database.query("INSERT INTO recordings VALUES('other','/x.m4a',NULL,NULL,NULL,NULL,'active')").run();
  database.query("INSERT INTO transcripts VALUES('t1',?,'secret words')").run(id);
  database.query('INSERT INTO processing_jobs VALUES(?,?)').run('j1', JSON.stringify({ data: { recordingId: id } }));
  database.query('INSERT INTO processing_jobs VALUES(?,?)').run('j2', JSON.stringify({ data: { recordingId: 'other' } }));
  database.query("INSERT INTO processing_jobs VALUES('j3','not json')").run();
  database.query("INSERT INTO plaud_import_events(recording_id,created_at) VALUES(?, 'now')").run(id);
  database.query("INSERT INTO ai_turns VALUES('a1','c','h',?,'what was said?','ready','{\"answer\":\"secret words\"}','now')").run(JSON.stringify([id, 'other']));
  database.query("INSERT INTO ai_turns VALUES('a2','c','h','[\"other\"]','q','ready','{}','now')").run();
  database.query("INSERT INTO note_documents VALUES('d1','my notes',?,'v1','generated')").run(id);
  database.query('INSERT INTO note_generations VALUES(?,?)').run('g1', id);
  database.query("INSERT INTO search_passages VALUES('p1',?,'secret')").run(id);
  const seen: string[] = [];
  const unregister = registerPurgeHook({ name: 'test-hook', inTransaction: context => seen.push(`tx:${context.recordingId}`), afterCommit: context => { seen.push(`after:${context.sourceRecordingId}`); } });

  const report = await purgeRecordingData(database, id, { libraryDirectory: library });
  unregister();
  expect(report?.removed).toMatchObject({ recordings: 1, processing_jobs: 1, plaud_import_events: 1, note_generations: 1, search_passages: 1 });
  expect(report?.aiTurnsRedacted).toBe(1);
  expect(report?.documentsUnlinked).toBe(1);
  expect(seen).toEqual([`tx:${id}`, 'after:SN123:42']);
  expect(existsSync(audio)).toBe(false);
  expect(existsSync(join(library, 'originals', id))).toBe(false);
  expect(existsSync(part)).toBe(false);
  expect(existsSync(unrelated)).toBe(true);
  expect(database.query('SELECT count(*) AS n FROM transcripts').get()).toEqual({ n: 0 });
  expect(database.query("SELECT question,state,result,recording_ids AS ids FROM ai_turns WHERE id='a1'").get())
    .toEqual({ question: '[purged]', state: 'purged', result: null, ids: '["other"]' });
  expect(database.query("SELECT state FROM ai_turns WHERE id='a2'").get()).toEqual({ state: 'ready' });
  expect(database.query("SELECT content,source_recording_id AS source FROM note_documents").get()).toEqual({ content: 'my notes', source: null });
  expect(database.query('SELECT recording_id AS id, fingerprint, reason FROM recording_tombstones').get()).toEqual({ id, fingerprint: 'abc', reason: 'manual' });
  expect(database.query('SELECT count(*) AS n FROM processing_jobs').get()).toEqual({ n: 2 });
});

test('purge refuses recordings that are not in Trash and tolerates missing optional tables', async () => {
  const database = new Database(':memory:');
  database.exec("CREATE TABLE recordings (id TEXT PRIMARY KEY, file_path TEXT NOT NULL, source_provider TEXT, source_recording_id TEXT, source_transport TEXT, fingerprint TEXT, retention_state TEXT NOT NULL)");
  database.query("INSERT INTO recordings VALUES('r','/nope.m4a',NULL,NULL,NULL,NULL,'active')").run();
  expect(await purgeRecordingData(database, 'r', { libraryDirectory: root })).toBeNull();
  database.query("UPDATE recordings SET retention_state='trash'").run();
  expect((await purgeRecordingData(database, 'r', { libraryDirectory: root }))?.removed).toEqual({ recordings: 1 });
});
