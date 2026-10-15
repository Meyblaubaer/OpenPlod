/**
 * Minimal POSIX ustar writer/reader for vault backups (regular files only).
 * Names longer than 100 bytes use the ustar prefix field (up to 255 bytes total).
 */

export const BLOCK = 512;

function octal(value: number, length: number) {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

function splitName(name: string): { prefix: string; base: string } {
  if (Buffer.byteLength(name) <= 100) return { prefix: '', base: name };
  for (let index = name.lastIndexOf('/'); index > 0; index = name.lastIndexOf('/', index - 1)) {
    const prefix = name.slice(0, index), base = name.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(base) <= 100 && base) return { prefix, base };
  }
  throw new Error(`Backup path is too long for the archive format: ${name}`);
}

export function tarHeader(name: string, size: number, mtime = Math.floor(Date.now() / 1000), mode = 0o600): Buffer {
  if (!/^[A-Za-z0-9._\-/]+$/.test(name) || name.startsWith('/') || name.split('/').some(part => part === '..' || part === '')) {
    throw new Error(`Unsafe backup path: ${name}`);
  }
  const { prefix, base } = splitName(name);
  const header = Buffer.alloc(BLOCK);
  header.write(base, 0, 100);
  header.write(octal(mode, 8), 100);
  header.write(octal(0, 8), 108);
  header.write(octal(0, 8), 116);
  header.write(octal(size, 12), 124);
  header.write(octal(mtime, 12), 136);
  header.fill(' ', 148, 156);
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  header.write(prefix, 345, 155);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(octal(sum, 7) + ' ', 148);
  return header;
}

export function tarPadding(size: number) {
  const remainder = size % BLOCK;
  return remainder ? Buffer.alloc(BLOCK - remainder) : Buffer.alloc(0);
}

export const tarEnd = () => Buffer.alloc(BLOCK * 2);

export type TarEntryHeader = { name: string; size: number; type: string };

export function parseTarHeader(block: Buffer): TarEntryHeader | null {
  if (block.every(byte => byte === 0)) return null;
  const text = (start: number, length: number) => block.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
  let sum = 0;
  for (let index = 0; index < BLOCK; index++) sum += index >= 148 && index < 156 ? 32 : block[index]!;
  if (parseInt(text(148, 8).trim(), 8) !== sum) throw new Error('Archive header checksum mismatch');
  if (text(257, 6) !== 'ustar') throw new Error('Not a ustar archive');
  const prefix = text(345, 155), base = text(0, 100);
  const name = prefix ? `${prefix}/${base}` : base;
  if (!name || name.startsWith('/') || name.split('/').some(part => part === '..')) throw new Error(`Unsafe path in archive: ${name}`);
  const size = parseInt(text(124, 12).trim() || '0', 8);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid archive entry size');
  return { name, size, type: text(156, 1) || '0' };
}

/** Pulls exact byte counts out of an async stream of chunks. */
export class ByteReader {
  private buffer = Buffer.alloc(0);
  private iterator: AsyncIterator<Uint8Array>;
  private done = false;
  constructor(source: AsyncIterable<Uint8Array>) { this.iterator = source[Symbol.asyncIterator](); }
  private async fill(length: number) {
    const parts = [this.buffer];
    let total = this.buffer.length;
    while (total < length && !this.done) {
      const next = await this.iterator.next();
      if (next.done) { this.done = true; break; }
      const chunk = Buffer.from(next.value);
      parts.push(chunk); total += chunk.length;
    }
    this.buffer = parts.length === 1 ? this.buffer : Buffer.concat(parts);
  }
  /** Exactly `length` bytes, or fewer only at end of stream. */
  async read(length: number): Promise<Buffer> {
    if (this.buffer.length < length) await this.fill(length);
    const result = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(result.length);
    return result;
  }
  async readExact(length: number, what = 'data'): Promise<Buffer> {
    const result = await this.read(length);
    if (result.length !== length) throw new Error(`Archive is truncated (${what})`);
    return result;
  }
  /** Streams `length` bytes to `sink` in pieces without buffering the whole entry. */
  async pipe(length: number, sink: (chunk: Buffer) => void | Promise<void>, piece = 1 << 20) {
    let remaining = length;
    while (remaining > 0) {
      if (!this.buffer.length) await this.fill(1);
      if (!this.buffer.length) throw new Error('Archive is truncated (entry body)');
      const chunk = this.buffer.subarray(0, Math.min(remaining, piece, this.buffer.length));
      this.buffer = this.buffer.subarray(chunk.length);
      remaining -= chunk.length;
      await sink(chunk);
    }
  }
  async atEnd() { if (!this.buffer.length) await this.fill(1); return !this.buffer.length; }
}

/** Iterates regular-file entries; `onEntry` must consume exactly `size` bytes via `body`. */
export async function readTar(source: AsyncIterable<Uint8Array>,
  onEntry: (header: TarEntryHeader, body: (sink: (chunk: Buffer) => void | Promise<void>) => Promise<void>) => Promise<void>) {
  const reader = new ByteReader(source);
  while (true) {
    const block = await reader.readExact(BLOCK, 'header');
    const header = parseTarHeader(block);
    if (!header) return;
    if (header.type !== '0') throw new Error(`Unsupported archive entry type for ${header.name}`);
    let consumed = false;
    await onEntry(header, async sink => { consumed = true; await reader.pipe(header.size, sink); });
    if (!consumed) await reader.pipe(header.size, () => undefined);
    const padding = tarPadding(header.size).length;
    if (padding) await reader.readExact(padding, 'padding');
  }
}
