import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SpeechProvider } from '../ai/config';
import { speechCapabilities } from '../ai/capabilities';
import type { TranscriptionOptions, TranscriptionResult, TranscriptSegment } from './types';

/**
 * Long-audio chunking (AI-08).
 *
 * Audio is split only when necessary: when the file exceeds the selected
 * provider's documented upload limit, or when it is longer than the user's
 * configured chunking threshold. Chunks are CHUNK_SECONDS long and each one
 * (except the last) runs OVERLAP_SECONDS into the next, so no word is cut
 * without also being heard whole in a neighbour.
 *
 * Overlap reconciliation rule, applied in time order across chunks: segment
 * times are offset by their chunk's start; then, for every chunk after the
 * first, a segment that starts before the end of the last segment already kept
 * is in the overlap and is dropped. When the provider returned word timings,
 * the segment is trimmed to the words starting at or after that end instead of
 * being dropped whole. Without word timings, speech inside a dropped segment that
 * runs past that end is lost, at most one segment per chunk boundary; providers
 * that return no timestamps at all cannot be chunked, because their overlap
 * cannot be reconciled without duplicating speech.
 */
export const CHUNK_SECONDS = 600;
export const OVERLAP_SECONDS = 2;
export type ChunkSpec = { index: number; start: number; duration: number };
export type StoredChunk = { index: number; engine: string; fullText: string; segments: TranscriptSegment[]; duration: number; confidence: number | null; metadata: Record<string, unknown> };
export type ChunkState = { plan: ChunkSpec[]; results: StoredChunk[] };
export type LongCheckpoint = { phase: string; remoteId?: string; inFlight?: boolean; provider?: string; progress?: { done: number; total: number }; chunks?: ChunkState };
const transcriptionFailure = (engine: string, error: string): TranscriptionResult => ({ success: false, engine, error, fullText: '', segments: [], wordCount: 0, confidence: null, speakerCount: null, duration: 0 });
export class RetryableError extends Error { readonly retryable = true; }

/** Whether this provider needs the audio chunked, and how; null when the whole file can be sent. */
export function chunkPlan(provider: SpeechProvider, input: { durationSeconds: number | null; fileBytes: number | null; chunkAboveMinutes: number }, chunkSeconds = CHUNK_SECONDS, overlap = OVERLAP_SECONDS): ChunkSpec[] | null {
  const maxBytes = speechCapabilities[provider].maxBytes;
  const tooLarge = maxBytes !== null && input.fileBytes !== null && input.fileBytes > maxBytes;
  const tooLong = input.chunkAboveMinutes > 0 && input.durationSeconds !== null && input.durationSeconds > input.chunkAboveMinutes * 60;
  if ((!tooLarge && !tooLong) || input.durationSeconds === null || input.durationSeconds <= 0) return null;
  const plan: ChunkSpec[] = [];
  for (let start = 0, index = 0; start < input.durationSeconds; start += chunkSeconds, index++)
    plan.push({ index, start, duration: Math.min(chunkSeconds + overlap, input.durationSeconds - start) });
  return plan;
}

/** Merge chunk results in order, offsetting times and reconciling overlap by the rule documented above. */
export function mergeChunks(plan: ChunkSpec[], chunks: StoredChunk[], durationSeconds: number): TranscriptionResult {
  const segments: TranscriptSegment[] = [];
  let lastEnd = -Infinity;
  for (const chunk of chunks) {
    const offset = plan[chunk.index].start;
    for (const raw of chunk.segments) {
      const segment: TranscriptSegment = { ...raw, start: raw.start + offset, end: raw.end + offset, ...(raw.words ? { words: raw.words.map(word => ({ ...word, start: word.start + offset, end: word.end + offset })) } : {}) };
      if (chunk.index === 0 || segment.start >= lastEnd) { segments.push(segment); lastEnd = Math.max(lastEnd, segment.end); continue; }
      const words = segment.words?.filter(word => word.start >= lastEnd);
      if (!words?.length) continue;
      const end = Math.max(segment.end, words[words.length - 1].end);
      segments.push({ ...segment, start: words[0].start, end, text: words.map(word => word.text).join(' '), words });
      lastEnd = Math.max(lastEnd, end);
    }
  }
  const fullText = segments.map(segment => segment.text.trim()).filter(Boolean).join(' ');
  const confidences = chunks.map(chunk => chunk.confidence);
  const usages = chunks.map(chunk => chunk.metadata.usage as Record<string, number> | null | undefined);
  // Usage is summed only when every chunk reported it; otherwise the total is unknown.
  const usage = usages.every(value => value && typeof value === 'object') ? usages.reduce<Record<string, number>>((sum, value) => {
    for (const [key, amount] of Object.entries(value!)) if (typeof amount === 'number') sum[key] = (sum[key] ?? 0) + amount;
    return sum;
  }, {}) : null;
  const languages = [...new Set(chunks.map(chunk => chunk.metadata.language).filter((value): value is string => typeof value === 'string'))];
  return {
    success: true, engine: chunks[0]?.engine ?? 'unknown', fullText, segments, wordCount: fullText.split(/\s+/).filter(Boolean).length,
    speakerCount: null, confidence: confidences.every(value => typeof value === 'number') ? confidences.reduce((a, b) => a! + b!, 0)! / confidences.length : null,
    duration: durationSeconds,
    metadata: { model: chunks[0]?.metadata.model ?? null, language: languages.length === 1 ? languages[0] : null, ...(languages.length > 1 ? { languages } : {}), usage,
      chunking: { chunks: plan.length, chunkSeconds: plan.length > 1 ? plan[1].start - plan[0].start : plan[0]?.duration ?? null, overlapSeconds: OVERLAP_SECONDS, rule: 'drop-overlap-before-previous-end' } },
  };
}

