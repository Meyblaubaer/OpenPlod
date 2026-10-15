import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Check, FileText, Link2, Loader2, Plus, Sparkles, Tag, X } from '@/components/icons'
import { notesApi, type DocumentSource, type DocumentSuggestions, type NoteDocument, type NoteProperties, type NoteSummary } from '@/lib/notes-api'

/**
 * Knowledge links for one document (roadmap KB-01): freeform tags, schemaless
 * properties, and the exact transcript version it was written from.
 *
 * Every change is its own revision-checked save, so this is disabled while the
 * Markdown has unsaved edits; the caller owns that rule.
 */
export function NoteMetadata({ document, disabled, onUpdate, onOpenDocument }: {
  document: NoteDocument
  disabled: boolean
  onUpdate: (data: { title?: string; tags?: string[]; properties?: NoteProperties }) => void
  onOpenDocument: (id: string) => void
}) {
  const [tagDraft, setTagDraft] = useState('')
  const addTags = (raw: string) => {
    const added = raw.split(',').map(tag => tag.trim()).filter(Boolean)
    setTagDraft('')
    const known = new Set(document.tags.map(tag => tag.toLocaleLowerCase()))
    const next = added.filter(tag => !known.has(tag.toLocaleLowerCase()))
    if (next.length) onUpdate({ tags: [...document.tags, ...next] })
  }
  const propertyCount = Object.keys(document.properties).length
  const [suggestions, setSuggestions] = useState<DocumentSuggestions | null>(null)
  const [suggesting, setSuggesting] = useState(false), [suggestError, setSuggestError] = useState('')
  // Suggestions describe one revision; a newer save or another note makes them stale.
  useEffect(() => { setSuggestions(null); setSuggestError('') }, [document.id])
  const live = suggestions && suggestions.documentId === document.id ? suggestions : null
  const pendingTags = live?.tags.filter(tag => !document.tags.some(existing => existing.toLocaleLowerCase() === tag)) ?? []
  const pendingTitle = live?.title && live.title !== document.title ? live.title : null
  const suggest = async () => {
    setSuggesting(true); setSuggestError('')
    try { setSuggestions(await notesApi.suggest(document.id)) }
    catch (error) { setSuggestError(error instanceof Error ? error.message : 'Suggestions are unavailable.') }
    finally { setSuggesting(false) }
  }
  return <div className="notes-metadata">
    <div className="notes-tags" aria-label="Tags">
      <Tag />
      {document.tags.map(tag => <span key={tag} className="notes-tag">{tag}
        <button type="button" aria-label={`Remove tag ${tag}`} title="Remove tag" disabled={disabled} onClick={() => onUpdate({ tags: document.tags.filter(value => value !== tag) })}><X /></button>
      </span>)}
      <input aria-label="Add tag" placeholder={document.tags.length ? 'Add tag' : 'Add a tag'} value={tagDraft} maxLength={64} disabled={disabled}
        onChange={event => { if (event.target.value.endsWith(',')) addTags(event.target.value); else setTagDraft(event.target.value) }}
        onKeyDown={event => { if (event.key === 'Enter' && tagDraft.trim()) { event.preventDefault(); addTags(tagDraft) } }}
        onBlur={() => { if (tagDraft.trim()) addTags(tagDraft) }} />
      <button type="button" className="notes-suggest" disabled={disabled || suggesting} title="Suggest a title and tags with AI. Nothing changes until you apply one." onClick={() => void suggest()}>
        {suggesting ? <Loader2 className="animate-spin" /> : <Sparkles />}<span>Suggest</span>
      </button>
    </div>
    {suggestError && <p className="notes-suggestions-error" role="alert">{suggestError}</p>}
    {live && <div className="notes-suggestions" role="group" aria-label="AI suggestions">
      {!pendingTitle && !pendingTags.length ? <span className="notes-suggestions-empty">No new suggestions{live.truncated ? ' (only the beginning of this long note was read)' : ''}.</span> : <>
        {pendingTitle && <button type="button" disabled={disabled} title="Use this title" onClick={() => onUpdate({ title: pendingTitle })}><Check /><span>Title: {pendingTitle}</span></button>}
        {pendingTags.map(tag => <button key={tag} type="button" disabled={disabled} title={`Add tag ${tag}`} onClick={() => onUpdate({ tags: [...document.tags, tag] })}><Plus /><span>{tag}</span></button>)}
        {pendingTags.length > 1 && <button type="button" className="notes-suggestions-all" disabled={disabled} onClick={() => onUpdate({ tags: [...document.tags, ...pendingTags] })}>Add all tags</button>}
      </>}
      <small>{live.provider} · {live.model}</small>
      <button type="button" className="notes-suggestions-close" aria-label="Dismiss suggestions" title="Dismiss" onClick={() => setSuggestions(null)}><X /></button>
    </div>}
    <details className="notes-links">
      <summary><Link2 />Properties and source<small>{propertyCount ? `${propertyCount} propert${propertyCount === 1 ? 'y' : 'ies'}` : ''}</small></summary>
      <div className="notes-links-body">
        <PropertyEditor properties={document.properties} disabled={disabled} onUpdate={properties => onUpdate({ properties })} />
        <SourcePanel document={document} onOpenDocument={onOpenDocument} />
      </div>
    </details>
  </div>
}

