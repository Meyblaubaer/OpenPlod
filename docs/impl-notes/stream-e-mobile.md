# Stream E: mobile clients, resumable uploads, outbox, sync, signing

Implementation notes for the 0.8.0 items MOB-02, MOB-03, MOB-04, MOB-05 (transfer part), MOB-06,
and MOB-08 (build configuration). None of these roadmap boxes is checked by this work alone: the
0.8.0 exit gate requires real interrupted-upload and phone-upgrade evidence that has not been
collected.

## Product rules these changes keep

- Audio is never deleted from the phone before a durable desktop acknowledgement. The web outbox
  and the native `PlaudStore` remove nothing automatically, except that the web outbox may
  remove a copy whose acknowledgement fingerprint matches the local SHA-256. That happens only
  after the configured retention window, or when the user removes the copy.
- Interruptions lose nothing. Upload chunks are fsynced before the committed offset advances. A
  retry resumes from the desktop's committed offset. An uncommitted IndexedDB write is never
  treated as done.
- A client can cancel only its own transfers. Transfers are keyed by client ID, so another
  client gets `404` for them.
- Phone presence is never inferred. The desktop shows "last seen" (the last authenticated
  request) and "last successful sync", never "online". The existing "Phone connection: Not
  monitored" row is unchanged.

## Schema (additive, idempotent)

`src/sync/mobile-schema.ts` → `initializeMobileSync(sqlite)` runs at the end of
`initializeDatabase()`. It creates tables only `IF NOT EXISTS` and never alters existing tables.

| Table | Purpose |
| --- | --- |
| `mobile_clients` | One row per paired client: `id`, `name`, `platform`, `token_hash` (SHA-256), `permissions` (JSON), `legacy`, `created_at`, `pairing_expires_at`, `last_seen_at`, `last_successful_sync_at`, `revoked_at` |
| `mobile_uploads` | Resumable transfers: `client_id`, `fingerprint`, `size`, `filename`, `metadata`, `received_bytes`, `state` (`open`/`complete`), `recording_id`, `added` |
| `sync_changes` | Monotonic change log (`seq` AUTOINCREMENT is the feed cursor) |
| `recording_tombstones` | `trash` / `restore` / `purge` events with timestamp, revision, fingerprint, and source identity |
| `sync_applied_changes` | Results of applied client pushes per `(client_id, change_id)` (idempotent retry) |

Triggers on `recordings` (insert, relevant update, delete) and on `transcripts` (insert, head
change) write `sync_changes` and `recording_tombstones`. Every existing code path is covered
without changes to `recording-library.ts`, including the 30-day Trash purge. On first run, an
empty feed is seeded with one baseline row per existing recording, so cursor `0` returns the
whole library. The triggers are added only once the library tables exist. A store opened on a
bare database still works.

## MOB-06: paired-client credentials

- `POST /api/mobile/clients` (desktop only) issues `{client, token}`. The token is 256 random
  bits (base64url). Only `sha256(token)` is stored, and the token is returned once. An unused
  code expires after 1 hour (`pairing_expires_at`). The first authenticated request clears the
  expiry and sets `last_seen_at`.
- Authentication (`src/api/access.ts` → `resolvePrincipal`):
  1. `OPENPLOD_API_TOKEN` → `api` (admin). Compared in constant time.
  2. The global `OPENPLOD_PAIRING_TOKEN` (constant-time compare):
     - From loopback, it is the desktop app itself (`desktop`, admin). The Tauri webview and
       `desktop_exports.rs` talk to `127.0.0.1`.
     - From the network, it is the **legacy client** (row id `legacy`). Phones paired before
       this change keep working until the owner revokes or rotates that row. Revoking it never
       locks out the desktop, because loopback still resolves to `desktop`. If the desktop
       generates a new global token, the legacy row is reset.
  3. Otherwise, the token is looked up by its SHA-256 (indexed) and compared again with
     `timingSafeEqual`. Revoked clients and expired, unused codes fail. A lookup error fails
     closed (401).
- The old non-timing-safe `!==` compare in `src/api/mobile.ts` is gone. The mobile router uses
  the same resolver.
- Permissions: `read` (GET on `/api/*`), `write` (other methods on `/api/*`), `upload`
  (`/api/mobile/uploads`, `/api/mobile/recordings`), and `sync` (`/api/mobile/changes`). New
  clients get all four, so the paired mobile web app keeps full functionality. Client
  management (`/api/mobile/clients*`) is desktop-only, except `GET`/`PATCH
  /api/mobile/clients/me`, where a phone can read its own record and set its name and platform.
- `last_seen_at` writes are throttled to once per minute. `last_successful_sync_at` is set by an
  upload completion, a legacy single-request upload, a change-feed read, and a push.
