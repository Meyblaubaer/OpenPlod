import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, ArrowUp, Check, Copy, Download, History, KeyRound, ListChecks, Loader2, Pencil, Plus, RefreshCw, RotateCcw, Save, Send, ShieldCheck, Trash2, Undo2, Wand2, X } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { NoteDialog, FolderSelect } from '@/components/NoteDialogs'
import { notesApi, type NoteFolder } from '@/lib/notes-api'
import { aiSettingsApi, profilesApi, type AiSettings, type TranscriptionProfile } from '@/lib/ai-settings'
import { api, type Recording } from '@/lib/api'
import {
  CONNECTORS, RECORDING_TYPES, RULE_SOURCES, TEMPLATE_LABELS, VERIFY_SNIPPET, WEBHOOK_EVENT_TYPES, blankRule, describeAction, describeTrigger, pendingAcknowledgements,
  rulesApi, tasksApi, webhooksApi,
  type AutomationRule, type Connector, type ConnectorSettings, type RuleAction, type RuleInput, type RulePreview, type RuleRun, type TaskDraft,
  type WebhookDelivery, type WebhookEventType, type WebhookSubscription,
} from '@/lib/automation-api'
import './automations.css'

type Tab = 'rules' | 'history' | 'webhooks' | 'tasks'
const TABS: [Tab, string][] = [['rules', 'Rules'], ['history', 'History'], ['webhooks', 'Webhooks'], ['tasks', 'Tasks']]
const message = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong.'
const when = (iso: string | null) => iso ? new Date(iso).toLocaleString() : '—'
const SOURCE_LABELS: Record<string, string> = { plaud: 'Plaud', upload: 'Uploads', mobile: 'Phone' }

/**
 * Automations (roadmap KB-08..KB-10): opt-in rules with a preview and explicit
 * approval for anything that leaves the computer, their execution history,
 * signed webhooks, and reviewed task exports. Nothing here runs or posts until
 * the person turns it on or presses the button.
 */
export function AutomationsPage() {
  const [tab, setTab] = useState<Tab>('rules')
  return <div className="studio-secondary-page automations-page">
    <header><div className="automations-title"><h1>Automations</h1>
      <p>Opt-in rules for new recordings, signed webhooks, and reviewed task exports. Transcript text never triggers or changes an action, and nothing is sent anywhere you have not approved.</p></div></header>
    <div className="automations-tabs" role="tablist" aria-label="Automation sections">
      {TABS.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}
    </div>
    <div role="tabpanel">
      {tab === 'rules' && <RulesPanel />}
      {tab === 'history' && <HistoryPanel />}
      {tab === 'webhooks' && <WebhooksPanel />}
      {tab === 'tasks' && <TasksPanel />}
    </div>
  </div>
}

// ============================================================ rules

interface RuleContext { settings: AiSettings | null; profiles: TranscriptionProfile[]; folders: NoteFolder[]; webhooks: WebhookSubscription[] }

function RulesPanel() {
  const [rules, setRules] = useState<AutomationRule[] | null>(null)
  const [context, setContext] = useState<RuleContext>({ settings: null, profiles: [], folders: [], webhooks: [] })
  const [editing, setEditing] = useState<AutomationRule | 'new' | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState('')
  const load = useCallback(async () => {
    const [list, settings, profiles, folders, hooks] = await Promise.all([rulesApi.list(), aiSettingsApi.get().catch(() => null),
      profilesApi.list().catch(() => ({ profiles: [] })), notesApi.folders().catch(() => []), webhooksApi.list().catch(() => ({ subscriptions: [] }))])
    setRules(list); setContext({ settings, profiles: profiles.profiles, folders, webhooks: hooks.subscriptions })
  }, [])
  useEffect(() => { load().catch(failure => setError(message(failure))) }, [load])
  const names = useMemo(() => ({ webhooks: Object.fromEntries(context.webhooks.map(hook => [hook.id, hook.name])), profiles: Object.fromEntries(context.profiles.map(profile => [profile.id, profile.name])) }), [context])
  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key); setError('')
    try { await action(); await load() } catch (failure) { setError(message(failure)) } finally { setBusy('') }
  }
  return <section aria-labelledby="rules-title">
    <div className="automations-head"><div><h2 id="rules-title"><Wand2 />Rules</h2>
      <p>A rule runs once per new matching recording. Each step is recorded in History and is never repeated on retry.</p></div>
      <Button variant="outline" onClick={() => setEditing('new')}><Plus />New rule</Button></div>
    {error && <p role="alert" className="note-error">{error}</p>}
    {!rules ? <p role="status" className="automations-empty">{error ? 'Rules unavailable.' : 'Loading rules…'}</p>
      : rules.length === 0 ? <p className="automations-empty">No rules yet. Example: Plaud meetings → transcribe with your chosen provider → draft meeting minutes into Documents/Meetings.</p>
      : <ul className="automations-list">{rules.map(rule => <li key={rule.id} className="automation-card">
        <header><h3>{rule.name}</h3><span className="automation-pill" data-state={rule.enabled ? 'on' : 'off'}>{rule.enabled ? 'On' : 'Off'}</span></header>
        <p>{describeTrigger(rule.trigger)}</p>
        <ol className="automation-steps">{rule.actions.map((action, index) => <li key={index}>{describeAction(action, names)}</li>)}</ol>
        {rule.acknowledgements.length > 0 && <p className="automation-hint"><ShieldCheck />Approved to send to {rule.acknowledgements.join(', ')}</p>}
        <footer>
          <Button size="sm" variant="ghost" onClick={() => setEditing(rule)}><Pencil />Edit</Button>
          <Button size="sm" variant="ghost" disabled={busy === rule.id} onClick={() => void run(rule.id, () => rulesApi.update(rule.id, { enabled: !rule.enabled, revision: rule.revision }))}>
            {busy === rule.id ? <Loader2 className="animate-spin" /> : rule.enabled ? <X /> : <Check />}{rule.enabled ? 'Turn off' : 'Turn on'}</Button>
          <Button size="sm" variant="ghost" disabled={busy === `delete:${rule.id}`} onClick={() => { if (window.confirm(`Delete the rule “${rule.name}”? Its history is kept.`)) void run(`delete:${rule.id}`, () => rulesApi.remove(rule.id)) }}><Trash2 />Delete</Button>
        </footer>
      </li>)}</ul>}
    {editing && <RuleEditor rule={editing === 'new' ? null : editing} context={context} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await load() }} />}
  </section>
}

