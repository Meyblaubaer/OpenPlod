import { Database } from 'bun:sqlite';
import { initializeOrganizer } from '../organizer/store';
import { initializeKnowledge } from './schema';

/**
 * Test vault with the recording, transcript, and settings columns the knowledge
 * features read, plus the organizer and knowledge schemas and their triggers.
 */
export function knowledgeVault() {
  const database = new Database(':memory:');
  database.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE recordings (id TEXT PRIMARY KEY, file_path TEXT NOT NULL DEFAULT '', original_filename TEXT, recorded_at TEXT, uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
      source_provider TEXT, retention_state TEXT NOT NULL DEFAULT 'active', fingerprint TEXT, revision INTEGER NOT NULL DEFAULT 1, tags TEXT,
      status TEXT NOT NULL DEFAULT 'complete', error_message TEXT, processed_at TEXT, duration_seconds INTEGER);
    CREATE TABLE transcripts (id TEXT PRIMARY KEY, recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE, full_text TEXT NOT NULL, segments TEXT,
      origin TEXT NOT NULL DEFAULT 'generated', current_version_id TEXT, summary TEXT, analyzed_at TEXT);
    CREATE TABLE transcript_versions (id TEXT PRIMARY KEY, recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE, full_text TEXT NOT NULL, segments TEXT,
      origin TEXT NOT NULL, provenance TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE user_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));`);
  initializeOrganizer(database);
  initializeKnowledge(database);
  return database;
}

type Segment = { start: number; end: number; text: string };
/** Insert an active recording whose current transcript is one new version. */
export function addRecording(database: Database, input: { title?: string; text?: string; segments?: Segment[]; recordedAt?: string; tags?: string[]; filePath?: string; fingerprint?: string | null } = {}) {
  const id = crypto.randomUUID(), versionId = crypto.randomUUID();
  const segments = input.segments ?? null;
  const text = input.text ?? segments?.map(segment => segment.text).join(' ') ?? 'Empty.';
  database.query('INSERT INTO recordings(id, file_path, original_filename, recorded_at, tags, fingerprint) VALUES(?,?,?,?,?,?)')
    .run(id, input.filePath ?? `/vault/${id}.m4a`, `${input.title ?? 'Recording'}.m4a`, input.recordedAt ?? new Date().toISOString(), JSON.stringify(input.tags ?? []), input.fingerprint ?? null);
  database.query("INSERT INTO transcript_versions(id, recording_id, full_text, segments, origin) VALUES(?,?,?,?,'generated')").run(versionId, id, text, segments ? JSON.stringify(segments) : null);
  database.query("INSERT INTO transcripts(id, recording_id, full_text, segments, origin, current_version_id) VALUES(?,?,?,?,'generated',?)").run(crypto.randomUUID(), id, text, segments ? JSON.stringify(segments) : null, versionId);
  return { id, versionId };
}

/** Save an edited version and make it current, as `updateTranscript` does. */
export function editTranscript(database: Database, recordingId: string, text: string) {
  const versionId = crypto.randomUUID();
  database.query("INSERT INTO transcript_versions(id, recording_id, full_text, origin) VALUES(?,?,?,'edited')").run(versionId, recordingId, text);
  database.query("UPDATE transcripts SET full_text=?, segments=NULL, origin='edited', current_version_id=? WHERE recording_id=?").run(text, versionId, recordingId);
  return versionId;
}
