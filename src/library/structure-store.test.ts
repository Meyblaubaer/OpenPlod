import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { StructureStore, StructureStoreError, structureSourceHash } from './structure-store';
import type { TranscriptStructure } from './transcript-ai';

let database: Database;
let clock = Date.parse('2026-10-15T09:00:00Z');
const recordingId = 'rec-1';

const structure = (title = 'Budget'): TranscriptStructure => ({
  chapters: [{ title, text: title, startSeconds: 64, segmentIndex: 1 }],
  decisions: [],
  actionItems: [{ text: 'Book the venue.', owner: null, due: null, startSeconds: null, segmentIndex: null }],
  openQuestions: [],
  provider: 'mistral', model: 'mistral-small-test', usage: null, timestampsAvailable: true,
});

beforeEach(() => {
  database = new Database(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec(`CREATE TABLE recordings(id TEXT PRIMARY KEY);
    CREATE TABLE transcripts(recording_id TEXT, current_version_id TEXT, full_text TEXT)`);
  database.query('INSERT INTO recordings VALUES(?)').run(recordingId);
  database.query('INSERT INTO transcripts VALUES(?,?,?)').run(recordingId, 'v1', 'Hello there.');
  clock = Date.parse('2026-10-15T09:00:00Z');
});
afterEach(() => database.close());

const store = () => new StructureStore(database, () => clock);

describe('structure store', () => {
  test('creating the table is idempotent', () => {
    store(); store();
    expect(database.query("SELECT count(*) AS n FROM sqlite_master WHERE name = 'transcript_structures'").get()).toEqual({ n: 1 });
  });

  test('a proposal is not saved until it is explicitly saved', () => {
    const structures = store();
    const proposal = structures.propose({ recordingId, versionId: 'v1', sourceHash: structureSourceHash('Hello there.'), structure: structure() });
    expect(structures.list(recordingId)).toHaveLength(0);
    const saved = structures.save(recordingId, proposal.proposalId);
    expect(saved).toMatchObject({ recordingId, versionId: 'v1', provider: 'mistral', model: 'mistral-small-test', current: true });
    // Unknown owner and due date survive the round trip as unset, not as text.
    expect(saved.structure.actionItems[0]).toMatchObject({ owner: null, due: null, startSeconds: null });
    expect(saved.structure.chapters[0]!.startSeconds).toBe(64);
    expect(saved.createdAt).toBe('2026-10-15T09:00:00.000Z');
  });

  test('a proposal saves once and only for its own recording', () => {
    const structures = store();
    const proposal = structures.propose({ recordingId, versionId: 'v1', sourceHash: 'h', structure: structure() });
    expect(() => structures.save('other-recording', proposal.proposalId)).toThrow(StructureStoreError);
    structures.save(recordingId, proposal.proposalId);
    expect(() => structures.save(recordingId, proposal.proposalId)).toThrow('no longer available');
    expect(structures.list(recordingId)).toHaveLength(1);
  });

  test('proposals expire', () => {
    const structures = store();
    const proposal = structures.propose({ recordingId, versionId: 'v1', sourceHash: 'h', structure: structure() });
    clock += 3_600_001;
    expect(() => structures.save(recordingId, proposal.proposalId)).toThrow('Run it again');
  });

  test('regenerating keeps history, newest first, and marks older versions stale', () => {
    const structures = store();
    structures.save(recordingId, structures.propose({ recordingId, versionId: 'v1', sourceHash: 'h', structure: structure('First') }).proposalId);
    database.query('UPDATE transcripts SET current_version_id = ?').run('v2');
    clock += 1000;
    structures.save(recordingId, structures.propose({ recordingId, versionId: 'v2', sourceHash: 'h', structure: structure('Second') }).proposalId);
    const listed = structures.list(recordingId);
    expect(listed.map(row => row.structure.chapters[0]!.title)).toEqual(['Second', 'First']);
    expect(listed.map(row => row.current)).toEqual([true, false]);
  });

  test('a legacy unversioned transcript is matched by its text', () => {
    database.query('UPDATE transcripts SET current_version_id = NULL').run();
    const structures = store();
    const saved = structures.save(recordingId, structures.propose({ recordingId, versionId: null, sourceHash: structureSourceHash('Hello there.'), structure: structure() }).proposalId);
    expect(saved.current).toBe(true);
    database.query('UPDATE transcripts SET full_text = ?').run('Edited.');
    expect(structures.get(recordingId, saved.id)!.current).toBe(false);
  });

  test('delete removes one row and is scoped to the recording', () => {
    const structures = store();
    const saved = structures.save(recordingId, structures.propose({ recordingId, versionId: 'v1', sourceHash: 'h', structure: structure() }).proposalId);
    expect(structures.remove('other-recording', saved.id)).toBe(false);
    expect(structures.remove(recordingId, saved.id)).toBe(true);
    expect(structures.get(recordingId, saved.id)).toBeNull();
  });

  test('rows go when their recording is purged', () => {
    const structures = store();
    structures.save(recordingId, structures.propose({ recordingId, versionId: 'v1', sourceHash: 'h', structure: structure() }).proposalId);
    database.query('DELETE FROM recordings WHERE id = ?').run(recordingId);
    expect(structures.list(recordingId)).toHaveLength(0);
  });
});
