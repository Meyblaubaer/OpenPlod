import { useEffect, useState } from 'react'
import { NoteDialog } from './NoteDialogs'
import { Button } from './ui/button'
import { AudioLines, Loader2, X } from './icons'
import { aiSettingsApi, profilesApi, type AiSettings, type SpeechProvider, type TranscriptionProfile } from '@/lib/ai-settings'
import { LANGUAGES, PROMPT_LIMIT, profileFit } from '@/lib/transcription'
import { api } from '@/lib/api'
import './profiles.css'

export function TranscribeDialog({ recordingId, title, onClose, onQueued }: { recordingId: string; title: string; onClose: () => void; onQueued: () => void }) {
  const [settings, setSettings] = useState<AiSettings | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [profiles, setProfiles] = useState<TranscriptionProfile[]>([])
  useEffect(() => {
    let active = true
    Promise.all([aiSettingsApi.get(), profilesApi.list().then(value => value.profiles).catch(() => [])])
      .then(([value, list]) => { if (active) { setSettings(value); setProfiles(list) } })
      .catch(e => { if (active) setError(e.message) })
    return () => { active = false }
  }, [])
  const profile = profiles.find(item => item.id === settings?.transcriptionProfile) ?? null
  // A provider-specific profile chooses its own engine, so the provider picker follows it.
  const engine = profile?.engine ?? settings?.transcriptionEngine
  const capability = settings && engine ? settings.capabilities[engine] : undefined
  const fit = settings && profile ? profileFit(profile, settings) : null
  return <NoteDialog title="Transcribe recording" description={title} onClose={onClose} busy={busy}><form onSubmit={async event => {
    event.preventDefault(); if (!settings) return; setBusy(true); setError('')
    try {
      await api.transcribe(recordingId, { transcriptionEngine: settings.transcriptionEngine, transcriptionModel: settings.transcriptionModel, transcriptionFallback: [], transcriptionLanguage: settings.transcriptionLanguage, transcriptionDiarize: settings.transcriptionDiarize, transcriptionVocabulary: settings.transcriptionVocabulary, transcriptionPrompt: capability?.prompt ? settings.transcriptionPrompt : '', transcriptionProfile: settings.transcriptionProfile })
      onQueued(); onClose()
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not queue transcription.') } finally { setBusy(false) }
  }}>
    {settings && capability ? <>
      <label>Profile<select disabled={busy} value={settings.transcriptionProfile} onChange={e => setSettings({ ...settings, transcriptionProfile: e.target.value })}>
        <option value="">None</option>{profiles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      {profile && <p className="profile-hint" {...(fit?.ignored.length ? { 'data-warn': '' } : {})}>{profile.prompt || profile.description || 'No context prompt.'}{fit?.ignored.length ? ` ${fit.label} will not receive the ${fit.ignored.join(' or ')}.` : ''}</p>}
      <label>Provider<select disabled={busy || Boolean(profile?.engine)} value={engine} onChange={e => { const next = e.target.value as SpeechProvider; setSettings({ ...settings, transcriptionEngine: next, transcriptionModel: '', transcriptionDiarize: false, transcriptionVocabulary: [], ...(settings.capabilities[next].prompt ? {} : { transcriptionPrompt: '' }) }) }}>{Object.entries(settings.capabilities).map(([id, item]) => <option key={id} value={id} disabled={settings.privacyMode === 'local-only' && !item.local}>{item.label}</option>)}</select></label>
      {!profile?.engine && <label>Model<select disabled={busy} value={settings.transcriptionModel} onChange={e => setSettings({ ...settings, transcriptionModel: e.target.value })}><option value="">{capability.models[0]} (default)</option>{capability.models.map(model => <option key={model}>{model}</option>)}</select></label>}
      {!profile?.language && <label>Language<select disabled={busy} value={settings.transcriptionLanguage} onChange={e => setSettings({ ...settings, transcriptionLanguage: e.target.value })}>{LANGUAGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
      {capability.prompt && <label>Context for this recording<textarea rows={2} maxLength={PROMPT_LIMIT} disabled={busy} value={settings.transcriptionPrompt} placeholder="Optional: who speaks, the topic, names to spell" onChange={e => setSettings({ ...settings, transcriptionPrompt: e.target.value })} /></label>}
      <p className="note-ai-disclosure">{capability.local ? 'Audio will be processed on this computer.' : `Audio will be sent to ${capability.label}. Provider charges may apply.`} No fallback provider. Original audio and manual edits are retained.</p>
    </> : <p role="status">Loading transcription settings...</p>}
    {error && <p role="alert" className="note-error">{error}</p>}
    <footer><Button type="button" variant="ghost" disabled={busy} onClick={onClose}><X />Cancel</Button><Button disabled={!settings || busy}>{busy ? <Loader2 className="animate-spin" /> : <AudioLines />}Transcribe</Button></footer>
  </form></NoteDialog>
}
