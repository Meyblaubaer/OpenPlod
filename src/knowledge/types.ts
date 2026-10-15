/** Shared knowledge-workspace types (0.7.0 KB-01, KB-04, KB-05). The web client imports these. */

export interface RecordingCollection {
  id: string; name: string; description: string; revision: number;
  createdAt: string; updatedAt: string;
  /** Active recordings only; trashed members are kept but not counted. */
  recordingCount: number;
}
export interface RecordingCollectionDetail extends RecordingCollection { recordingIds: string[] }

export type EmbeddingKind = 'lexical' | 'local' | 'cloud';
export type EmbeddingProviderName = 'auto' | 'lexical' | 'ollama' | 'openai' | 'mistral';
export interface KnowledgeSettings {
  /** `auto` uses the Ollama model when it is installed and the lexical fallback otherwise. */
  embeddingProvider: EmbeddingProviderName;
  ollamaModel: string;
  /** Explicit opt-in to send passages and queries to a cloud embedding API. */
  cloudOptIn: boolean;
}

export type Retriever = 'fts' | 'vector';
export interface SearchPassage {
  id: string;
  sourceType: 'transcript' | 'document';
  recordingId: string | null;
  recordingTitle: string | null;
  /** The exact transcript version the passage was cut from; always the current one at query time. */
  versionId: string | null;
  documentId: string | null;
  documentTitle: string | null;
  /** Inclusive segment index range in that version, or null when the version has no usable segments. */
  segmentStart: number | null;
  segmentEnd: number | null;
  /** Seconds, taken from the stored segments. Never estimated. */
  startTime: number | null;
  endTime: number | null;
  text: string;
  score: number;
  scores: { fts: number; vector: number };
  matchedBy: Retriever[];
}
export interface EmbeddingInfo { model: string; kind: EmbeddingKind; fallback: boolean; note: string | null }
export interface SearchResult {
  query: string; mode: 'hybrid' | 'lexical' | 'semantic';
  embedding: EmbeddingInfo;
  passages: SearchPassage[];
  index: { sources: number; passages: number; pending: number };
}
export interface IndexStatus {
  settings: KnowledgeSettings;
  embedding: EmbeddingInfo;
  sources: number; passages: number; pending: number;
}

/** Reviewable recording title and tag suggestions (KB-05). Applying them is an ordinary recording edit. */
export interface RecordingSuggestions {
  recordingId: string; revision: number; versionId: string | null;
  title: string | null; tags: string[];
  provider: string; model: string; truncated: boolean;
}
export interface TopicCandidate { topic: string; kind: 'tag' | 'term'; recordingCount: number; recordingIds: string[] }
export interface TopicSource { id: string; recordingId: string; title: string; versionId: string | null; start: number | null; end: number | null; text: string }
export interface TopicSummary {
  topic: string; days: number;
  /** Markdown preview. Nothing is saved until the person saves it as a document. */
  markdown: string;
  summary: string;
  sources: TopicSource[];
  citations: { sourceId: string; quote: string }[];
  provider: string; model: string; createdAt: string;
}
