import type { Database } from 'bun:sqlite';

/**
 * Additive, idempotent schema for paired clients (MOB-06), resumable uploads (MOB-02) and the
 * synchronization change feed (MOB-04). Every statement uses IF NOT EXISTS so it can run on every
 * start and on databases that predate it. Nothing here alters or drops an existing table.
 */
const initialized = new WeakSet<Database>();

export function initializeMobileSync(sqlite: Database): void {
  if (initialized.has(sqlite)) return;
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS mobile_clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'unknown',
      token_hash TEXT NOT NULL,
      permissions TEXT NOT NULL DEFAULT '["read","write","upload","sync"]',
      legacy INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      pairing_expires_at TEXT,
      last_seen_at TEXT,
      last_successful_sync_at TEXT,
      revoked_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mobile_clients_token_hash ON mobile_clients(token_hash);

    CREATE TABLE IF NOT EXISTS mobile_uploads (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      size INTEGER NOT NULL,
      filename TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      received_bytes INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'open',
      recording_id TEXT,
      added INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mobile_uploads_client_fingerprint ON mobile_uploads(client_id, fingerprint);
    CREATE INDEX IF NOT EXISTS idx_mobile_uploads_state_updated ON mobile_uploads(state, updated_at);

    CREATE TABLE IF NOT EXISTS sync_changes (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      entity TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      revision INTEGER,
      at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sync_changes_entity ON sync_changes(entity_id, seq);

    CREATE TABLE IF NOT EXISTS recording_tombstones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seq INTEGER NOT NULL,
      recording_id TEXT NOT NULL,
      event TEXT NOT NULL,
      revision INTEGER,
      fingerprint TEXT,
      source_provider TEXT,
      source_recording_id TEXT,
      at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_recording_tombstones_seq ON recording_tombstones(seq);
    CREATE INDEX IF NOT EXISTS idx_recording_tombstones_recording ON recording_tombstones(recording_id);

    CREATE TABLE IF NOT EXISTS sync_applied_changes (
      client_id TEXT NOT NULL,
      change_id TEXT NOT NULL,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (client_id, change_id)
    );

  `);
  // The feed triggers need the library tables; a store opened on a bare database (tests, tools)
  // still gets the client and transfer tables, and the triggers are added once the library exists.
  const library = sqlite.query("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('recordings', 'transcripts')").get() as { count: number };
  if (library.count < 2) return;
  sqlite.exec(`
    CREATE TRIGGER IF NOT EXISTS sync_recordings_insert AFTER INSERT ON recordings BEGIN
      INSERT INTO sync_changes(entity, entity_id, kind, revision) VALUES ('recording', new.id, 'upsert', new.revision);
    END;
    CREATE TRIGGER IF NOT EXISTS sync_recordings_update AFTER UPDATE ON recordings
    WHEN old.revision IS NOT new.revision OR old.retention_state IS NOT new.retention_state
      OR old.status IS NOT new.status OR old.original_filename IS NOT new.original_filename
      OR old.context IS NOT new.context OR old.notes IS NOT new.notes OR old.tags IS NOT new.tags
      OR old.recording_type IS NOT new.recording_type OR old.recorded_at IS NOT new.recorded_at
      OR old.fingerprint IS NOT new.fingerprint OR old.duration_seconds IS NOT new.duration_seconds
    BEGIN
      INSERT INTO sync_changes(entity, entity_id, kind, revision) VALUES ('recording', new.id,
        CASE WHEN old.retention_state IS NOT new.retention_state AND new.retention_state = 'trash' THEN 'trash'
             WHEN old.retention_state IS NOT new.retention_state AND old.retention_state = 'trash' THEN 'restore'
             ELSE 'upsert' END, new.revision);
      INSERT INTO recording_tombstones(seq, recording_id, event, revision, fingerprint, source_provider, source_recording_id)
        SELECT last_insert_rowid(), new.id,
          CASE WHEN new.retention_state = 'trash' THEN 'trash' ELSE 'restore' END,
          new.revision, new.fingerprint, new.source_provider, new.source_recording_id
        WHERE old.retention_state IS NOT new.retention_state
          AND (new.retention_state = 'trash' OR old.retention_state = 'trash');
    END;
    CREATE TRIGGER IF NOT EXISTS sync_recordings_delete AFTER DELETE ON recordings BEGIN
      INSERT INTO sync_changes(entity, entity_id, kind, revision) VALUES ('recording', old.id, 'purge', old.revision);
      INSERT INTO recording_tombstones(seq, recording_id, event, revision, fingerprint, source_provider, source_recording_id)
        VALUES (last_insert_rowid(), old.id, 'purge', old.revision, old.fingerprint, old.source_provider, old.source_recording_id);
    END;
    CREATE TRIGGER IF NOT EXISTS sync_transcripts_insert AFTER INSERT ON transcripts BEGIN
      INSERT INTO sync_changes(entity, entity_id, kind, revision)
        VALUES ('recording', new.recording_id, 'transcript', (SELECT revision FROM recordings WHERE id = new.recording_id));
    END;
    CREATE TRIGGER IF NOT EXISTS sync_transcripts_head AFTER UPDATE OF current_version_id, origin ON transcripts
    WHEN old.current_version_id IS NOT new.current_version_id OR old.origin IS NOT new.origin BEGIN
      INSERT INTO sync_changes(entity, entity_id, kind, revision)
        VALUES ('recording', new.recording_id, 'transcript', (SELECT revision FROM recordings WHERE id = new.recording_id));
    END;
  `);
  // Recordings that existed before the feed was introduced get one baseline change each, so a
  // client starting from cursor 0 sees the whole library. Runs only while the feed is empty.
  sqlite.exec(`
    INSERT INTO sync_changes(entity, entity_id, kind, revision)
    SELECT 'recording', id, 'upsert', revision FROM recordings
    WHERE NOT EXISTS (SELECT 1 FROM sync_changes)
    ORDER BY rowid
  `);
  initialized.add(sqlite);
}