function PropertyEditor({ properties, disabled, onUpdate }: { properties: NoteProperties; disabled: boolean; onUpdate: (patch: NoteProperties) => void }) {
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const entries = Object.entries(properties)
  return <section aria-label="Properties">
    <h3>Properties</h3>
    {entries.length === 0 && <p className="notes-links-empty">No properties.</p>}
    {entries.length > 0 && <dl className="notes-properties">{entries.map(([name, current]) => <div key={name}>
      <dt>{name}</dt>
      {/* Non-string values are shown as stored; editing here only writes strings. */}
      <dd>{typeof current === 'string' ? current : <code>{JSON.stringify(current)}</code>}</dd>
      <button type="button" aria-label={`Remove property ${name}`} title="Remove property" disabled={disabled} onClick={() => onUpdate({ [name]: null })}><X /></button>
    </div>)}</dl>}
    <form className="notes-property-form" onSubmit={event => {
      event.preventDefault()
      if (!key.trim()) return
      onUpdate({ [key.trim()]: value }); setKey(''); setValue('')
    }}>
      <input aria-label="Property name" placeholder="Name" value={key} maxLength={64} disabled={disabled} onChange={event => setKey(event.target.value)} />
      <input aria-label="Property value" placeholder="Value" value={value} maxLength={2000} disabled={disabled} onChange={event => setValue(event.target.value)} />
      <button type="submit" aria-label="Add property" title="Add or replace property" disabled={disabled || !key.trim()}><Plus /></button>
    </form>
  </section>
}

const statusText: Record<DocumentSource['status'], string> = {
  current: 'Current transcript version',
  stale: 'Older version — the transcript has been edited since',
  unknown: 'Unknown — the cited version can no longer be found',
  none: 'Not written from a transcript',
}

function SourcePanel({ document, onOpenDocument }: { document: NoteDocument; onOpenDocument: (id: string) => void }) {
  // Results are keyed by what they describe, so a previous document's source is never shown.
  const key = `${document.id}:${document.sourceVersionId ?? ''}`
  const [resolved, setResolved] = useState<{ key: string; source: DocumentSource | null; backlinks: NoteSummary[]; error: string } | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    notesApi.source(document.id, controller.signal).then(async source => {
      const links = source.versionId && (source.status === 'current' || source.status === 'stale')
        ? (await notesApi.backlinks(source.versionId, controller.signal)).documents.filter(row => row.id !== document.id) : []
      if (!controller.signal.aborted) setResolved({ key, source, backlinks: links, error: '' })
    }).catch(failure => {
      if (!controller.signal.aborted) setResolved({ key, source: null, backlinks: [], error: failure instanceof Error ? failure.message : 'Source unavailable.' })
    })
    return () => controller.abort()
  }, [document.id, key])
  const current = resolved?.key === key ? resolved : null
  const source = current?.source ?? null, backlinks = current?.backlinks ?? [], error = current?.error ?? ''

  return <section aria-label="Source">
    <h3>Source</h3>
    {error ? <p className="note-error" role="alert">{error}</p>
      : !source ? <p className="notes-links-empty">Resolving source…</p>
        : <>
          <p className="notes-source-status" data-status={source.status}>{statusText[source.status]}</p>
          {source.recordingId && <p className="notes-source-detail">
            <FileText />
            {source.recordingAvailable
              ? <Link to={`/recording/${source.recordingId}${source.versionId && source.status !== 'unknown' ? `?version=${source.versionId}` : ''}`}>{source.recordingFilename || 'Recording'}</Link>
              : <span>{source.recordingFilename || 'Recording'} (not in the library)</span>}
            {source.versionCreatedAt && <time dateTime={source.versionCreatedAt}>{new Date(source.versionCreatedAt).toLocaleString()}</time>}
            {source.versionOrigin && <span>{source.versionOrigin}</span>}
          </p>}
          {backlinks.length > 0 && <>
            <h4>Also written from this version</h4>
            <ul className="notes-backlinks">{backlinks.map(row => <li key={row.id}>
              <button type="button" onClick={() => onOpenDocument(row.id)}>{row.title}</button>
            </li>)}</ul>
          </>}
        </>}
  </section>
}
