import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ArrowLeft, BookmarkPlus, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, Download, FilePlus2, FileText, Folder, FolderOpen, FolderPlus, History, Inbox, Loader2, MoreHorizontal, NotebookPen, Pencil, RefreshCw, RotateCcw, Save, Search, Send, SlidersHorizontal, Sparkles, Star, Trash2, Upload, X } from "@/components/icons"
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { DocumentCanvas } from '@/components/DocumentCanvas'
import { FolderSelect, NoteDialog, SendNoteDialog } from '@/components/NoteDialogs'
import { NoteMetadata } from '@/components/NoteMetadata'
import { MarkdownExportDialog } from '@/components/MarkdownExportDialog'
import { notesApi, folderPaths, type NoteFolder, type NoteDocument, type NotePage, type NoteVersion, type SavedView, type SavedViewFilters } from '@/lib/notes-api'
import { exportDocument, safeDocumentName } from '@/lib/document-export'
import { formatDate, t, tn } from '@/i18n'
import './notes.css'

const errorMessage = (error: unknown) => error instanceof Error ? error.message : t('This operation could not be completed.')
const shortDate = (date: string) => formatDate(date, { month: 'short', day: 'numeric' })
const emptyPage: NotePage = { documents: [], total: 0, limit: 30, offset: 0 }
const draftKey = (id: string) => `openplod.note-draft.v1.${id}`
function clearDraft(id: string) { try { sessionStorage.removeItem(draftKey(id)) } catch { /* Browser storage may be disabled. */ } }

