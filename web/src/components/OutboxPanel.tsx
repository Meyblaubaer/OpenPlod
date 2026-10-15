import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Inbox, Loader2, RefreshCw, Trash2 } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { deliverCapture } from '@/lib/outbox-delivery'
import {
  captureStatus, cleanupStoredCaptures, isVerifiedStored, KEEP_DAY_CHOICES, listCaptures, readKeepDays,
  removeStoredCapture, summarizeOutbox, writeKeepDays, type PendingCapture,
} from '@/lib/recording-outbox'
import './outbox.css'

/**
 * Offline outbox (MOB-03): every capture still on this device, with its delivery state.
 * Retry is offered for anything not yet stored; removal only for copies the desktop verifiably
 * stored. Unsent recordings are never removed from here.
 */
export function OutboxPanel({ fromMobile, refreshKey = 0 }: { fromMobile: boolean; refreshKey?: number }) {
  const [captures, setCaptures] = useState<PendingCapture[] | null>(null)
  const [keepDays, setKeepDays] = useState(readKeepDays)
  const [active, setActive] = useState<Record<string, number>>({})
  const [message, setMessage] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try { setCaptures(await listCaptures()) }
    catch { setCaptures([]); setMessage('The local outbox could not be read.') }
  }, [])

  useEffect(() => {
    void cleanupStoredCaptures(keepDays).catch(() => 0).then(() => reload())
  }, [keepDays, reload, refreshKey])

  const retry = async (capture: PendingCapture) => {
    setMessage('')
    setActive(current => ({ ...current, [capture.id]: 0 }))
    try {
      await deliverCapture(capture, fromMobile, (sent, total) => setActive(current => ({ ...current, [capture.id]: total ? sent / total : 0 })))
      setMessage(`"${capture.title}" is stored in the desktop vault.`)
      await cleanupStoredCaptures(keepDays).catch(() => 0)
    } catch (error) {
      setMessage(`Local recording retained. ${error instanceof Error ? error.message : 'Retry when the desktop is reachable.'}`)
    } finally {
      setActive(current => { const next = { ...current }; delete next[capture.id]; return next })
      await reload()
    }
  }

  const remove = async (capture: PendingCapture) => {
    setConfirming(null)
    if (await removeStoredCapture(capture.id)) setMessage(`Removed the local copy of "${capture.title}".`)
    else setMessage('This recording is not verified as stored on the desktop, so it was kept.')
    await reload()
  }

  if (!captures || captures.length === 0) return null
  const summary = summarizeOutbox(captures)
  return <section className="outbox" aria-labelledby="outbox-title">
    <header>
      <div><Inbox /><div><h2 id="outbox-title">Outbox</h2><p>{summary.waiting + summary.failed} waiting · {summary.stored} stored · {formatBytes(summary.bytes)} on this device</p></div></div>
      <label className="outbox-keep">Keep stored copies
        <select value={keepDays} onChange={event => { const days = Number(event.target.value); writeKeepDays(days); setKeepDays(days) }}>
          {KEEP_DAY_CHOICES.map(days => <option key={days} value={days}>{days === 0 ? 'Remove when stored' : `${days} day${days === 1 ? '' : 's'}`}</option>)}
        </select>
      </label>
    </header>
    <ul>
      {captures.map(capture => {
        const progress = active[capture.id]
        const sending = progress !== undefined
        const status = sending ? 'uploading' : captureStatus(capture) === 'uploading' ? 'pending' : captureStatus(capture)
        const verified = isVerifiedStored(capture)
        return <li key={capture.id} className={`outbox-item ${status}`}>
          <div className="outbox-main">
            <strong>{capture.title}</strong>
            <span>{new Date(capture.recordedAt).toLocaleString()} · {formatBytes(capture.blob?.size ?? 0)}</span>
            <span className="outbox-status" role="status">{sending ? `Sending ${Math.round(progress * 100)}%`
              : status === 'stored' ? `Stored on desktop ${capture.acknowledgement ? new Date(capture.acknowledgement.storedAt).toLocaleDateString() : ''}`
              : status === 'failed' ? 'Not delivered' : 'Waiting for desktop'}
              {(capture.retryCount ?? 0) > 0 && !verified ? ` · ${capture.retryCount} failed attempt${capture.retryCount === 1 ? '' : 's'}` : ''}</span>
            {capture.lastError && !verified && !sending && <span className="outbox-error">{capture.lastError}</span>}
          </div>
          <div className="outbox-actions">
            {verified ? <CheckCircle2 aria-label="Verified on desktop" /> : <IconButton label="Retry upload" disabled={sending} onClick={() => void retry(capture)}>{sending ? <Loader2 className="animate-spin" /> : <RefreshCw />}</IconButton>}
            {verified && (confirming === capture.id
              ? <span className="outbox-confirm"><Button size="sm" variant="destructive" onClick={() => void remove(capture)}>Remove copy</Button><Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>Keep</Button></span>
              : <IconButton label="Remove local copy" onClick={() => setConfirming(capture.id)}><Trash2 /></IconButton>)}
          </div>
        </li>
      })}
    </ul>
    {message && <p className="outbox-message" role="status">{message}</p>}
  </section>
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}
