import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { toFtsQuery } from '../search/query';
import { emitAutomationEvent } from '../automation/hooks';
import { createFolderSchema, updateFolderSchema, createNoteSchema, updateNoteSchema, snapshotSchema, noteListSchema, identifier, revision, createViewSchema, updateViewSchema } from './schemas';
import type {
  NoteFolder, NoteDocument, NoteSummary, NoteVersion, NotePage, NoteProperties, DocumentSource,
  TranscriptVersionSummary, TranscriptVersionDetail, TranscriptVersionBacklinks, SavedView,
} from './types';

export class OrganizerError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 410 | 413 | 503, readonly code: string, message: string) { super(message); }
}
const fail = (status: OrganizerError['status'], code: string, message: string): never => { throw new OrganizerError(status, code, message); };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const fields = `d.id, d.title, d.folder_id AS folderId, d.starred, d.revision,
  substr(d.content, 1, 160) AS excerpt, d.created_at AS createdAt, d.updated_at AS updatedAt, d.deleted_at AS deletedAt,
  d.source_recording_id AS sourceRecordingId, d.source_version_id AS sourceVersionId, d.source_origin AS sourceOrigin,
  (SELECT json_group_array(t.tag) FROM note_tags t WHERE t.document_id=d.id) AS tags`;
/** SQLite returns flags as integers and tags/properties as JSON text. */
const normalize = <T extends NoteSummary>(row: T): T => {
  const raw = row as unknown as { tags: string; properties?: string };
  return {
    ...row, starred: Boolean(row.starred), tags: (JSON.parse(raw.tags) as string[]).sort(compareTags),
    ...(raw.properties === undefined ? {} : { properties: JSON.parse(raw.properties) as NoteProperties }),
  };
};
const compareTags = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });
const tagKey = (tag: string) => tag.toLocaleLowerCase();
/** Trim, drop case-insensitive duplicates (first spelling wins), and sort. */
const uniqueTags = (tags: string[]) => {
  const seen = new Map<string, string>();
  for (const tag of tags) if (!seen.has(tagKey(tag))) seen.set(tagKey(tag), tag);
  return [...seen.values()].sort(compareTags);
};
/** Merge a properties patch: present keys replace, `null` removes, absent keys are kept. */
const mergeProperties = (current: NoteProperties, patch: NoteProperties) => {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) { if (value === null) delete next[key]; else next[key] = value; }
  return next;
};
const versionColumns = `v.id, v.recording_id AS recordingId, v.origin, v.created_at AS createdAt,
  json_extract(v.provenance, '$.provider') AS provider, json_extract(v.provenance, '$.model') AS model,
  (v.id = t.current_version_id) AS current,
  (SELECT count(*) FROM note_documents d WHERE d.source_recording_id=v.recording_id AND d.source_version_id=v.id AND d.deleted_at IS NULL) AS documentCount`;
const normalizeVersion = <T extends TranscriptVersionSummary>(row: T): T => ({ ...row, current: Boolean(row.current) });

