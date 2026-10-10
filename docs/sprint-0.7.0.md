# Sprint Plan - 0.7.0 Sprint 1

| Field | Value |
| --- | --- |
| Status | Planned |
| Window | 2026-09-22 to 2026-10-05 (two weeks) |
| Milestone | 0.7.0 - Knowledge, Chat, and Automation |
| Base | 0.6.0 Transcript Studio, plus the batched-lookup maintenance pass (`780d5a7`) |
| Roadmap items | KB-01, KB-06, KB-07 |

## Sprint Goal

Make a saved document resolve to the exact transcript version it came from, make both
findable by tag and backlink, and expose the existing durable jobs through one read-only
status contract that API, MCP, and the UI can share.

This is the linkage layer of 0.7.0. It adds no live-provider dependency and no second
processing stack.

## Why This Scope First

- 0.6.0 shipped the Studio. The first thing the knowledge milestone needs is identity:
  `note_documents` already stores `source_recording_id`, `source_version_id`, and
  `source_origin`, but nothing reads them back as a backlink, and there is no way to tag a
  document or ask which documents cite a given version.
- KB-06 and KB-07 are safe to build now: `src/jobs/queue.ts` already persists jobs,
  checkpoints, cancellation, priority, and restart recovery. The sprint wraps that, it does
  not replace it.
- Everything else in 0.7.0 depends on a live provider or on a storage/delivery design that
  does not exist yet, so it is explicitly deferred below.

## Committed Scope

| ID | Deliverable | Primary modules | Done evidence |
| --- | --- | --- | --- |
| KB-01a | Document tags and properties | `src/organizer/schemas.ts`, `store.ts`, `src/mcp/server.ts`, `web/src/pages/NotesPage.tsx` | unit tests, typecheck, Notes UI check |
| KB-01b | Resolved source and backlinks to an exact transcript version | `src/organizer/store.ts`, `src/api/organizer.ts`, `web/src/pages/NotesPage.tsx` | unit tests, `bun run check:studio`/workspace UI |
| KB-06 | Unified versioned processing-job API | `src/jobs/queue.ts`, `src/index.ts`, `docs/api.md` | unit tests, restart/cancel tests, existing `/api/jobs` contract preserved |
| KB-07 | MCP source/version and job-status read tools | `src/mcp/server.ts`, `src/mcp/client.ts`, `docs/mcp.md` | MCP server tests, read-only boundary tests |
| MNT | Keep list paths query-bounded | `src/organizer/*`, `src/library/*` | regression test on query count |

## Ticket Detail

### KB-01a - Document tags and properties

**Intent.** A document carries a small, editable set of tags and schemaless properties
without turning into a second note store.

Tasks:

- Additive migration only. Add a `properties` JSON column to `note_documents` and a
  normalized `note_tags(document_id, tag)` table so `list()` can filter and reuse the
  existing FTS/sort path. Do not rewrite `note_documents`.
- Extend `createNoteSchema` / `updateNoteSchema` with optional `tags` and `properties`.
  Unknown property keys are preserved on update instead of dropped. Tag values are
  trimmed, lower-cased for comparison, and length-bounded.
- `list()` accepts `tag`; tag filtering composes with `view`, `folderId`, `q`, `starred`
  and still excludes Trash unless `view=trash`.
- Reflect tags and scalar properties in `get_document` and `list_documents` (MCP).
- Notes UI: a properties/tag editor with a tag filter chip row. No new page theme.

Acceptance:

- Existing documents load unchanged; an update that omits tags/properties preserves them.
- A tag filter returns only matching, non-trashed documents, and paginates correctly.
- Revision conflicts still fail with the existing `409` contract.
- A property value that is not a string is stored verbatim, not stringified on read-back.

### KB-01b - Resolved source and transcript-version backlinks

**Intent.** A document states which exact transcript version it was written from, and a
transcript version can list the documents that cite it.

Tasks:

- Add an index on `note_documents(source_recording_id, source_version_id)`.
- Add `GET /api/v1/documents/:id/source` returning the resolved recording filename,
  `source_version_id`, `source_origin`, and a `stale` flag when the cited version is not
  the current one. A missing version returns an explicit `unknown`, never the current text.
- Add `GET /api/v1/transcript-versions/:id/backlinks` (or recording-scoped equivalent)
  returning the documents that cite that version, excluding Trash.
- Notes UI: a Source panel that shows the resolved version and its backlinks and links to
  the recording; unknown state is shown as unknown.

Acceptance:

