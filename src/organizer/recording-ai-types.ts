import type { TextProvider } from '../ai/config';
import type { TextAttempt } from '../ai/text';
export type AiSource = { id: string; recordingId: string; title: string; versionId: string | null; origin: string; start: number | null; text: string; hash: string };
export type AiAnswer = { id: string; conversationId: string; question: string; answer: string; sources: AiSource[]; citations: { sourceId: string; quote: string }[]; model: string; provider: TextProvider; usage?: Record<string, number> | null; startedAt?: string | null; completedAt?: string | null; fallbackFrom?: TextAttempt[]; createdAt: string; trace: { stage: string; at: string }[] };
export type AiConversationSummary = { id: string; title: string | null; question: string; recordingIds: string[]; createdAt: string; turns: number; archived: boolean };