export function NotesPage() {
  const [params, setParams] = useSearchParams()
  const selectedId = params.get('document') || ''
  const [folders, setFolders] = useState<NoteFolder[]>([])
  const [view, setView] = useState('all')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('updated')
  const [tag, setTag] = useState('')
  const [tags, setTags] = useState<{ tag: string; count: number }[]>([])
  const [savedViews, setSavedViews] = useState<SavedView[]>([])
  // The applied saved view; its stored filters drive the list until any filter is changed by hand.
  const [activeView, setActiveView] = useState<SavedView | null>(null)
  const [viewDialog, setViewDialog] = useState<'new' | SavedView | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [offset, setOffset] = useState(0)
  const [page, setPage] = useState<NotePage>(emptyPage)
  const [document, setDocument] = useState<NoteDocument | null>(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [folderDraft, setFolderDraft] = useState('')
  const [mode, setMode] = useState<'edit' | 'preview'>('preview')
  const [loading, setLoading] = useState(true)
  const [documentLoading, setDocumentLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [folderDialog, setFolderDialog] = useState<'new' | NoteFolder | null>(null)
  const [sendOpen, setSendOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const importRef = useRef<HTMLInputElement>(null)
  const dirty = !!document && (title !== document.title || content !== document.content || folderDraft !== (document.folderId || ''))
  const selectedFolder = folders.find(folder => folder.id === view)
  const targetFolder = selectedFolder?.id || null
  const viewName = activeView?.name || selectedFolder?.name || ({ all: t('All notes'), inbox: t('Inbox'), starred: t('Starred'), trash: t('Trash') }[view] ?? t('Notes'))
  const currentFilters = (): Partial<SavedViewFilters> => ({
    q: query.trim(), sort: sort as SavedViewFilters['sort'], view: view === 'starred' || view === 'trash' ? view : 'all',
    ...(view !== 'all' && view !== 'starred' && view !== 'trash' ? { folderId: view } : {}), ...(tag ? { tag } : {}),
  })
  const filtered = view !== 'all' || !!query.trim() || !!tag || sort !== 'updated'

  const applyDocument = useCallback((document: NoteDocument) => {
    clearDraft(document.id)
    setDocument(document); setTitle(document.title); setContent(document.content); setFolderDraft(document.folderId || '')
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    notesApi.folders(controller.signal).then(setFolders).catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)) })
    notesApi.tags(controller.signal).then(setTags).catch(() => { /* The tag filter is optional; the list still loads. */ })
    notesApi.views(controller.signal).then(setSavedViews).catch(() => { /* Saved views are optional; the list still loads. */ })
    return () => controller.abort()
  }, [refresh])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    const timer = window.setTimeout(() => {
      const request: Record<string, string> = { q: query, sort, offset: String(offset), view: view === 'starred' || view === 'trash' ? view : 'all' }
      if (view !== 'all' && view !== 'starred' && view !== 'trash') request.folderId = view
      if (tag) request.tag = tag
      // A saved view may combine filters the sidebar cannot show at once (a folder and Starred), so use it verbatim.
      if (activeView) { for (const key of ['folderId', 'tag'] as const) delete request[key]; Object.assign(request, Object.fromEntries(Object.entries(activeView.filters).map(([key, value]) => [key, String(value)]))) }
      notesApi.list(request, controller.signal).then(result => { if (!controller.signal.aborted) setPage(result) })
        .catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)) })
        .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }, query ? 200 : 0)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [view, query, sort, offset, tag, refresh, activeView])
  useEffect(() => {
    if (!selectedId) { setDocument(null); setDocumentLoading(false); return }
    const controller = new AbortController()
    setDocumentLoading(true); setError('')
    notesApi.get(selectedId, controller.signal).then(result => {
      if (controller.signal.aborted) return
      let draft: {title: string; content: string; folderId: string; revision: number} | null = null
      try {
        const saved = JSON.parse(sessionStorage.getItem(draftKey(result.id)) || 'null')
        if (saved && typeof saved.title === 'string' && typeof saved.content === 'string' && typeof saved.folderId === 'string' && Number.isSafeInteger(saved.revision) && saved.revision > 0) draft = saved
      } catch { /* Invalid or unavailable cached drafts do not prevent loading saved notes. */ }
      applyDocument(result)
      if (draft && !result.deletedAt && (draft.title !== result.title || draft.content !== result.content || draft.folderId !== (result.folderId || ''))) {
        setDocument({ ...result, revision: draft.revision }); setTitle(draft.title); setContent(draft.content); setFolderDraft(draft.folderId); setMode('edit')
        setNotice(draft.revision === result.revision ? t('Unsaved draft recovered') : t('Draft recovered from an older revision. Reload the saved note before resolving the conflict.'))
      }
    })
      .catch(error => { if (!controller.signal.aborted) { setDocument(null); setError(errorMessage(error)) } })
      .finally(() => { if (!controller.signal.aborted) setDocumentLoading(false) })
    return () => controller.abort()
  }, [selectedId, applyDocument])
  useEffect(() => {
    if (!document || document.id !== selectedId) return
    if (!dirty || document.deletedAt) { clearDraft(document.id); return }
    try { sessionStorage.setItem(draftKey(document.id), JSON.stringify({ title, content, folderId: folderDraft, revision: document.revision })) }
    catch { /* The unload guard still protects drafts when session storage is full. */ }
  }, [document, selectedId, dirty, title, content, folderDraft])
  useEffect(() => {
    if (!dirty) return
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    const navigate = (event: MouseEvent) => {
      const link = (event.target as Element)?.closest('a[href]')
      if (!link || link.getAttribute('target') === '_blank' || event.ctrlKey || event.metaKey || event.shiftKey) return
      if (!window.confirm(t('Leave without saving your note changes?'))) { event.preventDefault(); event.stopPropagation() }
      else if (document) clearDraft(document.id)
    }
    window.addEventListener('beforeunload', unload)
    window.document.addEventListener('click', navigate, true)
    return () => { window.removeEventListener('beforeunload', unload); window.document.removeEventListener('click', navigate, true) }
  }, [dirty, document])

  const canLeave = () => {
    if (!dirty) return true
    if (!window.confirm(t('Discard the unsaved changes to this note?'))) return false
    if (document) clearDraft(document.id)
    return true
  }
  const selectDocument = (id: string) => {
    if (busy || !canLeave()) return
    setNotice(''); setError(''); setParams(id ? { document: id } : {}); setMode('preview')
  }
  const selectView = (next: string) => {
    if (busy || !canLeave()) return
    setView(next); setOffset(0); setParams({}); setError(''); setNotice(''); setSidebarOpen(false); setActiveView(null)
  }
  const applySavedView = (saved: SavedView) => {
    if (busy || !canLeave()) return
    const { filters } = saved
    setView(filters.folderId || (filters.view !== 'all' ? filters.view : 'all')); setQuery(filters.q); setSort(filters.sort); setTag(filters.tag || '')
    setOffset(0); setParams({}); setError(''); setNotice(''); setSidebarOpen(false); setActiveView(saved)
  }
  const mutate = async (operation: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await operation(); setRefresh(value => value + 1) }
    catch (error) { setError(errorMessage(error)) }
    finally { setBusy(false) }
  }
  const createNote = () => {
    if (!canLeave()) return
    void mutate(async () => {
      const note = await notesApi.create({ title: t('Untitled note'), content: '', folderId: targetFolder, idempotencyKey: crypto.randomUUID() })
      setParams({ document: note.id }); applyDocument(note); setMode('edit')
    })
  }
  const save = () => {
    if (!document || busy || !dirty || !title.trim() || document.deletedAt) return
    void mutate(async () => {
      applyDocument(await notesApi.update(document.id, { title, content, folderId: folderDraft || null, revision: document.revision }))
      setNotice(t('Note saved'))
    })
  }
  const exportNote = (format: 'md' | 'json') => {
    if (!document) return
    void exportDocument({ filename: `${safeDocumentName(document.title)}.${format}`, content: format === 'md' ? document.content : JSON.stringify(document, null, 2), mime: format === 'md' ? 'text/markdown' : 'application/json' })
      .catch(error => setError(errorMessage(error)))
  }
  const importFiles = async (files: File[]) => {
    if (!files.length || !canLeave()) return
    if (files.length > 20) { setError(t('Import up to 20 Markdown files at once.')); return }
    await mutate(async () => {
      let imported = 0
      for (const file of files) {
        try {
          if (!/\.(md|markdown)$/i.test(file.name) || file.size > 524288) throw new Error(t('Choose a Markdown file up to 512 KB.'))
          const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
          await notesApi.create({ title: file.name.replace(/\.(md|markdown)$/i, ''), content: text, folderId: targetFolder, idempotencyKey: crypto.randomUUID() }); imported++
        } catch (error) {
          setRefresh(value => value + 1)
          throw new Error(tn(imported, '{count} file imported. {file}: {error}', '{count} files imported. {file}: {error}', { file: file.name, error: errorMessage(error) }))
        }
      }
      setNotice(tn(imported, '{count} Markdown file imported', '{count} Markdown files imported'))
    })
  }

  return <div className="notes-workspace" data-document={!!selectedId}>
    <input type="file" ref={importRef} multiple accept=".md,.markdown,text/markdown" className="sr-only" aria-label={t('Import Markdown files')} tabIndex={-1} onChange={event => { const files = [...(event.target.files || [])]; event.target.value = ''; void importFiles(files) }} />
    {error && <div className="notes-message note-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError('')} aria-label={t('Dismiss error')}><X /></button></div>}
    {notice && <div className="notes-message" role="status"><Check /><span>{notice}</span></div>}
    <div className="notes-columns">
      <header className="notes-heading"><div><h1>{t('Documents')}</h1></div><div>
        <IconButton asChild label={t('Open transcripts')}><Link to="/transcripts"><FileText /></Link></IconButton>
        <IconButton label={t('Import Markdown')} disabled={busy} onClick={() => importRef.current?.click()}><Upload /></IconButton>
        <IconButton label={t('Export to folder')} disabled={busy} onClick={() => setExportOpen(true)}><FolderOpen /></IconButton>
        <Button size="sm" disabled={busy} onClick={createNote}><FilePlus2 />{t('New note')}</Button>
      </div></header>
      <aside className={`notes-folders ${sidebarOpen ? 'is-open' : ''}`} aria-label={t('Note folders')}>
        <div className="notes-folders-title"><span>{t('Workspace')}</span><Button size="icon" variant="ghost" title={t('New folder')} aria-label={t('New folder')} disabled={busy} onClick={() => setFolderDialog('new')}><FolderPlus /></Button></div>
        {([{ id: 'all', name: t('All notes'), icon: NotebookPen }, { id: 'inbox', name: t('Inbox'), icon: Inbox }, { id: 'starred', name: t('Starred'), icon: Star }] as const).map(({ id, name, icon: Icon }) =>
          <button type="button" key={id} className={!activeView && view === id ? 'selected' : ''} aria-current={!activeView && view === id ? 'page' : undefined} onClick={() => selectView(id)}><Icon /><span>{name}</span></button>)}
        {savedViews.length > 0 && <div className="notes-saved-views" role="group" aria-label={t('Saved views')}>{savedViews.map(saved => <button type="button" key={saved.id} title={saved.name} className={activeView?.id === saved.id ? 'selected' : ''} aria-current={activeView?.id === saved.id ? 'page' : undefined} onClick={() => applySavedView(saved)}><SlidersHorizontal /><span>{saved.name}</span></button>)}</div>}
        <div className="notes-folder-tree">{folderPaths(folders).map(({ folder, depth, path }) => <button type="button" key={folder.id} title={path} style={{ paddingLeft: `${10 + Math.min(depth, 6) * 12}px` }} className={!activeView && view === folder.id ? 'selected' : ''} aria-current={!activeView && view === folder.id ? 'page' : undefined} onClick={() => selectView(folder.id)}><Folder /><span>{folder.name}</span><small>{folder.documentCount}</small></button>)}</div>
        <button type="button" className={!activeView && view === 'trash' ? 'selected' : ''} aria-current={!activeView && view === 'trash' ? 'page' : undefined} onClick={() => selectView('trash')}><Trash2 /><span>{t('Trash')}</span></button>
      </aside>
      <section className="notes-list" aria-label={t('Documents')}>
        <header><button className="notes-folder-toggle" type="button" aria-label={t('Toggle folders')} aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(value => !value)}><Folder /></button><h2>{viewName}</h2><span>{page.total}</span>
          {activeView ? <DropdownMenu.Root><DropdownMenu.Trigger asChild><Button size="icon" variant="ghost" aria-label={t('Saved view actions')} title={t('Saved view actions')}><MoreHorizontal /></Button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="action-menu" align="end">
            <DropdownMenu.Item onSelect={() => setViewDialog(activeView)}><Pencil />{t('Rename view')}</DropdownMenu.Item>
            <DropdownMenu.Item onSelect={() => { if (window.confirm(t('Delete the saved view "{name}"? Notes are not affected.', { name: activeView.name }))) void mutate(async () => { await notesApi.deleteView(activeView.id, activeView.revision); setActiveView(null) }) }}><Trash2 />{t('Delete view')}</DropdownMenu.Item>
          </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
          : filtered && <Button size="icon" variant="ghost" title={t('Save as view')} aria-label={t('Save as view')} disabled={busy} onClick={() => setViewDialog('new')}><BookmarkPlus /></Button>}
          {activeView ? null : selectedFolder ? <DropdownMenu.Root><DropdownMenu.Trigger asChild><Button size="icon" variant="ghost" aria-label={t('Folder actions')} title={t('Folder actions')}><MoreHorizontal /></Button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="action-menu" align="end">
            <DropdownMenu.Item onSelect={() => setFolderDialog(selectedFolder)}><Pencil />{t('Edit folder')}</DropdownMenu.Item>
            <DropdownMenu.Item onSelect={() => { if (window.confirm(t('Delete this empty folder? Documents and subfolders must be moved first.'))) void mutate(async () => { await notesApi.deleteFolder(selectedFolder.id, selectedFolder.revision); selectView('all') }) }}><Trash2 />{t('Delete empty folder')}</DropdownMenu.Item>
          </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root> : <Button size="icon" variant="ghost" title={t('Refresh notes')} aria-label={t('Refresh notes')} onClick={() => setRefresh(value => value + 1)}><RefreshCw /></Button>}
        </header>
        <label className="notes-search"><Search /><input aria-label={t('Search notes')} value={query} placeholder={t('Search notes')} maxLength={200} onChange={event => { setQuery(event.target.value); setOffset(0); setActiveView(null) }} /></label>
        <select className="notes-sort" aria-label={t('Sort notes')} value={sort} onChange={event => { setSort(event.target.value); setOffset(0); setActiveView(null) }}><option value="updated">{t('Last edited')}</option><option value="title">{t('Title A to Z')}</option></select>
        {tags.length > 0 && <div className="notes-tag-filter" role="group" aria-label={t('Filter by tag')}>{tags.map(item => <button type="button" key={item.tag} aria-pressed={tag.toLocaleLowerCase() === item.tag.toLocaleLowerCase()} onClick={() => { setTag(current => current.toLocaleLowerCase() === item.tag.toLocaleLowerCase() ? '' : item.tag); setOffset(0); setActiveView(null) }}>{item.tag}<small>{item.count}</small></button>)}</div>}
        <div className="notes-list-items" aria-busy={loading}>
          {loading ? <div className="notes-empty" role="status"><Loader2 className="animate-spin" />{t('Loading notes')}</div> : page.documents.map(note => <button type="button" key={note.id} className={`notes-list-item ${selectedId === note.id ? 'selected' : ''}`} onClick={() => selectDocument(note.id)}>
            <FileText className="notes-list-file" /><div className="notes-list-copy"><div><strong>{note.title}</strong>{note.starred && <Star className="note-star" />}</div><p>{note.excerpt || t('Empty note')}</p>{note.tags.length > 0 && <span className="notes-list-tags">{note.tags.slice(0, 3).map(value => <i key={value}>{value}</i>)}</span>}<small>{shortDate(note.updatedAt)}<span>{note.sourceRecordingId ? t('Transcript') : 'Markdown'}</span></small></div>
          </button>)}
          {!loading && page.documents.length === 0 && <div className="notes-empty"><FileText /><p>{view === 'trash' ? t('Trash is empty') : query || tag ? t('No matching notes') : t('No notes here yet')}</p>{view !== 'trash' && !query && !tag && <Button size="sm" variant="outline" onClick={createNote}><FilePlus2 />{t('New note')}</Button>}</div>}
        </div>
        {page.total > page.limit && <footer className="notes-pagination"><Button size="icon" variant="ghost" aria-label={t('Previous page')} title={t('Previous page')} disabled={offset === 0 || loading} onClick={() => setOffset(value => Math.max(0, value - page.limit))}><ChevronLeft /></Button><span>{Math.floor(offset / page.limit) + 1} / {Math.ceil(page.total / page.limit)}</span><Button size="icon" variant="ghost" aria-label={t('Next page')} title={t('Next page')} disabled={offset + page.limit >= page.total || loading} onClick={() => setOffset(value => value + page.limit)}><ChevronRight /></Button></footer>}
      </section>
      <section className="notes-editor" aria-label={t('Note editor')}>
        {documentLoading ? <div className="notes-empty" role="status"><Loader2 className="animate-spin" />{t('Opening note')}</div> : document && document.id === selectedId ? <>
          <header className="notes-document-heading">
            <IconButton className="notes-back" label={t('Back to notes')} onClick={() => selectDocument('')}><ArrowLeft /></IconButton>
            <div className="notes-document-identity"><div><input className="notes-title-input" aria-label={t('Note title')} value={title} maxLength={180} disabled={busy || !!document.deletedAt} onChange={event => setTitle(event.target.value)} />
              <IconButton label={document.starred ? t('Unstar note') : t('Star note')} disabled={busy || dirty || !!document.deletedAt} onClick={() => void mutate(async () => applyDocument(await notesApi.update(document.id, { starred: !document.starred, revision: document.revision })))}><Star className={document.starred ? 'note-star' : ''} /></IconButton></div>
              <div className="notes-document-meta"><time dateTime={document.updatedAt}>{t('Edited {date}', { date: shortDate(document.updatedAt) })}</time><span>{t('Revision {revision}', { revision: document.revision })}</span>{document.sourceOrigin?.startsWith('ai:mistral:') && <span>Mistral</span>}</div>
            </div>
            <div className="notes-document-commands">
              <span className="notes-save-state" data-dirty={dirty} role="status">{busy ? <Loader2 className="animate-spin" /> : dirty ? <Pencil /> : <Check />}{busy ? t('Saving...') : dirty ? t('Unsaved') : t('Saved')}</span>
              <IconButton label={t('Save note')} variant={dirty ? 'default' : 'ghost'} disabled={busy || !dirty || !!document.deletedAt || !title.trim()} onClick={save}><Save /></IconButton>
              <IconButton label={t('Send note')} disabled={dirty || busy || !!document.deletedAt} onClick={() => setSendOpen(true)}><Send /></IconButton>
              <DropdownMenu.Root><DropdownMenu.Trigger asChild><Button size="sm" variant="outline" aria-label={t('Export note')} disabled={dirty || busy}><Download /><span>{t('Export')}</span><ChevronDown /></Button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="action-menu" align="end"><DropdownMenu.Item onSelect={() => exportNote('md')}><FileText />{t('Markdown file')}</DropdownMenu.Item><DropdownMenu.Item onSelect={() => exportNote('json')}><FileText />{t('JSON with metadata')}</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
              {document.sourceRecordingId && <Button asChild size="sm" className="notes-ask-ai"><Link to={`/ai?recording=${document.sourceRecordingId}`}><Sparkles /><span>{t('Ask AI')}</span></Link></Button>}
              <DropdownMenu.Root><DropdownMenu.Trigger asChild><IconButton label={t('Document actions')}><MoreHorizontal /></IconButton></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="action-menu" align="end">
                <DropdownMenu.Item disabled={busy} onSelect={() => { if (canLeave()) void mutate(async () => applyDocument(await notesApi.get(document.id))) }}><RefreshCw />{t('Reload saved note')}</DropdownMenu.Item>
                <DropdownMenu.Item disabled={dirty || busy} onSelect={() => {
                  if (!navigator.clipboard) { setError(t('Clipboard unavailable. Export the Markdown file instead.')); return }
                  void navigator.clipboard.writeText(document.content).then(() => setNotice(t('Markdown copied'))).catch(() => setError(t('Clipboard unavailable. Export the Markdown file instead.')))
                }}><Copy />{t('Copy Markdown')}</DropdownMenu.Item>
                <DropdownMenu.Item disabled={dirty || busy} onSelect={() => setHistoryOpen(true)}><History />{t('Note history')}</DropdownMenu.Item>
                {document.sourceRecordingId && <DropdownMenu.Item asChild><Link to={`/transcripts/${document.sourceRecordingId}`}><FileText />{t('Source transcript')}</Link></DropdownMenu.Item>}
                {!document.deletedAt && <><DropdownMenu.Separator /><DropdownMenu.Item className="destructive" disabled={dirty || busy} onSelect={() => { if (window.confirm(t('Move this note to Trash for 30 days? Source recordings are kept.'))) void mutate(async () => applyDocument(await notesApi.trash(document.id, document.revision))) }}><Trash2 />{t('Move note to Trash')}</DropdownMenu.Item></>}
              </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
            </div>
          </header>
          {document.deletedAt ? <div className="notes-trash-banner"><span>{t('In Trash since {date}', { date: shortDate(document.deletedAt) })}</span><Button size="sm" variant="outline" disabled={busy} onClick={() => void mutate(async () => { applyDocument(await notesApi.restore(document.id, document.revision)); setNotice(t('Note restored')) })}><RotateCcw />{t('Restore')}</Button><Button size="icon" variant="ghost" title={t('Delete permanently')} aria-label={t('Delete permanently')} disabled={busy} onClick={() => { if (window.confirm(t('Permanently delete this note and its saved versions? This cannot be undone. Source audio is not affected.'))) void mutate(async () => { await notesApi.purge(document.id, document.revision); setParams({}); setDocument(null) }) }}><Trash2 /></Button></div>
            : <div className="notes-location"><Folder /><FolderSelect folders={folders} value={folderDraft} onChange={setFolderDraft} disabled={busy} />{document.sourceRecordingId && <Link to={`/transcripts/${document.sourceRecordingId}`}><FileText />{t('Source transcript')}</Link>}</div>}
          {!document.deletedAt && <NoteMetadata document={document} disabled={busy || dirty} onOpenDocument={selectDocument}
            onUpdate={data => void mutate(async () => applyDocument(await notesApi.update(document.id, { ...data, revision: document.revision })))} />}
          <DocumentCanvas key={document.id} document={document} content={content} onChange={setContent} mode={mode} onModeChange={setMode} busy={busy} onSave={save} />
          {sendOpen && <SendNoteDialog document={document} onClose={() => setSendOpen(false)} />}
          {historyOpen && <NoteHistory document={document} onClose={() => setHistoryOpen(false)} onRestored={note => { applyDocument(note); setRefresh(value => value + 1); setHistoryOpen(false); setNotice(t('Version restored as a new revision')) }} />}
        </> : <div className="notes-empty notes-editor-empty"><NotebookPen /><h2>{t('Your Markdown workspace')}</h2><Button variant="outline" onClick={createNote}><FilePlus2 />{t('New note')}</Button></div>}
      </section>
    </div>
    {viewDialog && <ViewForm view={viewDialog === 'new' ? null : viewDialog} onClose={() => setViewDialog(null)} onSaved={async saved => {
      setViewDialog(null)
      if (viewDialog === 'new') {
        // Re-applying the view switches to its stored filters, which match what is on screen.
        setSavedViews(rows => [...rows, saved]); setActiveView(saved)
      } else setActiveView(current => current?.id === saved.id ? saved : current)
      setRefresh(value => value + 1)
    }} filters={currentFilters()} />}
    {exportOpen && <MarkdownExportDialog onClose={() => setExportOpen(false)} />}
    {folderDialog && <FolderForm folder={folderDialog === 'new' ? null : folderDialog} folders={folders} parentId={targetFolder} onClose={() => setFolderDialog(null)} onSaved={() => { setFolderDialog(null); setRefresh(value => value + 1) }} />}
  </div>
}