- Endpoints: `GET /clients`, `POST /clients`, `PATCH /clients/:id {name?, permissions?}`,
  `POST /clients/:id/revoke`, `POST /clients/:id/rotate`. Rotate replaces the token, and the old
  one stops working immediately. Rotating the legacy client revokes it and issues a new
  per-client credential, because the global token belongs to the desktop.
- Desktop UI (`web/src/pages/AndroidPage.tsx`): **Show pairing QR** now issues a fresh
  per-client token. The token is held only in memory while the QR is shown (60 s, and hidden
  when the window is hidden). The manual code field shows that issued token, never the global
  token. A **Paired devices** list shows status, last seen, last successful sync, platform, and
  access, with Rename, "Issue a new code" (rotate, shown as a new QR), and Revoke (with a
  confirmation dialog).
- Phone side: after pairing, `pairMobile` makes a best-effort `PATCH /mobile/clients/me` with
  the device's name and platform.

Docker or remote browser deployments reach the server through a non-loopback address. There,
the global token acts as the legacy client and cannot manage clients. Use `OPENPLOD_API_TOKEN`
for administration in that setup.

## MOB-02: resumable upload protocol

All under `/api/mobile`, authenticated, with the `upload` permission:

| Request | Result |
| --- | --- |
| `POST /uploads` `{fingerprint: sha256hex, size, filename, metadata: {sourceProvider, sourceRecordingId, recordedAt, durationMs, context, recordingType}}` | `{transferId, offset, size, state, maxChunkBytes: 8388608, recordingId}`, plus an `Upload-Offset` header. `201` when new. |
| `PUT /uploads/:id` with `Content-Range: bytes a-b/size` and `X-Chunk-SHA256: hex` (body = raw bytes) | `{offset}`. `409 offset_mismatch` and `422 chunk_checksum_mismatch` carry `data.offset` and `Upload-Offset`. |
| `GET` / `HEAD /uploads/:id` | Current committed offset. |
| `POST /uploads/:id/complete` | `{transferId, recordingId, fingerprint, added}`: the durable acknowledgement. |
| `DELETE /uploads/:id` | Cancels the caller's own open transfer. A completed import is never undone. |

- **Stable IDs.** `POST /uploads` with the same `(client, fingerprint, size)` returns the
  existing transfer and its committed offset. A completed transfer returns `state: complete`,
  and `complete` then replays the acknowledgement. A phone that lost its transfer ID or the
  acknowledgement can recover both. If the acknowledged recording was purged since, a new
  transfer starts.
- **Durability.** For each chunk, the server truncates the staging file to the committed
  offset, writes, fsyncs, and only then advances `received_bytes`. The committed offset is
  `min(db offset, staged file length)`. A crash before the database update re-sends at most
  one chunk, and a crash that loses the file tail lowers the offset. A chunk already fully
  committed is acknowledged idempotently.
- **Completion.** The server re-hashes the whole staged file. On a mismatch it deletes the
  staged bytes, resets the offset to 0, and returns `422 fingerprint_mismatch`; clients restart
  once. On a match it calls `importRecordingFile` with `expectedFingerprint`, which copies,
  fsyncs, and inserts the row. It then records the acknowledgement, deletes the staged file, and
  queues processing for a newly added recording. Completion is serialized per transfer and is
  idempotent.
- **Limits.** 8 MiB per chunk and 2 GiB per file. The extension must be a supported audio
  format.
- **Expiry.** Open transfers untouched for 48 h, completion records older than 30 days, and
  orphaned staging files older than 48 h are removed. Cleanup runs opportunistically on each
  `POST /uploads`. Staging lives in `<library parent>/incoming/uploads/`.
- **Compatibility.** `POST /api/mobile/recordings` (single request) is unchanged. The web client
  falls back to it when `POST /uploads` returns 404 or 405 (an older desktop), and the Kotlin
  client does the same.
- **Clients.**
  - Web: `web/src/lib/mobile-upload.ts` uses 4 MiB chunks, reports the transfer ID before
    sending (stored on the outbox row), resynchronizes the offset after a network error, backs
    off on consecutive failures without progress (4 attempts), and checks that the acknowledged
    fingerprint equals the local SHA-256.
  - Kotlin: `PlaudVaultClient.upload` does the same with `RandomAccessFile` reads, persists the
    transfer ID with `PlaudStore.recordTransfer` before sending, and records failures with
    `PlaudStore.recordUploadFailure`.

CORS now allows `Content-Range` and `X-Chunk-SHA256` and exposes `Upload-Offset`. This is the
only change to `src/index.ts`.

