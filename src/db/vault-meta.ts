import type { Database } from 'bun:sqlite';
import packageInfo from '../../package.json';

/**
 * REL-07 schema downgrade guard.
 *
 * `vault_meta.schema_generation` is raised whenever a release changes the vault in a
 * way older builds cannot safely read or write. A build refuses to open a vault whose
 * generation (or core `PRAGMA user_version`) is newer than it understands, instead of
 * running old migrations against a newer schema. Builds released before this guard
 * existed do not check it; see docs/upgrade-and-migration.md for rollback.
 */
export const VAULT_SCHEMA_GENERATION = 1;

export class VaultSchemaTooNewError extends Error {
  constructor(readonly found: { generation: number; userVersion: number }, readonly supported: { generation: number; userVersion: number }, readonly createdBy: string | null) {
    super(`This vault was last upgraded by a newer OpenPlod${createdBy ? ` (${createdBy})` : ''} `
      + `(vault schema ${found.generation}/${found.userVersion}; this build supports ${supported.generation}/${supported.userVersion}). `
      + 'It was not opened or modified. Install that version or newer, or restore a backup made with this version. See docs/upgrade-and-migration.md.');
  }
}

function ensureMeta(database: Database) {
  database.exec('CREATE TABLE IF NOT EXISTS vault_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
}

export function readVaultMeta(database: Database): Record<string, string> {
  if (!database.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='vault_meta'").get()) return {};
  return Object.fromEntries((database.query('SELECT key, value FROM vault_meta').all() as { key: string; value: string }[]).map(row => [row.key, row.value]));
}

/** Throws before any migration runs when the vault is newer than this build. Read-only. */
export function assertVaultSchemaCompatible(database: Database, supportedUserVersion: number, supportedGeneration = VAULT_SCHEMA_GENERATION) {
  const meta = readVaultMeta(database);
  const generation = Number(meta.schema_generation ?? 0);
  const userVersion = (database.query('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (generation > supportedGeneration || userVersion > supportedUserVersion) {
    throw new VaultSchemaTooNewError({ generation, userVersion }, { generation: supportedGeneration, userVersion: supportedUserVersion }, meta.last_app_version ?? null);
  }
}

/** Records the generation (never lowering it) and which app version last opened the vault. */
export function recordVaultSchema(database: Database, generation = VAULT_SCHEMA_GENERATION, appVersion = packageInfo.version) {
  ensureMeta(database);
  const upsert = database.query('INSERT INTO vault_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const current = Number(readVaultMeta(database).schema_generation ?? 0);
  database.transaction(() => {
    if (generation > current) upsert.run('schema_generation', String(generation));
    database.query("INSERT OR IGNORE INTO vault_meta(key, value) VALUES('first_guarded_app_version', ?)").run(appVersion);
    upsert.run('last_app_version', appVersion);
  })();
}
