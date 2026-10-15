import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import type { TextProvider } from './config';
import { recordTextSpend } from './spending';

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
export class TextProviderError extends Error {}
/** The transcript does not fit the local model's context. Never answered by a cloud fallback (AI-13). */
export class ContextLimitError extends TextProviderError {}
export type TextSelection = {
  provider: TextProvider; model: string; apiKey?: string; beforeSend?: () => void;
  /** Base URL of the custom OpenAI-compatible endpoint, already validated by `customEndpoint`. */
  baseUrl?: string;
  /** Explicit fallbacks, tried in order only after this provider fails (AI-07). */
  fallbacks?: TextSelection[];
  /** Where to record estimated spend for the provider that answered (AI-10). */
  ledger?: { database: Database; task: string };
};
export type TextMessage = { role: 'system' | 'user' | 'assistant'; content: string };
export type TextAttempt = { provider: TextProvider; model: string; error: string };
export type TextResult = {
  text: string; provider: TextProvider; model: string; usage: Record<string, number> | null;
  /** Providers tried before the one that answered; empty when the first choice answered. */
  fallbackFrom?: TextAttempt[];
  startedAt?: string; completedAt?: string;
};
const usageSchema = z.record(z.string(), z.unknown());
export function reportedUsage(value: unknown): Record<string, number> | null {
  const parsed = usageSchema.safeParse(value);
  if (!parsed.success) return null;
  const entries = Object.entries(parsed.data).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0);
  return entries.length ? Object.fromEntries(entries) : null;
}
const OLLAMA = 'http://127.0.0.1:11434';
const label = (provider: TextProvider) => provider === 'custom' ? 'Custom endpoint' : provider;

export async function installedOllamaModels(fetcher: Fetcher = fetch): Promise<string[]> {
  const response = await fetcher(`${OLLAMA}/api/tags`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Local Ollama is unavailable.');
  const payload = z.object({ models: z.array(z.object({ name: z.string(), remote_model: z.string().optional(), remote_host: z.string().optional() })) }).parse(await response.json());
  // Cloud aliases must never be represented as local inference.
  return payload.models.filter(item => !item.remote_model && !item.remote_host && !/cloud/i.test(item.name)).map(item => item.name);
}

/** A local model's maximum context in tokens from `/api/show`, or null when Ollama does not report one. */
export async function ollamaContextLength(model: string, fetcher: Fetcher = fetch): Promise<number | null> {
  const response = await fetcher(`${OLLAMA}/api/show`, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }), signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Local Ollama could not describe this model.');
  const payload = z.object({ model_info: z.record(z.string(), z.unknown()).optional() }).passthrough().parse(await response.json());
  const lengths = Object.entries(payload.model_info ?? {}).filter(([key, value]) => key.endsWith('.context_length') && typeof value === 'number' && Number.isInteger(value) && value > 0).map(([, value]) => value as number);
  return lengths.length ? Math.max(...lengths) : null;
}
/** A deliberately rough token estimate (about four bytes per token). Labelled approximate wherever shown. */
export const approximateTokens = (text: string) => Math.ceil(Buffer.byteLength(text, 'utf8') / 4);

/**
 * Complete with the selected provider, then its explicit fallbacks in order.
 * A cancelled request never falls back. A local context overflow only falls back
 * to other local providers, so a long transcript never silently reaches a cloud.
 */
export async function completeText(selection: TextSelection, messages: TextMessage[], options: { signal?: AbortSignal; timeoutMs?: number; maxTokens?: number; json?: boolean } = {}, fetcher: Fetcher = fetch): Promise<TextResult> {
  const chain = [selection, ...(selection.fallbacks ?? [])], attempts: TextAttempt[] = [];
  let contextLimited = false;
  for (const [index, candidate] of chain.entries()) {
    if (contextLimited && !isLocalSelection(candidate)) { attempts.push({ provider: candidate.provider, model: candidate.model, error: 'Skipped: a cloud fallback is never used for a transcript that exceeds a local model context.' }); continue; }
    const startedAt = new Date().toISOString();
    try {
      const result = await completeOne(candidate, messages, options, fetcher);
      if (selection.ledger) try { recordTextSpend(selection.ledger.database, selection.ledger.task, result.provider, result.model, result.usage); } catch { /* the ledger never fails a finished answer */ }
      return { ...result, fallbackFrom: attempts, startedAt, completedAt: new Date().toISOString() };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (error instanceof ContextLimitError) contextLimited = true;
      attempts.push({ provider: candidate.provider, model: candidate.model, error: error instanceof Error ? error.message : 'Failed.' });
      if (index === chain.length - 1 || chain.slice(index + 1).every(next => contextLimited && !isLocalSelection(next))) {
        if (attempts.length === 1) throw error;
        const message = `Every configured provider failed: ${attempts.map(item => `${item.provider}: ${item.error}`).join(' ')}`;
        throw error instanceof TextProviderError ? new (error.constructor as typeof TextProviderError)(message) : new Error(message);
      }
    }
  }
  throw new Error('No text provider is configured.');
}
const isLocalSelection = (selection: TextSelection) => selection.provider === 'ollama' || (selection.provider === 'custom' && Boolean(selection.baseUrl && /^http:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?(\/|$)/.test(selection.baseUrl)));

