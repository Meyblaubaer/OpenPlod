import type { Database } from 'bun:sqlite';
import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { migratePlaintextSecrets } from './secrets';
import { recoverInterruptedImports, setLastRecoveryReport } from '../library/import-journal';

/** The vault data directory (database, key file, backups) and the recordings library. */
export function vaultPaths() {
  const database = resolve(process.env.DATABASE_URL || './data/plaud.db');
  return { dataDirectory: dirname(database), database, library: resolve(process.env.OPENPLOD_LIBRARY_PATH || './data/recordings') };
}

/**
 * REL-06: the data directory and library are private to the vault owner (0700) and
 * the database files are 0600. Only tightens; never loosens permissions, and skips
 * Windows, where POSIX modes do not apply.
 */
export function hardenVaultPermissions(paths = vaultPaths()): string[] {
  if (process.platform === 'win32') return [];
  const changed: string[] = [];
  const tighten = (path: string, mode: number) => {
    if (!existsSync(path)) return;
    const info = statSync(path);
    if (info.uid !== process.getuid?.()) return;
    if ((info.mode & 0o777 & ~mode) !== 0) { chmodSync(path, info.mode & mode & 0o777); changed.push(path); }
  };
  for (const directory of [paths.dataDirectory, paths.library]) tighten(directory, 0o700);
  for (const file of [paths.database, `${paths.database}-wal`, `${paths.database}-shm`]) tighten(file, 0o600);
  return changed;
}

/** Startup work that must run after the schema is ready and before requests are served. */
export async function prepareVault(database: Database) {
  try {
    const changed = hardenVaultPermissions();
    if (changed.length) console.log(`[Vault] Restricted permissions on ${changed.length} path(s)`);
  } catch (error) { console.error('[Vault] Could not restrict data permissions:', error instanceof Error ? error.message : error); }
  try {
    const migrated = migratePlaintextSecrets(database);
    if (migrated) console.log(`[Vault] Encrypted ${migrated} stored API key(s) at rest`);
  } catch (error) { console.error('[Vault] Stored API keys could not be encrypted:', error instanceof Error ? error.message : error); }
  try {
    const report = await recoverInterruptedImports(database, vaultPaths().library);
    setLastRecoveryReport(report);
    if (report.completed.length || report.rolledBack.length) console.log(`[Vault] Import recovery: ${report.completed.length} completed, ${report.rolledBack.length} rolled back (files kept in incoming/recovered)`);
    if (report.orphanedFiles.length) console.warn(`[Vault] ${report.orphanedFiles.length} library file(s) have no recording; they were kept. See /api/vault/recovery.`);
  } catch (error) { console.error('[Vault] Import recovery failed:', error instanceof Error ? error.message : error); }
}

/**
 * Optional TLS for the Bun server: set OPENPLOD_TLS_CERT and OPENPLOD_TLS_KEY to PEM
 * file paths. Without them the server speaks plain HTTP, which is only appropriate on
 * loopback; plain-HTTP LAN pairing is not secure remote access.
 */
export function tlsOptions(): { tls?: { cert: string; key: string } } {
  const cert = process.env.OPENPLOD_TLS_CERT, key = process.env.OPENPLOD_TLS_KEY;
  if (!cert && !key) return {};
  if (!cert || !key) throw new Error('Set both OPENPLOD_TLS_CERT and OPENPLOD_TLS_KEY, or neither.');
  return { tls: { cert: readFileSync(cert, 'utf8'), key: readFileSync(key, 'utf8') } };
}
