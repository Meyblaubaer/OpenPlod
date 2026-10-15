import { useCallback, useEffect, useState } from 'react'
import { AudioLines, Loader2, Pencil, Plus, Sparkles, Trash2, X, Save } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { NoteDialog } from '@/components/NoteDialogs'
import { aiSettingsApi, profilesApi, type AiSettings, type ProfileInput, type ProfilePreset, type SpeechProvider, type TranscriptionProfile } from '@/lib/ai-settings'
import { LANGUAGES, PROMPT_LIMIT, languageLabel, profileFit } from '@/lib/transcription'
import './profiles.css'

/** Fired after profiles change so pickers elsewhere on the page reload them. */
export const PROFILES_CHANGED = 'openplod:profiles-changed'
const message = (error: unknown) => error instanceof Error ? error.message : 'The profile could not be saved.'
const blank: ProfileInput = { name: '', description: '', engine: null, model: null, language: null, diarize: null, prompt: '', vocabulary: [] }

/**
 * Transcription profiles: a context prompt and vocabulary for one kind of recording,
 * optionally tied to one provider and model. Presets are copied, never linked.
 */
export function TranscriptionProfilesPanel() {
  const [profiles, setProfiles] = useState<TranscriptionProfile[] | null>(null)
  const [presets, setPresets] = useState<ProfilePreset[]>([])
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [editing, setEditing] = useState<TranscriptionProfile | 'new' | null>(null)
  const [busy, setBusy] = useState(''), [error, setError] = useState('')
  const load = useCallback(async () => {
    const [list, ai] = await Promise.all([profilesApi.list(), aiSettingsApi.get()])
    setProfiles(list.profiles); setPresets(list.presets); setSettings(ai)
  }, [])
  useEffect(() => { load().catch(failure => setError(message(failure))) }, [load])
  const changed = async () => { await load(); window.dispatchEvent(new Event(PROFILES_CHANGED)) }
  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key); setError('')
    try { await action(); await changed() } catch (failure) { setError(message(failure)) } finally { setBusy('') }
  }

  return <section id="profiles" className="profiles" aria-labelledby="profiles-title">
    <div className="profiles-head">
      <div><h2 id="profiles-title">Transcription profiles</h2>
        <p>Tell the speech model what it is listening to. A profile sends a short context prompt and the names, products, and acronyms to spell correctly. It never rewrites a transcript.</p></div>
      <Button variant="outline" disabled={!settings} onClick={() => setEditing('new')}><Plus />New profile</Button>
    </div>
    {error && <p role="alert" className="note-error">{error}</p>}
    {!profiles ? <p role="status" className="profile-empty">{error ? 'Profiles unavailable.' : 'Loading profiles…'}</p> : <>
      {profiles.length === 0 && <p className="profile-empty">No profiles yet. Start from a preset below; you can edit it afterwards.</p>}
      {profiles.length > 0 && <ul className="profiles-list">{profiles.map(profile => {
        const fit = settings ? profileFit(profile, settings) : null
        return <li key={profile.id} className="profile-card">
          <h3>{profile.name}{settings?.transcriptionProfile === profile.id && <small>Default</small>}</h3>
          <p>{profile.prompt || profile.description || 'No context prompt.'}</p>
          <div className="profile-meta">
            <span>{profile.engine ? settings?.capabilities[profile.engine].label ?? profile.engine : 'Any provider'}{profile.model ? ` · ${profile.model}` : ''}</span>
            {profile.language && <span>{languageLabel(profile.language)}</span>}
            {profile.vocabulary.length > 0 && <span>{profile.vocabulary.length} terms</span>}
            {profile.diarize && <span>Speaker labels</span>}
          </div>
          {fit && fit.ignored.length > 0 && <p className="profile-hint" data-warn>{fit.label} ignores the {fit.ignored.join(' and ')}.</p>}
          <footer>
            <Button size="sm" variant="ghost" onClick={() => setEditing(profile)}><Pencil />Edit</Button>
            <Button size="sm" variant="ghost" disabled={busy === profile.id} onClick={() => { if (window.confirm(`Delete the profile “${profile.name}”? Transcripts made with it keep their provenance.`)) void run(profile.id, () => profilesApi.remove(profile.id)) }}>{busy === profile.id ? <Loader2 className="animate-spin" /> : <Trash2 />}Delete</Button>
          </footer>
        </li>
      })}</ul>}
      <div>
        <p className="profile-hint">Start from a preset</p>
        <div className="profile-presets">{presets.map(preset => <button key={preset.id} type="button" disabled={Boolean(busy)} title={preset.description} onClick={() => void run(`preset:${preset.id}`, () => profilesApi.create({ preset: preset.id }))}>
          {busy === `preset:${preset.id}` ? <Loader2 className="animate-spin" /> : <Sparkles />}{preset.name}</button>)}</div>
      </div>
    </>}
    {editing && settings && <ProfileEditor settings={settings} profile={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await changed() }} />}
  </section>
}

