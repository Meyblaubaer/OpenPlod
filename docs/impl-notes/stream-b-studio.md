# Stream B: Transcript Studio follow-ups (TS-06, TS-09, TS-10, TS-11)

Implementation notes for the 0.6.0 Transcript Studio items that had only partial
implementations. None of the roadmap checkboxes are changed here: every item below is
contract-tested with injected fetchers and transcribers, but none has been run against
a live provider or real audio.

## TS-06: saved structure per transcript version

**What exists now**

- `src/library/structure-store.ts` adds the `transcript_structures` table
  (`CREATE TABLE IF NOT EXISTS` plus an index, created when the store is first used).
  It is additive and idempotent, and it cascades when the recording is purged.
- Extracting (`POST …/transcript/structure`, optional `{ versionId }`) still only
  proposes. The server keeps the proposal in memory under a one-time `proposalId` (1 hour
  TTL, capped at 100) and returns it with the structure.
- `POST …/transcript/structures { proposalId }` saves. The client never sends a
  structure body, so every stored timestamp was resolved by the server from its own
  segments, as before. Regenerating adds a new row. Earlier rows are kept until someone
  explicitly deletes them.
- `GET …/transcript/structures`, `GET …/:structureId[?format=]` and
  `DELETE …/:structureId`. A row is `current` while its `version_id` is still the
  transcript's current version. Legacy transcripts without a version ID fall back to a
  source-text hash.
- Studio → Structure: Analyse/Regenerate shows an unsaved preview with Save/Discard. A
  history selector labels rows made from an older transcript version. Every export format
  is downloaded from the saved row, so no provider call is made. Delete asks for
  confirmation.
- Unknown owners and due dates stay `null` through save, list and every export.

**Decisions**

- Proposals live in memory, not in the database. A restart drops unsaved previews, and
  the person has to run the analysis again. That avoids writing unreviewed AI output to
  the vault.
- The old `POST …/structure?format=` download (which re-runs extraction) is kept for API
  compatibility. The UI no longer uses it. Its `window.open` against a POST route could
  not have worked anyway.

## TS-09: server-side PDF

- `src/library/pdf.ts` is a dependency-free PDF writer. It supports title, heading,
  paragraph with an optional bold prefix, bullet, note, word wrap, hard breaks for
  over-long words, page breaks, keep-with-next for headings, and an "N of M" footer.
- Fonts are the standard-14 Helvetica family with WinAnsiEncoding, so no font is
  embedded. Text that WinAnsi cannot represent is handled in this order:
  1. typographic substitutes are applied;
  2. diacritics are stripped (Ł→L, ā→a);
  3. anything left is drawn as `?`. The count is reported, and the PDF carries a visible
     note that points to the Markdown/text/JSON exports, which keep the exact text.
- The metadata title is UTF-16, so it is exact.
- The file is 7-bit ASCII: hex strings and uncompressed streams. That lets it travel
  through the existing text-only export paths (`exportDocument`, the Tauri
  `export_document` command and the Android share). The output was checked with `qpdf
  --check`, `pdftotext` and a rendered page.
- `GET /api/recordings/:id/transcript/pdf[?versionId=]` renders the selected saved
  version. Timestamps appear only when `subtitleReadiness` says the timings are genuine.
- Structure exports gained a `pdf` format.
- UI: the recording Export menu and the Transcripts reader menu have a PDF item. The
  recording menu uses the version being viewed. The Studio structure export row has PDF.
- Tauri `export_document` now accepts `csv`, `html` and `pdf` extensions, and the Android
  `PlaudExports.document` accepts the matching MIME types. Both are one-line changes.
  Neither the Rust nor the Kotlin change was compiled in this worktree.
- Existing Markdown, text and JSON exports are unchanged.

**Limitations**

- There is no CJK/Arabic/Cyrillic glyph support. Those scripts appear as `?` with the
  note. Embedding a Unicode TrueType subset would fix this, but it was out of scope for a
  dependency-free writer.
- There is no right-to-left layout, no hyphenation, and no tables. Action-item
  owners/dues are printed inline.

## TS-10: batch document generation

- `src/library/batch-documents.ts` provides the options schema (template, instructions,
  folder, `expectedProvider`), candidate selection (active and with transcript text), the
  estimate, the folder check, and the per-item runner. The runner calls
  `DocumentGenerationService.generate` and then `save`. Each item therefore gets the same
  prompt rules, the 100 KB limit, the provider-change check and the provenance as a
  hand-made document.
- `POST /batch/estimate` and `POST /batch` accept `kind: "document"`. Starting a batch
  needs `confirm: true` and the `expectedProvider` the person saw. A mismatch returns
  `409 provider_changed`. A retry reuses the stored options of the original batch, so it
  cannot quietly change the template, folder or provider.
- Document batches use their own `BatchManager(1)`, which runs one provider call at a
  time. They also use their own `DocumentGenerationService` instance, created lazily in
  `recordings.ts`. `GET /batch/:id` and cancel look in both managers.
