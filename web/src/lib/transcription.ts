import type { AiConfig, AiSettings, ProfileInput, SpeechProvider } from './ai-settings'

/** Languages offered in transcription pickers; `auto` lets the provider detect it. */
export const LANGUAGES: [string, string][] = [
  ['auto', 'Detect automatically'], ['en', 'English'], ['fr', 'French'], ['de', 'German'], ['es', 'Spanish'],
  ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['ja', 'Japanese'], ['zh', 'Chinese'],
]
export const languageLabel = (code: string | null) => LANGUAGES.find(([value]) => value === code)?.[1] ?? code ?? ''
export const PROMPT_LIMIT = 1000

/** What a profile will and will not send to one provider, for an honest preview before a job runs. */
export function profileFit(profile: Pick<ProfileInput, 'prompt' | 'vocabulary' | 'diarize' | 'engine'>, settings: AiSettings, engine: SpeechProvider = profile.engine ?? settings.transcriptionEngine) {
  const capability = settings.capabilities[engine]
  const ignored = [
    profile.prompt && !capability.prompt && 'context prompt',
    profile.vocabulary.length && !capability.vocabulary && 'vocabulary',
    profile.diarize && !capability.diarization && 'speaker labels',
  ].filter((value): value is string => Boolean(value))
  return { engine, label: capability.label, ignored }
}

/** The AI config without the read-only fields the settings endpoint adds. */
export function configOf(settings: AiSettings): AiConfig {
  return Object.fromEntries(Object.entries(settings).filter(([key]) => key !== 'credentials' && key !== 'capabilities')) as AiConfig
}
