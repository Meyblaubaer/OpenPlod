import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Check, FileText, Loader2, RotateCcw, Speech, X } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { api, type BatchEstimate, type BatchJob, type DocumentBatchEstimate, type Recording } from '@/lib/api'
import { describeEstimate } from '@/lib/transcription'
import { documentStyleLabel, DOCUMENT_STYLES, notesApi, type DocumentStyle, type NoteFolder } from '@/lib/notes-api'
import { t, tn } from '@/i18n'
import './batch-transcribe.css'

/**
 * Batch transcription and batch document generation (roadmap TS-10).
 *
 * Two-step by design: the first click reports what would run, where the
 * audio or transcript text goes and whether a paid provider is involved; only
 * the second starts work. Progress is per item, so one failure is visible as
 * one failure rather than a dead batch, and "Retry failed" re-submits exactly
 * the failed items — re-running a succeeded one against a paid provider is a
 * second charge, not a retry.
 */

const POLL_MS = 1500

type Mode = 'transcribe' | 'document'

export function BatchTranscribe({ recordings, onFinished }: {
  recordings: Recording[]
  onFinished: () => void
}) {
  const [mode, setMode] = useState<Mode>('transcribe')
  const [estimate, setEstimate] = useState<BatchEstimate | null>(null)
  const [documentEstimate, setDocumentEstimate] = useState<DocumentBatchEstimate | null>(null)
  const [job, setJob] = useState<BatchJob | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [costAccepted, setCostAccepted] = useState(false)
  const mounted = useRef(true)
  const finished = useRef(onFinished)
  useEffect(() => { finished.current = onFinished }, [onFinished])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  // Only recordings that have no transcript are transcription candidates; re-transcribing a
  // finished one is a separate, deliberate action on that recording.
  const candidates = useMemo(
    () => recordings.filter(row => !row.hasTranscript && !row.transcriptText?.trim() && row.retentionState === 'active'),
    [recordings])
  // Documents need transcript text to send.
  const transcribed = useMemo(
    () => recordings.filter(row => (row.hasTranscript || Boolean(row.transcriptText?.trim())) && row.retentionState === 'active'),
    [recordings])
  const titles = useMemo(() => new Map(recordings.map(row => [row.id, row.title])), [recordings])
  const activeMode: Mode = mode === 'document' ? (transcribed.length > 0 ? 'document' : 'transcribe') : (candidates.length > 0 ? 'transcribe' : 'document')

  const fail = (failure: unknown) => {
    if (mounted.current) setError(failure instanceof Error ? failure.message : t('The batch could not run.'))
  }

  // Poll while a batch is active; stop as soon as it settles.
  useEffect(() => {
    if (!job?.active) return
    const timer = window.setInterval(() => {
      void api.getBatch(job.id)
        .then(next => {
          if (!mounted.current) return
          setJob(next)
          if (!next.active) finished.current()
        })
        .catch(() => {})
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [job?.id, job?.active])

  const check = useCallback(async () => {
    setBusy(true); setError('')
    try { setEstimate(await api.estimateBatch(candidates.map(row => row.id))); setCostAccepted(false) }
    catch (failure) { fail(failure) }
    finally { if (mounted.current) setBusy(false) }
  }, [candidates])

  const start = async (retryOf?: string) => {
    setBusy(true); setError('')
    try {
      const ids = retryOf ? [] : candidates.map(row => row.id)
      setJob(await api.startBatch(ids, { ...(retryOf ? { retryOf } : {}), ...(costAccepted ? { confirmCost: true } : {}) }))
      setEstimate(null)
    } catch (failure) { fail(failure) }
    finally { if (mounted.current) setBusy(false) }
  }

  const retryDocuments = async (retryOf: string) => {
    setBusy(true); setError('')
    try { setJob(await api.startDocumentBatch([], { retryOf })) }
    catch (failure) { fail(failure) }
    finally { if (mounted.current) setBusy(false) }
  }

  if (candidates.length === 0 && transcribed.length === 0 && !job) return null

  const reset = () => { setEstimate(null); setDocumentEstimate(null); setError('') }

  return (
    <div className="batch-transcribe">
      {error && <p className="batch-error" role="alert"><AlertCircle />{error}</p>}

      {!job && !estimate && !documentEstimate && (
        <div className="batch-bar">
          <span>
            {activeMode === 'transcribe'
              ? tn(candidates.length, '{count} recording without a transcript', '{count} recordings without a transcript')
              : tn(transcribed.length, '{count} transcribed recording', '{count} transcribed recordings')}
          </span>
          {candidates.length > 0 && transcribed.length > 0 && (
            <span className="batch-modes" role="radiogroup" aria-label={t('Batch action')}>
              <button type="button" role="radio" aria-checked={activeMode === 'transcribe'} data-active={activeMode === 'transcribe'}
                onClick={() => setMode('transcribe')}>{t('Transcribe')}</button>
              <button type="button" role="radio" aria-checked={activeMode === 'document'} data-active={activeMode === 'document'}
                onClick={() => setMode('document')}>{t('Create documents')}</button>
            </span>
          )}
          {activeMode === 'transcribe'
            ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void check()}>
                {busy ? <Loader2 className="batch-spin" /> : <Speech />}{t('Transcribe all')}
              </Button>
            )
            : (
              <Button size="sm" variant="outline" disabled={busy}
                onClick={() => void (async () => {
                  setBusy(true); setError('')
                  try { setDocumentEstimate(await api.estimateDocumentBatch(transcribed.map(row => row.id))) }
                  catch (failure) { fail(failure) }
                  finally { if (mounted.current) setBusy(false) }
                })()}>
                {busy ? <Loader2 className="batch-spin" /> : <FileText />}{t('Create documents…')}
              </Button>
            )}
        </div>
      )}

      {!job && estimate && (
        <div className="batch-bar">
          <span>{tn(candidates.length, '{count} recording without a transcript', '{count} recordings without a transcript')}</span>
          <span className="batch-confirm">
            {estimate.usesCloudProvider
              ? tn(estimate.wouldRun, 'This sends {count} recording to {provider}, which may be billed.', 'This sends {count} recordings to {provider}, which may be billed.', { provider: estimate.provider ?? '' })
              : tn(estimate.wouldRun, 'This runs {count} recording locally with {provider}.', 'This runs {count} recordings locally with {provider}.', { provider: estimate.provider ?? t('the configured engine') })}
            {estimate.estimatedCost && ` ${describeEstimate(estimate.estimatedCost)}`}
          </span>
          {estimate.estimatedCost?.confirmationRequired && (
            <label className="batch-confirm">
              <input type="checkbox" checked={costAccepted} disabled={busy} onChange={event => setCostAccepted(event.target.checked)} />
              {' '}{estimate.estimatedCost.reasons.join(' ')} {t('I accept this estimated cost.')}
            </label>
          )}
          <Button size="sm" disabled={busy || Boolean(estimate.estimatedCost?.confirmationRequired && !costAccepted)} onClick={() => void start()}>
            {busy ? <Loader2 className="batch-spin" /> : <Check />}{t('Start')}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={reset}><X />{t('Cancel')}</Button>
        </div>
      )}

      {!job && documentEstimate && (
        <DocumentBatchSetup
          recordings={transcribed}
          estimate={documentEstimate}
          busy={busy}
          onCancel={reset}
          onStart={async (ids, options) => {
            setBusy(true); setError('')
            try {
              setJob(await api.startDocumentBatch(ids, { ...options, expectedProvider: documentEstimate.provider }))
              setDocumentEstimate(null)
            } catch (failure) { fail(failure) }
            finally { if (mounted.current) setBusy(false) }
          }}
        />
      )}

      {job && (
        <div className="batch-progress">
          <div className="batch-bar">
            <span>
              {job.active ? (job.kind === 'document' ? t('Creating documents') : t('Transcribing')) : t('Batch finished')}: {tn(job.summary.complete, '{count} done', '{count} done')}
              {job.summary.failed > 0 && `, ${tn(job.summary.failed, '{count} failed', '{count} failed')}`}
              {job.summary.cancelled > 0 && `, ${tn(job.summary.cancelled, '{count} cancelled', '{count} cancelled')}`}
              {' '}{t('of {total}', { total: job.summary.total })}
            </span>
            {job.active
              ? <Button size="sm" variant="ghost" onClick={() => void api.cancelBatch(job.id).catch(() => {})}><X />{t('Cancel')}</Button>
              : (
                <>
                  {job.summary.failed > 0 && (
                    <Button size="sm" variant="outline" disabled={busy}
                      onClick={() => void (job.kind === 'document' ? retryDocuments(job.id) : start(job.id))}>
                      <RotateCcw />{t('Retry {count} failed', { count: job.summary.failed })}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => { setJob(null); reset() }}><X />{t('Dismiss')}</Button>
                </>
              )}
          </div>
          {job.summary.failed > 0 && (
            <ul className="batch-failures">
              {job.items.filter(item => item.state === 'failed').map(item => (
                <li key={item.recordingId}>
                  {titles.get(item.recordingId) ?? <code>{item.recordingId.slice(0, 8)}</code>}: {item.error ?? t('Failed.')}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The review step for a document batch: which recordings, which template,
 * which folder, and — stated plainly — which provider receives the text.
 */
function DocumentBatchSetup({ recordings, estimate, busy, onCancel, onStart }: {
  recordings: Recording[]
  estimate: DocumentBatchEstimate
  busy: boolean
  onCancel: () => void
  onStart: (ids: string[], options: { style: DocumentStyle; instructions: string; folderId: string | null }) => Promise<void>
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(recordings.map(row => row.id)))
  const [style, setStyle] = useState<DocumentStyle>('notes')
  const [instructions, setInstructions] = useState('')
  const [folders, setFolders] = useState<NoteFolder[]>([])
  const [folderId, setFolderId] = useState('')

  useEffect(() => {
    let active = true
    notesApi.folders().then(rows => { if (active) setFolders(rows) }).catch(() => {})
    return () => { active = false }
  }, [])

  const count = selected.size
  const folderName = folderId ? folders.find(folder => folder.id === folderId)?.name ?? t('the chosen folder') : t('Notes (no folder)')
  const toggle = (id: string) => setSelected(current => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  return (
    <div className="batch-documents" aria-label={t('Create documents from transcripts')}>
      <div className="batch-documents-fields">
        <label><span>{t('Template')}</span>
          <select value={style} onChange={event => setStyle(event.target.value as DocumentStyle)} disabled={busy}>
            {DOCUMENT_STYLES.map(value => <option key={value} value={value}>{documentStyleLabel(value)}</option>)}
          </select>
        </label>
        <label><span>{t('Save to')}</span>
          <select value={folderId} onChange={event => setFolderId(event.target.value)} disabled={busy}>
            <option value="">{t('No folder')}</option>
            {folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
          </select>
        </label>
        <label className="batch-documents-wide"><span>{t('Instructions (optional)')}</span>
          <textarea value={instructions} onChange={event => setInstructions(event.target.value)} maxLength={2000} rows={2} disabled={busy}
            placeholder={t('Writing preferences applied to every document')} />
        </label>
      </div>
      <fieldset className="batch-documents-list" disabled={busy}>
        <legend>{t('{count} of {total} selected', { count, total: recordings.length })}</legend>
        {recordings.map(row => (
          <label key={row.id}><input type="checkbox" checked={selected.has(row.id)} onChange={() => toggle(row.id)} />{row.title}</label>
        ))}
      </fieldset>
      {estimate.providerError
        ? <p className="batch-error" role="alert"><AlertCircle />{estimate.providerError}</p>
        : (
          <p className="batch-confirm">
            {estimate.usesCloudProvider
              ? tn(count, 'This sends the transcript text of {count} recording to {provider} ({model}), which may be billed per token. Cost is not estimated here.', 'This sends the transcript text of {count} recordings to {provider} ({model}), which may be billed per token. Cost is not estimated here.', { provider: estimate.provider, model: estimate.model })
              : tn(count, 'This sends the transcript text of {count} recording to your local Ollama model {model}.', 'This sends the transcript text of {count} recordings to your local Ollama model {model}.', { model: estimate.model })}
            {` ${t('Each creates a new note in {folder}; existing notes are not changed.', { folder: folderName })}`}
          </p>
        )}
      <div className="batch-bar batch-bar--plain">
        <Button size="sm" disabled={busy || count === 0 || Boolean(estimate.providerError)}
          onClick={() => void onStart(recordings.filter(row => selected.has(row.id)).map(row => row.id), { style, instructions: instructions.trim(), folderId: folderId || null })}>
          {busy ? <Loader2 className="batch-spin" /> : <Check />}{tn(count, 'Create {count} document', 'Create {count} documents')}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}><X />{t('Cancel')}</Button>
      </div>
    </div>
  )
}
