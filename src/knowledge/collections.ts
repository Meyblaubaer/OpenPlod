import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import { OrganizerError } from '../organizer/store';
import { identifier, revision } from '../organizer/schemas';
import type { RecordingCollection, RecordingCollectionDetail } from './types';

const fail = (status: OrganizerError['status'], code: string, message: string): never => { throw new OrganizerError(status, code, message); };
const collectionName = z.string().trim().min(1).max(80).refine(value => !/[\x00-\x1f]/.test(value), 'Use a collection name without control characters');
const description = z.string().trim().max(500).refine(value => !value.includes('\0'), 'Use plain text');
export const createCollectionSchema = z.object({ name: collectionName, description: description.default('') }).strict();
export const updateCollectionSchema = z.object({ name: collectionName.optional(), description: description.optional(), revision }).strict();
export const collectionMembershipSchema = z.object({ recordingIds: z.array(identifier).min(1).max(500), revision }).strict();
export const COLLECTION_LIMIT = 500;

const columns = `c.id, c.name, c.description, c.revision, c.created_at AS createdAt, c.updated_at AS updatedAt,
  (SELECT count(*) FROM recording_collection_items i JOIN recordings r ON r.id=i.recording_id
    WHERE i.collection_id=c.id AND r.retention_state='active') AS recordingCount`;

/**
 * Recording collections (roadmap KB-01). A collection is a named, revision-checked
 * set of recordings. Membership survives Trash (a restored recording is still in
 * its collections) but trashed recordings are never counted or listed; purging a
 * recording removes it from every collection.
 */
export class RecordingCollections {
  constructor(readonly database: Database) {}

  list(): RecordingCollection[] {
    return this.database.query(`SELECT ${columns} FROM recording_collections c ORDER BY c.name COLLATE NOCASE, c.id`).all() as RecordingCollection[];
  }

  private row(id: string): RecordingCollection {
    const row = this.database.query(`SELECT ${columns} FROM recording_collections c WHERE c.id=?`).get(identifier.parse(id)) as RecordingCollection | null;
    return row ?? fail(404, 'collection_not_found', 'Collection not found.');
  }

  /** A collection and its active recording ids, newest recording first. */
  get(id: string): RecordingCollectionDetail {
    const collection = this.row(id);
    const recordingIds = (this.database.query(`SELECT i.recording_id AS id FROM recording_collection_items i JOIN recordings r ON r.id=i.recording_id
      WHERE i.collection_id=? AND r.retention_state='active' ORDER BY r.recorded_at DESC, r.id LIMIT 5000`).all(collection.id) as { id: string }[]).map(row => row.id);
    return { ...collection, recordingIds };
  }

  /** Collection ids per recording, for one page of the library in one statement. */
  membership(recordingIds: string[]): Map<string, string[]> {
    const result = new Map<string, string[]>();
    if (!recordingIds.length) return result;
    const rows = this.database.query('SELECT recording_id AS recordingId, collection_id AS collectionId FROM recording_collection_items WHERE recording_id IN (SELECT value FROM json_each(?)) ORDER BY collection_id')
      .all(JSON.stringify(recordingIds)) as { recordingId: string; collectionId: string }[];
    for (const row of rows) result.set(row.recordingId, [...(result.get(row.recordingId) ?? []), row.collectionId]);
    return result;
  }

  private unique(name: string, self = '') {
    if (this.database.query('SELECT id FROM recording_collections WHERE name=? COLLATE NOCASE AND id<>?').get(name, self))
      fail(409, 'collection_exists', 'A collection with that name already exists.');
  }

  private checkRevision(current: number, expected: number) {
    if (current !== expected) fail(409, 'revision_conflict', 'This collection changed elsewhere. Reload it before saving.');
  }

  create(input: unknown): RecordingCollection {
    const data = createCollectionSchema.parse(input);
    return this.database.transaction(() => {
      if ((this.database.query('SELECT count(*) AS count FROM recording_collections').get() as { count: number }).count >= COLLECTION_LIMIT)
        fail(400, 'collection_limit', `The collection limit is ${COLLECTION_LIMIT}.`);
      this.unique(data.name);
      const id = crypto.randomUUID(), now = new Date().toISOString();
      this.database.query('INSERT INTO recording_collections(id, name, description, created_at, updated_at) VALUES(?,?,?,?,?)').run(id, data.name, data.description, now, now);
      return this.row(id);
    })();
  }

  update(id: string, input: unknown): RecordingCollection {
    const data = updateCollectionSchema.parse(input);
    return this.database.transaction(() => {
      const current = this.row(id); this.checkRevision(current.revision, data.revision);
      const name = data.name ?? current.name, text = data.description ?? current.description;
      this.unique(name, current.id);
      this.database.query('UPDATE recording_collections SET name=?, description=?, revision=revision+1, updated_at=? WHERE id=?').run(name, text, new Date().toISOString(), current.id);
      return this.row(current.id);
    })();
  }

  /** Deletes the collection only; its recordings are untouched. */
  delete(id: string, expected: number) {
    this.database.transaction(() => {
      const current = this.row(id); this.checkRevision(current.revision, revision.parse(expected));
      this.database.query('DELETE FROM recording_collection_items WHERE collection_id=?').run(current.id);
      this.database.query('DELETE FROM recording_collections WHERE id=?').run(current.id);
    })();
  }

  /** Add active recordings. Recordings already in the collection are left as they are. */
  add(id: string, input: unknown): RecordingCollectionDetail {
    const data = collectionMembershipSchema.parse(input);
    return this.database.transaction(() => {
      const current = this.row(id); this.checkRevision(current.revision, data.revision);
      const ids = [...new Set(data.recordingIds)];
      const active = new Set((this.database.query(`SELECT id FROM recordings WHERE retention_state='active' AND id IN (SELECT value FROM json_each(?))`)
        .all(JSON.stringify(ids)) as { id: string }[]).map(row => row.id));
      if (ids.some(recordingId => !active.has(recordingId))) fail(404, 'recording_not_found', 'Only active recordings can be added to a collection.');
      const insert = this.database.query('INSERT OR IGNORE INTO recording_collection_items(collection_id, recording_id, added_at) VALUES(?,?,?)');
      const now = new Date().toISOString();
      for (const recordingId of ids) insert.run(current.id, recordingId, now);
      this.database.query('UPDATE recording_collections SET revision=revision+1, updated_at=? WHERE id=?').run(now, current.id);
      return this.get(current.id);
    })();
  }

  /** Remove recordings from the collection; the recordings themselves are untouched. */
  remove(id: string, input: unknown): RecordingCollectionDetail {
    const data = collectionMembershipSchema.parse(input);
    return this.database.transaction(() => {
      const current = this.row(id); this.checkRevision(current.revision, data.revision);
      this.database.query('DELETE FROM recording_collection_items WHERE collection_id=? AND recording_id IN (SELECT value FROM json_each(?))').run(current.id, JSON.stringify(data.recordingIds));
      this.database.query('UPDATE recording_collections SET revision=revision+1, updated_at=? WHERE id=?').run(new Date().toISOString(), current.id);
      return this.get(current.id);
    })();
  }
}
