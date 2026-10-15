import { afterAll, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginImport, findOrphanedFiles, markImportPlaced, pendingImports, recoverInterruptedImports } from './import-journal';
import { ensureDiskSpace, InsufficientDiskSpaceError } from './durable-files';

const root = mkdtempSync(join(tmpdir(), 'openplod-journal-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

function vault(name: string) {
  const library = join(root, name, 'recordings');
  mkdirSync(library, { recursive: true });
  const database = new Database(':memory:');
  database.exec("CREATE TABLE recordings (id TEXT PRIMARY KEY, file_path TEXT NOT NULL, fingerprint TEXT, retention_state TEXT NOT NULL DEFAULT 'active')");
  return { library, database };
}

test('recovery completes an import whose audio was placed before the crash', async () => {
  const { library, database } = vault('placed');
  const id = 'aaaaaaaa-1111-4111-8111-111111111111', destination = join(library, `${id}.m4a`);
  writeFileSync(destination, 'placed audio');
  beginImport(database, { id, stagingDirectory: join(library, '.staging', id), destination, originalsDirectory: null,
    fingerprint: sha('placed audio'), row: JSON.stringify({ id, file_path: destination, fingerprint: sha('placed audio') }) });
  markImportPlaced(database, id);
  const report = await recoverInterruptedImports(database, library);
  expect(report.completed).toEqual([id]);
  expect(database.query('SELECT file_path AS path FROM recordings WHERE id=?').get(id)).toEqual({ path: destination });
  expect(pendingImports(database)).toEqual([]);
  expect(report.orphanedFiles).toEqual([]);
});

test('recovery rolls back a staged import by moving its files aside, never deleting audio', async () => {
  const { library, database } = vault('staged');
  const id = 'bbbbbbbb-1111-4111-8111-111111111111', staging = join(library, '.staging', id);
  mkdirSync(join(staging, 'originals'), { recursive: true });
  writeFileSync(join(staging, 'audio.m4a'), 'half');
  writeFileSync(join(staging, 'originals', 'device-original.plaud'), 'device');
  beginImport(database, { id, stagingDirectory: staging, destination: join(library, `${id}.m4a`), originalsDirectory: join(library, 'originals', id),
    fingerprint: sha('complete audio'), row: JSON.stringify({ id, file_path: 'x' }) });
  const report = await recoverInterruptedImports(database, library);
  expect(report.rolledBack).toHaveLength(1);
  const retained = report.rolledBack[0]!.retainedAt!;
  expect(readFileSync(join(retained, id, 'audio.m4a'), 'utf8')).toBe('half');
  expect(readFileSync(join(retained, id, 'originals', 'device-original.plaud'), 'utf8')).toBe('device');
  expect(existsSync(staging)).toBe(false);
  expect(database.query('SELECT count(*) AS n FROM recordings').get()).toEqual({ n: 0 });
});

test('orphaned library files are reported but kept', () => {
  const { library, database } = vault('orphans');
  const orphan = join(library, 'cccccccc-1111-4111-8111-111111111111.m4a');
  writeFileSync(orphan, 'x'); writeFileSync(join(library, 'notes.txt'), 'ignored');
  mkdirSync(join(library, 'originals', 'dddddddd-1111-4111-8111-111111111111'), { recursive: true });
  expect(findOrphanedFiles(database, library).sort()).toEqual([orphan, join(library, 'originals', 'dddddddd-1111-4111-8111-111111111111')].sort());
  expect(existsSync(orphan)).toBe(true);
});

test('disk-space precheck fails clearly when the import cannot fit', async () => {
  await expect(ensureDiskSpace(root, Number.MAX_SAFE_INTEGER / 2)).rejects.toBeInstanceOf(InsufficientDiskSpaceError);
  await expect(ensureDiskSpace(root, Number.MAX_SAFE_INTEGER / 2)).rejects.toThrow('Not enough free disk space');
  await ensureDiskSpace(root, 1);
});
