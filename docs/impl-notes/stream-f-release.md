# Stream F: Release Hardening (REL-02..REL-09)

Implementation notes for the 0.9.0 "Secure, Recoverable Beta" items handled in this stream.
Nothing here checks a roadmap box: each item below says what is implemented, what was measured,
and what still needs hardware, a second tester, or a real release.

## REL-02 Transfer-tail checksum

**Evidence search.** The repository has no captured real transfer with its tail value: no
fixtures, no saved `device-original.plaud` plus tail, no vendor protocol notes. The Rust bridge and
Swift scripts only relay bytes; the Kotlin and TypeScript protocol code parse the value without
computing anything. The only tail in the tree is the synthetic test packet `0xffff` over
`01 02 03 04`, which matches none of the candidates (asserted in a test). The developer machine's
vault had no originals either. So no variant can be confirmed.

**Implemented (detection mode).** `src/sync/transfer-checksum.ts` computes 11 CRC-16 variants
(CCITT-FALSE, XMODEM, KERMIT, X-25, MCRF4XX, GENIBUS, SPI-FUJITSU, MODBUS, ARC, USB, UMTS), each
tested against its published check value, in both byte orders. `CONFIRMED_TAIL_ALGORITHM = null`,
so the status is always `unverified-algorithm`; candidate matches are recorded as evidence in
`provenance.json`. With a confirmed algorithm, a mismatch throws `TransferChecksumMismatch`, moves
the `.part` to `incoming/plaud-quarantine/` (kept, not deleted) and imports nothing. Android
mirrors this in `DirectPlaudChecksum.kt`, writing `<stem>.tail.json`, and renames mismatched
parts to `<stem>.mismatch-<time>.part`. **The Kotlin was not compiled here** (no Android SDK on
this machine).

**Next step:** after a real import, read `tailChecksum.candidateMatches` from a few
`originals/*/provenance.json` files. If exactly one variant matches all of them, set it in both
places.

## REL-03 Atomic import

`importRecordingFile` now stages audio and sidecars in `recordings/.staging/<id>/` (fsync each
file, then the directory), renames into place, fsyncs the parent directories, and inserts the row
and deletes its `import_journal` row in one transaction. Disk space is checked with `statfs`
first (`InsufficientDiskSpaceError`, 64 MiB margin). Direct Plaud imports pass device bytes,
decoded Ogg and `provenance.json` as sidecars, so originals become visible together with the row;
before, they were written after the row commit. Duplicate imports only add missing sidecars and
never replace existing evidence. Replacement audio is fsynced before its rename.

Startup recovery (`recoverInterruptedImports`, run from `prepareVault`) completes placed imports
whose audio hash matches, moves everything else to `incoming/recovered/<id>/`, and reports
orphaned files without deleting them (`GET /api/vault/recovery`).

Not done: a fault-injection test that kills the process between steps on a real filesystem; the
unit tests simulate each journal state instead.

## REL-04 Complete purge

`src/library/purge.ts` replaces the old row-and-audio delete. In one transaction: processing-job
payloads, `plaud_import_events`, `note_generations`, known search/embedding tables
(`search_passages`, `embeddings`, `recording_embeddings`, `passage_embeddings`, `embedding_chunks`,
`search_index`, each only if present with a `recording_id` column), registered hooks, a
`recording_purges` row, then the recording (FK cascades remove transcripts, versions,
analyses, bookmarks, and FTS rows via triggers). After commit: audio, `originals/<id>/`, matching
resume/quarantine parts, then `afterCommit` hooks. The in-memory job queue registers a hook.

Choices: AI turns citing the recording are **redacted** (question/answer removed, `state='purged'`)
rather than deleted, and documents are **kept but unlinked**; see `docs/recovery.md#purge`.
Hook point for stream E: `registerPurgeHook({ name, inTransaction, afterCommit })` receives the
source provider/ID and fingerprint, enough to write a `sync_tombstones` row. Nothing propagates to
peers yet.

## REL-05 Backup and restore

`src/vault/{tar,backup-crypto,backup}.ts`, `src/api/vault.ts`, and the Settings "Backup & restore"
wizard (`web/src/components/BackupRestorePanel.tsx`). Format and behaviour are documented in
`docs/backup-and-restore.md`. Tests cover a plain round trip with path rewriting, tampering,
truncation, encrypted round trip, wrong passphrase, damaged and cut ciphertext, non-empty target
refusal, the live-vault refusal, and moving existing files aside. Not done: a real multi-GB vault
restored on a second machine, and an independent review of the encryption format.