export interface AudioSplitter {
  /** Duration in seconds, or null when it cannot be read. */
  probe(path: string, signal?: AbortSignal): Promise<number | null>;
  extract(path: string, start: number, duration: number, output: string, signal?: AbortSignal): Promise<void>;
}
const run = promisify(execFile);
export const ffmpegSplitter: AudioSplitter = {
  async probe(path, signal) {
    try {
      const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path], { signal, timeout: 30000 });
      const value = Number.parseFloat(String(stdout).trim());
      return Number.isFinite(value) && value > 0 ? value : null;
    } catch { return null; }
  },
  async extract(path, start, duration, output, signal) {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(start), '-t', String(duration), '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '64k', output], { signal, timeout: 300000 });
  },
};

export type TranscribeChunk = (path: string, options: TranscriptionOptions) => Promise<TranscriptionResult>;
/**
 * Transcribe chunk by chunk, sequentially. After every finished chunk the
 * checkpoint holds the results so far, so a restart resumes after them; a chunk
 * whose remote job ID is known resumes polling rather than resubmitting.
 */
export async function transcribeChunks(transcribe: TranscribeChunk, filePath: string, plan: ChunkSpec[], durationSeconds: number, options: TranscriptionOptions & { checkpoint?: LongCheckpoint; save: (checkpoint: LongCheckpoint) => void; local: boolean; provider: string }, splitter: AudioSplitter = ffmpegSplitter): Promise<TranscriptionResult> {
  const previous = options.checkpoint?.chunks;
  const results: StoredChunk[] = previous && JSON.stringify(previous.plan) === JSON.stringify(plan) ? previous.results.slice() : [];
  // Only the chunk that was in progress when the job stopped may resume a remote job.
  let resumeRemote = previous && results.length === previous.results.length ? options.checkpoint?.remoteId : undefined;
  const { save, local, provider, checkpoint: _ignored, onCheckpoint: _unused, ...engineOptions } = options;
  const state = (done: number, phase: string, extra: Partial<LongCheckpoint> = {}): LongCheckpoint => ({ phase, provider, inFlight: false, progress: { done, total: plan.length }, chunks: { plan, results }, ...extra });
  const directory = await mkdtemp(join(tmpdir(), 'openplod-chunks-'));
  try {
    for (const spec of plan.slice(results.length)) {
      options.signal?.throwIfAborted();
      const done = results.length;
      save(state(done, 'chunk-extracting'));
      const output = join(directory, `chunk-${spec.index}.mp3`);
      try { await splitter.extract(filePath, spec.start, spec.duration, output, options.signal); }
      catch { options.signal?.throwIfAborted(); throw new RetryableError(`Could not split chunk ${spec.index + 1} of ${plan.length} with ffmpeg. Nothing was sent for it.`); }
      const resume = resumeRemote; resumeRemote = undefined;
      const result = await transcribe(output, { ...engineOptions, ...(resume ? { checkpoint: { phase: 'polling', remoteId: resume } } : {}),
        onCheckpoint: checkpoint => save(state(done, checkpoint.phase, { ...(checkpoint.remoteId ? { remoteId: checkpoint.remoteId } : {}), inFlight: !local })) });
      options.signal?.throwIfAborted();
      if (!result.success) return transcriptionFailure(result.engine, `Chunk ${spec.index + 1} of ${plan.length} failed: ${result.error ?? 'unknown error'} ${done} earlier chunk${done === 1 ? ' was' : 's were'} kept.`);
      if (result.fullText.trim() && !result.segments.length) return transcriptionFailure(result.engine, 'This provider returned no timestamps, so chunks cannot be merged without duplicating speech. Choose a model with segment timestamps.');
      results.push({ index: spec.index, engine: result.engine, fullText: result.fullText, segments: result.segments, duration: result.duration, confidence: result.confidence, metadata: result.metadata ?? {} });
      save(state(results.length, 'chunk-done'));
    }
    return mergeChunks(plan, results, durationSeconds);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
