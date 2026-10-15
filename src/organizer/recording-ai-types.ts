export type AiSource = {
  id: string; recordingId: string; title: string; versionId: string | null; origin: string; start: number | null; text: string; hash: string;
  /** End time in seconds from the stored segments, when known (retrieved passages). */
  end?: number | null;
  /** Inclusive segment index range of a retrieved passage in that exact version. */
  segmentStart?: number | null; segmentEnd?: number | null;
  /** Why the text was sent: chosen by the person, pinned to the conversation, or retrieved for this question. */
  via?: 'selected' | 'pinned' | 'retrieved';
  /** Retrievers that matched a retrieved passage. */
  matchedBy?: ('fts' | 'vector')[];
};
export type AiRetrieval = {
  /** `selected`: the person chose recordings; `retrieved`: passages were found across the vault. */
  mode: 'selected' | 'retrieved';
  pinnedRecordingIds: string[];
  /** Every recording whose text was sent to the provider. */
  sentRecordingIds: string[];
  /** Recordings the answer actually cites. */
  usedRecordingIds: string[];
  contextNote: boolean;
  embeddingModel: string | null;
};
export type AiAnswer = {
  id: string; conversationId: string; question: string; answer: string; sources: AiSource[]; citations: { sourceId: string; quote: string }[];
  model: string; provider: 'mistral' | 'openai' | 'anthropic' | 'ollama'; usage?: Record<string, number> | null; createdAt: string; trace: { stage: string; at: string }[];
  /** Up to three suggested follow-up questions. Shown to the person; never sent automatically. */
  followUps?: string[];
  retrieval?: AiRetrieval;
};
export type AiConversationSummary = {
  id: string; title: string | null; question: string; recordingIds: string[]; createdAt: string; turns: number; archived: boolean;
  pinnedRecordingIds?: string[]; contextNote?: string | null;
};
/** Per-conversation context: pinned recordings and a project note (KB-03). */
export type AiConversationContext = { id: string; pinnedRecordingIds: string[]; contextNote: string | null };
