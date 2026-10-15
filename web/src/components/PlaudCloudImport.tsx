import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Check, CheckCircle2, CloudUpload, Download, FileAudio, FileText, Link2, Loader2, RefreshCw, Sparkles, Trash2, X } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { api, type PlaudCloudImportJob, type PlaudCloudStatus } from '@/lib/api'
import { formatDate, t, tn } from '@/i18n'
import './plaud-cloud-import.css'

const bytes = (value: number) => value >= 1024 * 1024 ? t('{value} MB', { value: (value / 1024 / 1024).toFixed(1) }) : value >= 1024 ? t('{value} KB', { value: Math.round(value / 1024) }) : t('{value} B', { value })
const date = (value: string) => formatDate(value, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })

/**
 * Imports audio (and Plaud's own transcripts + summaries) straight from the
 * Plaud cloud account. This needs no Bluetooth and no recorder identity, so it
 * works on every platform, including a fresh Linux install.
 */
export function PlaudCloudImport() {
  const [status, setStatus] = useState<PlaudCloudStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [includeTrash, setIncludeTrash] = useState(false)
  const [job, setJob] = useState<PlaudCloudImportJob | null>(null)
  const mounted = useRef(true)
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async () => {
    try {
      const next = await api.getPlaudCloud()
      if (mounted.current) { setStatus(next); setError('') }
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : t('Could not reach the Plaud cloud.'))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void load()
    return () => {
      mounted.current = false
      if (pollTimer.current) clearTimeout(pollTimer.current)
    }
  }, [load])

  const stopPolling = () => {
    if (pollTimer.current) { clearTimeout(pollTimer.current); pollTimer.current = null }
  }

  const poll = useCallback((id: string) => {
    stopPolling()
    pollTimer.current = setTimeout(async () => {
      if (!mounted.current) return
      try {
        const next = await api.getPlaudCloudImport(id)
        if (!mounted.current) return
        setJob(next)
        if (next.state === 'running') poll(id)
        else {
          setJob(next)
          window.dispatchEvent(new CustomEvent('plaud:sync-complete'))
          void load()
        }
      } catch (failure) {
        if (mounted.current) {
          setError(failure instanceof Error ? failure.message : t('Lost the import progress. Check the library before retrying.'))
          setJob(null)
        }
      }
    }, 1000)
  }, [load])

  const link = async () => {
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await api.linkPlaudCloud(token.trim())
      setToken('')
      setNotice(tn(result.count, 'Linked. Found {count} recording ({size}) in the {region} cloud.', 'Linked. Found {count} recordings ({size}) in the {region} cloud.', { size: bytes(result.bytes), region: result.region || 'Plaud' }))
      await load()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('Could not link that token.'))
    } finally { setBusy(false) }
  }

  const unlink = async () => {
    setBusy(true); setError(''); setNotice('')
    try {
      await api.unlinkPlaudCloud()
      setSelected([]); setJob(null)
      setNotice(t('Plaud cloud unlinked. Recordings already imported stay in the vault.'))
      await load()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('Could not unlink the Plaud cloud.'))
    } finally { setBusy(false) }
  }

  const startImport = async (ids?: string[]) => {
    if (job?.state === 'running') return
    setBusy(true); setError(''); setNotice('')
    try {
      const started = await api.importPlaudCloud({ ...(ids ? { ids } : {}), includeTrash })
      setJob({ id: started.id, state: 'running', total: 0, completed: 0, totalBytes: 0, receivedBytes: 0, current: null, imported: [], failures: [], transcripts: 0, summaries: 0, transcriptFailures: [] })
      poll(started.id)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('Could not start the import.'))
    } finally { setBusy(false) }
  }

  const cancel = async () => {
    try { await api.cancelPlaudCloudImport() } catch { /* the poll will observe the cancellation */ }
  }

  if (loading) {
    return <section className="device-section plaud-cloud" aria-label={t('Plaud cloud import')}><div className="device-section-heading"><CloudUpload /><h2>{t('Import from Plaud cloud')}</h2></div><p className="device-muted"><Loader2 className="animate-spin inline size-4 mr-2" />{t('Checking the Plaud cloud…')}</p></section>
  }

  const linked = status?.linked ?? false
  const recordings = status?.recordings ?? []
  const available = recordings.filter(recording => !recording.imported && (!recording.isTrash || includeTrash))
  const running = job?.state === 'running'

  const toggle = (id: string) => setSelected(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id])
  const allSelected = available.length > 0 && available.every(recording => selected.includes(recording.id))

  const finished = job && job.state !== 'running'

  return <section className="device-section plaud-cloud" aria-label={t('Import from Plaud cloud')}>
    <div className="device-section-heading">
      <CloudUpload />
      <h2>{t('Import from Plaud cloud')}</h2>
      {linked && <span className="plaud-cloud-badge" data-linked><CheckCircle2 />{t('Linked')}</span>}
    </div>

    {!linked ? <>
      <p className="device-muted">{t('Get every recording off your Plaud account over the internet — no Bluetooth, no recorder authorization. Audio, transcripts and AI summaries come along.')}</p>
      <label className="plaud-cloud-field"><span>{t('Plaud sign-in token')}</span>
        <input type="password" autoComplete="off" spellCheck={false} value={token} placeholder={t('Paste workspaceToken (or tokenstr) from web.plaud.ai')} aria-label={t('Plaud sign-in token')} onChange={event => setToken(event.target.value)} />
      </label>
      <div className="plaud-cloud-actions">
        <Button disabled={busy || !token.trim()} onClick={() => void link()}>{busy ? <Loader2 className="animate-spin" /> : <Link2 />}{t('Link account & list recordings')}</Button>
      </div>
      <details className="plaud-cloud-help"><summary>{t('Where do I find this token?')}</summary>
        <p>{rich(t('Sign in at {site}, open your browser\'s developer tools, go to {path}, and copy the value of {key} (inside the {entry} entry). Some versions call the key {alternative} instead.'), {
          site: <a href="https://web.plaud.ai" target="_blank" rel="noreferrer">web.plaud.ai</a>,
          path: <em>Application → Local Storage → https://web.plaud.ai</em>,
          key: <code>workspaceToken</code>,
          entry: <code>…:workspaceList</code>,
          alternative: <code>tokenstr</code>,
        })}</p>
      </details>
    </> : <>
      {status?.account && <div className="plaud-cloud-account">
        <span>{status.account.region ?? 'Plaud'}</span>
        {status.account.expiresAt && <span>{t('Token valid until {date}', { date: formatDate(status.account.expiresAt * 1000) })}</span>}
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void unlink()}>{busy ? <Loader2 className="animate-spin" /> : <Trash2 />}{t('Unlink')}</Button>
      </div>}
      {status && <p className="device-muted">{status.totals.trashCount
        ? tn(status.totals.count, '{count} recording / {size} — {imported} already in the vault, {trash} in Trash.', '{count} recordings / {size} — {imported} already in the vault, {trash} in Trash.', { size: bytes(status.totals.bytes), imported: status.totals.importedCount, trash: status.totals.trashCount })
        : tn(status.totals.count, '{count} recording / {size} — {imported} already in the vault.', '{count} recordings / {size} — {imported} already in the vault.', { size: bytes(status.totals.bytes), imported: status.totals.importedCount })}</p>}

      {running && job && <div className="plaud-cloud-progress" role="status">
        <div className="plaud-cloud-progress-head"><span><Loader2 className="animate-spin" />{t('Importing {completed} / {total}', { completed: job.completed, total: job.total })}{job.current ? ` — ${job.current}` : ''}</span><small>{job.totalBytes ? `${Math.round(job.receivedBytes / job.totalBytes * 100)}%` : ''}</small></div>
        {job.totalBytes > 0 && <div className="plaud-cloud-bar"><i style={{ width: `${Math.min(100, Math.round(job.receivedBytes / job.totalBytes * 100))}%` }} /></div>}
        <Button variant="ghost" size="sm" onClick={() => void cancel()}><X />{t('Cancel')}</Button>
      </div>}

      {finished && job && <div className={`plaud-cloud-result ${job.state === 'failed' ? 'is-error' : ''}`} role="status">
        <p>{job.state === 'complete' ? [
          tn(job.imported.length, 'Saved {count} recording.', 'Saved {count} recordings.'),
          job.transcripts ? tn(job.transcripts, '{count} transcript included.', '{count} transcripts included.') : '',
          job.summaries ? tn(job.summaries, '{count} summary included.', '{count} summaries included.') : '',
        ].filter(Boolean).join(' ') : job.state === 'cancelled' ? t('Import cancelled. Recordings already saved stay in the vault.') : job.error ? t('Import failed: {error}', { error: job.error }) : t('Import failed.')}</p>
        {job.failures.length > 0 && <ul>{job.failures.map(failure => <li key={failure.sourceId}><strong>{failure.title}</strong>: {failure.error}</li>)}</ul>}
        {job.transcriptFailures.length > 0 && <details><summary>{tn(job.transcriptFailures.length, '{count} transcript unavailable', '{count} transcripts unavailable')}</summary><ul>{job.transcriptFailures.map(failure => <li key={failure.sourceId}><strong>{failure.title}</strong>: {failure.error}</li>)}</ul></details>}
      </div>}

      <div className="plaud-cloud-toolbar">
        <label className="plaud-cloud-include"><input type="checkbox" checked={includeTrash} onChange={event => { setIncludeTrash(event.target.checked); setSelected([]) }} />{t('Include Trash')}</label>
        <label className="plaud-cloud-select"><input type="checkbox" aria-label={t('Select all importable recordings')} checked={allSelected} disabled={busy || !available.length} onChange={event => setSelected(event.target.checked ? available.map(recording => recording.id) : [])} /><span>{t('Select all')}</span></label>
        <span className="plaud-cloud-toolbar-spacer" />
        <Button variant="outline" size="sm" disabled={busy || running || !selected.length} onClick={() => void startImport(selected)}><Download />{selected.length ? t('Import selected ({count})', { count: selected.length }) : t('Import selected')}</Button>
        <Button size="sm" disabled={busy || running || !available.length} onClick={() => void startImport()}><CloudUpload />{available.length ? t('Import all ({count})', { count: available.length }) : t('Import all')}</Button>
      </div>

      {recordings.length === 0 ? <div className="plaud-cloud-empty"><FileAudio /><p>{t('No recordings found on this account.')}</p></div> : <div className="plaud-cloud-list">
        {recordings.map(recording => {
          const selectable = !recording.imported && (!recording.isTrash || includeTrash)
          return <div className="plaud-cloud-row" key={recording.id} data-imported={recording.imported}>
            <input type="checkbox" aria-label={t('Select {name}', { name: recording.filename })} disabled={busy || !selectable} checked={selected.includes(recording.id)} onChange={() => toggle(recording.id)} />
            <FileAudio />
            <div className="plaud-cloud-name"><strong>{recording.filename}</strong><small>{date(recording.recordedAt)} · {recording.serial ? t('SN {serial}', { serial: recording.serial }) : 'Plaud'}</small></div>
            <span className="plaud-cloud-size">{bytes(recording.sizeBytes)}</span>
            <span className="plaud-cloud-tags">
              {recording.hasTranscript && <span title={t('Transcript')}><FileText /></span>}
              {recording.hasSummary && <span title={t('Summary')}><Sparkles /></span>}
              {recording.isTrash && <span className="plaud-cloud-trash" title={t('In Trash')}><Trash2 /></span>}
            </span>
            <span className="plaud-cloud-state" data-imported={recording.imported}>{recording.imported ? t('Imported') : t('New')}</span>
            {recording.imported && recording.recordingId ? <IconButton asChild label={t('Open recording')}><Link to={`/recording/${recording.recordingId}`}><Check /></Link></IconButton> : null}
          </div>
        })}
      </div>}
      {!running && recordings.length > 0 && <Button variant="ghost" size="sm" onClick={() => void load()}><RefreshCw />{t('Refresh list')}</Button>}
    </>}

    {notice && <p role="status" className="plaud-cloud-notice"><CheckCircle2 />{notice}</p>}
    {error && <p role="alert" className="device-error">{error}</p>}
  </section>
}

/** Splits a translated sentence on its {placeholders} and drops the given elements in their place. */
function rich(text: string, nodes: Record<string, ReactNode>): ReactNode {
  return text.split(/(\{\w+\})/).map((part, index) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1]
    return <Fragment key={index}>{name && name in nodes ? nodes[name] : part}</Fragment>
  })
}
