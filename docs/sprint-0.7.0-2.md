# Sprint Plan - 0.7.0 Sprint 2

| Field | Value |
| --- | --- |
| Status | Implemented 2026-10-14; released in [1.0.0](../CHANGELOG.md#100---2026-10-15); milestone exit gate not run |
| Window | 2026-10-13 to 2026-10-26 (two weeks) |
| Milestone | 0.7.0 - Knowledge, Chat, and Automation |
| Base | [0.7.0 Sprint 1](sprint-0.7.0.md) (`d42d312`) |
| Roadmap items | KB-01, KB-02, KB-03, KB-07 |

## Outcome

Everything committed below is implemented with automated tests. Nothing here marks a roadmap
checkbox complete; KB-01, KB-02, KB-03, and KB-07 stay open until the 0.7.0 exit gate.

| ID | Result | Evidence |
| --- | --- | --- |
| KB-01c | Done. Additive `note_views` table; `/api/v1/views` CRUD with revision checks and unique names; Notes sidebar lists views, "Save as view" from any filter, rename and delete | `src/organizer/organizer.test.ts` (round-trip, live listing, duplicate names, stale revision, pagination not savable, re-initialization); browser check at desktop and phone width |
| KB-02a | Done. `MarkdownExporter` and `/api/v1/exports/markdown`; folder tree mirrored, YAML front matter, `.openplod-export.json` manifest, dry run, per-note overwrite, atomic writes; Notes "Export to folder" dialog | `src/organizer/markdown-export.test.ts` (dry run writes nothing, idempotent re-run, update, move, external edit and deletion are conflicts, foreign files and duplicate titles, Trash keeps files, symlinks, invalid manifest, path escape, unset folder, HTTP contract); browser check |
| KB-03a | Done. `ai_conversations` metadata table; rename, archive and restore, archived listing, full Markdown/JSON export; AI history row menu | `src/organizer/recording-ai.test.ts` (rename, archive, follow-up restores, export resolves sources, HTTP contract); browser check |
| KB-07 | Done. `list_saved_views`, `get_markdown_export_status` | `src/mcp/server.test.ts` (present without the write flag, GET-only) |

Decisions taken on the open questions below:

- **The export folder is server configuration** (`OPENPLOD_EXPORT_DIR`), like destinations, and
  never an API argument, so a token holder cannot make the vault write anywhere on disk.
- **Exports never delete a user's file.** A trashed or purged note's file is kept (`orphaned`).
  The only removal is the old copy of a moved note, and only while it still matches the manifest.
- **Conversation metadata has no revision.** Title and archive state are last-write-wins
  metadata. Saved answers are never changed.

Not claimed:

- **Attachments** in the export. Notes carry no attachments today; source recordings are
  referenced by id in the front matter, not copied.
- **A folder picker.** The export folder is set by environment variable only. A native picker for
  the desktop app needs a Tauri command and a way to persist the choice outside the API.
- **Recording collections** (the rest of KB-01), and pinned sources, project context, and
  suggested follow-up questions (the rest of KB-03).
- Export runs through MCP. They write to the filesystem, so they stay a UI and REST action.

## Sprint Goal

Let a person keep the knowledge OpenPlod produces: return to a filtered set of notes in one click,
mirror notes into an Obsidian folder without risking edits made there, and name, archive, and
export whole chat conversations.

Like Sprint 1, this adds no live-provider dependency and no second storage stack.

## Why This Scope Next

- KB-02 is the most-requested missing piece of the milestone and needs only a filesystem
  contract, which this sprint defines. Bidirectional sync stays after 1.0.
- Saved views reuse the Sprint 1 list filters directly (tags, folders, search), so they cost one
  table and close a visible gap in KB-01.
- KB-03 rename, archive, and export work on answers that are already saved. They need no new
  provider call, unlike pinned sources or suggested follow-ups.
- KB-04, KB-05, KB-08, and KB-09 still need a storage, delivery, or provider design first.

## Committed Scope

| ID | Deliverable | Primary modules | Done evidence |
| --- | --- | --- | --- |
| KB-01c | Saved document views | `src/organizer/store.ts`, `schemas.ts`, `src/api/organizer.ts`, `web/src/pages/NotesPage.tsx` | unit tests, Notes UI check |
| KB-02a | Managed one-way Markdown export | `src/organizer/markdown-export.ts`, `src/api/organizer.ts`, `web/src/components/MarkdownExportDialog.tsx` | unit tests against a real temporary folder, UI check |
| KB-03a | Conversation rename, archive, export | `src/organizer/recording-ai.ts`, `src/api/recording-ai.ts`, `web/src/pages/AiPage.tsx` | unit tests, UI check |
| KB-07 | MCP read tools for views and export status | `src/mcp/server.ts`, `src/mcp/client.ts` | MCP server tests |

## Ticket Detail

### KB-01c - Saved document views

Tasks:

- Additive `note_views(id, name, filters, revision, created_at, updated_at)` with a
  case-insensitive unique name index.
- `filters` reuses the `GET /documents` schema without `offset` and `limit`.
- `GET/POST /views`, `PATCH/DELETE /views/:id` with the existing `409` revision contract.
- Notes: a Saved views group in the sidebar; "Save as view" when any filter is active; rename and
  delete from the list header menu. An applied view's stored filters drive the list until a
  filter is changed by hand, so combinations the sidebar cannot show (a folder and Starred) still
  list correctly.

Acceptance:

- A view lists the current matching notes, not a stored snapshot.
- Duplicate names and stale revisions are rejected; pagination cannot be saved.

### KB-02a - Managed Markdown export

Tasks:

- `OPENPLOD_EXPORT_DIR` names an existing absolute folder. Status reports configured, last run,
  and tracked note count.
- Mirror the folder tree; portable file names; YAML front matter carrying id, title, revision,
  updated time, tags, source recording and version, and properties.
- `.openplod-export.json` records path and SHA-256 per note. Compare before every write.
- Dry run first; a real run requires `confirm: true`; conflicts are only replaced when the note is
  named in `overwrite`.
- Atomic writes, one run at a time, paths confined to the root, symlinks never followed.

Acceptance:

- A file edited, deleted, or replaced outside OpenPlod is never overwritten silently.
- A file OpenPlod did not write is never replaced; the note gets a suffixed name.
- Running the export twice with no changes writes nothing.
- A trashed note's file is kept.

### KB-03a - Conversation rename, archive, and export

Tasks:

- Additive `ai_conversations(id, title, archived_at, updated_at)`; list returns `title`, `turns`,
  and `archived`, and `?archived=true` lists the archive.
- `PATCH /api/ai/conversations/:id` and `GET /api/ai/conversations/:id/export?format=md|json`.
- A follow-up question returns an archived conversation to the main list.
- AI history: a per-row menu with rename (inline), archive or restore, and both exports.

Acceptance:

- Renaming or archiving never changes a saved answer.
- The Markdown export resolves every cited quote to its recording, timestamp, and transcript
  version.

## Deferred / Explicitly Out of This Sprint

- **KB-01** recording collections.
- **KB-02** attachments, a desktop folder picker, and any form of import or bidirectional sync.
- **KB-03** pinned sources, project context, and suggested follow-up questions.
- **KB-04** hybrid retrieval, **KB-05** AI suggestions, **KB-08** signed webhook events,
  **KB-09** rules, and **KB-10** connectors, for the reasons given in Sprint 1.

## Definition of Done

- Merged implementation with automated tests, `bun run typecheck`, and frontend lint/build passing.
- Migrations are additive and re-runnable; no existing table changes shape.
- `docs/api.md`, `docs/mcp.md`, README, ROADMAP, and CHANGELOG updated.
- No roadmap checkbox is marked complete by this sprint alone.

## Risks and Open Questions

- **Obsidian property layout.** OpenPlod properties are nested under one `properties` key so they
  cannot collide with reserved front-matter keys. Obsidian's property panel shows them as one
  object; flattening would need a collision rule.
- **Very large vaults.** The exporter reads notes in pages of 100 and hashes each exported file
  once per run. It has not been measured against the 10,000-note budget in REL-08.
- **Moved folders.** Moving a folder moves every note in it on the next export, one file at a
  time; a run that fails midway leaves both layouts until it is re-run.
