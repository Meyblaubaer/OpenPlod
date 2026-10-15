import { constants, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { chmod, copyFile, open, statfs, writeFile } from 'node:fs/promises';

/** Bytes kept free beyond an import's own size so SQLite and the OS can still write. */
export const DISK_SPACE_MARGIN_BYTES = 64 * 1024 * 1024;

export class InsufficientDiskSpaceError extends Error {
  constructor(readonly requiredBytes: number, readonly availableBytes: number, readonly directory: string) {
    super(`Not enough free disk space for this import: ${formatBytes(requiredBytes)} needed, ${formatBytes(availableBytes)} available in ${directory}. Free space and retry; nothing was imported and no source audio was removed.`);
  }
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** Free bytes for an unprivileged writer, or null when the platform cannot report it. */
export async function availableBytes(directory: string): Promise<number | null> {
  try { const info = await statfs(directory); return Number(info.bavail) * Number(info.bsize); }
  catch { return null; }
}

/** Throws InsufficientDiskSpaceError unless `bytes` plus the safety margin fit. Unknown free space is not an error. */
export async function ensureDiskSpace(directory: string, bytes: number, margin = DISK_SPACE_MARGIN_BYTES) {
  const available = await availableBytes(directory);
  if (available !== null && available < bytes + margin) throw new InsufficientDiskSpaceError(bytes + margin, available, directory);
}

export async function fsyncFile(path: string) {
  const handle = await open(path, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Persists a rename/creation in `directory`. Windows cannot open directories; there it is a no-op. */
export async function fsyncDirectory(directory: string) {
  if (process.platform === 'win32') return;
  let handle;
  try { handle = await open(directory, constants.O_RDONLY); await handle.sync(); }
  catch { /* Some filesystems reject directory fsync; the rename itself is still atomic. */ }
  finally { await handle?.close(); }
}

export async function durableCopy(source: string, destination: string) {
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  await chmod(destination, 0o600);
  await fsyncFile(destination);
}

export async function durableWrite(destination: string, data: string | Uint8Array) {
  await writeFile(destination, data, { mode: 0o600, flag: 'wx' });
  await fsyncFile(destination);
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    createReadStream(path).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolveHash(hash.digest('hex')));
  });
}
