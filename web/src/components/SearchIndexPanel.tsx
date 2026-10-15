import { useEffect, useState } from 'react'
import { Loader2, RefreshCw, Save, Search } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { knowledgeApi, type IndexStatus, type KnowledgeSettings } from '@/lib/knowledge'
import './knowledge.css'

const providerLabel: Record<KnowledgeSettings['embeddingProvider'], string> = {
  auto: 'Automatic (local Ollama model if installed, otherwise built-in)',
  lexical: 'Built-in lexical index only (offline)',
  ollama: 'Local Ollama embedding model',
  openai: 'OpenAI embeddings (cloud)',
  mistral: 'Mistral embeddings (cloud)',
}

/**
 * Hybrid search settings (roadmap KB-04). Local by default; a cloud embedding
 * provider is only used after an explicit opt-in confirmed in the same save.
 */
export function SearchIndexPanel() {
  const [status, setStatus] = useState<IndexStatus | null>(null)
  const [draft, setDraft] = useState<KnowledgeSettings | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    knowledgeApi.searchStatus(controller.signal).then(next => { setStatus(next); setDraft(next.settings) }).catch(e => { if (!controller.signal.aborted) setError((e as Error).message) })
    return () => controller.abort()
  }, [])
  const cloud = draft?.embeddingProvider === 'openai' || draft?.embeddingProvider === 'mistral'
  const save = async () => {
    if (!draft) return
    if (cloud && !window.confirm(`Send every indexed transcript and note passage, and each search query, to ${draft.embeddingProvider === 'openai' ? 'OpenAI' : 'Mistral'} to compute embeddings? This may be billed. Local-only mode still blocks it.`)) return
    setBusy('save'); setError(''); setMessage('')
    try { const next = await knowledgeApi.saveSearchSettings({ ...draft, cloudOptIn: cloud, ...(cloud ? { confirmCloud: true } : {}) }); setStatus(next); setDraft(next.settings); setMessage('Saved.') }
    catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }
  const reindex = async () => {
    setBusy('index'); setError(''); setMessage('')
    try { const result = await knowledgeApi.reindex(); setStatus(await knowledgeApi.searchStatus()); setMessage(`Indexed ${result.indexed} source${result.indexed === 1 ? '' : 's'}${result.pending ? `; ${result.pending} left, run again to continue` : ''}.`) }
    catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }
  return <Card id="search">
    <CardHeader className="pb-3"><CardTitle className="text-base">Search and chat retrieval</CardTitle></CardHeader>
    <CardContent className="knowledge-panel">
      <p className="knowledge-note">Hybrid search combines full-text matching with embeddings over the current transcript of each active recording and your notes. Trash is never searched, and cached passages are deleted when a recording is trashed, purged, or re-transcribed.</p>
      {!status && !error && <Loader2 className="size-4 animate-spin" aria-label="Loading search settings" />}
      {draft && <label className="knowledge-field">Embeddings
        <select value={draft.embeddingProvider} disabled={!!busy} onChange={e => setDraft({ ...draft, embeddingProvider: e.target.value as KnowledgeSettings['embeddingProvider'] })}>
          {(Object.keys(providerLabel) as KnowledgeSettings['embeddingProvider'][]).map(value => <option key={value} value={value}>{providerLabel[value]}</option>)}
        </select>
      </label>}
      {draft && (draft.embeddingProvider === 'auto' || draft.embeddingProvider === 'ollama') && <label className="knowledge-field">Ollama embedding model
        <input value={draft.ollamaModel} maxLength={120} disabled={!!busy} spellCheck={false} onChange={e => setDraft({ ...draft, ollamaModel: e.target.value })} />
      </label>}
      {cloud && <p className="knowledge-note">Cloud embeddings send passages and queries off this computer. Saving asks you to confirm.</p>}
      {status && <p className="knowledge-note">In use: <strong>{status.embedding.kind === 'lexical' ? 'built-in lexical index' : status.embedding.model}</strong> ({status.embedding.kind}). {status.sources} source{status.sources === 1 ? '' : 's'} indexed, {status.passages} passages, {status.pending} waiting.{status.embedding.note ? ` ${status.embedding.note}` : ''}</p>}
      {error && <p className="note-error" role="alert">{error}</p>}
      {message && <p className="knowledge-note" role="status">{message}</p>}
      <div className="knowledge-row">
        <Button size="sm" disabled={!!busy || !draft} onClick={() => void save()}>{busy === 'save' ? <Loader2 className="animate-spin" /> : <Save />}Save search settings</Button>
        <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void reindex()}>{busy === 'index' ? <Loader2 className="animate-spin" /> : <RefreshCw />}Index now</Button>
        <Search aria-hidden="true" className="size-4 text-muted-foreground" />
      </div>
    </CardContent>
  </Card>
}
