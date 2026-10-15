import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import * as Dialog from '@radix-ui/react-dialog'
import { ArrowLeft, ArrowRight, AudioLines, Bluetooth, Check, CheckCircle2, Cloud, FileText, Loader2, Lock, Mic, NotebookPen, Rocket, ShieldCheck, Smartphone, Sparkles, Upload } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Brand } from '@/components/Brand'
import { ONBOARDING_EVENT, aiSettingsApi, onboardingApi, profilesApi, type AiSettings, type OnboardingStatus, type ProfilePreset, type SpeechProvider } from '@/lib/ai-settings'
import { LANGUAGES, configOf } from '@/lib/transcription'
import { getRuntime } from '@/lib/runtime'
import './onboarding.css'

const STEPS = ['Welcome', 'Privacy', 'Transcription', 'Profile', 'Recordings'] as const
const SPEECH: SpeechProvider[] = ['whisper', 'mistral', 'openai', 'deepgram', 'assemblyai']
const BLURB: Record<SpeechProvider, string> = {
  whisper: 'Runs on this computer. Needs whisper.cpp and a model file.',
  mistral: 'Voxtral: fast, multilingual, strong in French.',
  openai: 'Whisper and GPT-4o transcribe; accepts a context prompt.',
  deepgram: 'Nova models with speaker labels and key terms.',
  assemblyai: 'Universal model with speaker labels and word boost.',
}
const message = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Nothing was changed.'

/** Shows the first-run guide until it is finished or skipped, and again on request. */
export function OnboardingGate() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let active = true
    onboardingApi.status().then(status => { if (active && !status.completedAt) setOpen(true) }).catch(() => {})
    const reopen = () => setOpen(true)
    window.addEventListener(ONBOARDING_EVENT, reopen)
    return () => { active = false; window.removeEventListener(ONBOARDING_EVENT, reopen) }
  }, [])
  return open ? <Onboarding onClose={() => setOpen(false)} /> : null
}