export function initializeOrganizer(database: Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS note_folders (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT REFERENCES note_folders(id) ON DELETE RESTRICT, revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE UNIQUE INDEX IF NOT EXISTS note_folder_siblings ON note_folders(COALESCE(parent_id, ''), name COLLATE NOCASE);
    CREATE TABLE IF NOT EXISTS note_documents (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, folder_id TEXT REFERENCES note_folders(id) ON DELETE RESTRICT,
      starred INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
      source_recording_id TEXT, source_version_id TEXT, source_origin TEXT,
      snapshot_key TEXT UNIQUE, idempotency_key TEXT UNIQUE, request_hash TEXT
    );
    CREATE INDEX IF NOT EXISTS note_documents_folder ON note_documents(deleted_at, folder_id, updated_at DESC, id);
    CREATE TABLE IF NOT EXISTS note_versions (
      id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES note_documents(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(document_id, revision)
    );
    CREATE TABLE IF NOT EXISTS note_deliveries (
      id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES note_documents(id) ON DELETE CASCADE,
      document_revision INTEGER NOT NULL, destination_id TEXT NOT NULL, state TEXT NOT NULL,
      created_at TEXT NOT NULL, status_code INTEGER, request_hash TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS note_deliveries_document ON note_deliveries(document_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS note_generations (
      id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, recording_id TEXT NOT NULL, version_id TEXT,
      source_hash TEXT NOT NULL, state TEXT NOT NULL, model TEXT NOT NULL, title TEXT NOT NULL,
      content TEXT, created_at TEXT NOT NULL, steps TEXT NOT NULL DEFAULT '[]',
      document_id TEXT REFERENCES note_documents(id) ON DELETE CASCADE
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(document_id UNINDEXED, title, content, tokenize='unicode61 remove_diacritics 2');
    CREATE TRIGGER IF NOT EXISTS note_fts_insert AFTER INSERT ON note_documents BEGIN
      INSERT INTO note_fts(document_id, title, content) VALUES(new.id, new.title, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS note_fts_delete AFTER DELETE ON note_documents BEGIN
      DELETE FROM note_fts WHERE document_id = old.id;
    END;
    CREATE TRIGGER IF NOT EXISTS note_fts_update AFTER UPDATE OF title, content ON note_documents BEGIN
      DELETE FROM note_fts WHERE document_id = old.id;
      INSERT INTO note_fts(document_id, title, content) VALUES(new.id, new.title, new.content);
    END;
  `);
  const generationColumns = database.query('PRAGMA table_info(note_generations)').all() as { name: string }[];
  if (!generationColumns.some(column => column.name === 'provider')) database.exec("ALTER TABLE note_generations ADD COLUMN provider TEXT NOT NULL DEFAULT 'mistral'");
  // 0.7.0 (KB-01): additive tags, properties, and a source index for backlinks.
  const documentColumns = database.query('PRAGMA table_info(note_documents)').all() as { name: string }[];
  if (!documentColumns.some(column => column.name === 'properties')) database.exec("ALTER TABLE note_documents ADD COLUMN properties TEXT NOT NULL DEFAULT '{}'");
  database.exec(`
    CREATE TABLE IF NOT EXISTS note_tags (
      document_id TEXT NOT NULL REFERENCES note_documents(id) ON DELETE CASCADE, tag_key TEXT NOT NULL, tag TEXT NOT NULL,
      PRIMARY KEY(document_id, tag_key)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS note_tags_key ON note_tags(tag_key, document_id);
    CREATE INDEX IF NOT EXISTS note_documents_source ON note_documents(source_recording_id, source_version_id);
    CREATE TABLE IF NOT EXISTS note_views (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, filters TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS note_views_name ON note_views(name COLLATE NOCASE);
  `);
}
const viewColumns = 'id, name, filters, revision, created_at AS createdAt, updated_at AS updatedAt';
const normalizeView = (row: SavedView) => ({ ...row, filters: JSON.parse(row.filters as unknown as string) }) as SavedView;

export class OrganizerStore {
  constructor(readonly database: Database) {}

  folders(): NoteFolder[] {
    return this.database.query(`SELECT f.id, f.name, f.parent_id AS parentId, f.revision,
      (SELECT count(*) FROM note_documents d WHERE d.folder_id=f.id AND d.deleted_at IS NULL) AS documentCount
      FROM note_folders f ORDER BY f.name COLLATE NOCASE, f.id`).all() as NoteFolder[];
  }

  private folder(id: string): NoteFolder {
    const row = this.database.query(`SELECT id, name, parent_id AS parentId, revision FROM note_folders WHERE id=?`).get(identifier.parse(id)) as NoteFolder | null;
    return row ?? fail(404, 'folder_not_found', 'Folder not found.');
  }

  private folderParents(): Map<string, string | null> {
    const rows = this.database.query('SELECT id, parent_id AS parentId FROM note_folders').all() as { id: string; parentId: string | null }[];
    return new Map(rows.map(row => [row.id, row.parentId]));
  }

  private validParent(id: string | null, self?: string, parents: Map<string, string | null> = this.folderParents()) {
    let current = id;
    const visited = new Set<string>();
    while (current) {
      if (current === self || visited.has(current)) fail(409, 'folder_cycle', 'A folder cannot contain itself.');
      visited.add(current);
      if (visited.size >= 32) fail(400, 'folder_depth', 'Folders support up to 32 levels.');
      if (!parents.has(current)) fail(404, 'folder_not_found', 'Folder not found.');
      current = parents.get(current) ?? null;
    }
  }

  private uniqueFolder(name: string, parentId: string | null, self = '') {
    if (this.database.query(`SELECT id FROM note_folders WHERE name=? COLLATE NOCASE AND parent_id IS ? AND id<>?`).get(name, parentId, self))
      fail(409, 'folder_exists', 'A folder with that name already exists here.');
  }

  createFolder(input: unknown): NoteFolder {
    const data = createFolderSchema.parse(input);
    return this.database.transaction(() => {
      if (this.folders().length >= 1000) fail(400, 'folder_limit', 'The folder limit is 1,000.');
      this.validParent(data.parentId); this.uniqueFolder(data.name, data.parentId);
      const id = crypto.randomUUID();
      this.database.query('INSERT INTO note_folders(id, name, parent_id) VALUES(?,?,?)').run(id, data.name, data.parentId);
      return { ...this.folder(id), documentCount: 0 };
    })();
  }

  updateFolder(id: string, input: unknown): NoteFolder {
    const data = updateFolderSchema.parse(input);
    return this.database.transaction(() => {
      const folder = this.folder(id); this.checkRevision(folder.revision, data.revision);
      const name = data.name ?? folder.name, parentId = data.parentId === undefined ? folder.parentId : data.parentId;
      const parents = this.folderParents();
      this.validParent(parentId, id, parents); this.uniqueFolder(name, parentId, id);
      // Moving an ancestor must not push descendants beyond the depth limit.
      this.database.query('UPDATE note_folders SET name=?, parent_id=?, revision=revision+1 WHERE id=?').run(name, parentId, id);
      parents.set(id, parentId);
      for (const descendantId of parents.keys()) this.validParent(parents.get(descendantId) ?? null, descendantId, parents);
      return this.folders().find(row => row.id === id)!;
    })();
  }

  deleteFolder(id: string, expected: number) {
    this.database.transaction(() => {
      const folder = this.folder(id); this.checkRevision(folder.revision, revision.parse(expected));
      if (this.database.query('SELECT id FROM note_documents WHERE folder_id=? LIMIT 1').get(id)
        || this.database.query('SELECT id FROM note_folders WHERE parent_id=? LIMIT 1').get(id))
        fail(409, 'folder_not_empty', 'Move documents (including Trash) and subfolders before deleting this folder.');
      this.database.query('DELETE FROM note_folders WHERE id=?').run(id);
    })();
  }

  list(input: unknown = {}): NotePage {
    const data = noteListSchema.parse(input), params: (string | number)[] = [];
    let where = data.view === 'trash' ? 'd.deleted_at IS NOT NULL' : 'd.deleted_at IS NULL';
    if (data.view === 'starred') where += ' AND d.starred=1';
    if (data.folderId === 'inbox') where += ' AND d.folder_id IS NULL';
    else if (data.folderId) { where += ' AND d.folder_id=?'; params.push(data.folderId); }
    if (data.tag) { where += ' AND d.id IN (SELECT document_id FROM note_tags WHERE tag_key=?)'; params.push(tagKey(data.tag)); }
    if (data.q) {
      const query = toFtsQuery(data.q);
      if (!query) where += ' AND 0';
      else { where += ' AND d.id IN (SELECT document_id FROM note_fts WHERE note_fts MATCH ?)'; params.push(query); }
    }
    const total = (this.database.query(`SELECT count(*) AS count FROM note_documents d WHERE ${where}`).get(...params) as {count: number}).count;
    const order = data.sort === 'title' ? 'd.title COLLATE NOCASE, d.id' : 'd.updated_at DESC, d.id';
    const rows = this.database.query(`SELECT ${fields} FROM note_documents d WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, data.limit, data.offset) as NoteSummary[];
    return { documents: rows.map(normalize), total, offset: data.offset, limit: data.limit };
  }

  get(id: string): NoteDocument {
    const row = this.database.query(`SELECT ${fields}, d.content, d.properties FROM note_documents d WHERE d.id=?`).get(identifier.parse(id)) as NoteDocument | null;
    return row ? normalize(row) : fail(404, 'document_not_found', 'Document not found.');
  }

  private checkRevision(current: number, expected: number) {
    if (current !== expected) fail(409, 'revision_conflict', 'This item changed elsewhere. Reload it before saving; your draft has not been overwritten.');
  }

  active(id: string, expected?: number): NoteDocument {
    const document = this.get(id);
    if (document.deletedAt) fail(409, 'document_in_trash', 'Restore this document from Trash first.');
    if (expected !== undefined) this.checkRevision(document.revision, expected);
    return document;
  }

  private saveVersion(document: NoteDocument) {
    this.database.query('INSERT INTO note_versions(id, document_id, revision, title, content, created_at) VALUES(?,?,?,?,?,?)')
      .run(crypto.randomUUID(), document.id, document.revision, document.title, document.content, document.updatedAt);
    return document;
  }

  create(input: unknown): NoteDocument {
    const data = createNoteSchema.parse(input), requestHash = hash(JSON.stringify(data));
    return this.database.transaction(() => {
      const existing = this.database.query('SELECT id, request_hash AS requestHash FROM note_documents WHERE idempotency_key=?')
        .get(data.idempotencyKey) as {id: string; requestHash: string} | null;
      if (existing) {
        if (existing.requestHash !== requestHash) fail(409, 'idempotency_conflict', 'This request key was already used for different content.');
        return this.get(existing.id);
      }
      if (data.folderId) this.folder(data.folderId);
      const id = crypto.randomUUID(), now = new Date().toISOString();
      const properties = mergeProperties({}, data.properties);
      this.database.query(`INSERT INTO note_documents(id,title,content,folder_id,properties,created_at,updated_at,idempotency_key,request_hash) VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(id, data.title, data.content, data.folderId, JSON.stringify(properties), now, now, data.idempotencyKey, requestHash);
      this.writeTags(id, uniqueTags(data.tags));
      // KB-08: the webhook outbox row commits or rolls back with the document.
      void emitAutomationEvent({ type: 'document.created', documentId: id });
      return this.saveVersion(this.get(id));
    })();
  }

  update(id: string, input: unknown): NoteDocument {
    const data = updateNoteSchema.parse(input);
    return this.database.transaction(() => {
      const current = this.active(id, data.revision);
      const folderId = data.folderId === undefined ? current.folderId : data.folderId;
      if (folderId) this.folder(folderId);
      const title = data.title ?? current.title, content = data.content ?? current.content, starred = data.starred ?? current.starred;
      const tags = data.tags === undefined ? current.tags : uniqueTags(data.tags);
      const properties = data.properties === undefined ? current.properties : mergeProperties(current.properties, data.properties);
      const tagsChanged = tags.join('\n') !== current.tags.join('\n');
      const propertiesChanged = JSON.stringify(properties) !== JSON.stringify(current.properties);
      const textChanged = title !== current.title || content !== current.content;
      if (!textChanged && !tagsChanged && !propertiesChanged && folderId === current.folderId && starred === current.starred) return current;
      this.database.query('UPDATE note_documents SET title=?, content=?, folder_id=?, starred=?, properties=?, revision=revision+1, updated_at=? WHERE id=?')
        .run(title, content, folderId, starred ? 1 : 0, JSON.stringify(properties), new Date().toISOString(), id);
      if (tagsChanged) this.writeTags(id, tags);
      return this.saveVersion(this.get(id));
    })();
  }

  private writeTags(id: string, tags: string[]) {
    this.database.query('DELETE FROM note_tags WHERE document_id=?').run(id);
    const insert = this.database.query('INSERT INTO note_tags(document_id, tag_key, tag) VALUES(?,?,?)');
    for (const tag of tags) insert.run(id, tagKey(tag), tag);
  }

  /** Every tag on an active document, with how many active documents carry it. */
  tags(): { tag: string; count: number }[] {
    return this.database.query(`SELECT min(t.tag) AS tag, count(*) AS count FROM note_tags t JOIN note_documents d ON d.id=t.document_id
      WHERE d.deleted_at IS NULL GROUP BY t.tag_key ORDER BY t.tag_key`).all() as { tag: string; count: number }[];
  }

  /** Saved document views (KB-01). A view stores filters; the documents are listed live. */
  views(): SavedView[] {
    return (this.database.query(`SELECT ${viewColumns} FROM note_views ORDER BY name COLLATE NOCASE, id`).all() as SavedView[]).map(normalizeView);
  }

  private view(id: string): SavedView {
    const row = this.database.query(`SELECT ${viewColumns} FROM note_views WHERE id=?`).get(identifier.parse(id)) as SavedView | null;
    return row ? normalizeView(row) : fail(404, 'view_not_found', 'Saved view not found.');
  }

  private uniqueView(name: string, self = '') {
    if (this.database.query('SELECT id FROM note_views WHERE name=? COLLATE NOCASE AND id<>?').get(name, self))
      fail(409, 'view_exists', 'A saved view with that name already exists.');
  }

  createView(input: unknown): SavedView {
    const data = createViewSchema.parse(input);
    return this.database.transaction(() => {
      if ((this.database.query('SELECT count(*) AS count FROM note_views').get() as { count: number }).count >= 100) fail(400, 'view_limit', 'The saved view limit is 100.');
      this.uniqueView(data.name);
      const id = crypto.randomUUID(), now = new Date().toISOString();
      this.database.query('INSERT INTO note_views(id, name, filters, created_at, updated_at) VALUES(?,?,?,?,?)').run(id, data.name, JSON.stringify(data.filters), now, now);
      return this.view(id);
    })();
  }

  updateView(id: string, input: unknown): SavedView {
    const data = updateViewSchema.parse(input);
    return this.database.transaction(() => {
      const current = this.view(id); this.checkRevision(current.revision, data.revision);
      const name = data.name ?? current.name, filters = data.filters ?? current.filters;
      this.uniqueView(name, current.id);
      this.database.query('UPDATE note_views SET name=?, filters=?, revision=revision+1, updated_at=? WHERE id=?')
        .run(name, JSON.stringify(filters), new Date().toISOString(), current.id);
      return this.view(current.id);
    })();
  }

  deleteView(id: string, expected: number) {
    this.database.transaction(() => {
      const current = this.view(id); this.checkRevision(current.revision, revision.parse(expected));
      this.database.query('DELETE FROM note_views WHERE id=?').run(current.id);
    })();
  }

  trash(id: string, expected: number): NoteDocument {
    return this.database.transaction(() => {
      this.active(id, revision.parse(expected));
      this.database.query('UPDATE note_documents SET deleted_at=?, revision=revision+1 WHERE id=?').run(new Date().toISOString(), id);
      return this.get(id);
    })();
  }

  restore(id: string, expected: number): NoteDocument {
    return this.database.transaction(() => {
      const current = this.get(id); this.checkRevision(current.revision, revision.parse(expected));
      if (!current.deletedAt) return current;
      if (Date.parse(current.deletedAt) <= Date.now() - 30 * 86400000) fail(410, 'trash_expired', 'The 30-day restore period has expired.');
      this.database.query('UPDATE note_documents SET deleted_at=NULL, revision=revision+1, updated_at=? WHERE id=?').run(new Date().toISOString(), id);
      return this.saveVersion(this.get(id));
    })();
  }

  purge(id: string, expected: number) {
    this.database.transaction(() => {
      const current = this.get(id); this.checkRevision(current.revision, revision.parse(expected));
      if (!current.deletedAt) fail(409, 'not_in_trash', 'Move the document to Trash before permanent deletion.');
      if (this.database.query("SELECT id FROM note_deliveries WHERE document_id=? AND state='pending' AND created_at>? LIMIT 1")
        .get(id, new Date(Date.now() - 60000).toISOString())) fail(409, 'delivery_pending', 'Wait for the current delivery before permanently deleting this note.');
      this.database.query('DELETE FROM note_documents WHERE id=?').run(id);
    })();
  }

  purgeExpired(now = Date.now()) {
    return this.database.query('DELETE FROM note_documents WHERE deleted_at IS NOT NULL AND deleted_at<=? RETURNING id')
      .all(new Date(now - 30 * 86400000).toISOString()).length;
  }

  versions(id: string, offset = 0): Omit<NoteVersion, 'content'>[] {
    this.get(id);
    return this.database.query(`SELECT id, revision, title, created_at AS createdAt FROM note_versions WHERE document_id=? ORDER BY revision DESC LIMIT 30 OFFSET ?`)
      .all(id, z.number().int().min(0).parse(offset)) as Omit<NoteVersion, 'content'>[];
  }

  version(id: string, versionId: string): NoteVersion {
    this.get(id);
    const row = this.database.query('SELECT id, revision, title, content, created_at AS createdAt FROM note_versions WHERE document_id=? AND id=?')
      .get(id, identifier.parse(versionId)) as NoteVersion | null;
    return row ?? fail(404, 'version_not_found', 'Version not found.');
  }

  transcript(recordingId: string, versionId?: string | null) {
    const data = snapshotSchema.parse({ recordingId, versionId });
    return this.database.transaction(() => {
      const recording = this.database.query(`SELECT id, original_filename AS filename, recorded_at AS recordedAt, source_provider AS sourceProvider
        FROM recordings WHERE id=? AND retention_state='active'`).get(data.recordingId) as {id: string; filename: string | null; recordedAt: string; sourceProvider: string | null} | null;
      if (!recording) fail(404, 'recording_not_found', 'Active recording not found.');
      const transcript = (data.versionId
        ? this.database.query('SELECT id AS versionId, full_text AS fullText, origin FROM transcript_versions WHERE recording_id=? AND id=?').get(data.recordingId, data.versionId)
        : this.database.query('SELECT current_version_id AS versionId, full_text AS fullText, origin FROM transcripts WHERE recording_id=?').get(data.recordingId)
      ) as {versionId: string | null; fullText: string; origin: string} | null;
      if (!transcript) fail(404, 'transcript_not_found', 'Saved transcript version not found.');
      return { recording: recording!, transcript: transcript! };
    })();
  }

  /**
   * Resolve the transcript version a document cites. A version that no longer
   * exists is reported as `unknown`; it is never replaced with the current text.
   */
  source(id: string): DocumentSource {
    const document = this.get(id);
    const base: DocumentSource = {
      documentId: document.id, status: 'none', stale: null, recordingId: document.sourceRecordingId, recordingFilename: null,
      recordingAvailable: false, versionId: document.sourceVersionId, versionOrigin: null, versionCreatedAt: null,
      currentVersionId: null, sourceOrigin: document.sourceOrigin,
    };
    if (!document.sourceRecordingId) return base;
    const row = this.database.query(`SELECT r.original_filename AS filename, r.retention_state AS retentionState, t.current_version_id AS currentVersionId,
        v.id AS versionId, v.origin AS versionOrigin, v.created_at AS versionCreatedAt
      FROM recordings r LEFT JOIN transcripts t ON t.recording_id=r.id
      LEFT JOIN transcript_versions v ON v.recording_id=r.id AND v.id=?
      WHERE r.id=?`).get(document.sourceVersionId, document.sourceRecordingId) as
      { filename: string | null; retentionState: string; currentVersionId: string | null; versionId: string | null; versionOrigin: string | null; versionCreatedAt: string | null } | null;
    if (!row) return { ...base, status: 'unknown' };
    const resolved = { ...base, recordingFilename: row.filename, recordingAvailable: row.retentionState === 'active', currentVersionId: row.currentVersionId };
    if (!document.sourceVersionId || !row.versionId) return { ...resolved, status: 'unknown' };
    const stale = row.versionId !== row.currentVersionId;
    return { ...resolved, status: stale ? 'stale' : 'current', stale, versionOrigin: row.versionOrigin, versionCreatedAt: row.versionCreatedAt };
  }

  /** Saved transcript versions for a recording, newest first, without their text. */
  transcriptVersions(recordingId: string): TranscriptVersionSummary[] {
    const id = identifier.parse(recordingId);
    if (!this.database.query('SELECT id FROM recordings WHERE id=?').get(id)) fail(404, 'recording_not_found', 'Recording not found.');
    return (this.database.query(`SELECT ${versionColumns} FROM transcript_versions v LEFT JOIN transcripts t ON t.recording_id=v.recording_id
      WHERE v.recording_id=? ORDER BY v.created_at DESC, v.rowid DESC LIMIT 200`).all(id) as TranscriptVersionSummary[]).map(normalizeVersion);
  }

  transcriptVersion(versionId: string): TranscriptVersionDetail;
  transcriptVersion(versionId: string, withText: false): TranscriptVersionSummary;
  transcriptVersion(versionId: string, withText = true): TranscriptVersionSummary {
    const row = this.database.query(`SELECT ${versionColumns}${withText ? ', v.full_text AS fullText' : ''} FROM transcript_versions v
      LEFT JOIN transcripts t ON t.recording_id=v.recording_id WHERE v.id=?`).get(identifier.parse(versionId)) as TranscriptVersionSummary | null;
    return row ? normalizeVersion(row) : fail(404, 'version_not_found', 'Transcript version not found.');
  }

  /** Active documents that cite this exact transcript version. Trash is excluded. */
  backlinks(versionId: string): TranscriptVersionBacklinks {
    const version = this.transcriptVersion(versionId, false);
    const documents = this.database.query(`SELECT ${fields} FROM note_documents d
      WHERE d.source_recording_id=? AND d.source_version_id=? AND d.deleted_at IS NULL ORDER BY d.updated_at DESC, d.id LIMIT 200`)
      .all(version.recordingId, version.id) as NoteSummary[];
    return { version, documents: documents.map(normalize) };
  }

  snapshot(input: unknown): NoteDocument {
    const data = snapshotSchema.parse(input);
    return this.database.transaction(() => {
      const { recording, transcript } = this.transcript(data.recordingId, data.versionId);
      const key = hash(`${recording.id}:${transcript.versionId ?? hash(transcript.fullText)}`);
      const existing = this.database.query('SELECT id FROM note_documents WHERE snapshot_key=?').get(key) as {id: string} | null;
      if (existing) return this.get(existing.id);
      const title = data.title ?? ((recording.filename || 'Transcript').replace(/\.[^.]+$/, '').replace(/[\x00-\x1f/\\]/g, '-').slice(0, 180) || 'Transcript');
      const content = [`# ${title}`, `- Recording ID: ${recording.id}\n- Recorded: ${recording.recordedAt}\n- Source: ${recording.sourceProvider || 'audio'}\n- Transcript origin: ${transcript.origin}\n- Transcript version: ${transcript.versionId || 'legacy snapshot'}`, '## Transcript', transcript.fullText].join('\n\n') + '\n';
      const document = this.create({ title, content, folderId: data.folderId, idempotencyKey: crypto.randomUUID() });
      this.database.query('UPDATE note_documents SET source_recording_id=?, source_version_id=?, source_origin=?, snapshot_key=? WHERE id=?')
        .run(recording.id, transcript.versionId, transcript.origin, key, document.id);
      return this.get(document.id);
    })();
  }
}
