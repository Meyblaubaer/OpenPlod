# Recovery

OpenPlod's rule is that recovery never deletes audio. This page lists what happens after a
crash, power loss, full disk or failed transfer, and what to do.

## Interrupted imports

Every import (file import, folder sync, mobile upload, direct Plaud download) follows the same
sequence:

1. Free space is checked first (`statfs`): the import's size plus a 64 MiB margin. A full disk
   fails with "Not enough free disk space for this import…", and nothing is written.
2. The audio and any originals/sidecars are copied into `recordings/.staging/<id>/` and fsynced.
   An `import_journal` row records the planned paths and the full recording row.
3. Files are renamed into `recordings/<id>.<ext>` and `recordings/originals/<id>/`, and the
   directories are fsynced. The journal moves to `placed`.
4. The recording row is inserted and the journal row deleted in one database transaction.

The source file is not touched during an import, so a failed import loses nothing.

On every start, OpenPlod scans the journal:

| Found | Action |
| --- | --- |
| Recording row exists | Journal entry cleared; staged copies removed |
| Final audio exists with the journalled SHA-256 | Import completed: the row is inserted |
| Anything else | Rolled back: staged and placed files are **moved** to `incoming/recovered/<id>/` |

It also reports library files and `originals/` folders that have no recording row. They are
never deleted. The report is in the log and at `GET /api/vault/recovery` (and
`GET /api/vault/status`). To keep an orphaned audio file, import it again from its path; to
discard it, delete it yourself after checking it.

Replacing a recording's audio stages the new file beside the old one, fsyncs it, then renames
it over the old file.

## Interrupted Plaud downloads

Bluetooth downloads checkpoint received bytes to `incoming/plaud-resume/<serial>-<session>-<size>.part`
and resume from that offset. The recording stays on the Plaud: OpenPlod never deletes, resets or
re-binds the device. If an import fails after the download, the `.part` file is kept and the next
attempt resumes from it. It is removed only after the recording, its device bytes and decoded
audio are committed to the vault.

### Transfer-tail checksum

The device ends a transfer with a 16-bit value. No real captured transfer in this project
identifies which CRC-16 variant (or which bytes) it covers, so OpenPlod does **not** treat it as
verified. Each import computes eleven common CRC-16 variants over the received bytes and records
`tailChecksum: { status: "unverified-algorithm", algorithm: null, tailValue, candidateMatches }`
in `originals/<id>/provenance.json` (desktop) or `<stem>.tail.json` (Android). A transfer is never
rejected on an unconfirmed algorithm. Integrity still rests on the framing, exact size, decryption
and full Ogg page-checksum validation.

When a real capture confirms one variant, it is set in `src/sync/transfer-checksum.ts` and
`DirectPlaudChecksum.kt`. From then on a mismatch fails the import with "Plaud transfer checksum
mismatch"; the received bytes are moved to `incoming/plaud-quarantine/` (desktop) or kept as
`<stem>.mismatch-<time>.part` (Android) and the next attempt downloads afresh.

## Processing jobs

A transcription interrupted by a crash is marked failed with an "outcome may be unknown" warning
and is not resubmitted automatically, so a paid request is not sent twice. Jobs with a stored
remote ID (AssemblyAI) can be resumed without re-uploading. See [AI providers](ai-providers.md).

## Database problems

- Check integrity: verify a recent backup, or run `sqlite3 openplod.db 'PRAGMA integrity_check'`
  on a copy while OpenPlod is stopped.
- If the database is damaged, restore the newest verified backup into a new folder
  ([backup and restore](backup-and-restore.md)). Audio added after that backup is still in the
  damaged vault's `recordings/` folder; import it into the restored vault.
- A vault written by a newer OpenPlod is refused; see
  [upgrade and migration](upgrade-and-migration.md#schema-downgrade-guard).

## Lost keys

- `vault.key` lost or replaced: stored API keys cannot be decrypted. OpenPlod logs which key
  failed and treats it as not configured. Re-enter keys in Settings, or restore `vault.key` from an
  encrypted backup.
- Backup passphrase lost: the encrypted archive cannot be opened. There is no recovery.

## Purge

Purging a recording from Trash (manually, or automatically 30 days after it was trashed) removes:
the recording row and everything that cascades from it (transcripts, transcript versions,
analyses, speaker mappings, bookmarks, the full-text index entries), its audio file,
`originals/<id>/`, Plaud resume/quarantine `.part` files for its source session, its processing-job
history, Plaud import events, document-generation records, and rows in search/embedding tables
when those exist. Other modules can register cleanup through `registerPurgeHook`
(`src/library/purge-hooks.ts`).

Two kinds of data are deliberately kept but disconnected:

- **Chat answers** that cited the recording are redacted: the question and answer text are
  removed and the turn is marked `purged`, also when the answer cited other recordings, because an
  answer cannot be partially un-quoted.
- **Documents** in the Documents workspace are kept (they may contain your edits and have their
  own Trash); their link to the recording and transcript version is removed.

A `recording_purges` row (recording ID, source ID, fingerprint, reason, time; no content)
records each purge. Backups made before a purge still contain the recording. Purge is ordinary
file deletion, not certified secure erasure.
