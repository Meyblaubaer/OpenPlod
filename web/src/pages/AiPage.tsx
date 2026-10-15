import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Archive, ArrowUp, ChevronDown, Download, FileAudio, Loader2, MessageSquare, MoreHorizontal, Pencil, Plus, Square, ListTree, History, Copy, RefreshCw, RotateCcw, X, FileText, ListChecks, Check, BookmarkPlus, Sparkles, Save } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { api, type TranscriptDocument } from '@/lib/api'
import { aiRequest, askRecordings, conversationExport, type AiAnswer, type AiConversation, type AiConversationContext } from '@/lib/recording-ai'
import { exportDocument } from '@/lib/document-export'
import { knowledgeApi, recordingLink, type TopicCandidate, type TopicSummary } from '@/lib/knowledge'
import { notesApi } from '@/lib/notes-api'
import { formatDuration } from '@/lib/utils'
import './ai.css'
import '@/components/knowledge.css'
import { aiSettingsApi } from '@/lib/ai-settings'

const stages: Record<string, string> = { context: 'Reading selected transcripts', retrieval: 'Searching your recordings', mistral: 'Mistral is answering', openai: 'OpenAI is answering', anthropic: 'Anthropic is answering', ollama: 'Ollama is answering locally', citations: 'Checking source citations', saved: 'Saving answer' }
const prompts = [
  { label: 'Summary', prompt: 'Summarize the selected recordings.', icon: FileText },
  { label: 'Action items', prompt: 'Extract action items and owners from the selected recordings.', icon: ListChecks },
  { label: 'Decisions', prompt: 'What decisions were made in these recordings?', icon: Check },
]
const sourceTime = (start: number | null, end?: number | null) => start === null ? '' : `${formatDuration(start)}${end !== null && end !== undefined && end > start ? `–${formatDuration(end)}` : ''}`

