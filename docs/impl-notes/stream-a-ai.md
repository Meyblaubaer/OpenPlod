# Stream A: AI providers (implementation notes)

Scope: AI-03, AI-04/05, AI-07, AI-08, AI-09, AI-10, AI-11, AI-13, AI-14. Everything here is
contract-tested with injected fetchers, splitters and engines. Nothing was checked against live
provider APIs or real long audio.

## AI-10 Spending limits (estimates, not caps)

- `src/ai/pricing.ts`: a dated price table (`PRICES_AS_OF = 2025-08-01`) and `PRICE_LABEL`.
  Known list prices: OpenAI `whisper-1` / `gpt-4o-transcribe` $0.006/min, `gpt-4o-mini-transcribe`
  $0.003/min, Mistral `voxtral-mini-latest` $0.001/min; text per 1M tokens for OpenAI
  `gpt-4.1-mini` / `gpt-4.1` / `gpt-4o-mini`, Anthropic `claude-sonnet-4-5` / `claude-haiku-4-5` and
  Gemini `gemini-2.5-flash`. **Deliberately `null` (estimate unknown)**: Deepgram (plan and add-on
  dependent), AssemblyAI (tier and add-on dependent), `mistral-small-latest` (moving alias), any
  model not listed, and every custom endpoint. Local providers are $0 and never recorded.
- New config fields: `monthlyBudgetUsd`, `confirmAboveUsd` (both nullable USD, null = off).
- `src/ai/spending.ts`: `ai_spend_ledger` table (CREATE TABLE IF NOT EXISTS). Transcription jobs
  write an `estimated` row before sending and settle it as `complete` (with reported usage),
  `failed`, `cancelled`, or `not-sent` (nothing left this computer; excluded from totals). Text
  requests are recorded after they finish, from reported token usage. Months are UTC calendar
  months. Unknown estimates are counted (`unknownEntries`), never guessed.
- Gate (`costGate` / `estimateRecordings`): confirmation is required when an estimate exceeds the
  per-job threshold, would take month-to-date over the budget, or is unknown while a limit is set.
  With neither setting configured nothing extra is asked (pre-1.1 behaviour).
- With fallbacks, the estimate uses the most expensive cloud provider in the chain; any unknown
  price makes it unknown. Chunked audio includes the billed overlap seconds.
- Endpoints: `GET /api/ai-settings/spending`, `POST /api/ai-settings/estimate`
  `{recordingIds, overrides?}`. `POST /api/recordings/:id/reprocess` and `POST /api/recordings/batch`
  return **409** `{code: 'cost_confirmation_required', data: <estimate>}` unless `confirmCost: true`.
  `POST /api/recordings/batch/estimate` now fills `estimatedCost` with the estimate object.
- The job handler re-checks the gate at run time (auto-transcribed imports included); confirmed
  jobs carry `costConfirmed: true` in their job data. A blocked job fails with "Nothing was sent".
- UI: estimate + acceptance checkbox in TranscribeDialog and BatchTranscribe; budget, threshold and
  month-to-date in AiSettingsPanel. Copy never says the provider enforces the cap.

## AI-08 Long-audio chunking, retries, progress

- `src/transcription/long-audio.ts`: `chunkPlan` splits only when the file exceeds the selected
  provider's `maxBytes` (OpenAI 25 MB, AssemblyAI 100 MB) or the new
  `transcriptionChunkAboveMinutes` setting (0 = size limit only). Chunks are 600 s with 2 s overlap,
  re-encoded with ffmpeg to 16 kHz mono 64 kbps MP3 in a temp dir (removed afterwards).
- **Overlap rule** (documented in the module): offset segment times by chunk start; for chunks after
  the first, drop a segment whose start is before the end of the last kept segment. If the segment
  has word timings, trim to words starting at or after that end instead. Known limitation: without
  word timings, speech in a dropped segment that runs past that end is lost (at most one segment
  per boundary).
- Chunking is refused (nothing sent) when: speaker labels are requested (labels are per chunk and
  cannot be reconciled), the model returns no timestamps (`gpt-4o-*-transcribe`, AssemblyAI without
  speaker labels), or the file is over the limit and its duration cannot be probed.
- All chunks use the primary provider only (`TranscriptionRouter.primaryOnly()`).
- Checkpoints now carry `inFlight`, `provider`, `progress {done,total}` and `chunks {plan, results}`.
  After each finished chunk `inFlight=false` and results are persisted, so a restart resumes after
  completed chunks; a chunk with a known AssemblyAI remote ID resumes polling.
