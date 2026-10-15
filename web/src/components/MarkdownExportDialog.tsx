import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { AlertCircle, Check, FolderOpen, Loader2, Lock, RefreshCw, X } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { NoteDialog } from '@/components/NoteDialogs'
import { notesApi, type ExportItem, type ExportResult, type ExportStatus } from '@/lib/notes-api'
import { getRuntime } from '@/lib/runtime'
import './knowledge.css'

const errorMessage = (error: unknown) => error instanceof Error ? error.message : typeof error === 'string' ? error : 'The export could not be completed.'
const actionLabel: Record<ExportItem['action'], string> = { created: 'New', updated: 'Updated', moved: 'Moved', unchanged: 'Unchanged', conflict: 'Conflict', orphaned: 'Kept' }
const reasonLabel: Record<NonNullable<ExportItem['reason']>, string> = {
  modified_externally: 'Edited outside OpenPlod',
  deleted_externally: 'Deleted outside OpenPlod',
  not_a_file: 'Path is not a regular file',
}
/** A conflict is identified by its note, or for an attachment by its attachment key. */
const conflictKey = (item: ExportItem) => item.kind === 'attachment' ? `attachment:${item.attachmentKey}` : `note:${item.documentId}`

/**
 * Managed one-way export to a chosen folder (roadmap KB-02).
 * A preview always comes first; conflicting files are only replaced when the
 * user ticks them, one by one. The folder is chosen with the native picker in
 * the desktop app or typed in a browser, and saved only on explicit confirmation;
 * OPENPLOD_EXPORT_DIR locks it.
 */
