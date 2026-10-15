import { describe, expect, test } from 'bun:test'
import type { TranscriptVersion } from './api'
import { providerVersionPair, versionTitle } from './provider-versions'

const version = (id: string, origin: TranscriptVersion['origin'], provider?: string, extra: Partial<NonNullable<TranscriptVersion['provenance']>> = {}): TranscriptVersion => ({
  id, recordingId: 'r', fullText: id, origin, createdAt: '2026-10-15T09:00:00Z',
  provenance: provider ? { provider, ...extra } : null,
})

describe('provider version helpers', () => {
  test('titles carry only recorded provenance', () => {
    expect(versionTitle(version('a', 'generated', 'deepgram', { model: 'nova-3', comparison: true }))).toBe('generated · deepgram nova-3 · comparison run')
    expect(versionTitle(version('b', 'edited'))).toBe('edited')
  })

  test('pairs the current provider with the newest other provider', () => {
    // Newest first, as the API returns them.
    const versions = [
      version('dg2', 'generated', 'deepgram', { comparison: true }),
      version('edit', 'edited', 'mistral'),
      version('dg1', 'generated', 'deepgram', { comparison: true }),
      version('mi', 'generated', 'mistral'),
    ]
    expect(providerVersionPair(versions, 'mi')?.map(item => item.id)).toEqual(['mi', 'dg2'])
  })

  test('needs two providers and ignores edits and translations', () => {
    expect(providerVersionPair([version('a', 'generated', 'mistral'), version('b', 'generated', 'mistral')], 'a')).toBeNull()
    expect(providerVersionPair([version('a', 'generated', 'mistral'), version('b', 'edited', 'deepgram')], 'a')).toBeNull()
    expect(providerVersionPair([version('a', 'generated'), version('b', 'generated', 'deepgram')], 'a')).toBeNull()
  })
})
