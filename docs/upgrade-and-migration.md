# Upgrade, Migration, and Rollback

## Before every upgrade

1. Create and **verify** a backup (Settings > Backup & restore, see
   [backup and restore](backup-and-restore.md)). Keep it until the new version has run for a while.
2. Quit OpenPlod.
3. Replace only the application. Never delete the vault data directory to upgrade.

## How the vault is migrated

Migrations run when the backend starts (`src/db/setup.ts` and module initializers). They are
additive: new tables and columns are created with `CREATE … IF NOT EXISTS` / `ALTER TABLE ADD
COLUMN`, and existing data is not rewritten except for documented one-time fixes. Since 1.0.x:

- `import_journal`, `recording_purges` and `vault_meta` tables are created when missing.
- Plaintext API keys in `user_settings` are encrypted in place with a new `vault.key` in the data
  directory (see [provider privacy](provider-privacy-and-cost.md#api-keys)). Older builds cannot
  read encrypted keys; if you roll back, re-enter API keys or use environment variables.
- Data-directory and database permissions are tightened to `0700`/`0600` on Unix.

## Schema downgrade guard

The vault records two versions:

- `PRAGMA user_version`: the core schema version (currently 4).
- `vault_meta.schema_generation`: raised when a release changes the vault in a way older builds
  cannot safely use (currently 1). `vault_meta.last_app_version` records which app version last
  opened the vault.

On startup, a build that finds either value newer than it supports **refuses to open the vault
and does not modify it**, with a message naming the newer version. This prevents an older build
from running old migrations or writes against a newer schema.

The guard only exists from this release on. Builds released before it (1.0.0 and earlier) do not
check it, so rolling back to them past a schema change is unprotected; use a backup instead.

## Rollback

1. Quit OpenPlod.
2. If the newer version did not change the schema generation, install the previous app version
   and start it. API keys encrypted by the newer version need re-entering on builds older than
   the encryption change.
3. If the older build refuses the vault (or predates the guard and the schema changed), do not
   force it. Restore the backup you made before upgrading into a new folder and point the older
   build at it. Recordings added after that backup are only in the newer vault; keep that vault
   and move them over by importing their audio files from `recordings/` if needed.

## Desktop update signatures

Desktop builds include the Tauri updater plugin. Update packages are verified against a public
key compiled into the release build (`TAURI_UPDATER_PUBKEY`, see
`scripts/release-config.ts`); a package that does not match is rejected by the plugin. Releases
built without that key ship no updater artifacts, and the in-app updater is not wired to the UI
yet, so updates remain manual: download, verify `SHA256SUMS.txt`, replace the app.

macOS releases are signed and notarized only when the release workflow has Apple signing secrets.
Otherwise they are ad-hoc signed and not notarized, and the draft release says so.

## Moving to another computer

Create an encrypted backup (it carries API keys and the Plaud authorization), restore it on the
new computer into an empty folder, and place it in that computer's app data directory. See
[backup and restore](backup-and-restore.md#restore).
