export interface NoteFolder {
  id: string; name: string; parentId: string | null; revision: number; documentCount: number;
}

export interface NoteSummary {
  id: string; title: string; folderId: string | null; starred: boolean; revision: number;
  excerpt: string; createdAt: string; updatedAt: string; deletedAt: string | null;
  sourceRecordingId: string | null; sourceVersionId: string | null; sourceOrigin: string | null;
  tags: string[];
}

export type NoteProperties = Record<string, unknown>;
export interface NoteDocument extends NoteSummary { content: string; properties: NoteProperties }

/**
 * Where a document came from, resolved against the transcript history.
 *
 * `current`: the cited version is the recording's current transcript.
 * `stale`: the cited version still exists but a newer one is current.
 * `unknown`: the document names a source that can no longer be resolved.
 * `none`: the document was not written from a transcript.
 */
export interface DocumentSource {
  documentId: string;
  status: 'current' | 'stale' | 'unknown' | 'none';
  stale: boolean | null;
  recordingId: string | null;
  recordingFilename: string | null;
  recordingAvailable: boolean;
  versionId: string | null;
  versionOrigin: string | null;
  versionCreatedAt: string | null;
  currentVersionId: string | null;
  sourceOrigin: string | null;
}

export interface TranscriptVersionSummary {
  id: string; recordingId: string; origin: string; createdAt: string;
  provider: string | null; model: string | null; current: boolean; documentCount: number;
}
export interface TranscriptVersionDetail extends TranscriptVersionSummary { fullText: string }
export interface TranscriptVersionBacklinks { version: TranscriptVersionSummary; documents: NoteSummary[] }
export interface DocumentGeneration {
  id: string; recordingId: string; versionId: string | null; state: 'pending' | 'ready' | 'failed';
  provider: 'mistral' | 'openai' | 'anthropic' | 'ollama'; model: string; title: string; content: string | null;
  createdAt: string; documentId: string | null; steps: { stage: string; at: string }[];
}
export interface NoteVersion { id: string; revision: number; title: string; content: string; createdAt: string }
export interface NotePage { documents: NoteSummary[]; total: number; offset: number; limit: number }
export interface NoteDestination { id: string; name: string; host: string }
export interface NoteDelivery {
  id: string; documentId: string; documentRevision: number; destinationId: string;
  state: 'pending' | 'sent' | 'unknown'; createdAt: string; statusCode: number | null;
}
export type SavedViewFilters = { folderId?: string; view: 'all' | 'starred' | 'trash'; q: string; sort: 'updated' | 'title'; tag?: string };
export interface SavedView { id: string; name: string; filters: SavedViewFilters; revision: number; createdAt: string; updatedAt: string }

/** Managed Markdown export (KB-02). */
export type ExportAction = 'created' | 'updated' | 'moved' | 'unchanged' | 'conflict' | 'orphaned';
export interface ExportItem {
  /** The note, or for an attachment the first note citing it ('' when no active note does). */
  documentId: string; title: string | null; path: string; action: ExportAction; reason?: 'modified_externally' | 'deleted_externally' | 'not_a_file';
  kind?: 'note' | 'attachment';
  /** `audio:<recordingId>` or `transcript:<versionId>`; pass it in `overwriteAttachments` to replace a conflicting attachment. */
  attachmentKey?: string;
}
export interface ExportResult {
  root: string; dryRun: boolean; exportedAt: string;
  counts: Record<ExportAction, number>;
  /** Every item except `unchanged`, which is only counted. */
  items: ExportItem[];
}
export interface ExportStatus {
  configured: boolean; root: string | null;
  /** `env`: OPENPLOD_EXPORT_DIR, which locks the folder; `settings`: chosen in the app. */
  source: 'env' | 'settings' | null; locked: boolean;
  lastExportedAt: string | null; documentCount: number; attachmentCount: number; error: string | null;
}

/** Reviewable AI title and tag suggestions (KB-05); see `suggestions.ts`. */
export interface DocumentSuggestions {
  documentId: string;
  revision: number;
  /** A proposed title, or null when the model offered nothing usable or it equals the current one. */
  title: string | null;
  /** Proposed tags the note does not already carry. */
  tags: string[];
  provider: string;
  model: string;
  /** True when only the beginning of a long note was sent. */
  truncated: boolean;
}
