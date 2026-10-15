import type { Database } from 'bun:sqlite';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * REL-06: provider API keys at rest.
 *
 * Secret settings are stored as `enc:v1:<base64(iv | ciphertext | tag)>`, AES-256-GCM
 * with the setting name as additional data, under a random 32-byte key kept in
 * `<data dir>/vault.key` (mode 0600). This protects keys in database copies, logs of
 * SQL, and unencrypted backups that leave the machine; it does not protect against
 * someone who can read the data directory itself (the key file sits beside the
 * database). Environment variables remain a fallback and are never written here.
 *
 * Legacy plaintext values are still read, and `migratePlaintextSecrets` encrypts them
 * in place on startup.
 */
export const SECRET_SETTING_KEYS = ['mistralApiKey', 'deepgramApiKey', 'openaiApiKey', 'assemblyaiApiKey', 'anthropicApiKey', 'openWhistleApiKey'] as const;
const PREFIX = 'enc:v1:';

export function isSecretSetting(key: string) { return (SECRET_SETTING_KEYS as readonly string[]).includes(key); }

export function dataDirectory() { return dirname(resolve(process.env.DATABASE_URL || './data/plaud.db')); }
export function secretKeyPath() { return process.env.OPENPLOD_SECRET_KEY_FILE || join(dataDirectory(), 'vault.key'); }

let cached: { path: string; key: Buffer } | null = null;
/** Loads (or creates) the local key. Tightens permissions that are wider than 0600. */
export function secretKey(path = secretKeyPath()): Buffer {
  if (cached?.path === path) return cached.key;
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { writeFileSync(path, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  if (process.platform !== 'win32' && (statSync(path).mode & 0o077)) chmodSync(path, 0o600);
  const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'hex');
  if (key.length !== 32) throw new Error(`The vault secret key at ${path} is invalid. Restore it from a backup or remove it and re-enter API keys.`);
  cached = { path, key };
  return key;
}
export function resetSecretKeyCache() { cached = null; }

export function isEncryptedSecret(value: string) { return value.startsWith(PREFIX); }

export function encryptSecret(name: string, value: string, key = secretKey()): string {
  if (!value || isEncryptedSecret(value)) return value;
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(name));
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64');
}

const warned = new Set<string>();
/** Returns the plaintext, the legacy plaintext value, or '' when it cannot be decrypted (key lost or changed). */
export function decryptSecret(name: string, value: string | null | undefined, key?: Buffer): string {
  if (!value || !isEncryptedSecret(value)) return value ?? '';
  try {
    const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key ?? secretKey(), raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(name));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8');
  } catch {
    if (!warned.has(name)) { warned.add(name); console.error(`[Secrets] ${name} could not be decrypted with this vault's key; re-enter it in Settings.`); }
    return '';
  }
}

/** Decrypts the secret entries of a settings map; other values pass through. */
export function revealSettings(values: Record<string, string>): Record<string, string> {
  const result = { ...values };
  for (const key of SECRET_SETTING_KEYS) if (result[key]) result[key] = decryptSecret(key, result[key]);
  return result;
}

/** The value to store for a setting: secrets are encrypted, everything else is unchanged. */
export function protectSetting(key: string, value: string): string {
  return isSecretSetting(key) ? encryptSecret(key, value) : value;
}

/** Encrypts any plaintext secret settings in place. Returns how many were migrated. */
export function migratePlaintextSecrets(database: Database): number {
  if (!database.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='user_settings'").get()) return 0;
  const rows = database.query(`SELECT key, value FROM user_settings WHERE key IN (${SECRET_SETTING_KEYS.map(() => '?').join(',')})`)
    .all(...SECRET_SETTING_KEYS) as { key: string; value: string }[];
  const plaintext = rows.filter(row => row.value && !isEncryptedSecret(row.value));
  if (!plaintext.length) return 0;
  const update = database.query('UPDATE user_settings SET value=? WHERE key=? AND value=?');
  database.transaction(() => { for (const row of plaintext) update.run(encryptSecret(row.key, row.value), row.key, row.value); })();
  return plaintext.length;
}