async function completeOne(selection: TextSelection, messages: TextMessage[], options: { signal?: AbortSignal; timeoutMs?: number; maxTokens?: number; json?: boolean }, fetcher: Fetcher): Promise<TextResult> {
  const { provider, model, apiKey } = selection;
  const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 90000), ...(options.signal ? [options.signal] : [])]);
  signal.throwIfAborted();
  if (!['ollama', 'custom'].includes(provider) && !apiKey) throw new Error(`The ${provider} API key is not configured.`);
  const maxTokens = options.maxTokens ?? 8192;
  let url: string, body: unknown;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (provider === 'ollama') {
    if (!(await installedOllamaModels(fetcher)).includes(model)) throw new Error('The selected local Ollama model is not installed.');
    const context = await ollamaContextLength(model, fetcher).catch(() => null), needed = approximateTokens(messages.map(m => m.content).join('\n'));
    if (context !== null && needed + 256 > context)
      throw new ContextLimitError(`This request is about ${needed} tokens (approximate), more than the ${context}-token context of ${model}. Nothing was sent. Choose a local model with a larger context; OpenPlod does not switch to a cloud provider.`);
    // Ollama otherwise runs with a small default context and silently drops the start of long transcripts.
    const numCtx = context === null ? undefined : Math.min(context, Math.max(4096, Math.ceil((needed + maxTokens) / 1024) * 1024));
    url = `${OLLAMA}/api/chat`;
    body = { model, messages, stream: false, options: { temperature: 0.2, num_predict: maxTokens, ...(numCtx ? { num_ctx: numCtx } : {}) }, ...(options.json ? { format: 'json' } : {}) };
  } else if (provider === 'anthropic') {
    url = 'https://api.anthropic.com/v1/messages';
    headers['x-api-key'] = apiKey!; headers['anthropic-version'] = '2023-06-01';
    body = { model, system: messages.filter(m => m.role === 'system').map(m => m.content).join('\n'), messages: messages.filter(m => m.role !== 'system'), max_tokens: maxTokens };
  } else if (provider === 'gemini') {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.replace(/^models\//, ''))}:generateContent`;
    headers['x-goog-api-key'] = apiKey!;
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    body = { ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents: messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens, ...(options.json ? { responseMimeType: 'application/json' } : {}) } };
  } else if (provider === 'custom') {
    if (!selection.baseUrl) throw new Error('The custom endpoint URL is not configured.');
    // Compatibility is not assumed: no JSON mode is requested, and callers validate the output themselves.
    url = `${selection.baseUrl}/chat/completions`;
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    body = { model, messages, temperature: 0.2, max_tokens: maxTokens };
  } else {
    url = provider === 'mistral' ? 'https://api.mistral.ai/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions';
    headers.Authorization = `Bearer ${apiKey}`;
    body = { model, messages, temperature: 0.2, max_tokens: maxTokens, ...(options.json ? { response_format: { type: 'json_object' } } : {}) };
  }
  try {
    signal.throwIfAborted();
    selection.beforeSend?.();
    const response = await fetcher(url, { method: 'POST', redirect: 'error', headers, body: JSON.stringify(body), signal });
    if (!response.ok) throw new TextProviderError(provider === 'mistral' && [401, 403].includes(response.status)
      ? `Mistral rejected the API key (HTTP ${response.status}). Check AI settings.`
      : `${label(provider)} request failed (HTTP ${response.status}). Check AI settings.`);
    const payload = await response.json() as Record<string, any>;
    let text: unknown, finished: boolean, usage: unknown = payload.usage, reportedModel: unknown = payload.model;
    if (provider === 'anthropic') {
      text = Array.isArray(payload.content) ? payload.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('') : null;
      finished = payload.stop_reason === 'end_turn';
    } else if (provider === 'ollama') { text = payload.message?.content; finished = payload.done === true && payload.done_reason === 'stop'; usage = { input_tokens: payload.prompt_eval_count, output_tokens: payload.eval_count }; }
    else if (provider === 'gemini') {
      const candidate = payload.candidates?.[0];
      text = Array.isArray(candidate?.content?.parts) ? candidate.content.parts.map((part: any) => typeof part.text === 'string' && !part.thought ? part.text : '').join('') : null;
      finished = candidate?.finishReason === 'STOP'; usage = payload.usageMetadata; reportedModel = payload.modelVersion;
    } else { text = payload.choices?.[0]?.message?.content; finished = payload.choices?.[0]?.finish_reason === 'stop'; }
    if (!finished || typeof text !== 'string' || !text.trim()) throw new Error(`${label(provider)} returned an empty or incomplete response. Nothing was saved.`);
    signal.throwIfAborted();
    return { text: text.trim(), provider, model: typeof reportedModel === 'string' ? reportedModel.slice(0, 120) : model, usage: reportedUsage(usage) };
  } catch (error) {
    if (signal.aborted) throw new Error('AI request cancelled or timed out. No automatic retry was made.');
    if (error instanceof TextProviderError) throw error;
    if (error instanceof Error && /^Local-only/.test(error.message)) throw error;
    throw new Error(`${label(provider)} could not be reached or returned an invalid response.`);
  }
}

/** The provenance stored with every generated summary, document and answer (AI-09). Unknown usage stays null. */
export type TextProvenance = { provider: TextProvider; model: string; usage: Record<string, number> | null; startedAt: string | null; completedAt: string | null; fallbackFrom: TextAttempt[] };
export const textProvenance = (result: TextResult): TextProvenance => ({ provider: result.provider, model: result.model, usage: result.usage, startedAt: result.startedAt ?? null, completedAt: result.completedAt ?? null, fallbackFrom: result.fallbackFrom ?? [] });