## REL-06 Hardening

- API keys: AES-256-GCM at rest with `vault.key` (0600), transparent migration, env fallback
  (`src/vault/secrets.ts`). Readers updated: `readSettings`, the job handler in `src/index.ts`,
  `recording-ai.ts`, `generation.ts`, `forwarding.ts`. Writers: `/api/settings/:key`, `/api/ai-settings`.
- `hono/logger` replaced by `redactingLogger` (query secrets, token-like path segments).
- Data dir and library 0700, database and WAL/SHM 0600, tightened on start (Unix).
- Optional TLS (`OPENPLOD_TLS_CERT`/`OPENPLOD_TLS_KEY`) and a startup warning for plain HTTP on a
  non-loopback host. The desktop app binds `0.0.0.0`, so it shows that warning until TLS is set.
- Not done: revocation and per-client scopes (MOB-06), MCP scope changes, certificate provisioning
  for the desktop app and the Android client trusting it.

## REL-07 Packaging

- `tauri-plugin-updater` 2 registered on desktop; `plugins.updater` in `tauri.conf.json` with an
  empty `pubkey` and the GitHub `latest.json` endpoint; `createUpdaterArtifacts: false` by default.
- `scripts/release-config.ts` writes `src-tauri/tauri.release.conf.json` from the environment
  (updater public key, macOS signing identity); `.github/workflows/release.yml` builds macOS arm64,
  Linux x64 and Windows x64 bundles on `v*` tags, exports only the secrets that exist, writes
  `SHA256SUMS.txt`, and drafts a release whose notes say when artifacts are unsigned.
- Schema downgrade guard in `src/db/vault-meta.ts` (`vault_meta.schema_generation` plus
  `PRAGMA user_version`), called before any migration.
- `cargo check` of `src-tauri` passed on Linux x64 with the updater plugin (placeholder sidecar
  binaries). The workflow has not run on GitHub yet; no update UI exists, and no runtime
  dependency (ffmpeg, whisper.cpp) is bundled.

## REL-08 Benchmark

`bun run bench` (`scripts/benchmark.ts`) seeds a temp vault with a synthetic, clearly labelled
fixture and measures the in-process API. Run on 2026-10-15:

- Machine: Linux 7.2.5 (Omarchy), Intel Core Ultra 7 356H (16 threads), 31 GiB RAM, Bun 1.4.2.
- Fixture: 10,000 recordings, 100,000 segments (10 per transcript), seeded in 3.0 s.
- 200 samples each after 10 warm-up calls:

| Operation | p50 (ms) | p95 (ms) | max (ms) |
| --- | --- | --- | --- |
| list, 50 rows, random page (`GET /api/recordings`) | 2.36 | 7.65 | 26.67 |
| search, FTS, 1-2 terms (`searchTranscripts`) | 32.20 | 46.01 | 67.45 |
| detail, transcript and segments (`GET /api/recordings/:id`) | 0.29 | 0.37 | 5.57 |

On this machine all three are below the proposed budgets (300 ms list/search p95, 500 ms detail).
This is **not** the documented reference Mac the roadmap asks for, the calls skip HTTP and the
WebView, and the fixture text is repetitive, so it does not by itself close REL-08.

## REL-09 Accessibility (partial)

`scripts/check-a11y.mjs` (`bun run check:a11y`, uses `playwright-core` and `axe-core`, added as dev
dependencies) scans each main route with WCAG 2.0-2.2 A/AA axe rules on desktop and on a phone
viewport with reduced motion, and tabs through each page looking for focus without a visible
indicator. Against a fresh empty vault, its first run found one serious issue: `aria-label` on the
plain `div.brand` (`aria-prohibited-attr`). That is fixed in `Brand.tsx`; the rerun passed all 14
route/scenario pairs. Caveats: an empty vault mostly shows the first-run guide, so library-heavy
pages need a run against a populated vault; screen-reader and manual keyboard checks are still
needed; localization was left to the lead.

## Validation (this branch)

- `bun test`: 425 pass, 0 fail (49 files), including new tests for checksums, journal
  recovery, atomic import, purge, schema guard, secrets, logger, permissions, TLS options,
  backup/restore and the vault API.
- `bunx tsc --noEmit`, web `lint`, `tsc -b`, `bun test src` (33 pass), `bun run build`: pass.
- `cargo check` (src-tauri): pass. Android Kotlin: not compiled (no SDK here).
