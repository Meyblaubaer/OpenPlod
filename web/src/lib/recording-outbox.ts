const DATABASE_NAME = 'openplod-mobile'
const STORE_NAME = 'recording-outbox'
const DATABASE_VERSION = 1
const KEEP_DAYS_KEY = 'openplod.outbox.keepDays'
export const DEFAULT_KEEP_DAYS = 7
export const KEEP_DAY_CHOICES = [0, 1, 3, 7, 30] as const

/**
 * The offline outbox (MOB-03). A capture stays here until the desktop durably acknowledges it,
 * and a local copy is removed only after that acknowledgement was verified against the local
 * fingerprint. Fields added after the first release are optional so older rows still load.
 */
export type CaptureStatus = 'pending' | 'uploading' | 'failed' | 'stored'

export interface CaptureAcknowledgement {
  recordingId: string
  fingerprint: string
  storedAt: string
}

export interface PendingCapture {
  id: string
  blob: Blob
  filename: string
  title: string
  context: string
  recordedAt: string
  durationMs: number
  sourceProvider?: 'opennotes' | 'plaud' | 'upload'
  sourceTransport?: 'mobile' | 'upload'
  sourceRecordingId?: string
  nativeShareId?: string
  status?: CaptureStatus
  retryCount?: number
  lastError?: string | null
  lastAttemptAt?: string | null
  /** Resumable transfer the desktop assigned; reused so a retry continues from its offset. */
  transferId?: string | null
  /** SHA-256 of `blob`, computed locally. */
  fingerprint?: string | null
  acknowledgement?: CaptureAcknowledgement | null
}

// ---------------------------------------------------------------------------
// Pure rules (unit tested)
// ---------------------------------------------------------------------------

export function captureStatus(capture: PendingCapture): CaptureStatus {
  if (capture.status === 'stored' && !isVerifiedStored(capture)) return 'failed'
  return capture.status ?? 'pending'
}

/** True only when the desktop acknowledged exactly the audio held locally. */
export function isVerifiedStored(capture: PendingCapture): boolean {
  const ack = capture.acknowledgement
  return capture.status === 'stored' && Boolean(ack?.recordingId) && Boolean(capture.fingerprint)
    && ack?.fingerprint === capture.fingerprint
}

/** Verified copies older than the retention window; never anything still awaiting the desktop. */
export function expiredCaptures(captures: PendingCapture[], keepDays: number, now = new Date()): PendingCapture[] {
  const cutoff = now.getTime() - Math.max(0, keepDays) * 86_400_000
  return captures.filter(capture => isVerifiedStored(capture) && new Date(capture.acknowledgement!.storedAt).getTime() <= cutoff)
}

export interface OutboxSummary {
  total: number
  waiting: number
  failed: number
  stored: number
  bytes: number
}

export function summarizeOutbox(captures: PendingCapture[]): OutboxSummary {
  return captures.reduce<OutboxSummary>((summary, capture) => {
    const status = captureStatus(capture)
    summary.total += 1
    summary.bytes += capture.blob?.size ?? 0
    if (status === 'stored') summary.stored += 1
    else if (status === 'failed') summary.failed += 1
    else summary.waiting += 1
    return summary
  }, { total: 0, waiting: 0, failed: 0, stored: 0, bytes: 0 })
}

export function readKeepDays(): number {
  try {
    const value = Number(localStorage.getItem(KEEP_DAYS_KEY))
    return localStorage.getItem(KEEP_DAYS_KEY) !== null && Number.isFinite(value) && value >= 0 ? value : DEFAULT_KEEP_DAYS
  } catch { return DEFAULT_KEEP_DAYS }
}

export function writeKeepDays(days: number): void {
  try { localStorage.setItem(KEEP_DAYS_KEY, String(Math.max(0, Math.floor(days)))) } catch { /* preference only */ }
}

// ---------------------------------------------------------------------------
// IndexedDB store
// ---------------------------------------------------------------------------

export async function savePendingCapture(capture: PendingCapture): Promise<void> {
  const database = await openDatabase()
  try { await transactionPromise(database, 'readwrite', store => store.put(capture)) } finally { database.close() }
}