- Queue (`src/jobs/queue.ts`): restart/resume now also accepts `inFlight === false`. Bounded
  automatic retries: at most 2 (5 s, 30 s backoff), only for errors marked `retryable` (currently
  ffmpeg split failures) and only when the checkpoint shows `inFlight === false` with no remote ID.
  Cloud failures after submission are never retried automatically.
- `/api/v1/jobs` descriptors gain `progress` and `attempts`; legacy `/api/jobs` trims the checkpoint
  (no chunk payloads) and includes progress. The settings job list shows "chunk n of m".

## AI-14 Gemini and restricted custom endpoint

- `gemini`: `POST .../v1beta/models/{model}:generateContent`, key in `x-goog-api-key` (never the
  URL), system instruction, `model` role mapping, JSON via `responseMimeType`, completion only on
  `finishReason: STOP`, thought parts excluded, usage from `usageMetadata`. Default
  `gemini-2.5-flash`. Check: `GET /v1beta/models`.
- `custom`: `customBaseUrl` must be HTTPS, or HTTP on loopback only (127.0.0.0/8, localhost, [::1]);
  no credentials, query or fragment; redirects refused (`redirect: 'error'`). Model name required.
  Key optional (`customApiKey`, never read from the environment). It is cloud unless loopback, so
  local-only mode allows it only on loopback. JSON mode is not requested; callers' own output
  validation applies. Check: `GET {base}/models`.

## AI-07 Text fallbacks

- `analysisFallback` / `documentFallback` / `chatFallback`: ordered `{provider, model}` lists (max 3).
  `textSelection` returns the primary plus usable fallbacks and lists `skippedFallbacks` (blocked by
  local-only or unconfigured). `completeText` tries them in order, never after a user cancel, and
  never moves to a cloud provider after a local context overflow. Privacy is re-checked before each
  send. The provider that answered and the failed attempts (`fallbackFrom`) are returned and stored.
- UI exposes one fallback per task, limited to cloud providers with default models (Ollama/custom
  fallbacks need a model field; the API accepts them).
- Note: the existing `expectedProvider` consent check covers the primary only; configuring a
  fallback in settings is the explicit consent for it.

## AI-03 AssemblyAI remote cancel

- `src/transcription/remote-cancel.ts`, registered with `jobQueue.onCancel(...)` in `src/index.ts`.
  On cancel with a remote ID, sends `DELETE /v2/transcript/{id}` (best effort, 15 s) and appends the
  outcome to the job error. It never claims billing stopped. Skipped (and said so) in local-only
  mode or without a key.

## AI-04 / AI-05 Capabilities

- `speechCapabilities` gains per-model `languages` (documented lists for Whisper/OpenAI and Voxtral;
  `null` for Deepgram and AssemblyAI) and `timestampGranularity` (`word`/`segment`/`none`).
  `validateSpeechOptions` rejects a language only when a documented list excludes it; profiles are
  validated too. Exposed through `GET /api/ai-settings`. Language pickers filter by it and keep a
  previously chosen undocumented language visible with a marker rather than dropping it.

## AI-09 Provenance

- `textProvenance` = `{provider, model, usage, startedAt, completedAt, fallbackFrom}`.
  `analyses.provenance` and `note_generations.provenance` columns (guarded ALTER), returned by
  `RecordingAnalyzer.analyze` and `DocumentGeneration.provenance`; chat answers carry the same
  fields. Transcript provenance gains `chunking` when chunked.

## AI-11 / AI-13

- `RecordingAi` and `DocumentGenerationService` no longer read `mistralApiKey` themselves; keys come
  from `textSelection` (which still reads the legacy `mistralApiKey` setting and `MISTRAL_API_KEY`).
  The optional constructor key source remains for tests. Chat SSE progress no longer hard-codes
  `provider: 'mistral'`.
- Ollama: `ollamaContextLength` via `POST /api/show` (`*.context_length`); `GET
  /api/ai-settings/ollama-context?model=`. Requests above the context (approximate, ~4 bytes/token)
  are refused before sending with a `ContextLimitError`; otherwise `num_ctx` is set so Ollama does
  not silently truncate. Settings show the window after "Load local models".

## Not done / follow-ups

- Per-transcript context warning inside the document and chat dialogs (other streams own those
  components); the server refusal message surfaces there instead.
- Prices are not verified live; review `pricing.ts` before release.
- AssemblyAI chunking only works with speaker labels off *and* timestamps on, which this adapter
  does not provide (it maps utterances only), so AssemblyAI long files are refused rather than
  chunked. Adding word-level parsing would enable it.
- Live acceptance against real providers and real long audio is still required.
