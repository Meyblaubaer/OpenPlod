import { describe, expect, test } from 'bun:test'
import { ResumableUnsupported, sha256Hex, uploadResumable } from './mobile-upload'
import { expiredCaptures, isVerifiedStored, summarizeOutbox, type PendingCapture } from './recording-outbox'

/** In-memory model of the desktop's resumable upload endpoints, with fault injection. */
function fakeVault(options: { failPuts?: number[]; corruptFirstComplete?: boolean } = {}) {
  let received = new Uint8Array(0)
  let size = 0
  let fingerprint = ''
  let puts = 0
  let completes = 0
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
  const request = async (path: string, init: RequestInit): Promise<Response> => {
    if (path === '/mobile/uploads' && init.method === 'POST') {
      const body = JSON.parse(String(init.body))
      size = body.size; fingerprint = body.fingerprint
      return json(201, { success: true, data: { transferId: 't1', offset: received.length, size, state: 'open', maxChunkBytes: 1000 } })
    }
    if (path === '/mobile/uploads/t1' && init.method === 'GET') return json(200, { success: true, data: { offset: received.length } })
    if (path === '/mobile/uploads/t1' && init.method === 'PUT') {
      puts += 1
      if (options.failPuts?.includes(puts)) throw new TypeError('Network request failed')
      const headers = new Headers(init.headers)
      const [, start] = /bytes (\d+)-(\d+)\/(\d+)/.exec(headers.get('Content-Range')!)!.map(Number)
      const chunk = new Uint8Array(init.body as ArrayBuffer)
      if (await sha256Hex(chunk.buffer as ArrayBuffer) !== headers.get('X-Chunk-SHA256')) return json(422, { success: false, data: { offset: received.length } })
      if (start !== received.length) return json(409, { success: false, data: { offset: received.length } })
      const next = new Uint8Array(received.length + chunk.length); next.set(received); next.set(chunk, received.length); received = next
      return json(200, { success: true, data: { offset: received.length } })
    }
    if (path === '/mobile/uploads/t1/complete') {
      completes += 1
      if (options.corruptFirstComplete && completes === 1) { received = new Uint8Array(0); return json(422, { success: false, code: 'fingerprint_mismatch', data: { offset: 0 } }) }
      if (received.length !== size) return json(409, { success: false, code: 'incomplete', data: { offset: received.length } })
      return json(201, { success: true, data: { transferId: 't1', recordingId: 'r1', fingerprint: await sha256Hex(received.buffer as ArrayBuffer), added: true } })
    }
    return json(404, { success: false })
  }
  return { request, stats: () => ({ puts, completes, received: received.length, fingerprint }) }
}

const blob = (size: number) => new Blob([Uint8Array.from({ length: size }, (_, i) => (i * 7) & 0xff)])
const noWait = async () => undefined

describe('resumable mobile upload', () => {
  test('sends chunks and returns the verified acknowledgement', async () => {
    const vault = fakeVault()
    const transfers: string[] = []
    const ack = await uploadResumable(blob(2500), 'a.webm', {}, { request: vault.request, onTransfer: id => { transfers.push(id) }, wait: noWait })
    expect(ack).toMatchObject({ recordingId: 'r1', transferId: 't1' })
    expect(transfers).toEqual(['t1'])
    expect(vault.stats()).toMatchObject({ puts: 3, received: 2500 })
  })

  test('recovers from network failures by resynchronizing the offset', async () => {
    const vault = fakeVault({ failPuts: [2] })
    const ack = await uploadResumable(blob(2500), 'a.webm', {}, { request: vault.request, wait: noWait })
    expect(ack.recordingId).toBe('r1')
    expect(vault.stats().received).toBe(2500)
  })

  test('restarts once when the desktop rejects the assembled fingerprint', async () => {
    const vault = fakeVault({ corruptFirstComplete: true })
    const ack = await uploadResumable(blob(1500), 'a.webm', {}, { request: vault.request, wait: noWait })
    expect(ack.recordingId).toBe('r1')
    expect(vault.stats().completes).toBe(2)
  })

  test('gives up after repeated failures without progress, leaving the caller to keep the audio', async () => {
    const vault = fakeVault({ failPuts: [1, 2, 3, 4, 5] })
    await expect(uploadResumable(blob(1500), 'a.webm', {}, { request: vault.request, wait: noWait, maxAttempts: 3 })).rejects.toThrow('Network request failed')
  })

  test('reports an older desktop as unsupported so the single-request path can be used', async () => {
    const request = async () => new Response('{}', { status: 404 })
    await expect(uploadResumable(blob(10), 'a.webm', {}, { request, wait: noWait })).rejects.toBeInstanceOf(ResumableUnsupported)
  })
})

describe('outbox rules', () => {
  const base = (patch: Partial<PendingCapture>): PendingCapture => ({
    id: crypto.randomUUID(), blob: new Blob(['abc']), filename: 'a.webm', title: 'A', context: '', recordedAt: '2026-10-01T00:00:00Z', durationMs: 1, ...patch,
  })
  const stored = (storedAt: string, fingerprint = 'f') => base({ status: 'stored', fingerprint, acknowledgement: { recordingId: 'r', fingerprint: 'f', storedAt } })

  test('only fingerprint-matched acknowledgements count as verified', () => {
    expect(isVerifiedStored(stored('2026-10-01T00:00:00Z'))).toBe(true)
    expect(isVerifiedStored(stored('2026-10-01T00:00:00Z', 'other'))).toBe(false)
    expect(isVerifiedStored(base({ status: 'failed' }))).toBe(false)
    expect(isVerifiedStored(base({ status: 'stored' }))).toBe(false)
  })

  test('cleanup selects only verified copies older than the retention window', () => {
    const now = new Date('2026-10-10T00:00:00Z')
    const old = stored('2026-10-01T00:00:00Z')
    const recent = stored('2026-10-09T12:00:00Z')
    const unverified = stored('2026-09-01T00:00:00Z', 'mismatch')
    const pending = base({ status: 'pending' })
    expect(expiredCaptures([old, recent, unverified, pending], 7, now)).toEqual([old])
    expect(expiredCaptures([old, recent, unverified, pending], 0, now)).toEqual([old, recent])
  })

  test('summarizes waiting, failed, stored, and bytes used', () => {
    const summary = summarizeOutbox([base({}), base({ status: 'failed' }), stored('2026-10-01T00:00:00Z'), base({ status: 'uploading' })])
    expect(summary).toEqual({ total: 4, waiting: 2, failed: 1, stored: 1, bytes: 12 })
  })
})
