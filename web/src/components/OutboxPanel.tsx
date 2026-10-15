import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Inbox, Loader2, RefreshCw, Trash2 } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { deliverCapture } from '@/lib/outbox-delivery'
import {
  captureStatus, cleanupStoredCaptures, isVerifiedStored, KEEP_DAY_CHOICES, listCaptures, readKeepDays,
  removeStoredCapture, summarizeOutbox, writeKeepDays, type PendingCapture,
} from '@/lib/recording-outbox'
import { formatDate, t, tn } from '@/i18n'
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
    catch { setCaptures([]); setMessage(t('The local outbox could not be read.')) }
  }, [])

  useEffect(() => {
    void cleanupStoredCaptures(keepDays).catch(() => 0).then(() => reload())
  }, [keepDays, reload, refreshKey])

  const retry = async (capture: PendingCapture) => {
    setMessage('')
    setActive(current => ({ ...current, [capture.id]: 0 }))
    try {
      await deliverCapture(capture, fromMobile, (sent, total) => setActive(current => ({ ...current, [capture.id]: total ? sent / total : 0 })))
      setMessage(t('"{title}" is stored in the desktop vault.', { title: capture.title }))
      await cleanupStoredCaptures(keepDays).catch(() => 0)
    } catch (error) {
      setMessage(t('Local recording retained. {error}', { error: error instanceof Error ? error.message : t('Retry when the desktop is reachable.') }))
    } finally {
      setActive(current => { const next = { ...current }; delete next[capture.id]; return next })
      await reload()
    }
  }

  const remove = async (capture: PendingCapture) => {
    setConfirming(null)
    if (await removeStoredCapture(capture.id)) setMessage(t('Removed the local copy of "{title}".', { title: capture.title }))
    else setMessage(t('This recording is not verified as stored on the desktop, so it was kept.'))
    await reload()
  }

  if (!captures || captures.length === 0) return null
  const summary = summarizeOutbox(captures)
  return <section className="outbox" aria-labelledby="outbox-title">
    <header>
      <div><Inbox /><div><h2 id="outbox-title">{t('Outbox')}</h2><p>{t('{waiting} waiting · {stored} stored · {size} on this device', { waiting: summary.waiting + summary.failed, stored: summary.stored, size: formatBytes(summary.bytes) })}</p></div></div>
      <label className="outbox-keep">{t('Keep stored copies')}
        <select value={keepDays} onChange={event => { const days = Number(event.target.value); writeKeepDays(days); setKeepDays(days) }}>
          {KEEP_DAY_CHOICES.map(days => <option key={days} value={days}>{days === 0 ? t('Remove when stored') : tn(days, '{count} day', '{count} days')}</option>)}
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
            <span>{formatDate(capture.recordedAt)} · {formatBytes(capture.blob?.size ?? 0)}</span>
            <span className="outbox-status" role="status">{sending ? t('Sending {percent}%', { percent: Math.round(progress * 100) })
              : status === 'stored' ? capture.acknowledgement ? t('Stored on desktop {date}', { date: formatDate(capture.acknowledgement.storedAt, { dateStyle: 'short' }) }) : t('Stored on desktop')
              : status === 'failed' ? t('Not delivered') : t('Waiting for desktop')}
              {(capture.retryCount ?? 0) > 0 && !verified ? ` · ${tn(capture.retryCount ?? 0, '{count} failed attempt', '{count} failed attempts')}` : ''}</span>
            {capture.lastError && !verified && !sending && <span className="outbox-error">{capture.lastError}</span>}
          </div>
          <div className="outbox-actions">
            {verified ? <CheckCircle2 aria-label={t('Verified on desktop')} /> : <IconButton label={t('Retry upload')} disabled={sending} onClick={() => void retry(capture)}>{sending ? <Loader2 className="animate-spin" /> : <RefreshCw />}</IconButton>}
            {verified && (confirming === capture.id
              ? <span className="outbox-confirm"><Button size="sm" variant="destructive" onClick={() => void remove(capture)}>{t('Remove copy')}</Button><Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>{t('Keep')}</Button></span>
              : <IconButton label={t('Remove local copy')} onClick={() => setConfirming(capture.id)}><Trash2 /></IconButton>)}
          </div>
        </li>
      })}
    </ul>
    {message && <p className="outbox-message" role="status">{message}</p>}
  </section>
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return t('{value} B', { value: bytes })
  if (bytes < 1024 * 1024) return t('{value} KB', { value: (bytes / 1024).toFixed(0) })
  if (bytes < 1024 * 1024 * 1024) return t('{value} MB', { value: (bytes / 1024 / 1024).toFixed(1) })
  return t('{value} GB', { value: (bytes / 1024 / 1024 / 1024).toFixed(2) })
}