- After a transcript version is promoted, a document that cited the old version keeps
  citing it and is reported `stale` rather than silently rewritten.
- A document with no source renders an explicit empty/unknown state, not a fabricated one.
- Backlinks never include deleted documents; restored documents reappear.

Explicitly out of KB-01 this sprint: recording collections and saved views.

### KB-06 - Unified versioned processing-job API

**Intent.** One stable, additive contract over the existing job queue.

Tasks:

- Wrap `process-recording`, `forward-recording`, and future analysis runs in a job
  descriptor: `id`, `type`, `state`, `createdAt`, `startedAt`, `completedAt`, `error`,
  `recordingId`, `provider`, `priority`, `checkpoint`, and `resultRefs` (e.g. generated
  transcript-version ids).
- Add `GET /api/v1/jobs`, `GET /api/v1/jobs/:id`, and `POST /api/v1/jobs/:id/cancel`.
  Keep `GET /api/jobs` and its current fields working; new fields are additive.
- Reuse the existing idempotency: a retried submission for the same recording must not
  create a second pending job or a duplicate paid call.
- Document the contract in `docs/api.md` with a stable-version note.

Acceptance:

- Restart recovery still marks an interrupted uncertain remote job as failed rather than
  resubmitting it, matching current `queue.ts` behaviour.
- Cancellation is scoped to the requesting client and does not cancel another client's
  transfer.
- Existing `/api/jobs` consumers see the same shape plus new optional fields.

### KB-07 - MCP source/version and job-status read tools

**Intent.** An MCP client can inspect sources and job state without gaining a write path.

Tasks:

- Add read tools: `list_transcript_versions`, `get_transcript_version`, `list_jobs`,
  `get_job`. Read-only by default, unchanged permission model.
- Return the resolved source version and `stale` flag from KB-01b where relevant.
- Record the new tools in `docs/mcp.md`, including that `get_job` never triggers a provider
  call and that unknown ids are errors, not empty results.

Acceptance:

- With `OPENPLOD_MCP_WRITE` unset, the new tools are present and no mutation tool is
  registered.
- A missing job/version id returns an error; error bodies stay redacted.
- No tool call performs a provider request or a write.

### MNT - Keep list paths query-bounded

- Preserve the batching from `780d5a7`: preloaded fingerprints, settings, folder parents,
  and transcript contexts.
- Add one regression test asserting a list/context endpoint issues a bounded number of SQL
  statements rather than one per row.

## Deferred / Explicitly Out of This Sprint

- **KB-02** managed Markdown/Obsidian export (needs a filesystem and collision contract).
- **KB-04** hybrid retrieval and embeddings (needs local-embedding storage and a Trash/purge
  policy first).
- **KB-05** AI tag/title suggestions and topic summaries (needs live providers).
- **KB-08** signed webhook events (needs a delivery-ID and uncertain-delivery design).
- **KB-09** opt-in import rules and **KB-10** task connectors (depend on KB-06 + KB-08).
- **AI-10** cloud spending limits and the **0.6.0 exit gate** real-audio acceptance remain
  open from earlier milestones.

## Definition of Done

- Merged implementation with automated tests, `bun run typecheck`, and frontend lint/build
  passing.
- Migration is additive and tested against a populated vault; no existing document,
  transcript, or job payload changes shape destructively.
- `docs/api.md` and `docs/mcp.md` updated with the new contracts.
- No roadmap checkbox is marked complete by this sprint alone. KB-01/KB-06/KB-07 stay open
  until their milestone exit gate is run. Sprint completion is not a release.

## Risks and Open Questions

- **Tags: freeform vs taxonomy.** This plan assumes freeform, normalized only for
  comparison. If a fixed taxonomy is wanted, it changes the schema in KB-01a.
- **Properties: schemaless vs typed.** Schemaless JSON is proposed for flexibility; a typed
  set would need validation rules and migration.
- **Job API location.** New endpoints go under `/api/v1` while `/api/jobs` is preserved. If
  `/api/jobs` is to be promoted instead, KB-06 and KB-07 change.
- **Backlink scope.** This plan indexes document → transcript version. If recording →
  document navigation is also required, the index and endpoint set grow.

## Tracking

- Reference `KB-01`, `KB-06`, `KB-07` in implementation PRs and issues.
- Update the 0.7.0 status note in [ROADMAP.md](../ROADMAP.md#070---knowledge-chat-and-automation)
  at sprint end with what passed, what is stubbed, and what is not claimed.