- UI: `BatchTranscribe` gains a Transcribe / Create documents switch. The document setup
  step shows:
  - the template, the folder and optional instructions;
  - a checklist of transcribed recordings, all selected by default;
  - one sentence naming the provider and model, stating that transcript text is sent and
    may be billed per token, giving no cost figure, and saying that each item creates a
    new note.

  A provider configuration error is shown and disables Start. Progress, cancel and
  "Retry N failed" work as for transcription. Failures are listed by recording title.
- Template labels were added to `web/src/lib/notes-api.ts` as `DOCUMENT_STYLE_LABEL`.
  `NoteDialogs.tsx` still has its own copy, which was left alone to avoid touching
  another stream's file. These could be consolidated.

**Decision:** confirming the batch is the review step. Items save directly into the chosen
folder instead of producing per-item previews, because per-item review does not scale to a
batch. The scope (which recordings, provider, template, folder) is shown before anything
runs. Nothing existing is overwritten: each item creates a new note that records its source
version.

## TS-11: compare two transcription providers

- `src/jobs/queue.ts` adds an optional `dedupeKey` on `Job` and an `options.dedupeKey`
  parameter on `JobQueue.add`. A keyed job:
  - is deduplicated by its key, not by recording;
  - is ignored by `activeJob()`, so reprocess and transcription batches still see only the
    normal job;
  - never changes `recordings.status` on cancel, resume or restart recovery.

  Unkeyed behaviour is unchanged. The diff is small and isolated (about 20 lines, half of them a doc comment), so it
  should merge cleanly with stream A's retry and progress work.
- `src/library/provider-compare.ts`:
  - `prepareComparison` validates the request: active recording, existing transcript,
    `confirm: true`, a configured provider, and the privacy mode. It builds the
    configuration for the chosen provider only, with no fallback and no profile. Hints
    that provider cannot take are dropped and recorded as `ignoredHints`.
  - `queueComparison` adds a `process-recording` job with
    `dedupeKey = compare:<recording>:<provider>`.
  - `runComparison` is the handler. It checks that the audio fingerprint is unchanged
    before and after the provider call, refuses a result from a different engine, and
    saves one `generated` version under the job ID with `provenance.comparison = true`.
    It never touches `transcripts`, the recording status or the revision.
- `src/index.ts`: one line at the top of the `process-recording` handler routes
  `data.compare` jobs to `runComparison`, plus one import.
- Routes: `GET`/`POST …/transcript/provider-comparisons`.
- Studio → Versions:
  - version labels show the recorded provider and model, and "comparison run";
  - a "Compare transcription providers" section has a provider picker (configured
    engines only) and a required acknowledgement checkbox. The checkbox says the full
    audio is uploaded again and may be billed. For Whisper it says the audio is
    transcribed locally;
  - a run list polls while a run is pending;
  - a "Compare <A> with <B>" shortcut picks the latest version of each provider and
    reuses the existing diff, with a header naming both providers;
  - promotion stays the existing explicit "Make current".

  The pairing logic lives in `web/src/lib/provider-versions.ts`.

## Tests added

- `src/library/pdf.test.ts`: encoding, xref and stream-length validity, wrapping and
  paging, replacement note, the transcript PDF with and without timings, and the
  structure PDF.
- `src/library/structure-store.test.ts`: idempotent table, propose versus save, save-once,
  expiry, history and staleness, legacy hash, scoped delete, and cascade.
- `src/library/batch-documents.test.ts`: candidates, estimate, provider error, folder
  check, a full run with folder and provenance, retry-failed-only (no second send),
  cancel, and provider change. All use an injected `GenerationFetch`.
- `src/library/provider-compare.test.ts`: confirmation and provider checks, hint
  dropping, dedupe alongside a normal job, the recording status left untouched on cancel
  and restart, an independent unpromoted version, engine mismatch, fingerprint change,
  failure and cancel, and the queue end-to-end. All use an injected transcriber.
- `src/api/studio-routes.test.ts`: the route-level path for all four items on the
  throwaway test vault. The only AI path uses a stubbed `globalThis.fetch`. Nothing
  reaches the network.
- `web/src/lib/provider-versions.test.ts`.
- `src/library/structure-export.test.ts`: `pdf` is now a supported format.

## Not done or not verified

- No live-provider or real-audio run of any of the four items. The roadmap exit gates
  still apply.
- The Rust (`desktop_exports.rs`) and Kotlin (`PlaudExports.kt`) allow-list changes were
  not compiled here.
- No PDF glyph embedding for non-Latin scripts (see TS-09 limitations).
- Subtitle downloads in the Structure tab still use `window.open` (unchanged). On a paired
  desktop that requires a token, they may need the authenticated download path used by
  the other exports.
- Unsaved structure proposals and document batches are in memory and do not survive a
  server restart. Saved structures, saved notes and comparison versions do.
- CHANGELOG, README and ROADMAP are intentionally untouched. The release owner should add
  entries.
