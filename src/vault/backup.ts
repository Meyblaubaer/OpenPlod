import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import packageInfo from '../../package.json';
import { DEFAULT_CHUNK, DEFAULT_SCRYPT, EncryptingWriter, MAGIC, decryptingStream } from './backup-crypto';
import { readTar, tarEnd, tarHeader, tarPadding } from './tar';
import { SECRET_SETTING_KEYS } from './secrets';
import { ensureDiskSpace, fsyncDirectory } from '../library/durable-files';

/**
 * REL-05: full-vault backup and restore.
 *
 * Archive = POSIX tar (optionally wrapped in the OPBK encrypted container, see
 * backup-crypto.ts) with:
 *   database/openplod.db      consistent snapshot from `VACUUM INTO`
 *   library/<path>            every file under the recordings library (audio, originals/ sidecars)
 *   secrets/vault.key         encrypted archives only: the key that decrypts stored API keys
 *   device/plaud-device.json  encrypted archives only, when present: the Plaud authorization
 *   manifest.json             last entry: SHA-256 and size of every other entry
 *
 * Unencrypted archives never contain credentials: API keys are removed from the
 * snapshot and the key/identity files are left out. Restore always writes into a new
 * (or explicitly confirmed) directory and never deletes existing files.
 */

export const MANIFEST = 'manifest.json';
export const BACKUP_FORMAT = 'openplod-vault-backup';
export const MIN_PASSPHRASE_LENGTH = 12;

export type ManifestFile = { path: string; size: number; sha256: string };
export type BackupManifest = {
  format: typeof BACKUP_FORMAT; version: 1; createdAt: string; appVersion: string; encrypted: boolean;
  source: { databasePath: string; libraryPath: string };
  schema: { userVersion: number; vaultMeta: Record<string, string> };
  counts: { recordings: number; files: number; bytes: number };
  credentialsIncluded: boolean;
  skipped: string[];
  files: ManifestFile[];
};

export type BackupProgress = { files: number; bytes: number; totalBytes: number };
export type BackupPaths = { database: Database; databasePath: string; library: string; secretKeyPath?: string; deviceIdentityPath?: string };

const SAFE_PATH = /^[A-Za-z0-9._\-/]+$/;

function listFiles(root: string, skipped: string[]): { path: string; relative: string; size: number }[] {
  const result: { path: string; relative: string; size: number }[] = [];
  if (!existsSync(root)) return result;
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const rel = relative(root, path).split(sep).join('/');
      if (rel === '.staging' || rel.startsWith('.staging/')) continue;
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.isFile()) { skipped.push(`library/${rel} (not a regular file)`); continue; }
      if (!SAFE_PATH.test(rel) || Buffer.byteLength(`library/${rel}`) > 255) { skipped.push(`library/${rel} (unsupported file name)`); continue; }
      result.push({ path, relative: `library/${rel}`, size: statSync(path).size });
    }
  };
  walk(root);
  return result.sort((a, b) => a.relative.localeCompare(b.relative));
}

/** A consistent copy of the database; unencrypted copies have credentials removed. */
async function snapshotDatabase(database: Database, target: string, keepCredentials: boolean) {
  database.query('VACUUM INTO ?').run(target);
  if (keepCredentials) return;
  const copy = new Database(target);
  try {
    copy.query(`DELETE FROM user_settings WHERE key IN (${SECRET_SETTING_KEYS.map(() => '?').join(',')})`).run(...SECRET_SETTING_KEYS);
    copy.exec('VACUUM');
  } finally { copy.close(); }
}

