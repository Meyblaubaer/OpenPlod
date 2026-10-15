import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import { readAiConfig, textModels, textSelection } from '../ai/config';
import { DOCUMENT_STYLES } from '../organizer/document-templates';
import type { DocumentGenerationService } from '../organizer/generation';
import type { BatchRunner } from './batch';

/**
 * Batch document generation (roadmap TS-10).
 *
 * Each item runs the ordinary single-document pipeline
 * (`DocumentGenerationService.generate` then `save`), so a batch gets exactly
 * the same prompt rules, size limit, provider check and provenance as one
 * document made by hand. The batch adds only scope, confirmation and status.
 *
 * Confirming the batch is the review step for its scope: which recordings,
 * which provider receives their transcript text, which template and which
 * folder. Every item creates a new Note; nothing existing is overwritten, and
 * each Note records the transcript version and provider it came from.
 */

export const documentBatchOptionsSchema = z.object({
  style: z.enum(DOCUMENT_STYLES).default('notes'),
  instructions: z.string().trim().max(2000).default(''),
  folderId: z.string().uuid().nullable().default(null),
  /** The provider the person confirmed. A change since then fails each item instead of sending. */
  expectedProvider: z.enum(['mistral', 'openai', 'anthropic', 'ollama']).optional(),
});
export type DocumentBatchOptions = z.infer<typeof documentBatchOptionsSchema>;

export interface DocumentBatchEstimate {
  kind: 'document';
  recordings: number;
  /** Items that would run: selected, active and with transcript text. */
  wouldRun: number;
  /** Selected recordings left out because they have no transcript to send. */
  skipped: number;
  provider: string;
  model: string;
  /** False only for local Ollama. */
  usesCloudProvider: boolean;
  /** Always true: document generation sends the transcript text to the provider. */
  sendsTranscriptText: true;
  /** Set when the provider cannot be used as configured, so the UI can say why. */
  providerError: string | null;
  /** Deliberately absent: token pricing is unknown before the call. */
  estimatedCost: null;
}

/** Selected recordings that are active and have transcript text, in one statement. */
export function documentCandidates(database: Database, ids: string[]): Set<string> {
  if (ids.length === 0) return new Set();
  return new Set((database.query(`SELECT r.id AS id FROM recordings r JOIN transcripts t ON t.recording_id = r.id
    WHERE r.id IN (SELECT value FROM json_each(?)) AND r.retention_state = 'active' AND trim(t.full_text) <> ''`)
    .all(JSON.stringify(ids)) as { id: string }[]).map(row => row.id));
}

export function estimateDocumentBatch(database: Database, ids: string[]): DocumentBatchEstimate {
  const config = readAiConfig(database);
  const provider = config.documentProvider;
  let providerError: string | null = null;
  try { textSelection(database, 'document'); } catch (error) { providerError = error instanceof Error ? error.message : 'The document provider is unavailable.'; }
  const runnable = documentCandidates(database, ids);
  return {
    kind: 'document', recordings: ids.length, wouldRun: runnable.size, skipped: ids.length - runnable.size,
    provider, model: config.documentModel || textModels[provider], usesCloudProvider: provider !== 'ollama',
    sendsTranscriptText: true, providerError, estimatedCost: null,
  };
}

/** Throws when the chosen folder does not exist, before any provider is called. */
export function assertFolder(database: Database, folderId: string | null): void {
  if (folderId && !database.query('SELECT id FROM note_folders WHERE id = ?').get(folderId)) throw new Error('That folder no longer exists.');
}

/**
 * One batch item: generate, then save into the chosen folder. A cancel that
 * lands after generation but before saving leaves nothing in Notes.
 */
export function documentBatchRunner(database: Database, service: DocumentGenerationService, options: DocumentBatchOptions): BatchRunner {
  return async (recordingId, signal) => {
    const row = database.query('SELECT original_filename AS filename FROM recordings WHERE id = ?').get(recordingId) as { filename: string | null } | null;
    if (!row) throw new Error('Recording not found.');
    const title = (row.filename ?? '').replace(/\.[^.]+$/, '').replace(/[\x00-\x1f/\\]/g, '-').trim().slice(0, 180) || 'Recording notes';
    // Errors are the service's own explanations; they never contain the transcript or a key.
    const generated = await service.generate({
      idempotencyKey: crypto.randomUUID(), recordingId, versionId: null, title,
      style: options.style, instructions: options.instructions, expectedProvider: options.expectedProvider,
    }, async () => {}, signal);
    signal.throwIfAborted();
    service.save(generated.id, { folderId: options.folderId });
  };
}