function defaultAction(type: RuleAction['type'], context: RuleContext): RuleAction {
  switch (type) {
    case 'transcribe': return { type, provider: null, profileId: null }
    case 'generate_document': return { type, template: 'meeting', folderId: null }
    case 'add_tags': return { type, tags: [] }
    case 'add_to_collection': return { type, collectionId: '' }
    case 'notify_webhook': return { type, subscriptionId: context.webhooks[0]?.id ?? '' }
  }
}
const ACTION_LABELS: Record<RuleAction['type'], string> = { transcribe: 'Transcribe', generate_document: 'Generate document', add_tags: 'Add tags', add_to_collection: 'Add to collection', notify_webhook: 'Notify webhook' }

function RuleEditor({ rule, context, onClose, onSaved }: { rule: AutomationRule | null; context: RuleContext; onClose: () => void; onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState<RuleInput>(() => rule ? { name: rule.name, enabled: rule.enabled, trigger: rule.trigger, actions: rule.actions, acknowledgements: rule.acknowledgements } : blankRule())
  const [tagText, setTagText] = useState<Record<number, string>>(() => Object.fromEntries(draft.actions.map((action, index) => [index, action.type === 'add_tags' ? action.tags.join(', ') : ''])))
  const [preview, setPreview] = useState<RulePreview | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const set = (patch: Partial<RuleInput>) => { setDraft(value => ({ ...value, ...patch })); setPreview(null) }
  const setTrigger = (patch: Partial<RuleInput['trigger']>) => set({ trigger: { ...draft.trigger, ...patch } })
  const setAction = (index: number, action: RuleAction) => set({ actions: draft.actions.map((item, position) => position === index ? action : item) })
  const toggle = <T extends string>(list: T[], value: T) => list.includes(value) ? list.filter(item => item !== value) : [...list, value]
  const normalized = (): RuleInput => ({ ...draft, actions: draft.actions.map((action, index) => action.type === 'add_tags'
    ? { ...action, tags: (tagText[index] ?? '').split(',').map(tag => tag.trim()).filter(Boolean) } : action) })
  const runPreview = async () => {
    setBusy(true); setError('')
    try { setPreview(await rulesApi.preview(normalized())) } catch (failure) { setError(message(failure)) } finally { setBusy(false) }
  }
  const pending = preview ? pendingAcknowledgements(preview.requirements, draft.acknowledgements) : []
  const capabilities = context.settings?.capabilities
  const localOnly = context.settings?.privacyMode === 'local-only'
  return <NoteDialog title={rule ? 'Edit rule' : 'New automation rule'} description="Runs only for recordings imported after it is turned on" onClose={onClose} busy={busy}>
    <form className="rule-form" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('')
      try {
        const input = normalized()
        await (rule ? rulesApi.update(rule.id, { ...input, revision: rule.revision }) : rulesApi.create(input))
        await onSaved()
      } catch (failure) { setError(message(failure)); setBusy(false) }
    }}>
      <label>Name<input required maxLength={80} value={draft.name} onChange={event => set({ name: event.target.value })} placeholder="Plaud meetings to minutes" /></label>
      <fieldset><legend>When a new recording is imported</legend>
        <div className="rule-checks"><span>Source</span>{RULE_SOURCES.map(source => <label key={source}><input type="checkbox" checked={draft.trigger.sources.includes(source)} onChange={() => setTrigger({ sources: toggle(draft.trigger.sources, source) })} />{SOURCE_LABELS[source]}</label>)}</div>
        <div className="rule-checks"><span>Type</span>{RECORDING_TYPES.map(type => <label key={type}><input type="checkbox" checked={draft.trigger.recordingTypes.includes(type)} onChange={() => setTrigger({ recordingTypes: toggle(draft.trigger.recordingTypes, type) })} />{type}</label>)}</div>
        <div className="rule-row">
          <label>Has tag<input maxLength={64} value={draft.trigger.tag ?? ''} onChange={event => setTrigger({ tag: event.target.value.trim() ? event.target.value : null })} placeholder="Any" /></label>
          <label>Minimum length (minutes)<input type="number" min={0} max={1440} value={draft.trigger.minDurationSeconds === null ? '' : Math.round(draft.trigger.minDurationSeconds / 60)} onChange={event => setTrigger({ minDurationSeconds: event.target.value === '' ? null : Math.max(0, Number(event.target.value)) * 60 })} placeholder="Any" /></label>
        </div>
        <p className="automation-hint">Empty filters match everything. Leave the source empty to include all imports.</p>
      </fieldset>
      <fieldset><legend>Then, in order</legend>
        <ol className="rule-actions">{draft.actions.map((action, index) => <li key={index}>
          <div className="rule-action-head">
            <select aria-label={`Step ${index + 1} action`} value={action.type} onChange={event => setAction(index, defaultAction(event.target.value as RuleAction['type'], context))}>
              {Object.entries(ACTION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
            <Button type="button" size="icon" variant="ghost" aria-label="Move step up" title="Move up" disabled={index === 0} onClick={() => { const next = [...draft.actions]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; set({ actions: next }) }}><ArrowUp /></Button>
            <Button type="button" size="icon" variant="ghost" aria-label="Move step down" title="Move down" disabled={index === draft.actions.length - 1} onClick={() => { const next = [...draft.actions]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; set({ actions: next }) }}><ArrowUp className="icon-flip" /></Button>
            <Button type="button" size="icon" variant="ghost" aria-label="Remove step" title="Remove" disabled={draft.actions.length === 1} onClick={() => set({ actions: draft.actions.filter((_, position) => position !== index) })}><Trash2 /></Button>
          </div>
          {action.type === 'transcribe' && <div className="rule-row">
            <label>Provider<select value={action.provider ?? ''} onChange={event => setAction(index, { ...action, provider: event.target.value || null })}>
              <option value="">Default provider</option>
              {capabilities && Object.entries(capabilities).map(([id, item]) => <option key={id} value={id} disabled={localOnly && !item.local}>{item.label}{item.local ? ' (on this computer)' : ''}</option>)}</select></label>
            <label>Profile<select value={action.profileId ?? ''} onChange={event => setAction(index, { ...action, profileId: event.target.value || null })}>
              <option value="">Default</option>{context.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
          </div>}
          {action.type === 'generate_document' && <div className="rule-row">
            <label>Template<select value={action.template} onChange={event => setAction(index, { ...action, template: event.target.value })}>
              {Object.entries(TEMPLATE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label>Save into<FolderSelect folders={context.folders} value={action.folderId ?? ''} onChange={value => setAction(index, { ...action, folderId: value || null })} /></label>
          </div>}
          {action.type === 'add_tags' && <label>Tags<input value={tagText[index] ?? ''} onChange={event => { setTagText(value => ({ ...value, [index]: event.target.value })); setPreview(null) }} placeholder="meeting, auto" /></label>}
          {action.type === 'add_to_collection' && <label>Collection id<input value={action.collectionId} onChange={event => setAction(index, { ...action, collectionId: event.target.value })} placeholder="Skipped if collections are unavailable" /></label>}
          {action.type === 'notify_webhook' && (context.webhooks.length
            ? <label>Webhook<select value={action.subscriptionId} onChange={event => setAction(index, { ...action, subscriptionId: event.target.value })}>
              {context.webhooks.map(hook => <option key={hook.id} value={hook.id}>{hook.name} ({hook.host})</option>)}</select></label>
            : <p className="automation-hint" data-warn>Create a webhook first in the Webhooks tab.</p>)}
        </li>)}</ol>
        {draft.actions.length < 8 && <Button type="button" size="sm" variant="ghost" onClick={() => set({ actions: [...draft.actions, defaultAction('add_tags', context)] })}><Plus />Add step</Button>}
      </fieldset>
      <div className="rule-preview-bar"><Button type="button" variant="outline" disabled={busy} onClick={() => void runPreview()}>{busy ? <Loader2 className="animate-spin" /> : <ListChecks />}Preview scope and data use</Button></div>
      {preview && <div className="rule-preview" aria-live="polite">
        <p><strong>{preview.totalMatches}</strong> of {preview.scanned} existing recordings match. {preview.note}</p>
        {preview.matches.length > 0 && <ul className="rule-matches">{preview.matches.slice(0, 8).map(match => <li key={match.id}>{match.title ?? match.id}<small>{match.recordingType}{match.durationSeconds ? ` · ${Math.round(match.durationSeconds / 60)} min` : ''}</small></li>)}</ul>}
        {preview.problems.map(problem => <p key={problem} role="alert" className="note-error">{problem}</p>)}
        <h4>Where data goes</h4>
        {preview.requirements.length === 0 ? <p className="automation-hint">Nothing leaves this computer.</p>
          : <ul className="rule-requirements">{preview.requirements.map(item => <li key={`${item.key}:${item.step}`}>
            {item.local ? <span className="automation-hint"><ShieldCheck />Step {item.step + 1}: {item.label} (on this computer)</span>
              : <label><input type="checkbox" checked={draft.acknowledgements.includes(item.key)} onChange={() => setDraft(value => ({ ...value, acknowledgements: toggle(value.acknowledgements, item.key) }))} />
                Step {item.step + 1}: I approve that <strong>{item.label}</strong>{preview.blockedByLocalOnly.includes(item.key) ? ' (currently blocked by local-only mode)' : ''}</label>}
          </li>)}</ul>}
        <p className="automation-hint">Estimated cost: unknown. {preview.estimatedCost.reason}</p>
      </div>}
      <label className="rule-enable"><input type="checkbox" checked={draft.enabled} onChange={event => set({ enabled: event.target.checked })} />Turn this rule on</label>
      {draft.enabled && !preview && <p className="automation-hint">Preview before turning on to review and approve where data goes.</p>}
      {draft.enabled && pending.length > 0 && <p className="automation-hint" data-warn><AlertCircle />Approve {pending.join(', ')} above, or leave the rule off.</p>}
      {error && <p role="alert" className="note-error">{error}</p>}
      <footer>
        <Button type="button" variant="ghost" disabled={busy} onClick={onClose}><X />Cancel</Button>
        <Button disabled={busy || !draft.name.trim()}>{busy ? <Loader2 className="animate-spin" /> : <Save />}{rule ? 'Save rule' : 'Create rule'}</Button>
      </footer>
    </form>
  </NoteDialog>
}

// ============================================================ history

function HistoryPanel() {
  const [runs, setRuns] = useState<RuleRun[] | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState('')
  const load = useCallback(async () => setRuns(await rulesApi.runs()), [])
  useEffect(() => { load().catch(failure => setError(message(failure))) }, [load])
  return <section aria-labelledby="history-title">
    <div className="automations-head"><div><h2 id="history-title"><History />Execution history</h2>
      <p>Every rule run and each of its steps. Retrying reuses each step's id, so finished work is never repeated.</p></div>
      <Button variant="ghost" onClick={() => { setError(''); load().catch(failure => setError(message(failure))) }}><RefreshCw />Refresh</Button></div>
    {error && <p role="alert" className="note-error">{error}</p>}
    {!runs ? <p role="status" className="automations-empty">{error ? 'History unavailable.' : 'Loading…'}</p>
      : runs.length === 0 ? <p className="automations-empty">No rule has run yet.</p>
      : <ul className="automations-list single">{runs.map(run => <li key={run.id} className="automation-card">
        <header><h3>{run.ruleName ?? 'Deleted rule'} · {run.recordingTitle ?? run.recordingId}</h3><span className="automation-pill" data-state={run.status}>{run.status}</span></header>
        <small className="automation-hint">{when(run.createdAt)}</small>
        <ol className="automation-steps">{run.steps.map(step => <li key={step.id}><span className="automation-pill" data-state={step.status}>{step.status}</span> {step.type.replace(/_/g, ' ')}{step.detail ? ` — ${step.detail}` : ''}</li>)}</ol>
        {(run.status === 'failed' || run.status === 'cancelled') && <footer><Button size="sm" variant="ghost" disabled={busy === run.id} onClick={async () => {
          setBusy(run.id); setError('')
          try { await rulesApi.retry(run.id); await load() } catch (failure) { setError(message(failure)) } finally { setBusy('') }
        }}>{busy === run.id ? <Loader2 className="animate-spin" /> : <RotateCcw />}Retry failed steps</Button></footer>}
      </li>)}</ul>}
  </section>
}

// ============================================================ webhooks

function WebhooksPanel() {
  const [hooks, setHooks] = useState<WebhookSubscription[] | null>(null)
  const [creating, setCreating] = useState(false)
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([])
  const [error, setError] = useState(''), [busy, setBusy] = useState('')
  const load = useCallback(async () => setHooks((await webhooksApi.list()).subscriptions), [])
  useEffect(() => { load().catch(failure => setError(message(failure))) }, [load])
  const showDeliveries = async (id: string) => { setOpen(id); setDeliveries(await webhooksApi.deliveries(id)) }
  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key); setError('')
    try { await action(); await load(); if (open) await showDeliveries(open) } catch (failure) { setError(message(failure)) } finally { setBusy('') }
  }
  return <section aria-labelledby="webhooks-title">
    <div className="automations-head"><div><h2 id="webhooks-title"><Send />Webhooks</h2>
      <p>Signed event notifications with ids and metadata. Transcript and document text is only included when you turn it on for a webhook.</p></div>
      <Button variant="outline" onClick={() => setCreating(true)}><Plus />New webhook</Button></div>
    {error && <p role="alert" className="note-error">{error}</p>}
    {secret && <div className="webhook-secret" role="status"><KeyRound /><div><strong>Signing secret for {secret.name}</strong><p>Copy it now. It is not shown again.</p><code>{secret.value}</code></div>
      <Button size="sm" variant="ghost" onClick={() => { void navigator.clipboard.writeText(secret.value).catch(() => setError('Clipboard unavailable')) }}><Copy />Copy</Button>
      <Button size="icon" variant="ghost" aria-label="Dismiss secret" onClick={() => setSecret(null)}><X /></Button></div>}
    {!hooks ? <p role="status" className="automations-empty">{error ? 'Webhooks unavailable.' : 'Loading…'}</p>
      : hooks.length === 0 ? <p className="automations-empty">No webhooks yet.</p>
      : <ul className="automations-list single">{hooks.map(hook => <li key={hook.id} className="automation-card">
        <header><h3>{hook.name}</h3><span className="automation-pill" data-state={hook.enabled ? 'on' : 'off'}>{hook.enabled ? 'On' : 'Off'}</span></header>
        <p><code>{hook.url}</code>{hook.external ? ' · leaves this computer' : ' · this computer'}{hook.includeText ? ' · includes text' : ''}</p>
        <p className="automation-hint">{hook.eventTypes.join(', ')}</p>
        {hook.disabledReason && <p className="automation-hint" data-warn><AlertCircle />{hook.disabledReason}</p>}
        <footer>
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void run(`test:${hook.id}`, () => webhooksApi.test(hook.id))}>{busy === `test:${hook.id}` ? <Loader2 className="animate-spin" /> : <Send />}Send test</Button>
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void run(hook.id, () => webhooksApi.update(hook.id, { enabled: !hook.enabled }))}>{hook.enabled ? <X /> : <Check />}{hook.enabled ? 'Turn off' : 'Turn on'}</Button>
          <Button size="sm" variant="ghost" onClick={() => { if (open === hook.id) setOpen(null); else void showDeliveries(hook.id).catch(failure => setError(message(failure))) }}><History />Deliveries</Button>
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => { if (window.confirm('Rotate the signing secret? The receiver must be updated.')) void run(`rotate:${hook.id}`, async () => { const next = await webhooksApi.rotate(hook.id); setSecret({ name: next.name, value: next.secret }) }) }}><KeyRound />Rotate secret</Button>
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => { if (window.confirm(`Delete the webhook “${hook.name}” and its delivery history?`)) void run(`delete:${hook.id}`, () => webhooksApi.remove(hook.id)) }}><Trash2 />Delete</Button>
        </footer>
        {open === hook.id && <DeliveryList deliveries={deliveries} busy={busy} onRedeliver={id => void run(`redeliver:${id}`, () => webhooksApi.redeliver(id))} />}
      </li>)}</ul>}
    <details className="webhook-verify"><summary>Verify signatures</summary>
      <p className="automation-hint">Each request carries <code>OpenPlod-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</code>, an HMAC-SHA256 of <code>t.rawBody</code> with your secret, plus <code>OpenPlod-Event-Id</code> and <code>OpenPlod-Delivery-Id</code>. Retries reuse both ids.</p>
      <pre>{VERIFY_SNIPPET}</pre></details>
    {creating && <WebhookEditor onClose={() => setCreating(false)} onCreated={async created => { setCreating(false); setSecret({ name: created.name, value: created.secret }); await load() }} />}
  </section>
}