function Onboarding({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const [step, setStep] = useState(0)
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [status, setStatus] = useState<OnboardingStatus | null>(null)
  const [presets, setPresets] = useState<ProfilePreset[]>([])
  const [preset, setPreset] = useState<string>('')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [checked, setChecked] = useState('')
  const mobile = getRuntime().mode === 'mobile'

  useEffect(() => {
    Promise.all([aiSettingsApi.get(), onboardingApi.status(), profilesApi.list()])
      .then(([ai, state, list]) => { setSettings(ai); setStatus(state); setPresets(list.presets) })
      .catch(failure => setError(message(failure)))
  }, [])

  const act = async (work: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await work() } catch (failure) { setError(message(failure)) } finally { setBusy(false) }
  }
  const finish = (skipped: boolean, to?: string) => act(async () => {
    await onboardingApi.complete(skipped)
    onClose()
    if (to) navigate(to)
  })
  const local = settings?.privacyMode === 'local-only'
  const engine = settings?.transcriptionEngine ?? 'whisper'
  const capability = settings?.capabilities[engine]
  const needsKey = Boolean(settings && capability && !capability.local)
  const keyName = `${engine}ApiKey`
  const hasKey = Boolean(settings?.credentials[keyName])

  const saveTranscription = () => act(async () => {
    if (!settings) return
    await aiSettingsApi.save(configOf(settings), key.trim() ? { [keyName]: key.trim() } : {})
    setKey('')
    const [ai, state] = await Promise.all([aiSettingsApi.get(), onboardingApi.status()])
    setSettings(ai); setStatus(state); setStep(3)
  })
  const check = () => act(async () => {
    if (!settings) return
    if (key.trim()) { await aiSettingsApi.save(configOf(settings), { [keyName]: key.trim() }); setKey(''); setSettings(await aiSettingsApi.get()) }
    await aiSettingsApi.check(engine)
    setChecked(engine)
  })
  const saveProfile = () => act(async () => {
    if (!settings) return
    if (preset) {
      const profile = await profilesApi.create({ preset })
      await aiSettingsApi.save({ ...configOf(settings), transcriptionProfile: profile.id }, {})
      setSettings(await aiSettingsApi.get())
    }
    setStep(4)
  })

  return <Dialog.Root open onOpenChange={value => { if (!value && !busy) void finish(true) }}>
    <Dialog.Portal>
      <Dialog.Overlay className="onboarding-overlay" />
      <Dialog.Content className="onboarding" aria-describedby="onboarding-step-description" onInteractOutside={event => event.preventDefault()}>
        <header className="onboarding-top">
          <Brand />
          <ol className="onboarding-steps" aria-label="Setup progress">{STEPS.map((label, index) => <li key={label} data-state={index < step ? 'done' : index === step ? 'current' : 'todo'} aria-current={index === step ? 'step' : undefined}><span>{index < step ? <Check /> : index + 1}</span><em>{label}</em></li>)}</ol>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void finish(true)}>Skip setup</Button>
        </header>

        <div className="onboarding-body">
          {step === 0 && <section className="onboarding-hero">
            <span className="onboarding-badge"><Rocket />OpenPlod 1.0</span>
            <Dialog.Title>Your recordings, your vault.</Dialog.Title>
            <Dialog.Description id="onboarding-step-description">A two-minute setup: choose where audio is processed, pick a transcription model, and tell it what you usually record.</Dialog.Description>
            <ul className="onboarding-promises">
              <li><ShieldCheck /><div><strong>Audio stays on this computer</strong><span>Originals are never deleted or sent anywhere you did not choose.</span></div></li>
              <li><AudioLines /><div><strong>Any speech model you trust</strong><span>Whisper.cpp offline, or Mistral, OpenAI, Deepgram, AssemblyAI with your own key.</span></div></li>
              <li><NotebookPen /><div><strong>Markdown you own</strong><span>Transcripts become documents, chat answers cite exact timestamps, and your notes export to Obsidian.</span></div></li>
            </ul>
          </section>}

          {step === 1 && <section>
            <Dialog.Title>Where should AI run?</Dialog.Title>
            <Dialog.Description id="onboarding-step-description">You can change this any time in Settings. Local only blocks every cloud call, including fallbacks.</Dialog.Description>
            <div className="onboarding-choices" role="radiogroup" aria-label="Processing privacy">
              <button type="button" className="onboarding-card" role="radio" aria-checked={local} disabled={!settings} onClick={() => settings && setSettings({ ...settings, privacyMode: 'local-only', transcriptionEngine: 'whisper', transcriptionModel: '', transcriptionDiarize: false, transcriptionFallback: [], analysisProvider: 'ollama', analysisModel: '', documentProvider: 'ollama', documentModel: '', chatProvider: 'ollama', chatModel: '' })}>
                <Lock /><strong>Local only</strong><span>Whisper.cpp transcribes and Ollama writes documents, all on this machine. Slower, fully offline.</span>
              </button>
              <button type="button" className="onboarding-card" role="radio" aria-checked={settings ? !local : false} disabled={!settings} onClick={() => settings && setSettings({ ...settings, privacyMode: 'selected-providers' })}>
                <Cloud /><strong>Providers I choose</strong><span>Send audio or text only to the providers you select, with your own API keys. Faster and more accurate.</span>
              </button>
            </div>
          </section>}

          {step === 2 && settings && capability && <section>
            <Dialog.Title>Pick a transcription model</Dialog.Title>
            <Dialog.Description id="onboarding-step-description">This is the default; each recording can still use another provider or profile.</Dialog.Description>
            <div className="onboarding-providers" role="radiogroup" aria-label="Transcription provider">
              {SPEECH.map(id => { const item = settings.capabilities[id]; const blocked = local && !item.local
                return <button key={id} type="button" className="onboarding-card" role="radio" aria-checked={engine === id} disabled={blocked || busy} onClick={() => { setChecked(''); setKey(''); setSettings({ ...settings, transcriptionEngine: id, transcriptionModel: '', transcriptionDiarize: false, transcriptionVocabulary: [], transcriptionFallback: [], ...(item.prompt ? {} : { transcriptionPrompt: '' }) }) }}>
                  <strong>{item.label}</strong><span>{BLURB[id]}</span>
                  <small>{[item.local ? 'On device' : 'Cloud', item.prompt && 'Prompt', item.vocabulary && 'Vocabulary', item.diarization && 'Speakers'].filter(Boolean).join(' · ')}</small>
                </button> })}
            </div>
            <div className="onboarding-fields">
              <label>Model<select value={settings.transcriptionModel} onChange={event => setSettings({ ...settings, transcriptionModel: event.target.value })}><option value="">{capability.models[0]} (default)</option>{capability.models.map(model => <option key={model}>{model}</option>)}</select></label>
              <label>Language<select value={settings.transcriptionLanguage} onChange={event => setSettings({ ...settings, transcriptionLanguage: event.target.value })}>{LANGUAGES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label>
              {capability.diarization && <label className="onboarding-check"><input type="checkbox" checked={settings.transcriptionDiarize} onChange={event => setSettings({ ...settings, transcriptionDiarize: event.target.checked })} />Label speakers</label>}
            </div>
            {needsKey ? <div className="onboarding-key">
              <label>{capability.label} API key<input type="password" autoComplete="off" value={key} placeholder={hasKey ? 'Saved key — leave empty to keep it' : 'Paste your key'} onChange={event => { setKey(event.target.value); setChecked('') }} /></label>
              <Button type="button" variant="outline" disabled={busy || (!key.trim() && !hasKey)} onClick={() => void check()}>{checked === engine ? <CheckCircle2 /> : busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}{checked === engine ? 'Connected' : 'Check'}</Button>
              <p>Keys are stored in this vault only and never shown again. The check lists your models; it sends no audio.</p>
            </div> : <p className="onboarding-note">{status?.engine === 'whisper' && status.engineReady ? <><CheckCircle2 />whisper.cpp is installed.</> : <>Install <code>whisper-cpp</code> and put <code>ggml-{settings.transcriptionModel || 'base'}.bin</code> in <code>WHISPER_MODELS_DIR</code>. OpenPlod never downloads models for you.</>}</p>}
          </section>}

          {step === 3 && <section>
            <Dialog.Title>What do you usually record?</Dialog.Title>
            <Dialog.Description id="onboarding-step-description">A profile gives the speech model a context prompt and words to spell right. You can edit it, or add more, in Settings.</Dialog.Description>
            <div className="onboarding-presets" role="radiogroup" aria-label="Transcription profile">
              {presets.map(item => <button key={item.id} type="button" className="onboarding-card" role="radio" aria-checked={preset === item.id} onClick={() => setPreset(value => value === item.id ? '' : item.id)}>
                <Sparkles /><strong>{item.name}</strong><span>{item.description}</span>
              </button>)}
            </div>
            {preset && capability && !capability.prompt && <p className="onboarding-note">{capability.label} cannot take a context prompt, so only the profile’s language and speaker settings apply. OpenAI and Whisper.cpp use the full prompt.</p>}
          </section>}

          {step === 4 && <section>
            <Dialog.Title>Bring in your first recording</Dialog.Title>
            <Dialog.Description id="onboarding-step-description">{status && status.recordings > 0 ? `Your vault already holds ${status.recordings} recording${status.recordings === 1 ? '' : 's'}. ` : ''}Choose where to start. Setup is complete either way.</Dialog.Description>
            <div className="onboarding-actions">
              {!mobile && <button type="button" className="onboarding-card" disabled={busy} onClick={() => void finish(false, '/devices')}><Bluetooth /><strong>Plaud Note Pro</strong><span>Pair over Bluetooth and copy recordings without deleting them from the device.</span><ArrowRight /></button>}
              <button type="button" className="onboarding-card" disabled={busy} onClick={() => void finish(false, '/import')}><Upload /><strong>Import audio files</strong><span>Drop MP3, M4A, WAV, or OGG files, or a Plaud export.</span><ArrowRight /></button>
              <button type="button" className="onboarding-card" disabled={busy} onClick={() => void finish(false, '/record')}><Mic /><strong>Record now</strong><span>Capture a meeting with this device’s microphone.</span><ArrowRight /></button>
              {!mobile && <button type="button" className="onboarding-card" disabled={busy} onClick={() => void finish(false, '/android')}><Smartphone /><strong>Pair an Android phone</strong><span>Scan a QR code to send phone recordings to this vault.</span><ArrowRight /></button>}
              <button type="button" className="onboarding-card" disabled={busy} onClick={() => void finish(false, '/notes')}><FileText /><strong>Start with documents</strong><span>Write Markdown notes and organize them in folders.</span><ArrowRight /></button>
            </div>
          </section>}
          {error && <p role="alert" className="onboarding-error">{error}</p>}
          {!settings && !error && <p role="status" className="onboarding-note"><Loader2 className="animate-spin" />Loading your settings…</p>}
        </div>

        <footer className="onboarding-footer">
          {step > 0 ? <Button variant="ghost" disabled={busy} onClick={() => { setError(''); setStep(step - 1) }}><ArrowLeft />Back</Button> : <span />}
          {step === 0 && <Button disabled={busy} onClick={() => setStep(1)}>Get started<ArrowRight /></Button>}
          {step === 1 && <Button disabled={busy || !settings} onClick={() => setStep(2)}>Continue<ArrowRight /></Button>}
          {step === 2 && <Button disabled={busy || !settings || (needsKey && !hasKey && !key.trim())} onClick={() => void saveTranscription()}>{busy ? <Loader2 className="animate-spin" /> : null}Save and continue<ArrowRight /></Button>}
          {step === 3 && <Button disabled={busy} onClick={() => void saveProfile()}>{busy ? <Loader2 className="animate-spin" /> : null}{preset ? 'Use this profile' : 'Skip for now'}<ArrowRight /></Button>}
          {step === 4 && <Button disabled={busy} onClick={() => void finish(false)}><Check />Open my vault</Button>}
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
