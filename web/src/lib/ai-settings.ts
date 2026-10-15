import type { AiConfig, SpeechProvider, TextProvider } from '../../../src/ai/config'
import type { speechCapabilities } from '../../../src/ai/capabilities'
import { apiUrl, authenticatedHeaders } from './runtime'
import type { TranscriptionProfile, ProfilePreset, ProfileInput } from '../../../src/ai/transcription-profiles'
import type { OnboardingStatus } from '../../../src/api/onboarding'
export type { AiConfig, SpeechProvider, TextProvider, TranscriptionProfile, ProfilePreset, ProfileInput, OnboardingStatus }
export type AiSettings = AiConfig & { credentials: Record<string, boolean>; capabilities: typeof speechCapabilities }
export type ProcessingJob = { id: string; recordingId: string; provider?: string; status: string; error?: string; priority: number; checkpoint?: { phase: string; remoteId?: string } }
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(apiUrl(path), { method, headers: authenticatedHeaders({ 'Content-Type': 'application/json' }), ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) })
  const payload = await response.json().catch(() => ({ success: false, error: `Request failed (HTTP ${response.status}).` }))
  if (!response.ok || !payload.success) throw new Error(payload.error || 'Request could not be completed.')
  return payload.data
}
export const aiSettingsApi = {
  get: () => request<AiSettings>('/ai-settings'),
  save: (settings: AiConfig, credentials: Record<string, string>) => request('/ai-settings', 'PUT', { ...settings, credentials }),
  check: (provider: string) => request(`/ai-settings/check/${provider}`, 'POST'),
  models: () => request<string[]>('/ai-settings/ollama-models'),
  jobs: () => request<ProcessingJob[]>('/jobs'),
  cancel: (id: string) => request(`/jobs/${id}/cancel`, 'POST'),
  resume: (id: string) => request(`/jobs/${id}/resume`, 'POST'),
}

/** Named context prompts and vocabularies for transcription (`/api/v1/transcription-profiles`). */
export const profilesApi = {
  list: () => request<{ profiles: TranscriptionProfile[]; presets: ProfilePreset[] }>('/v1/transcription-profiles'),
  create: (input: Partial<ProfileInput> | { preset: string; name?: string }) => request<TranscriptionProfile>('/v1/transcription-profiles', 'POST', input),
  update: (id: string, patch: Partial<ProfileInput>) => request<TranscriptionProfile>(`/v1/transcription-profiles/${id}`, 'PATCH', patch),
  remove: (id: string) => request(`/v1/transcription-profiles/${id}`, 'DELETE'),
}

/** First-run setup state; see `src/api/onboarding.ts`. */
export const onboardingApi = {
  status: () => request<OnboardingStatus>('/onboarding'),
  complete: (skipped = false) => request('/onboarding/complete', 'POST', { skipped }),
  reset: () => request('/onboarding/reset', 'POST', {}),
}
/** Fired to open the setup guide from anywhere (Settings, command palette). */
export const ONBOARDING_EVENT = 'openplod:onboarding'