function DeliveryList({ deliveries, busy, onRedeliver }: { deliveries: WebhookDelivery[]; busy: string; onRedeliver: (id: string) => void }) {
  if (!deliveries.length) return <p className="automation-hint">No deliveries yet.</p>
  return <ul className="webhook-deliveries">{deliveries.map(delivery => <li key={delivery.id}>
    <div><span className="automation-pill" data-state={delivery.status}>{delivery.status}</span> <strong>{delivery.eventType}</strong> <small>{when(delivery.createdAt)} · delivery {delivery.id.slice(0, 8)}</small></div>
    {delivery.lastError && <p className="automation-hint">{delivery.lastError}</p>}
    {delivery.nextAttemptAt && <p className="automation-hint">Next attempt {when(delivery.nextAttemptAt)}</p>}
    <ol>{delivery.attempts.map(attempt => <li key={attempt.attempt}>#{attempt.attempt} {attempt.trigger} · {attempt.outcome ?? 'sending'}{attempt.statusCode ? ` · HTTP ${attempt.statusCode}` : ''}{attempt.durationMs !== null ? ` · ${attempt.durationMs} ms` : ''}</li>)}</ol>
    {['failed', 'unknown', 'blocked', 'skipped', 'delivered'].includes(delivery.status) && <Button size="sm" variant="ghost" disabled={busy === `redeliver:${delivery.id}`} onClick={() => {
      if (delivery.status !== 'delivered' || window.confirm('This event was already delivered. Send it again with the same ids?')) onRedeliver(delivery.id)
    }}><RotateCcw />Redeliver</Button>}
  </li>)}</ul>
}

function WebhookEditor({ onClose, onCreated }: { onClose: () => void; onCreated: (created: WebhookSubscription & { secret: string }) => Promise<void> }) {
  const [name, setName] = useState(''), [url, setUrl] = useState('')
  const [events, setEvents] = useState<WebhookEventType[]>(['recording.transcribed', 'document.created'])
  const [includeText, setIncludeText] = useState(false), [ackExternal, setAckExternal] = useState(false), [ackText, setAckText] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const external = (() => { try { return !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname) } catch { return false } })()
  return <NoteDialog title="New webhook" description="HTTPS, or plain HTTP to localhost only" onClose={onClose} busy={busy}>
    <form className="rule-form" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('')
      try { await onCreated(await webhooksApi.create({ name, url, eventTypes: events, includeText, acknowledgeExternal: ackExternal, acknowledgeText: ackText })) }
      catch (failure) { setError(message(failure)); setBusy(false) }
    }}>
      <label>Name<input required maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder="Team automation" /></label>
      <label>URL<input required type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://example.com/openplod" /></label>
      <fieldset><legend>Events</legend><div className="rule-checks">{WEBHOOK_EVENT_TYPES.map(type => <label key={type}><input type="checkbox" checked={events.includes(type)} onChange={() => setEvents(list => list.includes(type) ? list.filter(item => item !== type) : [...list, type])} />{type}</label>)}</div></fieldset>
      <label className="rule-enable"><input type="checkbox" checked={includeText} onChange={event => setIncludeText(event.target.checked)} />Include transcript and document text in payloads</label>
      {includeText && <label className="rule-enable"><input type="checkbox" checked={ackText} onChange={event => setAckText(event.target.checked)} />I understand full text will be sent to this URL</label>}
      {external && <label className="rule-enable"><input type="checkbox" checked={ackExternal} onChange={event => setAckExternal(event.target.checked)} />I approve sending event data to {(() => { try { return new URL(url).host } catch { return 'this host' } })()}, outside this computer</label>}
      {error && <p role="alert" className="note-error">{error}</p>}
      <footer>
        <Button type="button" variant="ghost" disabled={busy} onClick={onClose}><X />Cancel</Button>
        <Button disabled={busy || !name.trim() || !url || !events.length || (external && !ackExternal) || (includeText && !ackText)}>{busy ? <Loader2 className="animate-spin" /> : <Plus />}Create webhook</Button>
      </footer>
    </form>
  </NoteDialog>
}

