# Mobile Pairing and Sync

The desktop app owns the vault. A paired phone sends it recordings and can read and edit recording metadata. This page explains pairing, per-device access, how uploads survive interruptions, the phone's outbox, the sync protocol for integrators (including OpenNotes and OpenWhistle), and how Android release builds are signed and upgraded. Exact request and response shapes are in the [API reference](api.md#mobile-api).

**Verification status.** The server side (per-device credentials, resumable uploads, change feed, push) and the web client are covered by automated tests against an in-memory vault. Interrupted Wi-Fi uploads, process death during an upload, and upgrading the Android app over an existing install have **not** yet been tested on a physical phone, and the Kotlin client changes have not been compiled in CI. Treat those paths as implemented but unverified.

## Pairing a Phone

1. On the desktop, open **Settings > Android connection** and press **Show pairing QR**.
2. Scan the QR code with the OpenPlod Android app on the same private network.

Each QR code carries a new code for **one** phone. It is shown for 60 seconds (and hidden when the window is hidden), and a code that is never used stops working after one hour. After pairing, the phone sends its name and platform so it is easy to recognise in the list.

The pairing code is a credential. Do not photograph or share it, and do not expose the desktop service to the internet. Plain HTTP on the LAN is not encrypted; to serve HTTPS, set `OPENPLOD_TLS_CERT` and `OPENPLOD_TLS_KEY` (see [provider privacy](provider-privacy-and-cost.md)).

## Managing Paired Devices

**Paired devices** on the same page lists every phone with its status, platform, access, **Last seen** (the last authenticated request), and **Last successful sync** (the last completed upload, feed read, or push). These are timestamps, not live presence; OpenPlod never claims a phone is online.

| Action | Effect |
| --- | --- |
| Rename | Changes the label only |
| Issue a new code | Replaces the phone's credential and shows it as a new QR. The old code stops working immediately |
| Revoke | The phone loses access on its next request. Recordings already in the vault are not deleted |

Each device has its own permissions: `read` (browse the vault), `write` (change things through the API), `upload` (send recordings), and `sync` (use the change feed). New devices get all four. The API can narrow them (`PATCH /api/mobile/clients/:id { permissions }`); there is no toggle for this in the app yet. Only the desktop (or the separate `OPENPLOD_API_TOKEN`) can manage devices; a phone can only read and rename itself.

**Phones paired before per-device codes** used the desktop's shared pairing token. They keep working and appear as one device named "Legacy pairing". Revoking it cuts off every phone using the shared code but never the desktop itself. **Replace the shared code with a device code** (rotate) revokes it and issues a per-device code with the same access, shown as a new QR to scan.

If the desktop UI is not reached over loopback (for example in Docker or from a remote browser), the shared token counts as that legacy phone and cannot manage devices. Use `OPENPLOD_API_TOKEN` for administration in that setup.

## Sending Recordings: Resumable Uploads

A phone sends each recording in chunks so that a dropped connection costs at most one chunk:

1. The phone computes the file's SHA-256 and asks the desktop to start (or find) a transfer for that fingerprint and size. A phone that lost track of a transfer gets the same one back, with the number of bytes the desktop has safely stored.
2. It sends chunks (the web app uses 4 MiB; the desktop accepts up to 8 MiB), each with its own SHA-256. The desktop writes each chunk to disk and syncs it **before** counting it, so a crash never counts bytes it did not keep.
3. After the last chunk, the desktop re-hashes the whole file, imports it into the vault, and returns an acknowledgement with the recording id and fingerprint. The phone checks that fingerprint against its own.

If the connection drops, the phone asks for the committed offset and continues from there. A corrupted chunk is refused and resent. If the assembled file does not match its fingerprint, the desktop discards it and the phone starts that file again once. Files can be up to 2 GiB. Unfinished transfers untouched for 48 hours are cleaned up. A phone can only see, resume, or cancel its own transfers. Cancelling never removes a recording that was already imported.

Older desktops without resumable uploads are detected automatically: the phone falls back to sending the whole file in one request.

## The Outbox: Nothing Is Deleted Before the Desktop Confirms

Recordings made or imported on the phone wait in the **Outbox** (on the Record page when idle) until the desktop has stored them.

- Each item shows its state: waiting for the desktop, sending (with progress), not delivered (with the last error and retry count), or stored on the desktop.
- **Retry upload** is offered for anything not yet verified.
- An item counts as **verified** only when the desktop's acknowledgement fingerprint matches the SHA-256 computed on the phone. Only verified copies can be removed, either with **Remove local copy** or automatically after the **Keep stored copies** window (0, 1, 3, 7, or 30 days; 7 by default, set per device).
- An item that is not verified is never removed, whatever the setting.