export function AiPage() {
  const [params] = useSearchParams()
  const [recordings, setRecordings] = useState<TranscriptDocument[]>([])
  const [selected, setSelected] = useState<string[]>(() => { const id = params.get('recording'); return id && /^[0-9a-f-]{36}$/i.test(id) ? [id] : [] })
  const [conversationId, setConversationId] = useState<string>(() => crypto.randomUUID())
  const [conversations, setConversations] = useState<AiConversation[]>([])
  const [answers, setAnswers] = useState<AiAnswer[]>([])
  const [question, setQuestion] = useState(() => (params.get('question') || '').slice(0, 4000))
  const [consent, setConsent] = useState(false)
  const [provider, setProvider] = useState('')
  const [analysisProvider, setAnalysisProvider] = useState('')
  useEffect(() => { let active = true; aiSettingsApi.get().then(value => { if (active) { setProvider(value.chatProvider); setAnalysisProvider(value.analysisProvider) } }).catch(() => {}); return () => { active = false } }, [])
  const [loading, setLoading] = useState(true)
  const [more, setMore] = useState(false)
  const [stage, setStage] = useState('')
  const [error, setError] = useState('')
  const [panel, setPanel] = useState('sources')
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth > 767)
  const [historyError, setHistoryError] = useState('')
  const [historyRefresh, setHistoryRefresh] = useState(0)
  const [showArchived, setShowArchived] = useState(false)
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null)
  const [opening, setOpening] = useState(false)
  const [copied, setCopied] = useState('')
  // KB-03: per-conversation pinned recordings and project note, saved on the server.
  const [pinned, setPinned] = useState<string[]>([])
  const [contextNote, setContextNote] = useState('')
  const [savedNote, setSavedNote] = useState('')
  const [contextError, setContextError] = useState('')
  const [contextBusy, setContextBusy] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const active = useRef<AbortController | null>(null)
  const end = useRef<HTMLDivElement>(null)
  const request = useRef(0)
  const pagination = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    api.getTranscriptDocuments({ source: '', offset: 0, signal: controller.signal }).then(result => { if (!controller.signal.aborted) { setRecordings(result.data); setMore(result.pagination.hasMore) } })
      .catch(e => { if (!controller.signal.aborted) setError(e.message) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    // Invalidate async conversation work on unmount; this ref is a counter, not a DOM node.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { controller.abort(); request.current++; active.current?.abort(); pagination.current?.abort(); if (copyTimer.current) clearTimeout(copyTimer.current) }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    setHistoryError('')
    aiRequest<AiConversation[]>(`/conversations?archived=${showArchived}`, controller.signal).then(rows => { if (!controller.signal.aborted) setConversations(rows) }).catch(e => { if (!controller.signal.aborted) setHistoryError(e.message) })
    return () => controller.abort()
  }, [historyRefresh, showArchived])
  const updateConversation = async (id: string, data: { title?: string | null; archived?: boolean }) => {
    setHistoryError('')
    try { await aiRequest<AiConversation>(`/conversations/${id}`, undefined, { method: 'PATCH', body: data }); setRenaming(null); setHistoryRefresh(value => value + 1) }
    catch (e) { setHistoryError((e as Error).message) }
  }
  const saveContext = async (data: { pinnedRecordingIds?: string[]; contextNote?: string | null }) => {
    setContextBusy(true); setContextError('')
    try {
      const saved = await aiRequest<AiConversation>(`/conversations/${conversationId}`, undefined, { method: 'PATCH', body: data })
      setPinned(saved.pinnedRecordingIds ?? []); setSavedNote(saved.contextNote ?? ''); setContextNote(saved.contextNote ?? '')
    } catch (e) { setContextError((e as Error).message) } finally { setContextBusy(false) }
  }
  const togglePin = (recordingId: string) => void saveContext({ pinnedRecordingIds: pinned.includes(recordingId) ? pinned.filter(id => id !== recordingId) : [...pinned, recordingId] })
  const exportConversation = async (row: AiConversation, format: 'md' | 'json') => {
    setHistoryError('')
    try { await exportDocument({ filename: `openplod-conversation-${row.id}.${format}`, mime: format === 'md' ? 'text/markdown' : 'application/json', content: await conversationExport(row.id, format) }) }
    catch (e) { setHistoryError((e as Error).message) }
  }
  useEffect(() => { if (answers.length || stage) end.current?.scrollIntoView({ block: 'nearest' }) }, [answers, stage])
  const fresh = () => { request.current++; active.current?.abort(); active.current = null; setStage(''); setOpening(false); setConversationId(crypto.randomUUID()); setAnswers([]); setError(''); setPinned([]); setContextNote(''); setSavedNote(''); setContextError('') }
  const send = async () => {
    if (active.current || opening || loading || !question.trim() || !consent) return
    const controller = new AbortController(); active.current = controller; const ticket = ++request.current
    setError(''); setStage(selected.length ? 'context' : 'retrieval')
    try {
      const answer = await askRecordings({ id: crypto.randomUUID(), conversationId, question, recordingIds: selected, consent: true, expectedProvider: provider }, value => { if (ticket === request.current) setStage(value) }, controller.signal)
      if (ticket !== request.current) return
      setAnswers(rows => [...rows, answer]); setQuestion('')
      setHistoryRefresh(value => value + 1)
    } catch (e) { if (ticket === request.current) setError(controller.signal.aborted ? 'Question cancelled. Completed answers remain in history.' : (e as Error).message) }
    finally { if (ticket === request.current) { active.current = null; setStage('') } }
  }
  const open = async (conversation: AiConversation) => {
    fresh(); setOpening(true); setQuestion(''); const ticket = ++request.current
    try {
      const [rows, context] = await Promise.all([aiRequest<AiAnswer[]>(`/conversations/${conversation.id}`), aiRequest<AiConversationContext>(`/conversations/${conversation.id}/context`)])
      if (ticket === request.current) { setConversationId(conversation.id); setAnswers(rows); setSelected(conversation.recordingIds); setPinned(context.pinnedRecordingIds); setContextNote(context.contextNote ?? ''); setSavedNote(context.contextNote ?? '') }
    }
    catch (e) { if (ticket === request.current) setError((e as Error).message) } finally { if (ticket === request.current) { setOpening(false); if (window.innerWidth <= 767) setPanelOpen(false) } }
  }
  const loadMore = async () => {
    if (loading) return
    const controller = new AbortController(); pagination.current = controller
    setLoading(true)
    try { const result = await api.getTranscriptDocuments({ source: '', offset: recordings.length, signal: controller.signal }); if (!controller.signal.aborted) { setRecordings(rows => [...rows, ...result.data]); setMore(result.pagination.hasMore) } }
    catch (e) { if (!controller.signal.aborted) setError((e as Error).message) } finally { if (!controller.signal.aborted) setLoading(false) }
  }
  const exportAnswer = async (answer: AiAnswer) => {
    try { await exportDocument({ filename: `openplod-answer-${answer.id}.md`, mime: 'text/markdown', content: `# ${answer.question}\n\n${answer.answer}\n\n## Sources\n\n${answer.citations.map(c => { const source = answer.sources.find(s => s.id === c.sourceId)!; return `- [${c.sourceId}] ${source.title}${source.start === null ? '' : ` (${formatDuration(source.start)})`}${source.versionId ? `, version ${source.versionId}` : ''}: ${c.quote}` }).join('\n')}\n\n${answer.provider} / ${answer.model}` }) }
    catch (e) { setError((e as Error).message) }
  }
  const copyAnswer = async (answer: AiAnswer) => {
    try { await navigator.clipboard.writeText(answer.answer); setCopied(answer.id); if (copyTimer.current) clearTimeout(copyTimer.current); copyTimer.current = setTimeout(() => setCopied(''), 2000) }
    catch { setError('Clipboard unavailable. Export the answer as Markdown instead.') }
  }
  const applyFollowUp = (text: string) => { setQuestion(text.slice(0, 4000)); composer.current?.focus() }
  const recordingTitle = (id: string, answer?: AiAnswer) => recordings.find(r => r.recordingId === id)?.filename || answer?.sources.find(source => source.recordingId === id)?.title || 'Recording'
  const consentText = provider === 'ollama'
    ? `Allow local Ollama to process ${selected.length ? 'selected transcripts' : 'transcript passages found across your recordings'}${pinned.length ? ' and pinned recordings' : ''}.`
    : `Allow ${selected.length ? 'selected transcript text' : 'transcript passages found across your recordings'}${pinned.length ? ' and pinned recordings' : ''} to be sent to ${provider || 'the configured provider'}.`
  return <div className={`ai-page ${panelOpen ? 'panel-open' : ''}`}>
    <header className="ai-heading"><div><h1>AI Chat</h1><span className="capitalize">{provider || 'Provider unavailable'}</span></div><div className="ai-heading-actions"><IconButton label="Toggle sources and history" aria-expanded={panelOpen} aria-controls="ai-context-panel" onClick={() => setPanelOpen(v => !v)}><ListTree /></IconButton><Button variant="outline" size="sm" onClick={() => { fresh(); setQuestion(''); composer.current?.focus() }}><Plus />New conversation</Button></div></header>
    <div className="ai-workspace">
      <aside id="ai-context-panel" className="ai-context" aria-label="Recording context">
        <div className="ai-panel-toolbar"><ToggleGroup type="single" value={panel} onValueChange={v => { if (v) setPanel(v) }} aria-label="Chat sidebar"><ToggleGroupItem value="sources"><FileAudio />Sources</ToggleGroupItem><ToggleGroupItem value="history"><History />History</ToggleGroupItem><ToggleGroupItem value="topics"><Sparkles />Topics</ToggleGroupItem></ToggleGroup></div>
        {panel === 'sources' ? <>
        <h2>Context <span>{selected.length}/12</span></h2>
        {answers.length > 0 ? <p className="ai-context-fixed">{selected.length ? 'Conversation sources locked' : 'Answering from passages found across your recordings'}</p>
          : !selected.length && <p className="ai-context-fixed">No recordings selected: each question searches all your transcripts. Select recordings to answer from them only.</p>}
        <div className="ai-source-list">{recordings.map(recording => <div key={recording.recordingId} className="ai-source-row"><label className={`ai-source-choice ${selected.includes(recording.recordingId) ? 'selected' : ''}`}><input type="checkbox" checked={selected.includes(recording.recordingId)} disabled={!!stage || opening || answers.length > 0 || (!selected.includes(recording.recordingId) && selected.length >= 12)} onChange={e => { const checked = e.target.checked; fresh(); setSelected(rows => checked ? [...rows, recording.recordingId] : rows.filter(id => id !== recording.recordingId)) }} /><FileAudio /><span><strong>{recording.filename || 'Untitled recording'}</strong><small>{recording.wordCount ?? 0} words{recording.durationSeconds ? ` / ${formatDuration(recording.durationSeconds)}` : ''}{pinned.includes(recording.recordingId) ? ' / pinned' : ''}</small></span></label><IconButton label={pinned.includes(recording.recordingId) ? `Unpin ${recording.filename || 'recording'}` : `Pin ${recording.filename || 'recording'} to this conversation`} aria-pressed={pinned.includes(recording.recordingId)} disabled={!!stage || opening || contextBusy || (!pinned.includes(recording.recordingId) && pinned.length >= 12)} onClick={() => togglePin(recording.recordingId)}><BookmarkPlus /></IconButton></div>)}</div>
        {!loading && !recordings.length && <p className="ai-empty-copy">No transcripts yet. <Link to="/">Open recordings</Link></p>}
        {loading && <Loader2 className="size-4 animate-spin" aria-label="Loading transcripts" />}
        {more && <Button variant="ghost" size="sm" disabled={loading} onClick={() => void loadMore()}>{loading ? <Loader2 className="animate-spin" /> : <ChevronDown />}Load more recordings</Button>}
        <form className="knowledge-field ai-project-context" onSubmit={e => { e.preventDefault(); void saveContext({ contextNote: contextNote.trim() || null }) }}>
          <label htmlFor="ai-project-context">Project context</label>
          <textarea id="ai-project-context" maxLength={4000} value={contextNote} disabled={!!stage || opening || contextBusy} placeholder="Background the assistant should know, e.g. who is who or what the project is." onChange={e => setContextNote(e.target.value)} />
          <p className="knowledge-note">Sent with every question in this conversation as background, never as a citable source. Pinned recordings are always included.</p>
          {contextError && <p className="ai-history-error" role="alert">{contextError}</p>}
          <div className="knowledge-row"><Button type="submit" size="sm" variant="outline" disabled={contextBusy || contextNote.trim() === savedNote.trim()}>{contextBusy ? <Loader2 className="animate-spin" /> : <Save />}Save context</Button></div>
        </form>
        </> : panel === 'history' ? <div className="ai-history"><header><h2>{showArchived ? 'Archived conversations' : 'Recent conversations'}</h2><div><IconButton label={showArchived ? 'Show recent conversations' : 'Show archived conversations'} aria-pressed={showArchived} onClick={() => { setRenaming(null); setShowArchived(v => !v) }}><Archive /></IconButton><IconButton label="Refresh conversations" onClick={() => setHistoryRefresh(v => v + 1)}><RefreshCw /></IconButton></div></header>
        {historyError && <p className="ai-history-error" role="alert">{historyError}</p>}
        {conversations.map(row => renaming?.id === row.id
          ? <form key={row.id} className="ai-history-rename" onSubmit={e => { e.preventDefault(); void updateConversation(row.id, { title: renaming.title.trim() || null }) }}>
            <input autoFocus aria-label="Conversation title" placeholder={row.question} maxLength={120} value={renaming.title} onChange={e => setRenaming({ id: row.id, title: e.target.value })} onKeyDown={e => { if (e.key === 'Escape') setRenaming(null) }} />
            <IconButton type="submit" label="Save title"><Check /></IconButton><IconButton type="button" label="Cancel rename" onClick={() => setRenaming(null)}><X /></IconButton>
          </form>
          : <div key={row.id} className={`ai-history-item ${row.id === conversationId ? 'selected' : ''}`}>
            <button className="ai-history-row" disabled={!!stage} onClick={() => void open(row)}><MessageSquare /><span>{row.title || row.question}<small>{new Date(row.createdAt).toLocaleDateString()} / {row.turns} question{row.turns === 1 ? '' : 's'}{row.recordingIds.length ? '' : ' / all recordings'}</small></span></button>
            <DropdownMenu.Root><DropdownMenu.Trigger asChild><IconButton label="Conversation actions"><MoreHorizontal /></IconButton></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="action-menu" align="end">
              <DropdownMenu.Item onSelect={() => setRenaming({ id: row.id, title: row.title || '' })}><Pencil />Rename</DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => void updateConversation(row.id, { archived: !row.archived })}>{row.archived ? <RotateCcw /> : <Archive />}{row.archived ? 'Restore from archive' : 'Archive'}</DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item onSelect={() => void exportConversation(row, 'md')}><Download />Export Markdown</DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => void exportConversation(row, 'json')}><FileText />Export JSON</DropdownMenu.Item>
            </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
          </div>)}
        {!conversations.length && !historyError && <p className="ai-empty-copy">{showArchived ? 'No archived conversations.' : 'No saved conversations.'}</p>}</div>
        : <TopicsPanel provider={analysisProvider} />}
      </aside>
      <section className="ai-conversation" aria-label="Conversation">
        <div className="ai-messages">
          {opening && <div className="ai-progress" role="status"><Loader2 className="animate-spin" />Opening conversation</div>}
          {!answers.length && !stage && !opening && <div className="ai-empty"><MessageSquare /><h2>{selected.length ? 'What would you like to know?' : 'Ask across all your recordings'}</h2><button className="ai-source-shortcut" onClick={() => { setPanel('sources'); setPanelOpen(true) }}><FileAudio />{selected.length ? `${selected.length} source${selected.length === 1 ? '' : 's'} selected` : 'Or choose transcript sources'}<ChevronDown /></button>{selected.length > 0 && <div className="ai-prompts">{prompts.map(({ label, prompt, icon: Icon }) => <button key={label} onClick={() => { setQuestion(prompt); composer.current?.focus() }}><Icon />{label}</button>)}</div>}</div>}
          {answers.map((answer, index) => <article key={answer.id} className="ai-answer">
            <h2>{answer.question}</h2>
            <div className="markdown-document"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: () => null, a: ({ children }) => <span>{children}</span> }}>{answer.answer}</ReactMarkdown></div>
            {answer.retrieval && answer.retrieval.usedRecordingIds.length > 0 && <div className="knowledge-used" aria-label="Recordings used"><span>{answer.retrieval.mode === 'retrieved' ? 'Found in' : 'Used'}:</span>{answer.retrieval.usedRecordingIds.map(id => { const first = answer.citations.map(c => answer.sources.find(s => s.id === c.sourceId)).find(s => s?.recordingId === id); return <Link key={id} to={recordingLink(id, first?.start, first?.versionId)}><FileAudio />{recordingTitle(id, answer)}</Link> })}{answer.retrieval.sentRecordingIds.length > answer.retrieval.usedRecordingIds.length && <small>{answer.retrieval.sentRecordingIds.length - answer.retrieval.usedRecordingIds.length} more searched but not cited</small>}</div>}
            {answer.citations.length > 0 && <details className="ai-citations"><summary>{answer.citations.length} source references</summary>{answer.citations.map((citation, i) => { const source = answer.sources.find(s => s.id === citation.sourceId)!; return <div key={`${source.id}-${i}`}><Link to={recordingLink(source.recordingId, source.start, source.versionId)}><FileAudio />[{source.id}] {source.title}{source.start === null ? '' : ` / ${sourceTime(source.start, source.end)}`}</Link><blockquote>{citation.quote}</blockquote><small>{source.origin} transcript{source.via === 'retrieved' ? ` / found by ${(source.matchedBy ?? []).join(' + ') || 'search'}` : source.via === 'pinned' ? ' / pinned' : ''}{source.versionId ? ` / version ${source.versionId.slice(0, 8)}` : ''}</small></div> })}</details>}
            {answer.followUps && answer.followUps.length > 0 && index === answers.length - 1 && !stage && <div className="knowledge-chips" aria-label="Suggested follow-up questions">{answer.followUps.map(text => <button key={text} type="button" onClick={() => applyFollowUp(text)}>{text}</button>)}</div>}
            <footer><span>{answer.model}</span><details><summary>Activity</summary>{answer.trace.map(step => <p key={step.stage}>{stages[step.stage] || step.stage}</p>)}</details><div className="ai-answer-tools"><IconButton label={copied === answer.id ? 'Answer copied' : 'Copy answer'} onClick={() => void copyAnswer(answer)}>{copied === answer.id ? <Check /> : <Copy />}</IconButton><IconButton label="Export answer as Markdown" onClick={() => void exportAnswer(answer)}><Download /></IconButton></div></footer>
          </article>)}
          {stage && <p className="ai-progress" role="status"><Loader2 className="animate-spin" />{stages[stage] || stage}</p>}
          <div ref={end} />
        </div>
        <form className="ai-composer" onSubmit={e => { e.preventDefault(); void send() }}>
          {error && <p className="device-error" role="alert">{error}</p>}
          <div className="ai-selected-sources">{selected.slice(0, 3).map(id => <span key={id}><FileAudio /><span>{recordings.find(r => r.recordingId === id)?.filename || 'Saved recording source'}</span>{!answers.length && !stage && !opening && <IconButton type="button" label={`Remove source ${recordings.find(r => r.recordingId === id)?.filename || 'recording'}`} onClick={() => setSelected(rows => rows.filter(value => value !== id))}><X /></IconButton>}</span>)}{selected.length > 3 && <small>+{selected.length - 3}</small>}{!selected.length && <small>All recordings{pinned.length ? ` + ${pinned.length} pinned` : ''}</small>}</div>
          <div className="ai-input"><textarea ref={composer} aria-label="Question about your recordings" placeholder="Ask about your recordings..." rows={3} maxLength={4000} value={question} disabled={!!stage || opening} onChange={e => setQuestion(e.target.value)} />{stage ? <IconButton type="button" variant="outline" label="Cancel question" onClick={() => active.current?.abort()}><Square /></IconButton> : <IconButton type="submit" variant="default" disabled={!consent || !question.trim() || loading || opening} label="Send question"><ArrowUp /></IconButton>}</div>
          <div className="ai-composer-footer"><label className="ai-consent"><input type="checkbox" checked={consent} disabled={!!stage || !provider} onChange={e => setConsent(e.target.checked)} /><span>{consentText}</span></label><span>{question.length}/4000</span></div>
        </form>
      </section>
    </div>
  </div>
}