// ============================================================ tasks

function TasksPanel() {
  const [tasks, setTasks] = useState<TaskDraft[] | null>(null)
  const [recordings, setRecordings] = useState<Recording[]>([])
  const [connectors, setConnectors] = useState<ConnectorSettings | null>(null)
  const [recordingId, setRecordingId] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [connector, setConnector] = useState<Connector>('todoist')
  const [newTitle, setNewTitle] = useState('')
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState('')
  const load = useCallback(async () => {
    const [list, settings] = await Promise.all([tasksApi.list(), tasksApi.connectors()])
    setTasks(list); setConnectors(settings)
  }, [])
  useEffect(() => {
    load().catch(failure => setError(message(failure)))
    api.getRecordings().then(list => setRecordings(list.filter(item => item.hasTranscript !== false))).catch(() => {})
  }, [load])
  const run = async (key: string, action: () => Promise<string | void>) => {
    setBusy(key); setError(''); setNotice('')
    try { const result = await action(); if (result) setNotice(result); await load() } catch (failure) { setError(message(failure)) } finally { setBusy('') }
  }
  const approved = (tasks ?? []).filter(task => selected.includes(task.id) && task.status === 'approved')
  const dated = (tasks ?? []).filter(task => selected.includes(task.id) && task.dueDate)
  return <section aria-labelledby="tasks-title">
    <div className="automations-head"><div><h2 id="tasks-title"><ListChecks />Reviewed tasks</h2>
      <p>Action items become local drafts. Edit and approve each one, then export the ones you choose. Nothing is posted automatically.</p></div></div>
    {error && <p role="alert" className="note-error">{error}</p>}
    {notice && <p role="status" className="automation-hint">{notice}</p>}
    <div className="tasks-toolbar">
      <select aria-label="Recording" value={recordingId} onChange={event => setRecordingId(event.target.value)}>
        <option value="">Choose a recording…</option>{recordings.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select>
      <Button variant="outline" disabled={!recordingId || !!busy} onClick={() => void run('extract', async () => {
        const result = await tasksApi.extract(recordingId)
        return `${result.created.length} new draft${result.created.length === 1 ? '' : 's'}${result.existing ? `, ${result.existing} already listed` : ''}.`
      })}>{busy === 'extract' ? <Loader2 className="animate-spin" /> : <ListChecks />}Import action items</Button>
      <form className="tasks-add" onSubmit={event => { event.preventDefault(); if (newTitle.trim()) void run('add', async () => { await tasksApi.create({ title: newTitle.trim(), recordingId: recordingId || null }); setNewTitle('') }) }}>
        <input aria-label="New task" value={newTitle} maxLength={500} onChange={event => setNewTitle(event.target.value)} placeholder="Add a task by hand" />
        <Button variant="ghost" disabled={!newTitle.trim() || !!busy}><Plus />Add</Button></form>
    </div>
    {!tasks ? <p role="status" className="automations-empty">{error ? 'Tasks unavailable.' : 'Loading…'}</p>
      : tasks.length === 0 ? <p className="automations-empty">No task drafts yet. Import action items from an analyzed recording, or add one by hand.</p>
      : <ul className="tasks-list">{tasks.map(task => <TaskRow key={task.id} task={task} selected={selected.includes(task.id)}
        onSelect={value => setSelected(list => value ? [...list, task.id] : list.filter(id => id !== task.id))}
        onSave={(patch, label) => run(`${label}:${task.id}`, async () => { await tasksApi.update(task.id, { ...patch, revision: task.revision }) })}
        onDelete={() => run(`delete:${task.id}`, async () => { await tasksApi.remove(task.id); setSelected(list => list.filter(id => id !== task.id)) })} busy={busy} />)}</ul>}
    <div className="tasks-export">
      <select aria-label="Connector" value={connector} onChange={event => setConnector(event.target.value as Connector)}>
        {CONNECTORS.map(item => <option key={item} value={item} disabled={!connectors?.[item].configured}>{item[0].toUpperCase() + item.slice(1)}{connectors?.[item].configured ? '' : ' (not set up)'}</option>)}</select>
      <Button disabled={!approved.length || !connectors?.[connector].configured || !!busy} onClick={() => {
        if (!window.confirm(`Create ${approved.length} approved task${approved.length === 1 ? '' : 's'} in ${connector}? Task titles and notes are sent to ${connector}.`)) return
        void run('export', async () => {
          const { results } = await tasksApi.export(connector, approved.map(task => task.id))
          const unknown = results.filter(item => item.status === 'unknown')
          if (unknown.length && window.confirm(`${unknown.length} export(s) may already exist in ${connector} (no confirmation was received). Check ${connector} first. Send again anyway? This can create duplicates.`))
            await tasksApi.export(connector, unknown.map(item => item.taskId), true)
          return `${results.filter(item => item.status === 'created').length} created, ${results.filter(item => item.status === 'failed').length} failed, ${unknown.length} unknown, ${results.filter(item => item.status === 'skipped').length} skipped.`
        })
      }}>{busy === 'export' ? <Loader2 className="animate-spin" /> : <Send />}Export {approved.length || ''} approved</Button>
      <Button variant="outline" disabled={!dated.length || !!busy} onClick={() => void run('ics', async () => {
        const blob = await tasksApi.calendar(dated.map(task => task.id)), link = document.createElement('a')
        link.href = URL.createObjectURL(blob); link.download = 'openplod-tasks.ics'; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000)
      })}><Download />Calendar file ({dated.length})</Button>
    </div>
    {connectors && <ConnectorSettingsForm settings={connectors} onSaved={setConnectors} />}
  </section>
}

