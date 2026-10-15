import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { ByteReader } from './tar';

/**
 * Encrypted backup container (format "OPBK" v1). Documented in docs/backup-and-restore.md.
 *
 *   magic   "OPBK" (4 bytes) | version 0x01 (1 byte) | header length (u16 BE) | header JSON
 *   records (repeated):  ciphertext length (u32 BE) | final flag (1 byte) | ciphertext | GCM tag (16 bytes)
 *
 * Header JSON: { kdf: "scrypt", N, r, p, salt (base64, 16 bytes), cipher: "aes-256-gcm",
 * chunkSize, noncePrefix (base64, 8 bytes) }.
 * Key = scrypt(passphrase, salt, 32, {N, r, p}). Record i (from 0) uses nonce
 * noncePrefix || u32 BE i and additional data = header bytes (magic through JSON) ||
 * u32 BE i || final flag. The plaintext stream is the tar archive. Exactly one record,
 * the last, has final = 1; a missing final record means truncation. Reordered,
 * dropped or altered records fail authentication.
 */
export const MAGIC = Buffer.from('OPBK');
export const DEFAULT_CHUNK = 1 << 20;
export const DEFAULT_SCRYPT = { N: 1 << 17, r: 8, p: 1 };

export class BackupPassphraseError extends Error {}

function deriveKey(passphrase: string, salt: Buffer, params: { N: number; r: number; p: number }) {
  return scryptSync(passphrase.normalize('NFC'), salt, 32, { ...params, maxmem: 256 * params.N * params.r + 32 * 1024 * 1024 });
}

const recordAad = (header: Buffer, index: number, final: boolean) => {
  const suffix = Buffer.alloc(5); suffix.writeUInt32BE(index, 0); suffix[4] = final ? 1 : 0;
  return Buffer.concat([header, suffix]);
};
const nonce = (prefix: Buffer, index: number) => { const value = Buffer.alloc(12); prefix.copy(value, 0); value.writeUInt32BE(index, 8); return value; };

export class EncryptingWriter {
  private pending: Buffer[] = [];
  private pendingLength = 0;
  private index = 0;
  readonly header: Buffer;
  private key: Buffer;
  private prefix = randomBytes(8);
  constructor(passphrase: string, private emit: (bytes: Buffer) => Promise<void>, private chunkSize = DEFAULT_CHUNK, scrypt = DEFAULT_SCRYPT) {
    const salt = randomBytes(16);
    this.key = deriveKey(passphrase, salt, scrypt);
    const json = Buffer.from(JSON.stringify({ kdf: 'scrypt', ...scrypt, salt: salt.toString('base64'), cipher: 'aes-256-gcm', chunkSize, noncePrefix: this.prefix.toString('base64') }));
    const fixed = Buffer.alloc(7); MAGIC.copy(fixed); fixed[4] = 1; fixed.writeUInt16BE(json.length, 5);
    this.header = Buffer.concat([fixed, json]);
  }
  async start() { await this.emit(this.header); }
  private async record(plain: Buffer, final: boolean) {
    if (this.index >= 0xffffffff) throw new Error('Backup too large for one encrypted archive');
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce(this.prefix, this.index));
    cipher.setAAD(recordAad(this.header, this.index, final));
    const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    const prefix = Buffer.alloc(5); prefix.writeUInt32BE(body.length - 16, 0); prefix[4] = final ? 1 : 0;
    this.index++;
    await this.emit(Buffer.concat([prefix, body]));
  }
  async write(bytes: Buffer) {
    this.pending.push(bytes); this.pendingLength += bytes.length;
    while (this.pendingLength >= this.chunkSize) {
      const all = Buffer.concat(this.pending);
      await this.record(all.subarray(0, this.chunkSize), false);
      const rest = all.subarray(this.chunkSize);
      this.pending = [rest]; this.pendingLength = rest.length;
    }
  }
  async finish() {
    await this.record(Buffer.concat(this.pending), true);
    this.pending = []; this.pendingLength = 0; this.key.fill(0);
  }
}


/** Decrypts an OPBK stream into the plaintext tar stream. */
export async function* decryptingStream(source: AsyncIterable<Uint8Array>, passphrase: string): AsyncGenerator<Buffer> {
  const reader = new ByteReader(source);
  const fixed = await reader.readExact(7, 'encryption header');
  if (!fixed.subarray(0, 4).equals(MAGIC) || fixed[4] !== 1) throw new Error('Not an OpenPlod encrypted backup (or an unsupported version)');
  const json = await reader.readExact(fixed.readUInt16BE(5), 'encryption header');
  const header = Buffer.concat([fixed, json]);
  const params = JSON.parse(json.toString('utf8')) as { kdf: string; N: number; r: number; p: number; salt: string; cipher: string; chunkSize: number; noncePrefix: string };
  if (params.kdf !== 'scrypt' || params.cipher !== 'aes-256-gcm' || !Number.isInteger(params.N) || params.N > 1 << 20 || params.r > 32 || params.p > 16
    || !Number.isInteger(params.chunkSize) || params.chunkSize > 64 << 20) throw new Error('Unsupported backup encryption parameters');
  const key = deriveKey(passphrase, Buffer.from(params.salt, 'base64'), params);
  const prefix = Buffer.from(params.noncePrefix, 'base64');
  try {
    for (let index = 0; ; index++) {
      const meta = await reader.read(5);
      if (meta.length === 0) throw new Error('Encrypted backup is truncated (no final record)');
      if (meta.length !== 5) throw new Error('Encrypted backup is truncated');
      const length = meta.readUInt32BE(0), final = meta[4] === 1;
      if (length > params.chunkSize) throw new Error('Encrypted backup record is too large');
      const body = await reader.readExact(length + 16, 'encrypted record');
      const decipher = createDecipheriv('aes-256-gcm', key, nonce(prefix, index));
      decipher.setAAD(recordAad(header, index, final));
      decipher.setAuthTag(body.subarray(length));
      let plain: Buffer;
      try { plain = Buffer.concat([decipher.update(body.subarray(0, length)), decipher.final()]); }
      catch { throw index === 0 ? new BackupPassphraseError('Wrong passphrase, or the backup is damaged') : new Error('Encrypted backup is damaged (authentication failed)'); }
      if (plain.length) yield plain;
      if (final) {
        if (!await reader.atEnd()) throw new Error('Unexpected data after the final encrypted record');
        return;
      }
    }
  } finally { key.fill(0); }
}
