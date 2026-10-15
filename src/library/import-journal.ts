import type { Database } from 'bun:sqlite';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fsyncDirectory, sha256File } from './durable-files';

/**
 * REL-03: import journal and startup recovery.
 *
 * An import writes everything to `<library>/.staging/<id>/` first (audio plus any
 * originals/sidecars, each fsynced), then renames the staged files into place, and
 * only then inserts the recording row. The journal row brackets the operation:
 *
 *   staging  -> files staged, nothing visible in the library yet
 *   placed   -> files renamed into their final paths, database row not yet written
 *   (deleted in the same transaction that inserts the recording row)
 *
 * After a crash, `recoverInterruptedImports` completes an import whose final audio
 * exists with the journalled fingerprint, and otherwise rolls it back by moving
 * any staged or placed files to `incoming/recovered/<id>/`. Audio is never deleted
 * by recovery; orphaned files are only reported.
 */

export type JournalRecord = {
  id: string; state: 'staging' | 'placed'; stagingDirectory: string; destination: string;
  originalsDirectory: string | null; fingerprint: string; row: string; createdAt: string;
};

export function ensureImportJournal(database: Database) {
  database.exec(`CREATE TABLE IF NOT EXISTS import_journal (
    id TEXT PRIMARY KEY, state TEXT NOT NULL, staging_directory TEXT NOT NULL, destination TEXT NOT NULL,
    originals_directory TEXT, fingerprint TEXT NOT NULL, row TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
}

export function beginImport(database: Database, record: Omit<JournalRecord, 'state' | 'createdAt'>) {
  ensureImportJournal(database);
  const now = new Date().toISOString();
  database.query(`INSERT INTO import_journal(id,state,staging_directory,destination,originals_directory,fingerprint,row,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(record.id, 'staging', record.stagingDirectory, record.destination, record.originalsDirectory, record.fingerprint, record.row, now, now);
}

export function markImportPlaced(database: Database, id: string) {
  database.query("UPDATE import_journal SET state='placed', updated_at=? WHERE id=?").run(new Date().toISOString(), id);
}

export function finishImport(database: Database, id: string) {
  database.query('DELETE FROM import_journal WHERE id=?').run(id);
}

export function pendingImports(database: Database): JournalRecord[] {
  ensureImportJournal(database);
  return database.query(`SELECT id,state,staging_directory AS stagingDirectory,destination,originals_directory AS originalsDirectory,
    fingerprint,row,created_at AS createdAt FROM import_journal ORDER BY created_at`).all() as JournalRecord[];
}

export type RecoveryReport = {
  checkedAt: string;
  completed: string[];
  rolledBack: { id: string; retainedAt: string | null }[];
  orphanedFiles: string[];
  errors: string[];
};

/** The recordings INSERT used by both the normal import path and recovery. */
export function insertRecordingRow(database: Database, row: Record<string, unknown>) {
  const columns = Object.keys(row);
  if (!columns.every(column => /^[a-z_]+$/.test(column))) throw new Error('Invalid journalled recording row');
  database.query(`INSERT INTO recordings(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
    .run(...columns.map(column => row[column] as string | number | null));
}

async function moveAside(paths: string[], target: string) {
  const present = paths.filter(path => existsSync(path));
  if (!present.length) return null;
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const path of present) {
    let destination = join(target, basename(path));
    if (existsSync(destination)) destination = `${destination}.${Date.now()}`;
    await rename(path, destination);
  }
  await fsyncDirectory(target);
  return target;
}

export async function recoverInterruptedImports(database: Database, libraryDirectory: string): Promise<RecoveryReport> {
  const library = resolve(libraryDirectory);
  const recovered = join(dirname(library), 'incoming', 'recovered');
  const report: RecoveryReport = { checkedAt: new Date().toISOString(), completed: [], rolledBack: [], orphanedFiles: [], errors: [] };
  for (const entry of pendingImports(database)) {
    try {
      const exists = database.query('SELECT 1 FROM recordings WHERE id=?').get(entry.id);
      const placed = existsSync(entry.destination) && await sha256File(entry.destination) === entry.fingerprint;
      if (exists || placed) {
        if (!exists) database.transaction(() => { insertRecordingRow(database, JSON.parse(entry.row)); finishImport(database, entry.id); })();
        else finishImport(database, entry.id);
        // Only staged copies remain in the staging directory once the final files are in place.
        await rm(entry.stagingDirectory, { recursive: true, force: true });
        report.completed.push(entry.id);
      } else {
        const paths = [entry.stagingDirectory, entry.destination, ...(entry.originalsDirectory ? [entry.originalsDirectory] : [])];
        const retainedAt = await moveAside(paths, join(recovered, entry.id));
        finishImport(database, entry.id);
        report.rolledBack.push({ id: entry.id, retainedAt });
      }
    } catch (error) {
      report.errors.push(`${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  report.orphanedFiles = findOrphanedFiles(database, library);
  return report;
}

const recordingFileName = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[a-z0-9]+$/i;
/** Library audio, originals and staging leftovers with no recording row. Reported only; never deleted. */
export function findOrphanedFiles(database: Database, libraryDirectory: string): string[] {
  const library = resolve(libraryDirectory);
  if (!existsSync(library)) return [];
  const known = new Set((database.query('SELECT id FROM recordings').all() as { id: string }[]).map(row => row.id));
  const journalled = new Set(pendingImports(database).map(row => row.id));
  const orphaned: string[] = [];
  for (const name of readdirSync(library)) {
    const match = recordingFileName.exec(name);
    if (match && !known.has(match[1]!) && !journalled.has(match[1]!)) orphaned.push(join(library, name));
  }
  for (const folder of ['originals', '.staging']) {
    const directory = join(library, folder);
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory)) if (!known.has(name) && !journalled.has(name)) orphaned.push(join(directory, name));
  }
  return orphaned;
}

let lastReport: RecoveryReport | null = null;
export function lastRecoveryReport() { return lastReport; }
export function setLastRecoveryReport(report: RecoveryReport) { lastReport = report; }
