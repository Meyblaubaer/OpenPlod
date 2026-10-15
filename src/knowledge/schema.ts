import type { Database } from 'bun:sqlite';

const hasTable = (database: Database, name: string) =>
  Boolean(database.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));

/**
 * Knowledge tables for 0.7.0 (KB-01 collections, KB-04 retrieval).
 *
 * Additive and re-runnable. Cached passages and embeddings are derived data: the
 * triggers below drop them the moment their source leaves the searchable vault
 * (Trash, purge, a new current transcript version, an edited or trashed note),
 * so retrieval can never return text the person has removed. Re-indexing
 * rebuilds what is still active.
 */
export function initializeKnowledge(database: Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS recording_collections (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS recording_collections_name ON recording_collections(name COLLATE NOCASE);
    CREATE TABLE IF NOT EXISTS recording_collection_items (
      collection_id TEXT NOT NULL REFERENCES recording_collections(id) ON DELETE CASCADE, recording_id TEXT NOT NULL, added_at TEXT NOT NULL,
      PRIMARY KEY(collection_id, recording_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS recording_collection_items_recording ON recording_collection_items(recording_id, collection_id);

    CREATE TABLE IF NOT EXISTS knowledge_passages (
      id TEXT PRIMARY KEY, source_type TEXT NOT NULL, source_key TEXT NOT NULL,
      recording_id TEXT, version_id TEXT, document_id TEXT, document_revision INTEGER,
      seq INTEGER NOT NULL, segment_start INTEGER, segment_end INTEGER, start_time REAL, end_time REAL,
      text TEXT NOT NULL, source_hash TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS knowledge_passages_source ON knowledge_passages(source_key, seq);
    CREATE INDEX IF NOT EXISTS knowledge_passages_recording ON knowledge_passages(recording_id);
    CREATE INDEX IF NOT EXISTS knowledge_passages_document ON knowledge_passages(document_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(passage_id UNINDEXED, text, tokenize='unicode61 remove_diacritics 2');
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts_vocab USING fts5vocab(knowledge_fts, 'row');
    CREATE TABLE IF NOT EXISTS knowledge_vectors (
      passage_id TEXT NOT NULL, model TEXT NOT NULL, dims INTEGER NOT NULL, vector BLOB NOT NULL,
      PRIMARY KEY(passage_id, model)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS knowledge_vectors_model ON knowledge_vectors(model);
    -- One row per indexed source and embedding model: what was embedded, from which exact text.
    CREATE TABLE IF NOT EXISTS knowledge_sources (
      source_key TEXT NOT NULL, model TEXT NOT NULL, source_hash TEXT NOT NULL, indexed_at TEXT NOT NULL,
      PRIMARY KEY(source_key, model)
    ) WITHOUT ROWID;

    CREATE TRIGGER IF NOT EXISTS knowledge_passages_insert AFTER INSERT ON knowledge_passages BEGIN
      INSERT INTO knowledge_fts(passage_id, text) VALUES(new.id, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS knowledge_passages_delete AFTER DELETE ON knowledge_passages BEGIN
      DELETE FROM knowledge_fts WHERE passage_id = old.id;
      DELETE FROM knowledge_vectors WHERE passage_id = old.id;
    END;

  `);
  const forget = (where: string) => `DELETE FROM knowledge_passages WHERE ${where}; DELETE FROM knowledge_sources WHERE source_key = `;
  if (hasTable(database, 'recordings')) database.exec(`
    CREATE TRIGGER IF NOT EXISTS knowledge_recording_retention AFTER UPDATE OF retention_state ON recordings WHEN new.retention_state <> 'active' BEGIN
      ${forget('recording_id = new.id')}'t:' || new.id;
    END;
    CREATE TRIGGER IF NOT EXISTS knowledge_recording_purge AFTER DELETE ON recordings BEGIN
      ${forget('recording_id = old.id')}'t:' || old.id;
      DELETE FROM recording_collection_items WHERE recording_id = old.id;
    END;
  `);
  if (hasTable(database, 'transcripts')) database.exec(`
    CREATE TRIGGER IF NOT EXISTS knowledge_transcript_version AFTER UPDATE OF current_version_id, full_text, segments ON transcripts BEGIN
      ${forget('recording_id = new.recording_id')}'t:' || new.recording_id;
    END;
    CREATE TRIGGER IF NOT EXISTS knowledge_transcript_delete AFTER DELETE ON transcripts BEGIN
      ${forget('recording_id = old.recording_id')}'t:' || old.recording_id;
    END;
  `);
  if (hasTable(database, 'note_documents')) database.exec(`
    CREATE TRIGGER IF NOT EXISTS knowledge_document_change AFTER UPDATE OF title, content, deleted_at ON note_documents
      WHEN old.title IS NOT new.title OR old.content IS NOT new.content OR old.deleted_at IS NOT new.deleted_at BEGIN
      ${forget('document_id = new.id')}'d:' || new.id;
    END;
    CREATE TRIGGER IF NOT EXISTS knowledge_document_purge AFTER DELETE ON note_documents BEGIN
      ${forget('document_id = old.id')}'d:' || old.id;
    END;
  `);
}