function ProfileEditor({ settings, profile, onClose, onSaved }: { settings: AiSettings; profile: TranscriptionProfile | null; onClose: () => void; onSaved: () => Promise<void> }) {
  // Only editable fields: the API rejects read-only ones such as id and timestamps.
  const [draft, setDraft] = useState<ProfileInput>(() => profile ? Object.fromEntries(Object.keys(blank).map(key => [key, profile[key as keyof ProfileInput]])) as ProfileInput : blank)
  const [vocabulary, setVocabulary] = useState((profile?.vocabulary ?? []).join(', '))
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const set = (patch: Partial<ProfileInput>) => setDraft(value => ({ ...value, ...patch }))
  const terms = vocabulary.split(',').map(term => term.trim()).filter(Boolean)
  const fit = profileFit({ ...draft, vocabulary: terms }, settings)
  const capability = draft.engine ? settings.capabilities[draft.engine] : null
  const local = settings.privacyMode === 'local-only'
  return <NoteDialog title={profile ? 'Edit profile' : 'New transcription profile'} description="Context and vocabulary sent with the audio" onClose={onClose} busy={busy}>
    <form onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('')
      const input = { ...draft, vocabulary: terms, model: draft.model || null }
      try { await (profile ? profilesApi.update(profile.id, input) : profilesApi.create(input)); await onSaved() }
      catch (failure) { setError(message(failure)); setBusy(false) }
    }}>
      <label>Name<input required maxLength={80} value={draft.name} onChange={event => set({ name: event.target.value })} placeholder="Weekly product review" /></label>
      <label>Description<input maxLength={300} value={draft.description} onChange={event => set({ description: event.target.value })} placeholder="When to use this profile" /></label>
      <div className="profile-row">
        <label>Provider<select value={draft.engine ?? ''} onChange={event => { const engine = (event.target.value || null) as SpeechProvider | null; set({ engine, model: null, ...(engine && !settings.capabilities[engine].diarization ? { diarize: null } : {}) }) }}>
          <option value="">Any provider (use the default)</option>
          {Object.entries(settings.capabilities).map(([id, item]) => <option key={id} value={id} disabled={local && !item.local}>{item.label}</option>)}
        </select></label>
        <label>Model<select disabled={!capability} value={draft.model ?? ''} onChange={event => set({ model: event.target.value || null })}>
          <option value="">{capability ? `${capability.models[0]} (default)` : 'Default model'}</option>
          {capability?.models.map(model => <option key={model}>{model}</option>)}
        </select></label>
        <label>Language<select value={draft.language ?? ''} onChange={event => set({ language: event.target.value || null })}>
          <option value="">Use the default</option>{LANGUAGES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
        </select></label>
        <label>Speaker labels<select disabled={Boolean(capability && !capability.diarization)} title={capability && !capability.diarization ? `${capability.label} cannot label speakers` : undefined} value={draft.diarize === null ? '' : String(draft.diarize)} onChange={event => set({ diarize: event.target.value === '' ? null : event.target.value === 'true' })}>
          <option value="">Use the default</option><option value="true">On, where supported</option><option value="false">Off</option>
        </select></label>
      </div>
      <label><span style={{ display: 'flex', justifyContent: 'space-between' }}>Context prompt<span className="profile-count">{draft.prompt.length}/{PROMPT_LIMIT}</span></span>
        <textarea rows={4} maxLength={PROMPT_LIMIT} value={draft.prompt} onChange={event => set({ prompt: event.target.value })} placeholder="A weekly product review between the design and engineering leads. It mentions OpenPlod, Voxtral, and sprint names." /></label>
      <label>Vocabulary<input value={vocabulary} onChange={event => setVocabulary(event.target.value)} placeholder="Names, products, acronyms, separated by commas" /></label>
      <p className="profile-hint" {...(fit.ignored.length ? { 'data-warn': '' } : {})}>
        {fit.ignored.length ? `${fit.label} cannot take the ${fit.ignored.join(' or ')}; ${draft.engine ? 'choose another provider or remove it.' : 'it will be left out when this provider runs.'}` : `${fit.label} will receive this context with the audio.`}
        {' '}Describe the recording rather than giving orders: speech models use the prompt as a spelling and style hint.
      </p>
      {error && <p role="alert" className="note-error">{error}</p>}
      <footer>
        <Button type="button" variant="ghost" disabled={busy} onClick={onClose}><X />Cancel</Button>
        <Button disabled={busy || !draft.name.trim()}>{busy ? <Loader2 className="animate-spin" /> : profile ? <Save /> : <AudioLines />}{profile ? 'Save profile' : 'Create profile'}</Button>
      </footer>
    </form>
  </NoteDialog>
}