function FolderForm({ folder, folders, parentId, onClose, onSaved }: {folder: NoteFolder | null; folders: NoteFolder[]; parentId: string | null; onClose: () => void; onSaved: () => void}) {
  const [name, setName] = useState(folder?.name || '')
  const [parent, setParent] = useState(folder ? folder.parentId || '' : parentId || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return <NoteDialog title={folder ? t('Edit folder') : t('New folder')} description={folder ? folder.name : t('Markdown workspace')} onClose={onClose} busy={busy}>
    <form onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('')
      try { if (folder) await notesApi.updateFolder(folder.id, { name, parentId: parent || null, revision: folder.revision }); else await notesApi.createFolder(name, parent || null); onSaved() }
      catch (error) { setError(errorMessage(error)) }
      finally { setBusy(false) }
    }}><label>{t('Name')}<input autoFocus aria-label={t('Folder name')} value={name} onChange={event => setName(event.target.value)} required maxLength={180} /></label>
      <label>{t('Parent folder')}<FolderSelect folders={folders} value={parent} onChange={setParent} rootLabel={t('Workspace')} exclude={folder?.id} disabled={busy} /></label>
      {error && <p role="alert" className="note-error">{error}</p>}<footer><Button type="button" variant="ghost" disabled={busy} onClick={onClose}><X />{t('Cancel')}</Button><Button disabled={busy || !name.trim()}>{busy ? <Loader2 className="animate-spin" /> : <FolderPlus />}{folder ? t('Save folder') : t('Create folder')}</Button></footer>
    </form>
  </NoteDialog>
}