/**
 * Recurring topics across recent recordings (KB-05). Listing topics is local
 * counting; summarizing one sends matching passages to the analysis provider
 * after explicit consent, and the result is only a preview until saved.
 */
function TopicsPanel({ provider }: { provider: string }) {
  const [days, setDays] = useState(30)
  const [topics, setTopics] = useState<TopicCandidate[] | null>(null)
  const [count, setCount] = useState(0)
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [summary, setSummary] = useState<TopicSummary | null>(null)
  const [savedId, setSavedId] = useState('')
  const abort = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    setTopics(null); setError('')
    knowledgeApi.topics(days, controller.signal).then(result => { if (!controller.signal.aborted) { setTopics(result.topics); setCount(result.recordingCount) } })
      .catch(e => { if (!controller.signal.aborted) setError((e as Error).message) })
    return () => controller.abort()
  }, [days])
  useEffect(() => () => abort.current?.abort(), [])
  const summarize = async (topic: string) => {
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller
    setBusy(topic); setError(''); setSummary(null); setSavedId('')
    try { const result = await knowledgeApi.summarizeTopic(topic, days, controller.signal); if (!controller.signal.aborted) setSummary(result) }
    catch (e) { if (!controller.signal.aborted) setError((e as Error).message) }
    finally { if (!controller.signal.aborted) setBusy('') }
  }
  const save = async () => {
    if (!summary) return
    setBusy('save'); setError('')
    try { const document = await notesApi.create({ title: `Topic - ${summary.topic}`.slice(0, 180).replace(/[/\\]/g, '-'), content: summary.markdown, folderId: null, idempotencyKey: crypto.randomUUID() }); setSavedId(document.id) }
    catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }
  return <div className="knowledge-panel">
    <div className="knowledge-row"><h2>Recurring topics</h2><select aria-label="Period" value={days} onChange={e => setDays(Number(e.target.value))}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option></select></div>
    <p className="knowledge-note">Tags and words that come up in at least two of your {count} transcribed recording{count === 1 ? '' : 's'} in this period. Counting happens on this computer.</p>
    {topics === null && !error && <Loader2 className="size-4 animate-spin" aria-label="Loading topics" />}
    {topics && !topics.length && <p className="ai-empty-copy">No recurring topics yet.</p>}
    {topics && topics.length > 0 && <div className="knowledge-chips" aria-label="Recurring topics">{topics.map(topic => <button key={`${topic.kind}:${topic.topic}`} type="button" disabled={!!busy || !consent} title={consent ? `Summarize ${topic.topic}` : 'Allow sending passages first'} onClick={() => void summarize(topic.topic)}>{busy === topic.topic ? <Loader2 className="animate-spin" /> : null}{topic.kind === 'tag' ? '#' : ''}{topic.topic} <small>{topic.recordingCount}</small></button>)}</div>}
    <label className="ai-consent"><input type="checkbox" checked={consent} disabled={!provider || !!busy} onChange={e => setConsent(e.target.checked)} /><span>{provider === 'ollama' ? 'Allow local Ollama to summarize matching passages.' : `Allow matching transcript passages to be sent to ${provider || 'the analysis provider'} for a summary.`}</span></label>
    {error && <p className="ai-history-error" role="alert">{error}</p>}
    {summary && <section aria-label="Topic summary preview" className="knowledge-panel">
      <h3>Preview — not saved</h3>
      <div className="markdown-document knowledge-topic-preview"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: () => null, a: ({ children }) => <span>{children}</span> }}>{summary.markdown}</ReactMarkdown></div>
      <div className="knowledge-used">{[...new Set(summary.citations.map(c => c.sourceId))].map(id => { const source = summary.sources.find(s => s.id === id); return source ? <Link key={id} to={recordingLink(source.recordingId, source.start, source.versionId)}><FileAudio />[{id}] {source.title}{source.start === null ? '' : ` ${sourceTime(source.start, source.end)}`}</Link> : null })}</div>
      <div className="knowledge-row">{savedId ? <Button asChild size="sm" variant="outline"><Link to={`/notes?document=${savedId}`}><FileText />Open document</Link></Button> : <Button size="sm" disabled={!!busy} onClick={() => void save()}>{busy === 'save' ? <Loader2 className="animate-spin" /> : <Save />}Save as document</Button>}<Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setSummary(null)}><X />Discard</Button></div>
    </section>}
  </div>
}
