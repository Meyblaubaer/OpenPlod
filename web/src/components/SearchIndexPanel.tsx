import { useEffect, useState } from 'react'
import { Loader2, RefreshCw, Save, Search } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { knowledgeApi, type IndexStatus, type KnowledgeSettings } from '@/lib/knowledge'
import { t, tn } from '@/i18n'
import './knowledge.css'

const providerLabel = (): Record<KnowledgeSettings['embeddingProvider'], string> => ({
  auto: t('Automatic (local Ollama model if installed, otherwise built-in)'),
  lexical: t('Built-in lexical index only (offline)'),
  ollama: t('Local Ollama embedding model'),
  openai: t('OpenAI embeddings (cloud)'),
  mistral: t('Mistral embeddings (cloud)'),
})

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
    if (cloud && !window.confirm(t('Send every indexed transcript and note passage, and each search query, to {provider} to compute embeddings? This may be billed. Local-only mode still blocks it.', { provider: draft.embeddingProvider === 'openai' ? 'OpenAI' : 'Mistral' }))) return
    setBusy('save'); setError(''); setMessage('')
    try { const next = await knowledgeApi.saveSearchSettings({ ...draft, cloudOptIn: cloud, ...(cloud ? { confirmCloud: true } : {}) }); setStatus(next); setDraft(next.settings); setMessage(t('Saved.')) }
    catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }
  const reindex = async () => {
    setBusy('index'); setError(''); setMessage('')
    try { const result = await knowledgeApi.reindex(); setStatus(await knowledgeApi.searchStatus()); setMessage(result.pending ? tn(result.indexed, 'Indexed {count} source; {pending} left, run again to continue.', 'Indexed {count} sources; {pending} left, run again to continue.', { pending: result.pending }) : tn(result.indexed, 'Indexed {count} source.', 'Indexed {count} sources.')) }
    catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }
  return <Card id="search">
    <CardHeader className="pb-3"><CardTitle className="text-base">{t('Search and chat retrieval')}</CardTitle></CardHeader>
    <CardContent className="knowledge-panel">
      <p className="knowledge-note">{t('Hybrid search combines full-text matching with embeddings over the current transcript of each active recording and your notes. Trash is never searched, and cached passages are deleted when a recording is trashed, purged, or re-transcribed.')}</p>
      {!status && !error && <Loader2 className="size-4 animate-spin" aria-label={t('Loading search settings')} />}
      {draft && <label className="knowledge-field">{t('Embeddings')}
        <select value={draft.embeddingProvider} disabled={!!busy} onChange={e => setDraft({ ...draft, embeddingProvider: e.target.value as KnowledgeSettings['embeddingProvider'] })}>
          {Object.entries(providerLabel()).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>}
      {draft && (draft.embeddingProvider === 'auto' || draft.embeddingProvider === 'ollama') && <label className="knowledge-field">{t('Ollama embedding model')}
        <input value={draft.ollamaModel} maxLength={120} disabled={!!busy} spellCheck={false} onChange={e => setDraft({ ...draft, ollamaModel: e.target.value })} />
      </label>}
      {cloud && <p className="knowledge-note">{t('Cloud embeddings send passages and queries off this computer. Saving asks you to confirm.')}</p>}
      {status && <p className="knowledge-note">{t('In use:')} <strong>{status.embedding.kind === 'lexical' ? t('built-in lexical index') : status.embedding.model}</strong> ({status.embedding.kind}). {tn(status.sources, '{count} source indexed', '{count} sources indexed')}, {tn(status.passages, '{count} passage', '{count} passages')}, {tn(status.pending, '{count} waiting', '{count} waiting')}.{status.embedding.note ? ` ${status.embedding.note}` : ''}</p>}
      {error && <p className="note-error" role="alert">{error}</p>}
      {message && <p className="knowledge-note" role="status">{message}</p>}
      <div className="knowledge-row">
        <Button size="sm" disabled={!!busy || !draft} onClick={() => void save()}>{busy === 'save' ? <Loader2 className="animate-spin" /> : <Save />}{t('Save search settings')}</Button>
        <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void reindex()}>{busy === 'index' ? <Loader2 className="animate-spin" /> : <RefreshCw />}{t('Index now')}</Button>
        <Search aria-hidden="true" className="size-4 text-muted-foreground" />
      </div>
    </CardContent>
  </Card>
}