## MOB-05: cancellation isolation (transfers)

Every transfer operation is looked up by `(id, client_id)`. Client B cannot read, append to,
complete, or cancel client A's transfer; it gets `404`. Admin principals (`desktop`, `api`) own
their transfers under their own key. This test covers it: *transfers are scoped to their
client*.

Not covered here: Bluetooth recovery validation, desktop BLE/cloud import cancellation, and
processing-job cancellation by client. The cloud import cancel endpoint
(`/api/plaud/cloud/cancel`) is still global.

## MOB-03: offline outbox

Web (`web/src/lib/recording-outbox.ts`, `web/src/components/OutboxPanel.tsx`):

- New optional fields on outbox rows: `status`, `retryCount`, `lastError`, `lastAttemptAt`,
  `transferId`, `fingerprint`, and `acknowledgement {recordingId, fingerprint, storedAt}`. Old
  rows load as `pending`. The IndexedDB version is unchanged, because no new index is needed.
- Writes resolve on `transaction.oncomplete` (commit), not on request success. `updateCapture`
  is a single read-modify-write transaction.
- An item counts as **verified** only when `status === 'stored'` and the acknowledgement
  fingerprint equals the locally computed SHA-256. `removeStoredCapture` refuses anything
  unverified.
- Cleanup: "Keep stored copies" offers 0, 1, 3, 7 (default), or 30 days, stored per device in
  `localStorage`. The cleanup removes verified copies older than the window, and only those.
- The outbox panel appears on the Record page when idle. It lists every capture with its status
  (waiting, sending %, not delivered, or stored), retry count, last error, size, and total
  device storage used. Retry is offered for anything not verified. **Remove local copy** (with
  inline confirmation) appears only for verified items.
- Storing from the review screen now goes through the same delivery path
  (`web/src/lib/outbox-delivery.ts`). The local copy is kept for the retention window instead of
  being deleted immediately.

Android native (`PlaudStore.kt`): rows gain `transferId`, `uploadAttempts`, `lastUploadError`,
`lastUploadAt`, and `acknowledgedAt`. `outbox()` returns `{pending, failed, acknowledged, bytes}`
and is exposed as `snapshot().outbox`. The Devices page shows the last upload error on a row.
Native rows are still never deleted.

## MOB-04: synchronization protocol

### Pull: `GET /api/mobile/changes?since=<cursor>&limit=<n>`

This needs the `sync` and `read` permissions. The response is
`{cursor, hasMore, changes[], tombstones[]}`.

- `cursor` is an opaque string; today it is the `sync_changes.seq` value. Start with no `since`
  (or `0`) and repeat with the returned `cursor` while `hasMore` is true. Persist the cursor
  only after the page is applied locally.
- `changes` holds one entry per recording touched after the cursor, with its **current** state:
  - `{type: 'recording', id, seq, revision, retentionState, deletedAt, title, recordedAt,
    recordingType, context, notes, tags, status, fingerprint, durationSeconds, sourceProvider,
    sourceRecordingId, transcriptHead: {versionId, origin} | null}`.
  - `{type: 'purged', id, seq, revision}` when the recording no longer exists.
- `tombstones` are the `trash`, `restore`, and `purge` events in `(since, cursor]`, each with
  `at`, `revision`, `fingerprint`, and source identity. Peers propagate these in order. A
  purge tombstone carries the fingerprint, so a peer can match a copy it imported under another
  ID.
- `410 cursor_expired` means the cursor is ahead of this vault (for example, a restored
  backup). The client must resynchronize from `0`.
- The transcript head is a version pointer plus `origin` (`generated` or `edited`). Transcript
  text is fetched separately (`GET /api/recordings/:id/transcript/versions`). Processing results
  stay desktop-owned, and a client never pushes a transcript through this feed.

### Push: `POST /api/mobile/changes {changes: [...]}`

This needs the `sync` and `write` permissions. It accepts up to 200 changes per request, each
`{changeId, recordingId, baseRevision, fields}`. `fields` may contain only `title`, `context`,
`notes`, `tags`, `recordingType`, and `recordedAt`. Each change is applied in its own
transaction with `UPDATE … WHERE id = ? AND revision = ?`.

The response is `{results[], cursor}`, with one result per change:

