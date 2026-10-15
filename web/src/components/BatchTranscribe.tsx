import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Check, FileText, Loader2, RotateCcw, Speech, X } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { api, type BatchEstimate, type BatchJob, type DocumentBatchEstimate, type Recording } from '@/lib/api'
import { DOCUMENT_STYLE_LABEL, DOCUMENT_STYLES, notesApi, type DocumentStyle, type NoteFolder } from '@/lib/notes-api'
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
    if (mounted.current) setError(failure instanceof Error ? failure.message : 'The batch could not run.')
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
    try { setEstimate(await api.estimateBatch(candidates.map(row => row.id))) }
    catch (failure) { fail(failure) }
    finally { if (mounted.current) setBusy(false) }
  }, [candidates])

  const start = async (retryOf?: string) => {
    setBusy(true); setError('')
    try {
      const ids = retryOf ? [] : candidates.map(row => row.id)
      setJob(await api.startBatch(ids, retryOf ? { retryOf } : {}))
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
              ? `${candidates.length} recording${candidates.length === 1 ? '' : 's'} without a transcript`
              : `${transcribed.length} transcribed recording${transcribed.length === 1 ? '' : 's'}`}
          </span>
          {candidates.length > 0 && transcribed.length > 0 && (
            <span className="batch-modes" role="radiogroup" aria-label="Batch action">
              <button type="button" role="radio" aria-checked={activeMode === 'transcribe'} data-active={activeMode === 'transcribe'}
                onClick={() => setMode('transcribe')}>Transcribe</button>
              <button type="button" role="radio" aria-checked={activeMode === 'document'} data-active={activeMode === 'document'}
                onClick={() => setMode('document')}>Create documents</button>
            </span>
          )}
          {activeMode === 'transcribe'
            ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void check()}>
                {busy ? <Loader2 className="batch-spin" /> : <Speech />}Transcribe all
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
                {busy ? <Loader2 className="batch-spin" /> : <FileText />}Create documents…
              </Button>
            )}
        </div>
      )}

      {!job && estimate && (
        <div className="batch-bar">
          <span>{candidates.length} recording{candidates.length === 1 ? '' : 's'} without a transcript</span>
          <span className="batch-confirm">
            {estimate.usesCloudProvider
              ? `This sends ${estimate.wouldRun} recording${estimate.wouldRun === 1 ? '' : 's'} to ${estimate.provider}, which may be billed. Cost is not estimated here because ${estimate.provider} prices per second of audio.`
              : `This runs ${estimate.wouldRun} recording${estimate.wouldRun === 1 ? '' : 's'} locally with ${estimate.provider ?? 'the configured engine'}.`}
          </span>
          <Button size="sm" disabled={busy} onClick={() => void start()}>
            {busy ? <Loader2 className="batch-spin" /> : <Check />}Start
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={reset}><X />Cancel</Button>
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
              {job.active ? (job.kind === 'document' ? 'Creating documents' : 'Transcribing') : 'Batch finished'}: {job.summary.complete} done
              {job.summary.failed > 0 && `, ${job.summary.failed} failed`}
              {job.summary.cancelled > 0 && `, ${job.summary.cancelled} cancelled`}
              {' '}of {job.summary.total}
            </span>
            {job.active
              ? <Button size="sm" variant="ghost" onClick={() => void api.cancelBatch(job.id).catch(() => {})}><X />Cancel</Button>
              : (
                <>
                  {job.summary.failed > 0 && (
                    <Button size="sm" variant="outline" disabled={busy}
                      onClick={() => void (job.kind === 'document' ? retryDocuments(job.id) : start(job.id))}>
                      <RotateCcw />Retry {job.summary.failed} failed
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => { setJob(null); reset() }}><X />Dismiss</Button>
                </>
              )}
          </div>
          {job.summary.failed > 0 && (
            <ul className="batch-failures">
              {job.items.filter(item => item.state === 'failed').map(item => (
                <li key={item.recordingId}>
                  {titles.get(item.recordingId) ?? <code>{item.recordingId.slice(0, 8)}</code>}: {item.error ?? 'Failed.'}
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
  const folderName = folderId ? folders.find(folder => folder.id === folderId)?.name ?? 'the chosen folder' : 'Notes (no folder)'
  const toggle = (id: string) => setSelected(current => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  return (
    <div className="batch-documents" aria-label="Create documents from transcripts">
      <div className="batch-documents-fields">
        <label><span>Template</span>
          <select value={style} onChange={event => setStyle(event.target.value as DocumentStyle)} disabled={busy}>
            {DOCUMENT_STYLES.map(value => <option key={value} value={value}>{DOCUMENT_STYLE_LABEL[value]}</option>)}
          </select>
        </label>
        <label><span>Save to</span>
          <select value={folderId} onChange={event => setFolderId(event.target.value)} disabled={busy}>
            <option value="">No folder</option>
            {folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
          </select>
        </label>
        <label className="batch-documents-wide"><span>Instructions (optional)</span>
          <textarea value={instructions} onChange={event => setInstructions(event.target.value)} maxLength={2000} rows={2} disabled={busy}
            placeholder="Writing preferences applied to every document" />
        </label>
      </div>
      <fieldset className="batch-documents-list" disabled={busy}>
        <legend>{count} of {recordings.length} selected</legend>
        {recordings.map(row => (
          <label key={row.id}><input type="checkbox" checked={selected.has(row.id)} onChange={() => toggle(row.id)} />{row.title}</label>
        ))}
      </fieldset>
      {estimate.providerError
        ? <p className="batch-error" role="alert"><AlertCircle />{estimate.providerError}</p>
        : (
          <p className="batch-confirm">
            {estimate.usesCloudProvider
              ? `This sends the transcript text of ${count} recording${count === 1 ? '' : 's'} to ${estimate.provider} (${estimate.model}), which may be billed per token. Cost is not estimated here.`
              : `This sends the transcript text of ${count} recording${count === 1 ? '' : 's'} to your local Ollama model ${estimate.model}.`}
            {` Each creates a new note in ${folderName}; existing notes are not changed.`}
          </p>
        )}
      <div className="batch-bar batch-bar--plain">
        <Button size="sm" disabled={busy || count === 0 || Boolean(estimate.providerError)}
          onClick={() => void onStart(recordings.filter(row => selected.has(row.id)).map(row => row.id), { style, instructions: instructions.trim(), folderId: folderId || null })}>
          {busy ? <Loader2 className="batch-spin" /> : <Check />}Create {count} document{count === 1 ? '' : 's'}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}><X />Cancel</Button>
      </div>
    </div>
  )
}