function TaskRow({ task, selected, busy, onSelect, onSave, onDelete }: { task: TaskDraft; selected: boolean; busy: string; onSelect: (value: boolean) => void; onSave: (patch: Partial<TaskDraft>, label: string) => Promise<void>; onDelete: () => Promise<void> }) {
  const [draft, setDraft] = useState({ title: task.title, notes: task.notes, owner: task.owner ?? '', dueDate: task.dueDate ?? '' })
  const dirty = draft.title !== task.title || draft.notes !== task.notes || draft.owner !== (task.owner ?? '') || draft.dueDate !== (task.dueDate ?? '')
  return <li className="task-row" data-status={task.status}>
    <input type="checkbox" aria-label={`Select ${task.title}`} checked={selected} onChange={event => onSelect(event.target.checked)} />
    <div className="task-fields">
      <input aria-label="Title" value={draft.title} maxLength={500} onChange={event => setDraft(value => ({ ...value, title: event.target.value }))} />
      <div className="rule-row">
        <input aria-label="Owner" value={draft.owner} maxLength={120} placeholder="Owner" onChange={event => setDraft(value => ({ ...value, owner: event.target.value }))} />
        <input aria-label="Due date" type="date" value={draft.dueDate} onChange={event => setDraft(value => ({ ...value, dueDate: event.target.value }))} />
      </div>
      {task.dueText && !task.dueDate && <small className="automation-hint">Said: “{task.dueText}”. Set a date if you want one.</small>}
      <textarea aria-label="Notes" rows={2} value={draft.notes} maxLength={4000} placeholder="Notes" onChange={event => setDraft(value => ({ ...value, notes: event.target.value }))} />
      <div className="task-meta"><span className="automation-pill" data-state={task.status}>{task.status}</span>
        {task.exports.map(item => <span key={item.connector} className="automation-pill" data-state={item.status}>{item.connector}: {item.status}{item.remoteUrl ? <> · <a href={item.remoteUrl} target="_blank" rel="noreferrer">{item.remoteId}</a></> : item.remoteId ? ` · ${item.remoteId}` : ''}</span>)}</div>
    </div>
    <div className="task-actions">
      {dirty && <Button size="sm" variant="ghost" disabled={!!busy || !draft.title.trim()} onClick={() => void onSave({ title: draft.title, notes: draft.notes, owner: draft.owner || null, dueDate: draft.dueDate || null }, 'save')}><Save />Save</Button>}
      {!dirty && task.status !== 'approved' && <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void onSave({ status: 'approved' }, 'approve')}><Check />Approve</Button>}
      {!dirty && task.status === 'approved' && <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void onSave({ status: 'draft' }, 'unapprove')}><Undo2 />Back to draft</Button>}
      {task.status !== 'dismissed' && <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void onSave({ status: 'dismissed' }, 'dismiss')}><X />Dismiss</Button>}
      {!task.exports.length && <Button size="sm" variant="ghost" aria-label="Delete task" disabled={!!busy} onClick={() => void onDelete()}><Trash2 /></Button>}
    </div>
  </li>
}

