# Backup and Restore

OpenPlod can write a full-vault backup archive, verify it, and restore it into a new folder.
Use **Settings > Backup & restore** (three steps: Create, Verify, Restore) or the API below.

## What a backup contains

| Archive path | Content |
| --- | --- |
| `database/openplod.db` | A consistent snapshot of the vault database made with SQLite `VACUUM INTO` while OpenPlod runs: recordings, transcripts and versions, documents, chat history, settings, job history, tombstones |
| `library/…` | Every file in the recordings library: playable audio and `originals/<id>/` (device bytes, decoded audio, provenance) |
| `secrets/vault.key` | **Encrypted archives only.** The local key that decrypts stored API keys |
| `device/plaud-device.json` | **Encrypted archives only**, when present: this computer's Plaud authorization |
| `manifest.json` | Last entry. Format version, app version, schema version, counts, and the size and SHA-256 of every other entry |

Unencrypted archives never contain credentials. API keys are removed from the database snapshot
and the key and device-identity files are left out, so you re-enter API keys and re-authorize
the Plaud after restoring one. Temporary import folders (`incoming/`, `.staging/`), the pairing
token and app logs are not backed up.

The database snapshot is taken first and the library is listed afterwards, so every recording
in the snapshot has its audio in the archive. A recording imported while a backup runs may be
in the archive without a database row; it shows up as an orphaned file after a restore and is
kept (see [recovery](recovery.md)).

Each archive is written as `<name>.partial`, fsynced, and renamed when complete, with
`<name>.sha256` beside it (`sha256sum -c` format). The default folder is `backups/` in the vault
data directory; set `OPENPLOD_BACKUP_DIR` or choose a folder per backup. Copy backups to
another disk: a backup on the same disk does not survive that disk failing.

## Backups keep data until you delete them

**An archive is an independent copy.** Moving a recording to Trash, purging it, or the 30-day
Trash expiry does not change any existing backup. Recordings, transcripts and documents in an
archive remain there until you delete the archive file yourself. Delete or re-create old
backups if you need purged content to be gone everywhere.

## Encryption

Tick **Encrypt with a passphrase** (at least 12 characters). There is no recovery if the
passphrase is lost. The encrypted file (`.tar.opbk`) wraps the same tar stream:

```text
"OPBK" | version 0x01 | header length (u16 BE) | header JSON
record*: ciphertext length (u32 BE) | final flag (1 byte) | ciphertext | 16-byte GCM tag
```

- Header JSON: `{ "kdf": "scrypt", "N": 131072, "r": 8, "p": 1, "salt": <16 bytes base64>,
  "cipher": "aes-256-gcm", "chunkSize": 1048576, "noncePrefix": <8 bytes base64> }`.
- Key: `scrypt(passphrase NFC, salt, 32 bytes, N, r, p)`.
- Record `i` (from 0): nonce = `noncePrefix || u32 BE i`; additional authenticated data = the
  full header bytes `|| u32 BE i || final flag`. Plaintext records are at most `chunkSize` bytes.
- Exactly one record, the last, has the final flag. A missing final record (truncation), a
  reordered or altered record, or trailing data fails verification. A wrong passphrase fails on
  the first record.

The encryption is implemented with Node/Bun `crypto` only (`src/vault/backup-crypto.ts`). It has
not had an independent cryptographic review.

## Verify

Verification reads the whole archive (decrypting it if needed), recomputes the SHA-256 of every
entry, requires the manifest to list exactly the entries present with matching sizes and hashes,
and runs `PRAGMA integrity_check` on the database snapshot. Verify every new backup, and verify
again before relying on an old one.

## Restore

Restore always writes into a folder you choose, never into the running vault:

1. The archive is verified while it is extracted into a hidden `.restore-…` folder inside the
   target. Any failure removes that folder and leaves the target as it was.
2. A non-empty target is refused unless you confirm. Confirmed restores **move** the existing
   contents into `.pre-restore-<time>/` inside the target; nothing is deleted.
3. The restored layout matches the desktop app: `openplod.db`, `recordings/`, and, from encrypted
   archives, `vault.key` and `plaud-device.json`.
4. Recording paths in the restored database are rewritten from the original library path to the
   new `recordings/` folder. Unfinished import-journal rows are cleared.

Then start OpenPlod on the restored folder. For a source run:

```bash
DATABASE_URL=/path/to/restored/openplod.db OPENPLOD_LIBRARY_PATH=/path/to/restored/recordings bun run start
```

For the desktop app, quit OpenPlod, move the current data directory aside (do not delete it),
and move the restored folder's contents into the app data directory
(`~/Library/Application Support/com.openplod.vault/` on macOS,
`~/.local/share/com.openplod.vault/` on Linux, `%APPDATA%\com.openplod.vault\` on Windows). The
desktop app reads the Plaud identity from that directory. A source run reads it from
`OPENPLOD_DEVICE_IDENTITY` or the default identity location.

A backup made by a newer OpenPlod than the one restoring it is refused when the vault is opened
(see [upgrade and migration](upgrade-and-migration.md)).

## API

All routes are under `/api/vault` and use the normal API token. Long operations return
`202` with an operation and are polled.

| Route | Purpose |
| --- | --- |
| `GET /status` | Data, database, library and backups paths, schema metadata, last import-recovery report |
| `GET /backups` | Archives in the backups folder |
| `POST /backups` | `{ "passphrase"?: string, "directory"?: absolute path }` starts a backup |
| `POST /backups/verify` | `{ "path": name or absolute path, "passphrase"?: string }` |
| `POST /restore` | `{ "path", "targetDirectory": absolute path, "passphrase"?, "confirmOverwrite"?: boolean }` |
| `GET /operations/:id` | `{ state: running \| complete \| failed, progress, result, error, code }`; `code` is `wrong_passphrase` or `target_not_empty` where applicable |

One backup, verify or restore runs at a time.

## Limits

- Backups are full copies each time; there are no incremental backups or schedules yet.
- Paths with characters outside `A-Z a-z 0-9 . _ - /` or longer than 255 bytes are skipped and
  listed in the manifest's `skipped` field. OpenPlod's own files never use such names.
- A restore needs free space for the extracted vault; the archive size is checked up front.
- Backup and restore have automated tests (`src/vault/backup.test.ts`, `src/api/vault.test.ts`).
  A restore of a real, full-size vault on a second machine has not been recorded yet.
