# OpenPlod API

The 0.5 development build adds [AI provider settings, connection checks, and durable job controls](ai-providers.md#apis). These routes use the same authentication below. Provider live acceptance and spending controls remain open release gates.

The organizer API is rooted at `/api/v1`. It runs inside the existing desktop service, normally `http://127.0.0.1:3487`. Existing recording and transcript endpoints remain backward compatible.

## Authentication and Exposure

Send `X-OpenPlod-Token` with the desktop pairing token, or with a separately configured `OPENPLOD_API_TOKEN`. The native app automatically configures its pairing token. A source-run server with neither token configured remains unauthenticated for local development; do not bind it to a shared network in that state.

Tokens are credentials, not public URLs. Keep them out of query strings, logs, source, and screenshots. The native app uses private-LAN HTTP for pairing, not internet-facing TLS. Use HTTPS for remote API clients. API responses disable caching.

## Contract

Successful responses use `{ "success": true, "data": ... }`. Failures use `{ "success": false, "code": "revision_conflict", "error": "..." }`.

| Status | Meaning |
| --- | --- |
| 200 / 201 | Successful operation / created resource |
| 400 | Invalid JSON, unknown fields, missing confirmation, or invalid input |
| 401 | Missing or invalid API/pairing token |
| 404 | Document, folder, active recording, version, or destination unavailable |
| 409 | Stale revision, duplicate request key with different content, cycle, or invalid retention state |
| 410 | The document's 30-day restore window expired |
| 413 | Request body exceeds 4 MB; Markdown itself is limited to 512 KB of UTF-8 |
| 503 | Destination configuration is invalid or unavailable |

IDs and idempotency keys are UUIDs. Mutable resources have a positive integer `revision`. Read first, then submit that revision with updates, moves, Trash, restore, or purge. A conflict does not overwrite newer data. Titles are 1-180 characters without control characters or path separators.

Folders are logical SQLite-backed collections, not arbitrary filesystem paths. A note is stored independently of its source transcript and audio. Moving or deleting a note never moves or deletes the recording. Unsaved UI drafts use per-tab session storage when available; they are not synchronized or durable server saves.

## Endpoints

All paths below are relative to `/api/v1`.

| Method | Path | Request / behavior |
| --- | --- | --- |
| GET | `/` | API capabilities, Markdown size limit, retention period |
| GET | `/folders` | Flat folder tree with `parentId`, `revision`, direct active-document counts |
| POST | `/folders` | `{ name, parentId?: UUID \| null }` |
| PATCH | `/folders/:id` | `{ revision, name?, parentId? }`; rejects cycles and duplicate sibling names |
| DELETE | `/folders/:id` | `{ revision }`; only empty folders, including Trash contents |
| GET | `/documents` | Paginated summaries; filters described below |
| POST | `/documents` | `{ title, content?, folderId?, tags?, properties?, idempotencyKey }` |
| GET | `/documents/:id` | Complete note including content, tags, properties, source references, revision, retention dates |
| PATCH | `/documents/:id` | `{ revision, title?, content?, folderId?, starred?, tags?, properties? }` |
| GET | `/documents/:id/source` | The exact transcript version the note cites, resolved: `current`, `stale`, `unknown`, or `none` |
| GET | `/tags` | Tags on active notes with counts, `[{ tag, count }]` |
| GET | `/views` | Saved document views, by name; see [Saved Views](#saved-views) |
| POST | `/views` | `{ name, filters }`; filters are the `GET /documents` filters without pagination |
| PATCH | `/views/:id` | `{ revision, name?, filters? }` |
| DELETE | `/views/:id` | `{ revision }`; notes are not affected |
| GET | `/exports/markdown` | Managed Markdown export status; see [Managed Markdown Export](#managed-markdown-export) |
| POST | `/exports/markdown` | `{ dryRun: true }` to preview, or `{ confirm: true, overwrite?: [documentId] }` to write |
| GET | `/recordings/:id/transcript-versions` | Saved transcript versions, newest first, without text; `current` flag and citing-note count |
| GET | `/transcript-versions/:id` | One transcript version including `fullText` |
| GET | `/transcript-versions/:id/backlinks` | `{ version, documents }`: active notes citing exactly this version |
| GET | `/jobs` | Processing jobs, newest first; see [Processing Jobs](#processing-jobs) |
| GET | `/jobs/:id` | One job descriptor |
| POST | `/jobs/:id/cancel` | Cancel exactly this queued or running job |
| DELETE | `/documents/:id` | `{ revision }`; move to 30-day Trash |
| POST | `/documents/:id/restore` | `{ revision }`; restore during the retention window |
| POST | `/documents/:id/purge` | `{ revision, confirm: true }`; permanently remove a trashed note and history |
| GET | `/documents/:id/versions` | Version summaries, newest first; `offset` paginates in groups of 30 |
| GET | `/documents/:id/versions/:versionId` | Historical title and Markdown |
| POST | `/documents/:id/versions/:versionId/restore` | `{ revision }`; restore content as a new revision |
| GET | `/documents/:id/export?format=md` | Download exact saved Markdown; `format=json` includes metadata |
| GET | `/transcripts/:recordingId` | Read source metadata and current transcript; optional `versionId` selects history |
| POST | `/documents/from-transcript` | `{ recordingId, versionId?, folderId?, title? }`; independent, provenance-linked snapshot |
| POST | `/documents/generate` | AI generation with the configured text provider; SSE `progress` (`{ id, stage }`), `result`, or `error` events; no note saved yet |
| GET | `/generations/:id` | Private generation result and timestamped processing trace |
| POST | `/generations/:id/save` | `{ folderId? }`; save reviewed AI output once as a new note |
| GET | `/destinations` | Configured destination ID, name, and host only; no secrets or full URL |
| POST | `/documents/:id/send` | `{ destinationId, revision, confirm: true, idempotencyKey }` |
| GET | `/documents/:id/deliveries` | Latest 30 delivery attempts, without provider response bodies |

`GET /documents` accepts:

- `view=all|starred|trash` (default `all`, excluding Trash).
- `folderId=<UUID>` for direct members only, or `folderId=inbox` for unfiled notes.
- `q=<text>` for indexed full-text token-prefix search across titles and Markdown.
- `tag=<tag>` for notes carrying that tag, compared case-insensitively. Composes with every other filter.
- `sort=updated|title`, `offset=0`, and `limit=30` (maximum 100).

Response: `{ documents: [...], total, offset, limit }`. Summaries include a short excerpt and the note's `tags`, not the entire Markdown body. Up to 1,000 folders and 32 nesting levels are supported.

## Tags, Properties, and Sources

Tags are freeform: up to 32 per note, 1-64 characters, no commas or control characters. They are trimmed, deduplicated case-insensitively (the first spelling is kept), and returned sorted. Sending `tags` on `PATCH` replaces the whole set; omitting it keeps the current tags.

`properties` is a schemaless JSON object (up to 64 keys, 16 KB). Values are stored verbatim, so a number stays a number and an object stays an object. `PATCH` merges by key: keys you send replace their values, `null` removes a key, and keys you omit are kept. Changing tags or properties creates a new revision and uses the same `409` conflict rule as any other edit.

A note written from a transcript records the exact transcript version it read (a generated note written from "the current transcript" records the version that was current at the time). `GET /documents/:id/source` resolves it:

| `status` | Meaning |
| --- | --- |
| `current` | The cited version is the recording's current transcript |
| `stale` | The cited version still exists, but the transcript has been edited or another version promoted since; `stale: true` |
| `unknown` | The note names a source that can no longer be found; no substitute text is returned |
| `none` | The note was not written from a transcript |

The response also carries `recordingId`, `recordingFilename`, `recordingAvailable` (false when the recording is in Trash or gone), `versionId`, `versionOrigin`, `versionCreatedAt`, and `currentVersionId`. Notes keep citing their version after a newer one is promoted; they are never rewritten. Backlinks exclude notes in Trash, and a restored note reappears.

## Saved Views

A saved view stores a named set of `GET /documents` filters: `folderId`, `view`, `q`, `sort`, and `tag`. Pagination is never saved, and the notes are listed live each time, so a view always reflects the current vault. Names are 1-80 characters and unique case-insensitively; up to 100 views. Renames and filter changes use the same revision rule as notes (`409` on a stale `revision`). A view that names a folder or tag that no longer exists simply lists nothing.

```json
{ "id": "…", "name": "Client work", "filters": { "view": "all", "q": "", "sort": "updated", "tag": "acme" }, "revision": 1, "createdAt": "…", "updatedAt": "…" }
```

## Managed Markdown Export

A one-way export of every active note into a folder the server owner chooses, such as an Obsidian vault. The folder is configured only on the server, with `OPENPLOD_EXPORT_DIR` (an absolute path to an existing folder); there is no API for choosing a path. Without it, `GET /exports/markdown` reports `configured: false` and a run returns `503`.

Each note becomes `<folder path>/<title>.md`, following the note's folder tree, with names made portable (no path separators, reserved or control characters). The file starts with YAML front matter: `openplod_id`, `title`, `revision`, `updated`, `tags`, and when present `source_recording`, `source_version`, `source_origin`, and `properties`. The body is the saved Markdown, unchanged.

`.openplod-export.json` in the folder records, per note, the path and SHA-256 of what OpenPlod last wrote. Each run compares the file on disk against it:

| `action` | Meaning |
| --- | --- |
| `created` | New note, written to a free path. A file OpenPlod does not own is never replaced; the note gets `Title (2).md` instead |
| `updated` | The file still matched the manifest and was replaced with the new text |
| `moved` | The note was renamed or moved; the new file was written and the old one removed, because it still matched the manifest |
| `unchanged` | Nothing to do. Only counted, not listed |
| `conflict` | The file was edited (`modified_externally`), deleted (`deleted_externally`), or replaced by a folder or symlink (`not_a_file`) outside OpenPlod. It is left alone |
| `orphaned` | The note is in Trash or purged. Its file and manifest entry are kept, never deleted |

A conflict is only resolved by naming that note in `overwrite` on a confirmed run, which replaces or recreates its file; symlinks are never followed or replaced. Run `{ "dryRun": true }` first: it reports exactly the same actions without writing anything. A real run requires `confirm: true`. Writes go through a temporary file and an atomic rename, and only one export runs at a time (`409 export_running`). An invalid manifest stops the run with `409 manifest_invalid` before anything is written; move it aside to start over. If a run fails midway, the manifest still records the files it wrote, so the next run does not treat them as foreign.

Response: `{ root, dryRun, exportedAt, counts: { created, updated, moved, unchanged, conflict, orphaned }, items: [{ documentId, title, path, action, reason? }] }`. Attachments are not exported; notes reference their source recording and transcript version by id.

## AI Chat Conversations

Saved chat conversations live under `/api/ai`, outside the versioned `/api/v1` contract:

| Method | Path | Request / behavior |
| --- | --- | --- |
| GET | `/conversations?archived=false` | Up to 30 conversations, newest activity first: `{ id, title, question, recordingIds, createdAt, turns, archived }`. `archived=true` lists the archive instead |
| GET | `/conversations/:id` | Every saved answer, with sources and citations |
| PATCH | `/conversations/:id` | `{ title?: string \| null, archived?: boolean }`; metadata only, saved answers are never changed. `title: null` returns to the first question |
| GET | `/conversations/:id/export?format=md` | The complete conversation as Markdown, each cited quote resolved to its recording, timestamp, and transcript version; `format=json` returns every saved answer |

`question` is the latest question asked. Asking a follow-up question in an archived conversation returns it to the main list. Conversations whose sources are in Trash are not listed or exported.

## Processing Jobs

`/api/v1/jobs` is a stable, read-mostly view over the durable processing queue. It never submits work: transcription and forwarding jobs are created by import, reprocess, and batch flows, which keep their per-recording idempotency (a retried submission for a recording with a queued or running job returns that job rather than creating a second one or a second paid call). Fields may be added within `/api/v1`; existing fields keep their meaning.

```json
{
  "id": "5f0c…",
  "type": "process-recording",
  "state": "complete",
  "createdAt": "2026-10-12T09:00:00.000Z",
  "startedAt": "2026-10-12T09:00:01.000Z",
  "completedAt": "2026-10-12T09:02:10.000Z",
  "error": null,
  "recordingId": "8a1e…",
  "provider": "mistral",
  "priority": 0,
  "checkpoint": { "phase": "polling", "remoteId": "provider-job-id" },
  "resultRefs": { "transcriptVersionIds": ["5f0c…"] }
}
```

`state` is `pending`, `running`, `complete`, `failed`, or `cancelled`. `GET /jobs` accepts `state`, `type`, `recordingId`, `offset`, and `limit` (maximum 100) and returns `{ jobs, total, offset, limit, stats }`. Unknown ids return `404` with `code: "job_not_found"`; cancelling a finished job returns `409` with `code: "job_not_cancellable"`. Cancelling affects only the named job, never other work on the same recording.

After a restart, a job interrupted before the provider confirmed receipt is marked `failed` (and its recording shows the failure) rather than resubmitted, because the provider may already have billed it. A job with a known remote id resumes polling. Finished jobs are kept for 30 days (at most 1,000) and pruned at startup.

The older `GET /api/jobs`, `POST /api/jobs/:id/cancel`, `POST /api/jobs/:id/resume`, and `PATCH /api/jobs/:id` keep their shape; job objects there gain an optional `startedAt`.

## Create and Update a Note

Example request body for `POST /api/v1/documents`:

```json
{
  "title": "Weekly review",
  "content": "# Weekly review\n\n- [ ] Review the onboarding flow\n",
  "folderId": null,
  "idempotencyKey": "12345678-1234-4234-8234-123456789abc"
}
```

Use a fresh UUID for each logical create, and reuse it only for retries of the exact same request. A duplicate key with different content returns `409`. Subsequent edits use `PATCH /documents/:id`, for example `{ "revision": 1, "content": "# Updated note\n" }`.

Snapshot imports deduplicate by recording plus transcript version (or content fingerprint for a legacy unversioned transcript). Saving the same snapshot returns its existing note, including if it is in Trash or was moved/edited. It does not silently restore, move, or replace that note. A new source transcript version can be saved separately.

### Mistral Documents

The UI's **Create document** action generates structured Markdown using `mistral-small-latest` and the Mistral key in desktop Settings (or `MISTRAL_API_KEY`). It does not call the snapshot endpoint. A request contains `{ idempotencyKey, recordingId, versionId?, title, style?, instructions? }`, where `style` is `notes`, `meeting`, or `brief`. The server retrieves the selected saved transcript and sends its text, title, and optional writing instructions to Mistral. Original audio is not sent by this operation.

Generation streams truthful workflow stages and returns a reviewable draft. Only `/generations/:id/save` creates a note. Provider errors, cancellation, invalid output, and the 90-second timeout never fall back to a copied transcript. Inputs above 100 KB are rejected without truncation. At most two generations run concurrently per desktop service. Reusing a completed request ID returns its existing result; pending or failed IDs are not automatically retried. Failed/restarted requests require an explicit new generation.

The saved document preserves source recording/version references, a generated initial version, provider/model provenance, and a private generation trace. Subsequent user edits use normal note revisions. Uncommitted generation drafts older than 24 hours are cleaned up when another generation starts; saved traces are removed when their document is permanently purged. These AI outputs can contain mistakes and should be reviewed before saving or sending.

Note history includes saved content and metadata changes. Restoring history copies its title and Markdown into a new revision; it does not rewind the current folder, star state, or source provenance. Expired note and recording Trash is purged when the backend starts and every six hours while it runs. This is retention cleanup, not forensic secure erasure.

## Send to a Destination

The server only sends to named destinations configured by its owner. There is no API for supplying an arbitrary URL, headers, or credentials with a send request. Configuration requires a private JSON file owned by the server user, mode `0600` on macOS/Linux:

```text
~/Library/Application Support/com.openplod.vault/openplod-destinations.json
```

A source-run backend defaults to the parent of `OPENPLOD_LIBRARY_PATH`, usually `./data/openplod-destinations.json`. Override it with `OPENPLOD_DESTINATIONS_FILE`. Example configuration (replace placeholders locally, never commit real URLs containing secrets):

```json
[
  {
    "id": "workflow",
    "name": "My automation",
    "url": "https://automation.example.com/hooks/openplod",
    "bearerToken": "replace-with-your-private-receiver-token"
  }
]
```

Destinations must use HTTPS without URL user credentials or fragments. Configuration is local administrative authority: choose hosts you trust with the document. Requests use a 10-second timeout, reject redirects, and send:

```json
{
  "schemaVersion": "1",
  "event": "document.export",
  "deliveryId": "12345678-1234-4234-8234-123456789abc",
  "document": {
    "id": "12345678-1234-4234-8234-123456789abd",
    "title": "Weekly review",
    "content": "# Weekly review\n",
    "revision": 2,
    "sourceRecordingId": null,
    "sourceVersionId": null
  }
}
```

Headers are `Content-Type: application/json`, `Idempotency-Key: <deliveryId>`, and optional bearer authorization. This generic contract can be received by an n8n workflow or your own service; Slack, Notion, and other SaaS APIs require a receiver that maps the payload to their specific API. No SaaS account is automatically connected.

Delivery state is `pending`, `sent` (HTTP 2xx accepted), or `unknown`. A timeout, rejected redirect, network failure, or non-2xx response is not proof that the receiver performed no work. The attempt is persisted before sending; reusing its idempotency key retrieves the same attempt without another POST. There are no automatic retries. Check the destination before explicitly starting a new delivery with a new key. A stale pending attempt becomes unknown when delivery history is read after 60 seconds.

## Existing Audio APIs

### Subtitle export

`GET /api/recordings/:id/transcript/subtitles`

Without `format`, returns whether the saved transcript can become subtitles:

```json
{ "success": true, "data": { "exportable": false, "reason": "no-timing",
  "detail": "The transcription provider returned no timings for this recording. Subtitles need real start and end times.",
  "cueCount": 0, "formats": [] } }
```

`reason` is one of `no-segments`, `no-timing`, `invalid-timing`, `empty-text`, or `null` when exportable.

| Query | Meaning |
| --- | --- |
| `format=srt\|vtt` | Download the subtitle file instead of the readiness report |
| `versionId=<id>` | Export a stored transcript version rather than the current one |
| `speakerLabels=1` | Prefix each cue with `Speaker N:` for diarized speakers, or the speaker's name once renamed |

Returns `409` with the refusal reason when a format is requested for a transcript without usable
timings; timings are never invented or interpolated. `400` for an unsupported format, `404` when no
saved transcript exists.

The existing `/api/recordings`, `/api/transcripts`, `/api/plaud`, and `/api/mobile` routes are unchanged apart from accepting the optional API token through the shared authentication gate. Plaud extraction and recording ownership are not routed through the organizer. See [README.md](../README.md) for hardware and privacy limitations.