export async function createBackup(paths: BackupPaths, options: {
  outputDirectory: string; passphrase?: string; onProgress?: (progress: BackupProgress) => void; scrypt?: typeof DEFAULT_SCRYPT; now?: Date;
}): Promise<{ path: string; sha256: string; bytes: number; manifest: BackupManifest }> {
  const encrypted = Boolean(options.passphrase);
  if (encrypted && options.passphrase!.length < MIN_PASSPHRASE_LENGTH) throw new Error(`Use a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  const outputDirectory = resolve(options.outputDirectory);
  const library = resolve(paths.library);
  if (outputDirectory === library || outputDirectory.startsWith(library + sep)) throw new Error('Save backups outside the recordings library.');
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const work = await mkdtemp(join(tmpdir(), 'openplod-backup-'));
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const name = `openplod-backup-${stamp}${encrypted ? '.tar.opbk' : '.tar'}`;
  const finalPath = join(outputDirectory, name), partial = `${finalPath}.partial`;
  const skipped: string[] = [];
  try {
    const snapshot = join(work, 'openplod.db');
    await snapshotDatabase(paths.database, snapshot, encrypted);
    const entries: { path: string; relative: string; size: number }[] = [{ path: snapshot, relative: 'database/openplod.db', size: statSync(snapshot).size }];
    // Listed after the snapshot, so every recording in the snapshot has its audio here.
    entries.push(...listFiles(library, skipped));
    if (encrypted && paths.secretKeyPath && existsSync(paths.secretKeyPath)) entries.push({ path: paths.secretKeyPath, relative: 'secrets/vault.key', size: statSync(paths.secretKeyPath).size });
    if (encrypted && paths.deviceIdentityPath && existsSync(paths.deviceIdentityPath)) entries.push({ path: paths.deviceIdentityPath, relative: 'device/plaud-device.json', size: statSync(paths.deviceIdentityPath).size });
    const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    await ensureDiskSpace(outputDirectory, totalBytes + entries.length * 1024);

    const snapshotDb = new Database(snapshot, { readonly: true });
    let recordingsCount = 0, userVersion = 0, vaultMeta: Record<string, string> = {};
    try {
      recordingsCount = (snapshotDb.query('SELECT count(*) AS n FROM recordings').get() as { n: number }).n;
      userVersion = (snapshotDb.query('PRAGMA user_version').get() as { user_version: number }).user_version;
      if (snapshotDb.query("SELECT 1 FROM sqlite_master WHERE name='vault_meta'").get()) vaultMeta = Object.fromEntries((snapshotDb.query('SELECT key,value FROM vault_meta').all() as { key: string; value: string }[]).map(row => [row.key, row.value]));
    } finally { snapshotDb.close(); }

    const handle = await open(partial, 'wx', 0o600);
    const archiveHash = createHash('sha256');
    let archiveBytes = 0;
    const emit = async (bytes: Buffer) => { archiveHash.update(bytes); archiveBytes += bytes.length; await handle.write(bytes); };
    const encryptor = encrypted ? new EncryptingWriter(options.passphrase!, emit, DEFAULT_CHUNK, options.scrypt ?? DEFAULT_SCRYPT) : null;
    const write = (bytes: Buffer) => encryptor ? encryptor.write(bytes) : emit(bytes);
    const files: ManifestFile[] = [];
    const progress: BackupProgress = { files: 0, bytes: 0, totalBytes };
    try {
      await encryptor?.start();
      for (const entry of entries) {
        const size = statSync(entry.path).size;
        await write(tarHeader(entry.relative, size));
        const hash = createHash('sha256');
        let written = 0;
        for await (const chunk of createReadStream(entry.path, { highWaterMark: 1 << 20, end: size ? size - 1 : 0, start: 0 })) {
          const piece = Buffer.from(chunk as Buffer).subarray(0, size - written);
          if (!piece.length) continue;
          hash.update(piece); written += piece.length; await write(piece);
        }
        if (written !== size) throw new Error(`${entry.relative} changed size during backup; retry.`);
        await write(tarPadding(size));
        files.push({ path: entry.relative, size, sha256: hash.digest('hex') });
        progress.files++; progress.bytes += size; options.onProgress?.({ ...progress });
      }
      const manifest: BackupManifest = {
        format: BACKUP_FORMAT, version: 1, createdAt: (options.now ?? new Date()).toISOString(), appVersion: packageInfo.version, encrypted,
        source: { databasePath: resolve(paths.databasePath), libraryPath: library },
        schema: { userVersion, vaultMeta }, counts: { recordings: recordingsCount, files: files.length, bytes: progress.bytes },
        credentialsIncluded: encrypted, skipped, files,
      };
      const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
      await write(tarHeader(MANIFEST, manifestBytes.length));
      await write(manifestBytes);
      await write(tarPadding(manifestBytes.length));
      await write(tarEnd());
      await encryptor?.finish();
      await handle.sync();
      await handle.close();
      await rename(partial, finalPath);
      const sha256 = archiveHash.digest('hex');
      const sums = await open(`${finalPath}.sha256`, 'w', 0o600);
      try { await sums.write(`${sha256}  ${name}\n`); await sums.sync(); } finally { await sums.close(); }
      await fsyncDirectory(outputDirectory);
      return { path: finalPath, sha256, bytes: archiveBytes, manifest };
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(partial).catch(() => undefined);
      throw error;
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function* fileChunks(path: string) {
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) yield chunk as Buffer;
}

async function archiveStream(path: string, passphrase?: string): Promise<{ stream: AsyncIterable<Uint8Array>; encrypted: boolean }> {
  const handle = await open(path, 'r');
  const first = Buffer.alloc(4);
  try { await handle.read(first, 0, 4, 0); } finally { await handle.close(); }
  const encrypted = first.equals(MAGIC);
  if (!encrypted) return { stream: fileChunks(path), encrypted };
  if (!passphrase) throw new Error('This backup is encrypted. Enter its passphrase.');
  return { stream: decryptingStream(fileChunks(path), passphrase), encrypted };
}

export type VerifyResult = { ok: true; manifest: BackupManifest; encrypted: boolean; databaseIntegrity: string };

/**
 * Reads the whole archive, checks every entry against the manifest (hash, size,
 * nothing missing or extra) and runs `PRAGMA integrity_check` on the database snapshot.
 * With `extractTo`, verified entries are also written below that directory.
 */
export async function verifyBackup(path: string, options: { passphrase?: string; extractTo?: string } = {}): Promise<VerifyResult> {
  const { stream, encrypted } = await archiveStream(resolve(path), options.passphrase);
  const seen = new Map<string, { size: number; sha256: string }>();
  let manifest: BackupManifest | null = null;
  const scratch = options.extractTo ? null : await mkdtemp(join(tmpdir(), 'openplod-verify-'));
  let databaseCopy: string | null = null;
  try {
    await readTar(stream, async (header, body) => {
      if (manifest) throw new Error('Archive has entries after its manifest');
      if (seen.has(header.name)) throw new Error(`Duplicate archive entry ${header.name}`);
      if (header.name === MANIFEST) {
        const parts: Buffer[] = [];
        await body(chunk => { parts.push(Buffer.from(chunk)); });
        manifest = JSON.parse(Buffer.concat(parts).toString('utf8')) as BackupManifest;
        return;
      }
      const hash = createHash('sha256');
      let target: string | null = null;
      if (options.extractTo) target = join(options.extractTo, header.name);
      else if (header.name === 'database/openplod.db') target = join(scratch!, 'openplod.db');
      if (target) {
        if (!resolve(target).startsWith(resolve(options.extractTo ?? scratch!) + sep)) throw new Error(`Unsafe path in archive: ${header.name}`);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        const output = await open(target, 'wx', 0o600);
        try { await body(async chunk => { hash.update(chunk); await output.write(chunk); }); await output.sync(); }
        finally { await output.close(); }
        if (header.name === 'database/openplod.db') databaseCopy = target;
      } else await body(chunk => { hash.update(chunk); });
      seen.set(header.name, { size: header.size, sha256: hash.digest('hex') });
    });
    const found = manifest as BackupManifest | null;
    if (!found || found.format !== BACKUP_FORMAT || found.version !== 1) throw new Error('Archive has no valid OpenPlod manifest');
    if (found.encrypted !== encrypted) throw new Error('Manifest encryption flag does not match the archive');
    for (const file of found.files) {
      const actual = seen.get(file.path);
      if (!actual) throw new Error(`Missing from archive: ${file.path}`);
      if (actual.size !== file.size || actual.sha256 !== file.sha256) throw new Error(`Checksum mismatch: ${file.path}`);
    }
    if (seen.size !== found.files.length) throw new Error('Archive contains files not listed in its manifest');
    if (!databaseCopy) throw new Error('Archive has no database snapshot');
    const database = new Database(databaseCopy, { readonly: true });
    let integrity: string;
    try { integrity = (database.query('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check; }
    finally { database.close(); }
    if (integrity !== 'ok') throw new Error(`Database snapshot failed its integrity check: ${integrity}`);
    return { ok: true, manifest: found, encrypted, databaseIntegrity: integrity };
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}

export class RestoreTargetNotEmpty extends Error {}

/**
 * Restores into `targetDirectory` with the desktop layout: openplod.db, recordings/,
 * vault.key (encrypted archives) and plaud-device.json (when it was backed up).
 * Refuses a non-empty target unless `confirmOverwrite`; even then existing entries are
 * moved to `.pre-restore-<time>/`, never deleted. Refuses the running vault.
 */
export async function restoreBackup(path: string, options: {
  targetDirectory: string; passphrase?: string; confirmOverwrite?: boolean; liveDirectories?: string[];
}) {
  const target = resolve(options.targetDirectory);
  if (!isAbsolute(options.targetDirectory)) throw new Error('Choose an absolute restore folder.');
  for (const live of options.liveDirectories ?? []) {
    const directory = resolve(live);
    if (target === directory || directory.startsWith(target + sep) || target.startsWith(directory + sep)) {
      throw new Error('Restore into a new folder, not the vault that is currently running.');
    }
  }
  await mkdir(target, { recursive: true, mode: 0o700 });
  const existing = (await readdir(target)).filter(name => !name.startsWith('.restore-'));
  if (existing.length && !options.confirmOverwrite) throw new RestoreTargetNotEmpty('The restore folder is not empty. Choose an empty folder, or confirm to move its current contents aside.');
  const archiveSize = (await stat(path)).size;
  await ensureDiskSpace(target, archiveSize);
  const staging = join(target, `.restore-${Date.now()}`);
  await mkdir(staging, { mode: 0o700 });
  let result: VerifyResult;
  try { result = await verifyBackup(path, { passphrase: options.passphrase, extractTo: staging }); }
  catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }

  let movedAside: string | null = null;
  if (existing.length) {
    movedAside = join(target, `.pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    await mkdir(movedAside, { mode: 0o700 });
    for (const name of existing) await rename(join(target, name), join(movedAside, name));
  }
  const library = join(target, 'recordings');
  const placed: Record<string, string> = { 'database/openplod.db': join(target, 'openplod.db'), library, 'secrets/vault.key': join(target, 'vault.key'), 'device/plaud-device.json': join(target, 'plaud-device.json') };
  await rename(join(staging, 'database', 'openplod.db'), placed['database/openplod.db']!);
  if (existsSync(join(staging, 'library'))) await rename(join(staging, 'library'), library);
  else await mkdir(library, { mode: 0o700 });
  for (const key of ['secrets/vault.key', 'device/plaud-device.json']) if (existsSync(join(staging, key))) await rename(join(staging, key), placed[key]!);
  await rm(staging, { recursive: true, force: true });

  // Recording rows hold absolute paths; point them at the restored library.
  const database = new Database(placed['database/openplod.db']!);
  let repointed = 0;
  try {
    const previous = result.manifest.source.libraryPath.replace(/[\\/]+$/, '');
    repointed = database.query(`UPDATE recordings SET file_path = ?1 || substr(file_path, length(?2) + 1)
      WHERE substr(file_path, 1, length(?2) + 1) IN (?2 || '/', ?2 || '\\')`).run(library, previous).changes;
    if (database.query("SELECT 1 FROM sqlite_master WHERE name='import_journal'").get()) database.exec('DELETE FROM import_journal');
  } finally { database.close(); }
  await fsyncDirectory(target);
  return { targetDirectory: target, databasePath: placed['database/openplod.db']!, libraryPath: library, movedAside,
    repointedRecordings: repointed, manifest: result.manifest, credentialsRestored: existsSync(placed['secrets/vault.key']!) };
}

