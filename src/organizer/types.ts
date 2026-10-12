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
