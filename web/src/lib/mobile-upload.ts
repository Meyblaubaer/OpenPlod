/**
 * Byte-offset resumable upload to the desktop vault (MOB-02).
 *
 * Protocol (see docs/impl-notes/stream-e-mobile.md):
 *   POST /mobile/uploads {fingerprint, size, filename, metadata} -> {transferId, offset, maxChunkBytes}
 *   PUT  /mobile/uploads/:id  Content-Range: bytes a-b/size, X-Chunk-SHA256 -> {offset}
 *   GET  /mobile/uploads/:id -> {offset}
 *   POST /mobile/uploads/:id/complete -> {recordingId, fingerprint, added}
 *
 * The transfer ID is reported through `onTransfer` before any byte is sent so the caller can
 * persist it; a later attempt passes the same fingerprint and resumes from the committed offset.
 */
export const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024

export interface ResumableMetadata {
  recordedAt?: string
  context?: string
  recordingType?: string
  sourceProvider?: 'opennotes' | 'plaud' | 'upload'
  sourceRecordingId?: string
  durationMs?: number
}

export interface ResumableAcknowledgement {
  transferId: string
  recordingId: string
  fingerprint: string
  added: boolean
}

export interface ResumableOptions {
  fingerprint?: string
  onTransfer?: (transferId: string, fingerprint: string) => void | Promise<void>
  onProgress?: (sentBytes: number, totalBytes: number) => void
  chunkBytes?: number
  /** Sends a request to `/api` + path with authentication. Injectable for tests. */
  request: (path: string, init: RequestInit) => Promise<Response>
  /** Consecutive failures without progress before giving up (the outbox keeps the audio). */
  maxAttempts?: number
  wait?: (ms: number) => Promise<void>
}

/** The desktop predates resumable uploads; the caller may use the single-request endpoint. */
export class ResumableUnsupported extends Error {}

interface Envelope<T> { success: boolean; data?: T; error?: string; code?: string }
interface TransferState { transferId: string; offset: number; size: number; state: 'open' | 'complete'; maxChunkBytes: number }

export async function sha256Hex(data: Blob | ArrayBuffer): Promise<string> {
  const buffer = data instanceof Blob ? await data.arrayBuffer() : data
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

async function readEnvelope<T>(response: Response): Promise<Envelope<T>> {
  return await response.json().catch(() => ({ success: false })) as Envelope<T>
}

export async function uploadResumable(file: Blob, filename: string, metadata: ResumableMetadata, options: ResumableOptions): Promise<ResumableAcknowledgement> {
  const fingerprint = options.fingerprint ?? await sha256Hex(file)
  const maxAttempts = options.maxAttempts ?? 4
  const wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })

  const created = await options.request('/mobile/uploads', json({ fingerprint, size: file.size, filename, metadata }))
  if (created.status === 404 || created.status === 405) throw new ResumableUnsupported('The desktop does not support resumable uploads.')
  const start = await readEnvelope<TransferState>(created)
  if (!created.ok || !start.data) throw new Error(start.error || `Upload could not start (HTTP ${created.status}).`)
  const transferId = start.data.transferId
  await options.onTransfer?.(transferId, fingerprint)
  const chunkBytes = Math.max(1, Math.min(options.chunkBytes ?? DEFAULT_CHUNK_BYTES, start.data.maxChunkBytes || DEFAULT_CHUNK_BYTES))
  let offset = start.data.offset
  let failures = 0
  let restarted = false
  options.onProgress?.(offset, file.size)

  const fail = async (message: string) => {
    failures += 1
    if (failures >= maxAttempts) throw new Error(message)
    await wait(Math.min(8000, 500 * 2 ** (failures - 1)))
  }
  const resync = async () => {
    try {
      const status = await options.request(`/mobile/uploads/${transferId}`, { method: 'GET' })
      const payload = await readEnvelope<TransferState>(status)
      if (status.ok && payload.data) offset = payload.data.offset
    } catch { /* keep the last known offset */ }
  }

  for (;;) {
    while (offset < file.size) {
      const end = Math.min(offset + chunkBytes, file.size)
      const chunk = await file.slice(offset, end).arrayBuffer()
      let response: Response
      try {
        response = await options.request(`/mobile/uploads/${transferId}`, {
          method: 'PUT', body: chunk,
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${offset}-${end - 1}/${file.size}`, 'X-Chunk-SHA256': await sha256Hex(chunk) },
        })
      } catch (error) {
        await fail(error instanceof Error ? error.message : 'Network error during upload.')
        await resync()
        continue
      }
      const payload = await readEnvelope<{ offset: number }>(response)
      if (response.ok && payload.data) {
        if (payload.data.offset > offset) failures = 0
        offset = payload.data.offset
        options.onProgress?.(offset, file.size)
        continue
      }
      if (response.status === 404) throw new Error('The desktop no longer has this transfer. Retry to start again.')
      if (typeof payload.data?.offset === 'number') offset = payload.data.offset
      await fail(payload.error || `Upload failed (HTTP ${response.status}).`)
    }
    const completed = await options.request(`/mobile/uploads/${transferId}/complete`, { method: 'POST' })
    const ack = await readEnvelope<ResumableAcknowledgement>(completed)
    if (completed.ok && ack.data) {
      if (ack.data.fingerprint !== fingerprint) throw new Error('The desktop acknowledged different audio. Local recording retained.')
      return ack.data
    }
    if (ack.code === 'fingerprint_mismatch' && !restarted) { restarted = true; offset = 0; continue }
    if (ack.code === 'incomplete') { await resync(); await fail(ack.error || 'The transfer is incomplete.'); continue }
    throw new Error(ack.error || `The desktop did not acknowledge the recording (HTTP ${completed.status}).`)
  }
}
