import type { TranscriptVersion } from './api'

/**
 * Helpers for comparing transcription providers in the Versions tab (TS-11).
 *
 * Labels come only from what a version's provenance recorded. A version with
 * no recorded provider is not attributed to one.
 */

/** "generated · deepgram nova-3 · comparison run". */
export function versionTitle(version: TranscriptVersion): string {
  const provider = version.provenance?.provider
  return [
    version.origin,
    provider ? `${provider}${version.provenance?.model ? ` ${version.provenance.model}` : ''}` : null,
    version.provenance?.comparison ? 'comparison run' : null,
  ].filter(Boolean).join(' · ')
}

/**
 * The latest generated version from each of two different providers, the
 * current transcript's provider first, or null when fewer than two providers
 * have produced a version. Edited and translated versions are never treated
 * as a provider's output.
 */
export function providerVersionPair(versions: TranscriptVersion[], currentId: string | null | undefined): [TranscriptVersion, TranscriptVersion] | null {
  const byProvider = new Map<string, TranscriptVersion>()
  const current = versions.find(version => version.id === currentId)
  for (const version of [...(current ? [current] : []), ...versions]) {
    const provider = version.origin === 'generated' ? version.provenance?.provider : undefined
    if (provider && !byProvider.has(provider)) byProvider.set(provider, version)
  }
  const pair = [...byProvider.values()]
  return pair.length >= 2 ? [pair[0]!, pair[1]!] : null
}