export function MarkdownExportDialog({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<ExportStatus | null>(null)
  const [result, setResult] = useState<ExportResult | null>(null)
  const [overwrite, setOverwrite] = useState<string[]>([])
  const [attachments, setAttachments] = useState({ audio: false, transcript: false })
  const [folder, setFolder] = useState('')
  const [editingFolder, setEditingFolder] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const desktop = getRuntime().mode === 'desktop'
  useEffect(() => {
    const controller = new AbortController()
    notesApi.exportStatus(controller.signal).then(next => { setStatus(next); setFolder(next.root ?? '') }).catch(failure => { if (!controller.signal.aborted) setError(errorMessage(failure)) })
    return () => controller.abort()
  }, [])
  const run = async (dryRun: boolean) => {
    setBusy(true); setError('')
    try {
      // A preview always shows every conflict; ticked files are only replaced by the real export.
      const notes = overwrite.filter(key => key.startsWith('note:')).map(key => key.slice(5))
      const files = overwrite.filter(key => key.startsWith('attachment:')).map(key => key.slice(11))
      const next = await notesApi.exportMarkdown({ dryRun, attachments, overwrite: dryRun ? [] : notes, overwriteAttachments: dryRun ? [] : files })
      setResult(next)
      setOverwrite(keys => dryRun ? keys.filter(key => next.items.some(item => item.action === 'conflict' && conflictKey(item) === key)) : [])
      if (!dryRun) setStatus(await notesApi.exportStatus())
    } catch (failure) { setError(errorMessage(failure)) } finally { setBusy(false) }
  }
  const saveFolder = async (path: string | null) => {
    setBusy(true); setError('')
    try {
      const next = await notesApi.setExportFolder(path)
      setStatus(next); setFolder(next.root ?? ''); setEditingFolder(false); setResult(null); setOverwrite([])
    } catch (failure) { setError(errorMessage(failure)) } finally { setBusy(false) }
  }
  const pickFolder = async () => {
    setError('')
    try {
      const picked = await invoke<string | null>('pick_export_folder')
      if (picked && window.confirm(`Export notes to ${picked}? OpenPlod will write Markdown files there and never overwrite files you edit.`)) await saveFolder(picked)
    } catch (failure) { setError(errorMessage(failure)) }
  }
  const ready = status?.configured && !status.error
  const conflicts = result?.items.filter(item => item.action === 'conflict') ?? []
  const counts = result ? (['created', 'updated', 'moved', 'unchanged', 'conflict', 'orphaned'] as const).filter(action => result.counts[action] > 0) : []
  const changeAttachments = (key: 'audio' | 'transcript', value: boolean) => { setAttachments(current => ({ ...current, [key]: value })); setResult(null); setOverwrite([]) }

  return <NoteDialog title="Export to folder" description="One-way Markdown export with front matter" onClose={onClose} busy={busy}>
    <div className="notes-export">
      {!status && !error && <p className="notes-links-empty" role="status"><Loader2 className="animate-spin" />Checking export folder</p>}
      {status && <dl className="notes-export-status">
        <div><dt>Folder</dt><dd>{status.root ? <code>{status.root}</code> : 'Not chosen'}{status.locked && <small title="Set by OPENPLOD_EXPORT_DIR"> <Lock aria-label="Locked" /> set by OPENPLOD_EXPORT_DIR</small>}</dd></div>
        {status.configured && <div><dt>Last export</dt><dd>{status.lastExportedAt ? new Date(status.lastExportedAt).toLocaleString() : 'Never'}</dd></div>}
        {status.configured && <div><dt>Tracked</dt><dd>{status.documentCount} note{status.documentCount === 1 ? '' : 's'}{status.attachmentCount ? `, ${status.attachmentCount} attachment${status.attachmentCount === 1 ? '' : 's'}` : ''}</dd></div>}
      </dl>}
      {status && !status.locked && (desktop
        ? <div className="knowledge-row"><Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void pickFolder()}><FolderOpen />{status.root ? 'Change folder' : 'Choose folder'}</Button>{status.source === 'settings' && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void saveFolder(null)}><X />Forget folder</Button>}</div>
        : editingFolder || !status.root
          ? <form className="knowledge-field" onSubmit={event => { event.preventDefault(); if (folder.trim()) void saveFolder(folder.trim()) }}>
            <label htmlFor="export-folder">Absolute path of an existing folder on the OpenPlod computer</label>
            <input id="export-folder" value={folder} disabled={busy} placeholder="/Users/me/Obsidian/Vault" autoComplete="off" spellCheck={false} onChange={event => setFolder(event.target.value)} />
            <div className="knowledge-row"><Button type="submit" size="sm" disabled={busy || !folder.trim()}><Check />Use this folder</Button>{status.root && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { setEditingFolder(false); setFolder(status.root ?? '') }}><X />Cancel</Button>}</div>
          </form>
          : <div className="knowledge-row"><Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setEditingFolder(true)}><FolderOpen />Change folder</Button>{status.source === 'settings' && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void saveFolder(null)}><X />Forget folder</Button>}</div>)}
      {status && !status.configured && <p className="notes-export-note">Choose an existing folder, such as an Obsidian vault. Exports never delete or overwrite files you edited there.</p>}
      {ready && <fieldset className="knowledge-suggestion" disabled={busy}>
        <legend className="knowledge-note">Attachments for notes written from a recording</legend>
        <label><input type="checkbox" checked={attachments.audio} onChange={event => changeAttachments('audio', event.target.checked)} />Copy the recording audio</label>
        <label><input type="checkbox" checked={attachments.transcript} onChange={event => changeAttachments('transcript', event.target.checked)} />Copy the exact cited transcript version</label>
        <p className="knowledge-note">Saved in <code>attachments/</code> and listed in each note's front matter. Recordings in Trash are skipped.</p>
      </fieldset>}
      {status?.error && <p className="note-error" role="alert">{status.error}</p>}
      {error && <p className="note-error" role="alert">{error}</p>}
      {result && <section aria-label={result.dryRun ? 'Export preview' : 'Export result'}>
        <h3>{result.dryRun ? 'Preview — nothing written yet' : 'Export complete'}</h3>
        <p className="notes-export-counts">{counts.length ? counts.map(action => <span key={action} data-action={action}>{actionLabel[action]} {result.counts[action]}</span>) : <span>No active notes</span>}</p>
        {result.items.length > 0 && <ul className="notes-export-items">{result.items.slice(0, 200).map(item => <li key={`${conflictKey(item)}:${item.path}`} data-action={item.action}>
          {item.action === 'conflict'
            ? <label><input type="checkbox" checked={overwrite.includes(conflictKey(item))} disabled={busy || item.reason === 'not_a_file'} onChange={event => setOverwrite(keys => event.target.checked ? [...keys, conflictKey(item)] : keys.filter(key => key !== conflictKey(item)))} /><span>Replace</span></label>
            : <em>{actionLabel[item.action]}</em>}
          <code title={item.path}>{item.path}</code>
          {item.reason && <small>{reasonLabel[item.reason]}</small>}
        </li>)}</ul>}
        {result.items.length > 200 && <p className="notes-links-empty">{result.items.length - 200} more not shown.</p>}
        {conflicts.length > 0 && <p className="notes-export-note"><AlertCircle />Conflicting files are left as they are. Tick a file to replace it with the vault copy on the next export.</p>}
      </section>}
    </div>
    <footer>
      <Button type="button" variant="ghost" disabled={busy} onClick={onClose}><X />Close</Button>
      <Button type="button" variant="outline" disabled={busy || !ready} onClick={() => void run(true)}>{busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}Preview</Button>
      <Button type="button" disabled={busy || !ready || !result?.dryRun} title={result?.dryRun ? undefined : 'Preview the export first'} onClick={() => void run(false)}>{busy ? <Loader2 className="animate-spin" /> : result && !result.dryRun ? <Check /> : <FolderOpen />}Export</Button>
    </footer>
  </NoteDialog>
}
