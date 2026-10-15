import { api, type UploadAcknowledgement } from '@/lib/api'
import { sha256Hex } from '@/lib/mobile-upload'
import { markAttemptFailed, markAttemptStarted, markStored, updateCapture, type PendingCapture } from '@/lib/recording-outbox'

/**
 * Sends one outbox capture to the desktop vault and records the outcome on the outbox row.
 * The local audio is never deleted here; the acknowledgement is stored for later verified cleanup.
 */
export async function deliverCapture(capture: PendingCapture, fromMobile: boolean, onProgress?: (sent: number, total: number) => void): Promise<UploadAcknowledgement> {
  await markAttemptStarted(capture.id)
  try {
    const fingerprint = capture.fingerprint ?? await sha256Hex(capture.blob)
    if (!capture.fingerprint) await updateCapture(capture.id, { fingerprint })
    const acknowledgement = await api.uploadRecording(
      new File([capture.blob], capture.filename, { type: capture.blob.type }),
      fromMobile,
      {
        recordedAt: capture.recordedAt,
        context: capture.context,
        recordingType: 'other',
        sourceProvider: capture.sourceProvider,
        sourceTransport: capture.sourceTransport,
        sourceRecordingId: capture.sourceRecordingId,
        durationMs: capture.durationMs,
      },
      {
        fingerprint,
        onProgress,
        onTransfer: async transferId => { await updateCapture(capture.id, { transferId }) },
      },
    )
    const stored = await markStored(capture.id, acknowledgement, fingerprint)
    if (stored?.status !== 'stored') throw new Error(stored?.lastError ?? 'The desktop acknowledgement could not be verified.')
    return acknowledgement
  } catch (error) {
    await markAttemptFailed(capture.id, error).catch(() => undefined)
    throw error
  }
}