export async function listCaptures(): Promise<PendingCapture[]> {
  const database = await openDatabase()
  try {
    const captures = await transactionPromise<PendingCapture[]>(database, 'readonly', store => store.getAll())
    return captures.slice().sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
  } finally { database.close() }
}

/** The newest capture still waiting for the desktop (stored copies are not reopened for review). */
export async function latestPendingCapture(): Promise<PendingCapture | null> {
  return (await listCaptures()).find(capture => captureStatus(capture) !== 'stored') ?? null
}

/** Read-modify-write in one transaction so concurrent updates cannot drop fields. */
export async function updateCapture(id: string, patch: Partial<PendingCapture> | ((capture: PendingCapture) => Partial<PendingCapture>)): Promise<PendingCapture | null> {
  const database = await openDatabase()
  try {
    return await new Promise<PendingCapture | null>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      let result: PendingCapture | null = null
      const request = store.get(id)
      request.onsuccess = () => {
        const current = request.result as PendingCapture | undefined
        if (!current) return
        result = { ...current, ...(typeof patch === 'function' ? patch(current) : patch), id: current.id, blob: current.blob }
        store.put(result)
      }
      transaction.oncomplete = () => resolve(result)
      transaction.onerror = () => reject(transaction.error ?? new Error('The recording outbox update failed.'))
      transaction.onabort = () => reject(transaction.error ?? new Error('The recording outbox update was aborted.'))
    })
  } finally { database.close() }
}

export function markAttemptStarted(id: string) {
  return updateCapture(id, { status: 'uploading', lastAttemptAt: new Date().toISOString() })
}

export function markAttemptFailed(id: string, error: unknown) {
  const message = error instanceof Error ? error.message : 'The desktop vault could not be reached.'
  return updateCapture(id, current => ({ status: 'failed', retryCount: (current.retryCount ?? 0) + 1, lastError: message.slice(0, 300) }))
}

/** Records the desktop's acknowledgement. It counts as verified only if the fingerprints match. */
export function markStored(id: string, ack: { recordingId: string; fingerprint?: string }, localFingerprint: string) {
  const verified = Boolean(ack.fingerprint) && ack.fingerprint === localFingerprint
  return updateCapture(id, {
    status: verified ? 'stored' : 'failed',
    fingerprint: localFingerprint,
    lastError: verified ? null : 'The desktop did not confirm the audio fingerprint. Local copy retained.',
    acknowledgement: verified ? { recordingId: ack.recordingId, fingerprint: ack.fingerprint!, storedAt: new Date().toISOString() } : null,
  })
}

/** Explicitly discards an unsent capture (the caller must have confirmed with the user). */
export async function removePendingCapture(id: string): Promise<void> {
  const database = await openDatabase()
  try { await transactionPromise(database, 'readwrite', store => store.delete(id)) } finally { database.close() }
}

/** Removes a local copy only if the desktop verifiably stored it. */
export async function removeStoredCapture(id: string): Promise<boolean> {
  const capture = (await listCaptures()).find(item => item.id === id)
  if (!capture || !isVerifiedStored(capture)) return false
  await removePendingCapture(id)
  return true
}

/** Applies the retention window to verified copies. Returns how many were removed. */
export async function cleanupStoredCaptures(keepDays = readKeepDays(), now = new Date()): Promise<number> {
  const expired = expiredCaptures(await listCaptures(), keepDays, now)
  for (const capture of expired) await removePendingCapture(capture.id)
  return expired.length
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open the recording outbox.'))
  })
}

function transactionPromise<T = void>(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode)
    const request = operation(transaction.objectStore(STORE_NAME))
    let result: T
    request.onsuccess = () => { result = request.result as T }
    request.onerror = () => reject(request.error ?? new Error('The recording outbox operation failed.'))
    // Resolve on commit so a caller never treats an uncommitted write as durable.
    transaction.oncomplete = () => resolve(result)
    transaction.onerror = () => reject(transaction.error ?? new Error('The recording outbox transaction failed.'))
  })
}
