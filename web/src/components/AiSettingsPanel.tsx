import { useEffect, useState } from 'react'
import { aiSettingsApi, profilesApi, type AiSettings, type AiConfig, type SpeechProvider, type TextProvider, type ProcessingJob, type TranscriptionProfile, type MonthSpend } from '@/lib/ai-settings'
import { LANGUAGES, PROMPT_LIMIT, configOf, customEndpointIsLocal, formatUsd, languagesFor } from '@/lib/transcription'
import { PROFILES_CHANGED } from '@/components/TranscriptionProfilesPanel'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Save, RefreshCw, X, Loader2 } from '@/components/icons'

const speech: SpeechProvider[] = ['whisper', 'mistral', 'deepgram', 'openai', 'assemblyai']
const text: TextProvider[] = ['mistral', 'openai', 'anthropic', 'gemini', 'ollama', 'custom']
const labels: Record<string, string> = { whisper: 'Whisper.cpp', mistral: 'Mistral', deepgram: 'Deepgram', openai: 'OpenAI', assemblyai: 'AssemblyAI', anthropic: 'Anthropic', ollama: 'Ollama', gemini: 'Gemini', custom: 'Custom endpoint' }
const tasks = ['analysis', 'document', 'chat'] as const
const selectClass = 'h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm'
const usdValue = (value: string) => value.trim() === '' ? null : Math.max(0, Number(value))
export function AiSettingsPanel() {
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [vocabulary, setVocabulary] = useState('')
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const [models, setModels] = useState<string[]>([]), [jobs, setJobs] = useState<ProcessingJob[]>([])
  const [contexts, setContexts] = useState<Record<string, number | null>>({}), [spend, setSpend] = useState<MonthSpend | null>(null)
  useEffect(() => { let active = true; aiSettingsApi.get().then(value => { if (active) { setSettings(value); setVocabulary(value.transcriptionVocabulary.join(', ')) } }).catch(e => { if (active) setError(e.message) }); aiSettingsApi.spending().then(value => { if (active) setSpend(value) }).catch(() => {}); return () => { active = false } }, [])
  const [profiles, setProfiles] = useState<TranscriptionProfile[]>([])
  useEffect(() => {
    const load = () => { profilesApi.list().then(value => setProfiles(value.profiles)).catch(() => setProfiles([])) }
    load(); window.addEventListener(PROFILES_CHANGED, load)
    return () => window.removeEventListener(PROFILES_CHANGED, load)
  }, [])
  const update = (patch: Partial<AiConfig>) => { setNotice(''); if (patch.transcriptionVocabulary) setVocabulary(patch.transcriptionVocabulary.join(', ')); setSettings(value => value ? { ...value, ...patch } : value) }
  const action = async (run: () => Promise<void>) => { setBusy(true); setError(''); setNotice(''); try { await run() } catch (e) { setError(e instanceof Error ? e.message : 'AI settings unavailable.') } finally { setBusy(false) } }
  const save = () => action(async () => {
    if (!settings) return
    const config = configOf(settings)
    config.transcriptionVocabulary = vocabulary.split(',').map(value => value.trim()).filter(Boolean)
    await aiSettingsApi.save(config, keys); setKeys({}); setSettings(await aiSettingsApi.get()); setSpend(await aiSettingsApi.spending().catch(() => null)); setNotice('AI settings saved')
  })
  // Context windows of the selected local models, so long transcripts are refused up front rather than truncated.
  const loadModels = () => action(async () => {
    const installed = await aiSettingsApi.models(); setModels(installed)
    const selected = settings ? [...new Set(tasks.filter(task => settings[`${task}Provider`] === 'ollama').map(task => settings[`${task}Model`]).filter(model => installed.includes(model)))] : []
    const found = await Promise.all(selected.map(async model => [model, (await aiSettingsApi.ollamaContext(model).catch(() => null))?.contextLength ?? null] as const))
    setContexts(Object.fromEntries(found))
  })
  if (!settings) return <section className="border-t pt-5" aria-label="AI providers">{error ? <p role="alert">{error}</p> : <p role="status">Loading AI settings...</p>}<Button variant="ghost" onClick={() => action(async () => setSettings(await aiSettingsApi.get()))}><RefreshCw />Retry</Button></section>
  const local = settings.privacyMode === 'local-only', capability = settings.capabilities[settings.transcriptionEngine]
  const customLocal = customEndpointIsLocal(settings.customBaseUrl)
  const isLocalText = (provider: TextProvider) => provider === 'ollama' || (provider === 'custom' && customLocal)
  const textUsed = tasks.flatMap(task => [settings[`${task}Provider`], ...settings[`${task}Fallback`].map(entry => entry.provider)])
  const used = [...new Set([settings.transcriptionEngine, ...settings.transcriptionFallback, ...textUsed])].filter(provider => !['whisper', 'ollama'].includes(provider))
  const languages = languagesFor(settings, settings.transcriptionEngine, settings.transcriptionModel)
  const languageOptions = languages.some(([code]) => code === settings.transcriptionLanguage) ? languages : [...languages, [settings.transcriptionLanguage, `${LANGUAGES.find(([code]) => code === settings.transcriptionLanguage)?.[1] ?? settings.transcriptionLanguage} (not documented for this model)`] as [string, string]]
  return <section className="border-t pt-5 space-y-5" aria-label="AI providers">
    <div className="flex items-center justify-between gap-3"><h2 className="text-base font-semibold">AI providers</h2><Button disabled={busy} onClick={save}>{busy ? <Loader2 className="animate-spin" /> : <Save />}Save AI</Button></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}{notice && <p role="status" className="text-sm">{notice}</p>}
    <label className="grid gap-2 text-sm">Processing privacy<select className={selectClass} disabled={busy} value={settings.privacyMode} onChange={e => update(e.target.value === 'local-only' ? { privacyMode: 'local-only', transcriptionEngine: 'whisper', transcriptionModel: '', transcriptionDiarize: false, transcriptionVocabulary: [], transcriptionFallback: [], analysisProvider: 'ollama', analysisModel: '', documentProvider: 'ollama', documentModel: '', chatProvider: 'ollama', chatModel: '', analysisFallback: [], documentFallback: [], chatFallback: [] } : { privacyMode: 'selected-providers' })}><option value="selected-providers">Selected providers</option><option value="local-only">Local only</option></select></label>
    <fieldset disabled={busy} className="grid min-w-0 gap-4 sm:grid-cols-2"><legend className="mb-3 text-sm font-semibold">Transcription</legend>
      <label className="grid gap-2 text-sm">Provider<select className={selectClass} value={settings.transcriptionEngine} onChange={e => update({ transcriptionEngine: e.target.value as SpeechProvider, transcriptionModel: '', transcriptionDiarize: false, transcriptionVocabulary: [], transcriptionFallback: [], ...(settings.capabilities[e.target.value as SpeechProvider].prompt ? {} : { transcriptionPrompt: '' }) })}>{speech.map(provider => <option key={provider} disabled={local && provider !== 'whisper'} value={provider}>{labels[provider]}</option>)}</select></label>
      <label className="grid gap-2 text-sm">Model<select className={selectClass} value={settings.transcriptionModel} onChange={e => update({ transcriptionModel: e.target.value })}><option value="">{capability.models[0]} (default)</option>{capability.models.map(model => <option key={model}>{model}</option>)}</select></label>
      <label className="grid gap-2 text-sm">Language<select className={selectClass} value={settings.transcriptionLanguage} onChange={e => update({ transcriptionLanguage: e.target.value })}>{languageOptions.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!capability.diarization} checked={settings.transcriptionDiarize} onChange={e => update({ transcriptionDiarize: e.target.checked })} />Speaker labels</label>
      <label className="grid gap-2 text-sm sm:col-span-2">Vocabulary hints<Input disabled={!capability.vocabulary} value={vocabulary} onChange={e => { setVocabulary(e.target.value); setNotice('') }} /></label>
      <label className="grid gap-2 text-sm sm:col-span-2">Default profile<select className={selectClass} value={settings.transcriptionProfile} onChange={e => update({ transcriptionProfile: e.target.value })}><option value="">None</option>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}{settings.transcriptionProfile && !profiles.some(profile => profile.id === settings.transcriptionProfile) && <option value={settings.transcriptionProfile}>Missing profile</option>}</select></label>
      <label className="grid gap-2 text-sm sm:col-span-2">Context prompt<textarea className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm" disabled={!capability.prompt} maxLength={PROMPT_LIMIT} rows={3} value={capability.prompt ? settings.transcriptionPrompt : ''} placeholder={capability.prompt ? 'Describe your usual recordings: who speaks, the topic, names to spell.' : `${capability.label} does not accept a context prompt.`} onChange={e => update({ transcriptionPrompt: e.target.value })} /></label>
      <label className="grid gap-2 text-sm sm:col-span-2">Fallback provider<select className={selectClass} value={settings.transcriptionFallback[0] || ''} onChange={e => update({ transcriptionFallback: e.target.value ? [e.target.value as SpeechProvider] : [] })}><option value="">None</option>{speech.filter(provider => provider !== settings.transcriptionEngine).map(provider => <option key={provider} disabled={local && provider !== 'whisper'} value={provider}>{labels[provider]}</option>)}</select></label>
      <label className="grid gap-2 text-sm sm:col-span-2">Split recordings longer than (minutes, 0 = only when a provider size limit requires it)<Input type="number" min={0} max={1440} step={1} value={settings.transcriptionChunkAboveMinutes} onChange={e => update({ transcriptionChunkAboveMinutes: Math.max(0, Math.min(1440, Math.round(Number(e.target.value) || 0))) })} /></label>
    </fieldset>
    <fieldset disabled={busy} className="space-y-4 border-t pt-4"><legend className="text-sm font-semibold">Text AI</legend>{tasks.map(task => {
      const provider = settings[`${task}Provider`], model = settings[`${task}Model`], fallback = settings[`${task}Fallback`][0]?.provider ?? ''
      return <div key={task} className="grid gap-3 sm:grid-cols-3">
        <label className="grid gap-2 text-sm">{task === 'analysis' ? 'Summaries' : task === 'document' ? 'Documents' : 'Chat'}<select className={selectClass} value={provider} onChange={e => update({ [`${task}Provider`]: e.target.value, [`${task}Model`]: '', [`${task}Fallback`]: [] })}>{text.map(item => <option key={item} value={item} disabled={local && !isLocalText(item)}>{labels[item]}</option>)}</select></label>
        <label className="grid gap-2 text-sm">Model{provider === 'ollama' ? <select className={selectClass} value={model} onChange={e => update({ [`${task}Model`]: e.target.value })}><option value="">Select installed model</option>{models.map(item => <option key={item}>{item}</option>)}</select> : <Input value={model} placeholder={provider === 'custom' ? 'Model name (required)' : `${settings.textCapabilities[provider]?.defaultModel ?? 'Provider'} (default)`} onChange={e => update({ [`${task}Model`]: e.target.value })} />}
          {provider === 'ollama' && model in contexts && <span className="text-xs text-muted-foreground">{contexts[model] ? `Context window: ${contexts[model]} tokens (roughly ${Math.round(contexts[model]! * 4 / 1000)} KB of text). Longer transcripts are refused, never sent to a cloud provider.` : 'Ollama did not report a context window for this model.'}</span>}</label>
        <label className="grid gap-2 text-sm">Fallback<select className={selectClass} value={fallback} onChange={e => update({ [`${task}Fallback`]: e.target.value ? [{ provider: e.target.value as TextProvider, model: '' }] : [] })}><option value="">None</option>{text.filter(item => item !== provider && !['ollama', 'custom'].includes(item)).map(item => <option key={item} value={item} disabled={local && !isLocalText(item)}>{labels[item]}</option>)}</select></label>
      </div>
    })}
    <p className="text-xs text-muted-foreground">A fallback is used only when the first provider fails, and only the one you choose here. The provider that answered is recorded with each result.</p>
    {[...textUsed].includes('custom') && <label className="grid gap-2 text-sm">Custom OpenAI-compatible endpoint<Input value={settings.customBaseUrl} placeholder="https://example.com/v1" onChange={e => update({ customBaseUrl: e.target.value.trim() })} /><span className="text-xs text-muted-foreground">{customLocal ? 'Loopback endpoint: treated as local.' : 'Treated as a cloud provider. HTTPS is required (plain HTTP only on this computer); redirects are refused; JSON mode is not assumed.'}</span></label>}
    {textUsed.includes('ollama') && <Button variant="outline" onClick={loadModels}><RefreshCw />Load local models</Button>}</fieldset>
    <fieldset disabled={busy} className="grid min-w-0 gap-4 border-t pt-4 sm:grid-cols-2"><legend className="mb-3 text-sm font-semibold">Cloud spending</legend>
      <label className="grid gap-2 text-sm">Monthly budget (USD)<Input type="number" min={0} step="0.01" value={settings.monthlyBudgetUsd ?? ''} placeholder="No budget" onChange={e => update({ monthlyBudgetUsd: usdValue(e.target.value) })} /></label>
      <label className="grid gap-2 text-sm">Ask before a job over (USD)<Input type="number" min={0} step="0.01" value={settings.confirmAboveUsd ?? ''} placeholder="Never ask" onChange={e => update({ confirmAboveUsd: usdValue(e.target.value) })} /></label>
      <p className="text-xs text-muted-foreground sm:col-span-2">{spend ? `Estimated this month (${spend.month}, UTC): ${formatUsd(spend.estimatedUsd)}${spend.unknownEntries ? `, plus ${spend.unknownEntries} job${spend.unknownEntries === 1 ? '' : 's'} with unknown cost` : ''}${spend.budgetUsd !== null ? `; ${formatUsd(spend.remainingUsd)} of ${formatUsd(spend.budgetUsd)} left` : ''}. ` : ''}{settings.pricing.label} Prices as of {settings.pricing.pricesAsOf}. Jobs over the budget or threshold need your confirmation; providers do not enforce this limit.</p>
    </fieldset>
    {used.length > 0 && <fieldset disabled={busy} className="space-y-4 border-t pt-4"><legend className="text-sm font-semibold">Credentials</legend>{used.map(provider => <div key={provider} className="flex items-end gap-2"><label className="grid flex-1 gap-2 text-sm">{labels[provider]} API key{provider === 'custom' ? ' (optional)' : ''}<Input type="password" autoComplete="off" value={keys[`${provider}ApiKey`] || ''} placeholder={settings.credentials[`${provider}ApiKey`] ? 'Saved key' : 'Not configured'} onChange={e => setKeys(value => ({ ...value, [`${provider}ApiKey`]: e.target.value }))} /></label><Button variant="outline" disabled={Object.keys(keys).length > 0} onClick={() => action(async () => { await aiSettingsApi.check(provider); setNotice(`${labels[provider]} connection verified`) })}>Check</Button></div>)}</fieldset>}
    <details className="border-t pt-4"><summary className="cursor-pointer text-sm">Processing jobs</summary><Button variant="ghost" className="my-2" onClick={() => action(async () => setJobs(await aiSettingsApi.jobs()))}><RefreshCw />Refresh</Button><ul className="divide-y">{jobs.slice().reverse().map(job => <li key={job.id} className="flex items-center gap-2 py-3 text-sm"><div className="min-w-0 flex-1"><p className="truncate">{labels[job.provider || ''] || 'Processing'} / {job.status}{job.checkpoint?.progress ? ` / chunk ${Math.min(job.checkpoint.progress.done + (job.status === 'running' ? 1 : 0), job.checkpoint.progress.total)} of ${job.checkpoint.progress.total}` : ''}</p><p className="break-words text-xs text-muted-foreground">{job.error || job.checkpoint?.phase || job.recordingId}</p></div>{['running', 'pending'].includes(job.status) && <Button variant="ghost" size="icon" title="Cancel processing" onClick={() => action(async () => { await aiSettingsApi.cancel(job.id); setJobs(await aiSettingsApi.jobs()) })}><X /></Button>}{(job.checkpoint?.remoteId || job.checkpoint?.inFlight === false) && ['failed', 'cancelled'].includes(job.status) && <Button variant="outline" onClick={() => action(async () => { await aiSettingsApi.resume(job.id); setJobs(await aiSettingsApi.jobs()) })}>Resume</Button>}</li>)}</ul></details>
  </section>
}