- `applied {revision}`: the change was applied, and the revision is now `baseRevision + 1`.
- `conflict {current}`: the base revision is stale. **Nothing was written.** The client must
  rebase onto `current` (for example, reapply the user's still-pending field edits) or ask the
  user, then resubmit. A manual desktop edit is never overwritten.
- `trashed`, `not_found`, `invalid {error}`: not applied.

An applied result is stored under `(client, changeId)`, so retrying a request whose response was
lost returns `applied` again instead of a false conflict. Clients should queue edits locally with
a stable `changeId` and their `baseRevision`, and push them when connected.

### OpenNotes / OpenWhistle

This feed and push contract is the interface those apps should use. No OpenNotes or OpenWhistle
code changed in this stream. Restore propagation means applying the `restore` tombstone and then
the recording entry, which carries `retentionState: active`.

## MOB-08: Android release signing and upgrade-in-place

`src-tauri/gen/android/app/build.gradle.kts`:

- The release `signingConfig` is configured only when all four values are present. Each value
  is read from the environment first, then from `src-tauri/gen/android/keystore.properties`
  (`storeFile`, `storePassword`, `keyAlias`, `keyPassword`):

  | Value | Environment variable |
  | --- | --- |
  | Keystore file | `OPENPLOD_ANDROID_KEYSTORE` |
  | Keystore password | `OPENPLOD_ANDROID_KEYSTORE_PASSWORD` |
  | Key alias | `OPENPLOD_ANDROID_KEY_ALIAS` |
  | Key password | `OPENPLOD_ANDROID_KEY_PASSWORD` |

  APK signature schemes v2 and v3 are enabled. Without the values, the release build stays
  unsigned rather than falling back to the debug key.
- `versionCode` and `versionName` come from `tauri.properties` (written by the Tauri CLI). If
  that file is missing, they are derived from `src-tauri/tauri.conf.json`
  (`major*1_000_000 + minor*1_000 + patch`, the Tauri CLI formula).
- `keystore.properties`, `*.jks`, and `*.keystore` are ignored by git (root and Android
  `.gitignore`).

Upgrade-in-place path:

1. Use the same `applicationId` (`com.openplod.vault`) and the **same release key** for every
   release. A different key forces an uninstall, and an uninstall deletes app data. Back up the
   keystore offline; it cannot be recovered.
2. Increase the version in `tauri.conf.json`, which raises `versionCode`. Android rejects a
   downgrade.
3. Install over the existing app (`adb install -r` or the package installer). Do not uninstall
   first.
4. Data that survives an in-place upgrade:
   - `filesDir/plaud-audio/` (downloaded audio and `index.json` with outbox and acknowledgement
     state)
   - `noBackupFilesDir/plaud-identity.enc` together with its AndroidKeyStore keys (Note Pro
     enrollment)
   - `noBackupFilesDir/plaud-transfers/` (partial Bluetooth transfers)
   - the WebView's IndexedDB (web outbox) and `localStorage` (desktop pairing)

   `allowBackup="false"`, so none of this moves to a new device.
5. Debug builds use the `.debug` application ID suffix and install alongside a release build.
   Data never migrates between them.

## Tests

- `src/api/mobile.test.ts` (14 tests) covers:
  - per-client credentials (hash only)
  - admin-only management, rename, revoke, rotate
  - legacy token, legacy revoke and rotate
  - loopback desktop versus LAN legacy
  - permissions and pairing-code expiry
  - chunked upload with corrupt and out-of-order chunks
  - resume by `POST`, `HEAD` offset, idempotent completion
  - cross-client isolation and cancel
  - fingerprint mismatch restart, validation, expiry cleanup
  - the single-request endpoint
  - the change feed with trash, restore, and purge tombstones, and `410`
  - push applied, idempotent retry, conflict without overwrite, invalid field, not found
- `web/src/lib/mobile-upload.test.ts` (8 tests) covers the resumable client against a fake
  vault (network failure and resync, fingerprint restart, give-up, unsupported fallback) and the
  outbox rules (verified only, retention selection, summary).
- Kotlin was **not compiled**: there is no Android SDK or offline Gradle on the build machine.
  The changes follow the existing OkHttp, `AtomicFile`, and JSONObject patterns and should be
  compiled with `./gradlew :app:assembleDebug` before release.

## Not done (leftovers)

- Physical-phone acceptance: interrupted Wi-Fi upload, process death during upload, and upgrade
  over an existing install. This is the 0.8.0 exit-gate evidence.
- A native Android outbox screen. State is exposed through the snapshot; the Devices page only
  shows a per-row error.
- A client-side queue for metadata edits in the web app. The server push and feed exist; the
  web UI still edits through `PATCH /api/recordings/:id`, which also uses revision checks.
- Compaction of `sync_changes`. It grows by about one row per recording change, and there is no
  compaction or cursor-expiry policy yet.
- Per-client processing-job cancellation, and BLE/cloud import cancellation isolation.
- A UI for per-client permission editing. The API supports `PATCH {permissions}`, and the web
  `api.setPairedClientPermissions` exists, but there is no toggle UI.