function ViewForm({ view, filters, onClose, onSaved }: {view: SavedView | null; filters: Partial<SavedViewFilters>; onClose: () => void; onSaved: (view: SavedView) => void}) {
  const [name, setName] = useState(view?.name || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return <NoteDialog title={view ? t('Rename view') : t('Save view')} description={view ? view.name : t('Keep the current folder, search, tag, and sort')} onClose={onClose} busy={busy}>
    <form onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('')
      try { onSaved(view ? await notesApi.updateView(view.id, { name, revision: view.revision }) : await notesApi.createView(name, filters)) }
      catch (error) { setError(errorMessage(error)) }
      finally { setBusy(false) }
    }}><label>{t('Name')}<input autoFocus aria-label={t('View name')} value={name} onChange={event => setName(event.target.value)} required maxLength={80} /></label>
      {error && <p role="alert" className="note-error">{error}</p>}<footer><Button type="button" variant="ghost" disabled={busy} onClick={onClose}><X />{t('Cancel')}</Button><Button disabled={busy || !name.trim()}>{busy ? <Loader2 className="animate-spin" /> : <BookmarkPlus />}{view ? t('Rename view') : t('Save view')}</Button></footer>
    </form>
  </NoteDialog>
}

function NoteHistory({ document, onClose, onRestored }: {document: NoteDocument; onClose: () => void; onRestored: (document: NoteDocument) => void}) {
  const [versions, setVersions] = useState<Omit<NoteVersion, 'content'>[]>([])
  const [selected, setSelected] = useState<NoteVersion | null>(null)
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { let cancelled = false; notesApi.versions(document.id).then(rows => { if (!cancelled) { setVersions(rows); setMore(rows.length === 30) } }).catch(error => { if (!cancelled) setError(errorMessage(error)) }); return () => { cancelled = true } }, [document.id])
  return <NoteDialog title={t('Note history')} description={document.title} onClose={onClose} busy={busy}>
    {error && <p role="alert" className="note-error">{error}</p>}
    <div className="notes-history-list">{versions.map(version => <button type="button" disabled={busy} key={version.id} aria-pressed={selected?.id === version.id} onClick={async () => { setBusy(true); try { setSelected(await notesApi.version(document.id, version.id)) } catch (error) { setError(errorMessage(error)) } finally { setBusy(false) } }}><span>{t('Revision {revision}', { revision: version.revision })}</span><time>{formatDate(version.createdAt)}</time></button>)}</div>
    {more && <Button variant="ghost" disabled={busy} onClick={async () => { setBusy(true); try { const rows = await notesApi.versions(document.id, versions.length); setVersions(current => [...current, ...rows]); setMore(rows.length === 30) } catch (error) { setError(errorMessage(error)) } finally { setBusy(false) } }}><ChevronDown />{t('Load older versions')}</Button>}
    {selected && <><h3 className="notes-history-title">{selected.title}</h3><pre className="notes-history-content">{selected.content}</pre></>}
    <footer><Button variant="outline" onClick={onClose} disabled={busy}><X />{t('Close')}</Button><Button disabled={busy || !selected || selected.revision === document.revision} onClick={async () => { if (!selected || !window.confirm(t('Restore this content as a new revision? Current history will be kept.'))) return; setBusy(true); try { onRestored(await notesApi.restoreVersion(document.id, selected.id, document.revision)) } catch (error) { setError(errorMessage(error)) } finally { setBusy(false) } }}><RotateCcw />{t('Restore version')}</Button></footer>
  </NoteDialog>
}
