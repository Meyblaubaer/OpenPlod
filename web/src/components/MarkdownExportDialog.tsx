import { useEffect, useState } from 'react'
import { AlertCircle, Check, FolderOpen, Loader2, RefreshCw, X } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { NoteDialog } from '@/components/NoteDialogs'
import { notesApi, type ExportItem, type ExportResult, type ExportStatus } from '@/lib/notes-api'

const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'The export could not be completed.'
const actionLabel: Record<ExportItem['action'], string> = { created: 'New', updated: 'Updated', moved: 'Moved', unchanged: 'Unchanged', conflict: 'Conflict', orphaned: 'Kept' }
const reasonLabel: Record<NonNullable<ExportItem['reason']>, string> = {
  modified_externally: 'Edited outside OpenPlod',
  deleted_externally: 'Deleted outside OpenPlod',
  not_a_file: 'Path is not a regular file',
}

/**
 * Managed one-way export to the server-configured folder (roadmap KB-02).
 * A preview always comes first; conflicting files are only replaced when the
 * user ticks them, one by one.
 */
export function MarkdownExportDialog({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<ExportStatus | null>(null)
  const [result, setResult] = useState<ExportResult | null>(null)
  const [overwrite, setOverwrite] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    notesApi.exportStatus(controller.signal).then(setStatus).catch(failure => { if (!controller.signal.aborted) setError(errorMessage(failure)) })
    return () => controller.abort()
  }, [])
  const run = async (dryRun: boolean) => {
    setBusy(true); setError('')
    try {
      // A preview always shows every conflict; ticked files are only replaced by the real export.
      const next = await notesApi.exportMarkdown({ dryRun, overwrite: dryRun ? [] : overwrite })
      setResult(next)
      setOverwrite(ids => dryRun ? ids.filter(id => next.items.some(item => item.action === 'conflict' && item.documentId === id)) : [])
      if (!dryRun) setStatus(await notesApi.exportStatus())
    } catch (failure) { setError(errorMessage(failure)) } finally { setBusy(false) }
  }
  const ready = status?.configured && !status.error
  const conflicts = result?.items.filter(item => item.action === 'conflict') ?? []
  const counts = result ? (['created', 'updated', 'moved', 'unchanged', 'conflict', 'orphaned'] as const).filter(action => result.counts[action] > 0) : []

  return <NoteDialog title="Export to folder" description="One-way Markdown export with front matter" onClose={onClose} busy={busy}>
    <div className="notes-export">
      {!status && !error && <p className="notes-links-empty" role="status"><Loader2 className="animate-spin" />Checking export folder</p>}
      {status && !status.configured && <p className="notes-export-note">Set <code>OPENPLOD_EXPORT_DIR</code> to an existing folder, such as an Obsidian vault, and restart OpenPlod. Exports never delete or overwrite files you edited there.</p>}
      {status?.configured && <dl className="notes-export-status">
        <div><dt>Folder</dt><dd><code>{status.root}</code></dd></div>
        <div><dt>Last export</dt><dd>{status.lastExportedAt ? new Date(status.lastExportedAt).toLocaleString() : 'Never'}</dd></div>
        <div><dt>Tracked notes</dt><dd>{status.documentCount}</dd></div>
      </dl>}
      {status?.error && <p className="note-error" role="alert">{status.error}</p>}
      {error && <p className="note-error" role="alert">{error}</p>}
      {result && <section aria-label={result.dryRun ? 'Export preview' : 'Export result'}>
        <h3>{result.dryRun ? 'Preview — nothing written yet' : 'Export complete'}</h3>
        <p className="notes-export-counts">{counts.length ? counts.map(action => <span key={action} data-action={action}>{actionLabel[action]} {result.counts[action]}</span>) : <span>No active notes</span>}</p>
        {result.items.length > 0 && <ul className="notes-export-items">{result.items.slice(0, 200).map(item => <li key={`${item.documentId}:${item.path}`} data-action={item.action}>
          {item.action === 'conflict'
            ? <label><input type="checkbox" checked={overwrite.includes(item.documentId)} disabled={busy || item.reason === 'not_a_file'} onChange={event => setOverwrite(ids => event.target.checked ? [...ids, item.documentId] : ids.filter(id => id !== item.documentId))} /><span>Replace</span></label>
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
