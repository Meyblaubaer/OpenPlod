import { apiUrl, authenticatedHeaders } from './runtime'
import type { RecordingCollection, RecordingCollectionDetail, SearchResult, IndexStatus, KnowledgeSettings, RecordingSuggestions, TopicCandidate, TopicSummary } from '../../../src/knowledge/types'
export type { RecordingCollection, RecordingCollectionDetail, SearchResult, SearchPassage, IndexStatus, KnowledgeSettings, RecordingSuggestions, TopicCandidate, TopicSummary } from '../../../src/knowledge/types'

/** Knowledge workspace API (0.7.0 KB-01, KB-04, KB-05). */
async function request<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal; timeout?: number } = {}): Promise<T> {
  const timeout = AbortSignal.timeout(init.timeout ?? 20000)
  const response = await fetch(apiUrl(`/v1${path}`), {
    method: init.method ?? 'GET',
    headers: authenticatedHeaders(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || !payload?.success) throw new Error(payload?.error || `Request failed (HTTP ${response.status}).`)
  return payload.data as T
}

export type SearchMode = SearchResult['mode']

export const knowledgeApi = {
  collections: (signal?: AbortSignal) => request<RecordingCollection[]>('/collections', { signal }),
  collection: (id: string, signal?: AbortSignal) => request<RecordingCollectionDetail>(`/collections/${id}`, { signal }),
  createCollection: (name: string, description = '') => request<RecordingCollection>('/collections', { method: 'POST', body: { name, description } }),
  updateCollection: (id: string, data: { name?: string; description?: string; revision: number }) => request<RecordingCollection>(`/collections/${id}`, { method: 'PATCH', body: data }),
  deleteCollection: (id: string, revision: number) => request<null>(`/collections/${id}`, { method: 'DELETE', body: { revision } }),
  addToCollection: (id: string, recordingIds: string[], revision: number) => request<RecordingCollectionDetail>(`/collections/${id}/recordings`, { method: 'POST', body: { recordingIds, revision } }),
  removeFromCollection: (id: string, recordingIds: string[], revision: number) => request<RecordingCollectionDetail>(`/collections/${id}/recordings`, { method: 'DELETE', body: { recordingIds, revision } }),
  /** Indexing new sources can take a while on the first search, especially with a local embedding model. */
  search: (q: string, options: { mode?: SearchMode; source?: 'all' | 'transcripts' | 'documents'; limit?: number; signal?: AbortSignal } = {}) =>
    request<SearchResult>(`/search?${new URLSearchParams({ q, mode: options.mode ?? 'hybrid', source: options.source ?? 'all', limit: String(options.limit ?? 20) })}`, { signal: options.signal, timeout: 60000 }),
  searchStatus: (signal?: AbortSignal) => request<IndexStatus>('/search/status', { signal }),
  saveSearchSettings: (settings: KnowledgeSettings & { confirmCloud?: boolean }) => request<IndexStatus>('/search/settings', { method: 'PUT', body: settings }),
  reindex: (rebuild = false) => request<{ indexed: number; pending: number }>('/search/reindex', { method: 'POST', body: { maxSources: 200, rebuild }, timeout: 300000 }),
  suggestRecording: (id: string, signal?: AbortSignal) => request<RecordingSuggestions>(`/recordings/${id}/suggestions`, { method: 'POST', body: { consent: true }, signal, timeout: 75000 }),
  topics: (days: number, signal?: AbortSignal) => request<{ days: number; recordingCount: number; topics: TopicCandidate[] }>(`/topics?days=${days}`, { signal }),
  summarizeTopic: (topic: string, days: number, signal?: AbortSignal) => request<TopicSummary>('/topics/summary', { method: 'POST', body: { topic, days, consent: true }, signal, timeout: 110000 }),
}

/** Link to a recording at a time and exact transcript version; the recording page seeks to `t`. */
export function recordingLink(recordingId: string, start: number | null | undefined, versionId: string | null | undefined) {
  const query = new URLSearchParams({ ...(start === null || start === undefined ? {} : { t: String(start) }), ...(versionId ? { version: versionId } : {}) })
  const text = query.toString()
  return `/recording/${recordingId}${text ? `?${text}` : ''}`
}