On Android, recordings downloaded from a Plaud recorder are kept in app storage with their upload state (pending, failed, acknowledged); the native store never deletes them automatically. A native outbox screen is not built yet; the Devices page shows the last upload error per recording.

## Sync Protocol for Integrators

Phones and companion apps such as OpenNotes and OpenWhistle keep a local copy of recording metadata with two calls. Both need a device token with the `sync` permission (plus `read` to pull, `write` to push).

### Pull changes

`GET /api/mobile/changes?since=<cursor>` returns the recordings that changed after the cursor, each with its **current** metadata and revision, plus `trash`, `restore`, and `purge` events (tombstones) in order.

1. Start with no `since`. The first pages return the whole library.
2. Apply the page locally, then save the returned `cursor`. Repeat while `hasMore` is true.
3. Apply tombstones in order. A purge tombstone carries the audio fingerprint and source ids, so a peer can find a copy it stored under a different id. Restoring means applying the `restore` tombstone, then the recording entry, which shows `retentionState: "active"`.
4. On `410 cursor_expired` (for example, the desktop was restored from a backup), start again from the beginning.

Transcripts are referenced, not embedded: each entry has a `transcriptHead` (version id and whether it was generated or edited). Fetch the text separately.

### Push metadata edits

Queue each local edit with a stable `changeId`, the recording id, the `baseRevision` you edited, and the changed fields, then send them in batches of up to 200 with `POST /api/mobile/changes`. Only title, context, notes, tags, recording type, and recorded time can be changed from a client; audio, transcripts, and processing results stay desktop-owned.

| Result | What to do |
| --- | --- |
| `applied` | Done. Store the new revision |
| `conflict` | The recording changed on the desktop since `baseRevision`. **Nothing was written.** Rebase the pending edit onto the returned current state (or ask the user) and push again with the new revision. A desktop edit is never overwritten |
| `trashed` | The recording is in Trash; it must be restored on the desktop first |
| `not_found`, `invalid` | Drop or fix the edit |

Retrying a push whose response was lost is safe: an already applied `changeId` returns `applied` again rather than a false conflict.

Current limits: the web app still edits metadata directly (`PATCH /api/recordings/:id`, also revision-checked) rather than through a local queue; the change log is not compacted; and cancelling processing jobs or Plaud cloud/Bluetooth imports is not yet isolated per device.

## Android Signing and Upgrades

Release builds of the Android app are signed only when all four signing values are provided, from the environment or from `src-tauri/gen/android/keystore.properties` (`storeFile`, `storePassword`, `keyAlias`, `keyPassword`):

| Value | Environment variable |
| --- | --- |
| Keystore file | `OPENPLOD_ANDROID_KEYSTORE` |
| Keystore password | `OPENPLOD_ANDROID_KEYSTORE_PASSWORD` |
| Key alias | `OPENPLOD_ANDROID_KEY_ALIAS` |
| Key password | `OPENPLOD_ANDROID_KEY_PASSWORD` |

Without them, the release build stays unsigned rather than falling back to the debug key. APK signature schemes v2 and v3 are enabled. Keystore files and `keystore.properties` are ignored by git. The version code comes from the Tauri version (`major × 1,000,000 + minor × 1,000 + patch`).

To upgrade in place without losing data:

1. Sign every release with the **same key** and keep the application id `com.openplod.vault`. A different key forces an uninstall, and uninstalling deletes the app's data. Back up the keystore offline; it cannot be recovered.
2. Raise the version. Android refuses a downgrade.
3. Install over the existing app (`adb install -r` or the package installer). Do not uninstall first.

An in-place upgrade keeps downloaded audio and its outbox state, the Note Pro enrollment and its keystore keys, partial Bluetooth transfers, and the web outbox and desktop pairing stored in the WebView. Backups are disabled (`allowBackup="false"`), so none of this moves to a new phone. Debug builds use a `.debug` application id, install alongside a release build, and never share its data. Desktop upgrades are covered in [upgrade-and-migration.md](upgrade-and-migration.md).

## Related

- [API reference: Mobile API](api.md#mobile-api), [Paired Mobile Clients](api.md#paired-mobile-clients), [Resumable Uploads](api.md#resumable-uploads), [Change Feed and Metadata Push](api.md#change-feed-and-metadata-push)
- [Supported devices](supported-devices.md)
- [Provider privacy and network exposure](provider-privacy-and-cost.md)