function ConnectorSettingsForm({ settings, onSaved }: { settings: ConnectorSettings; onSaved: (settings: ConnectorSettings) => void }) {
  const [values, setValues] = useState<Record<string, string>>({ linearTeamId: settings.linear.teamId, notionDatabaseId: settings.notion.databaseId, notionTitleProperty: settings.notion.titleProperty, notionDateProperty: settings.notion.dateProperty })
  const [busy, setBusy] = useState(false), [status, setStatus] = useState('')
  const field = (key: string, label: string, secret = false, placeholder = '') => <label>{label}<input type={secret ? 'password' : 'text'} autoComplete="off" value={values[key] ?? ''} placeholder={placeholder}
    onChange={event => setValues(current => ({ ...current, [key]: event.target.value }))} /></label>
  return <details className="tasks-connectors"><summary><KeyRound />Connector credentials</summary>
    <form className="rule-form" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setStatus('')
      try {
        // Blank secret fields keep the stored value; other blank fields clear it.
        const input = Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== '' || !['todoistApiToken', 'linearApiKey', 'notionApiKey'].includes(key)))
        onSaved(await tasksApi.saveConnectors(input)); setStatus('Saved.')
        setValues(current => ({ ...current, todoistApiToken: '', linearApiKey: '', notionApiKey: '' }))
      } catch (failure) { setStatus(message(failure)) } finally { setBusy(false) }
    }}>
      <p className="automation-hint">Stored with your other settings on this computer and never shown again. Tasks are only sent when you press Export.</p>
      <div className="rule-row">{field('todoistApiToken', `Todoist API token${settings.todoist.configured ? ' (saved)' : ''}`, true)}</div>
      <div className="rule-row">{field('linearApiKey', `Linear API key${settings.linear.configured ? ' (saved)' : ''}`, true)}{field('linearTeamId', 'Linear team id')}</div>
      <div className="rule-row">{field('notionApiKey', `Notion integration secret${settings.notion.configured ? ' (saved)' : ''}`, true)}{field('notionDatabaseId', 'Notion database id')}</div>
      <div className="rule-row">{field('notionTitleProperty', 'Notion title property', false, 'Name')}{field('notionDateProperty', 'Notion date property (optional)')}</div>
      {status && <p role="status" className="automation-hint">{status}</p>}
      <footer><Button disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : <Save />}Save credentials</Button></footer>
    </form>
  </details>
}
