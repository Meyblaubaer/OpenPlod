import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { readAiConfig } from '../ai/config';

/**
 * A deterministic RFC 9562-shaped UUID (version 5 layout, SHA-256 based) for
 * the given parts. The same (rule, recording, step) or (event, subscription)
 * always maps to the same id, which is what makes retries idempotent.
 */
export function stableId(...parts: string[]): string {
  const hex = createHash('sha256').update(parts.join('\u001f')).digest('hex');
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export class AutomationError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 503, readonly code: string, message: string) { super(message); }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** True for http(s) URLs that stay on this computer. */
export function isLoopbackUrl(value: string): boolean {
  try { return LOOPBACK.has(new URL(value).hostname); } catch { return false; }
}

/**
 * Outbound URLs must be HTTPS, or plain HTTP to a loopback address, and must
 * not carry credentials or fragments (which would end up in logs).
 */
export function validateOutboundUrl(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return 'Enter a valid URL.'; }
  if (url.username || url.password) return 'Remove credentials from the URL.';
  if (url.hash) return 'Remove the #fragment from the URL.';
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return null;
  return 'Use HTTPS, or plain HTTP only to localhost.';
}

export const localOnly = (database: Database) => readAiConfig(database).privacyMode === 'local-only';

export const nowIso = () => new Date().toISOString();

export function tableExists(database: Database, name: string): boolean {
  return Boolean(database.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

/**
 * Classify a thrown fetch error. A refused connection or failed DNS lookup
 * proves nothing was sent; anything else (timeouts, resets after connect) may
 * have reached the server, so the outcome is unknown.
 */
export function transportOutcome(error: unknown): 'failed' | 'unknown' {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const code = String((current as { code?: unknown }).code ?? '');
    if (['ECONNREFUSED', 'ConnectionRefused', 'ENOTFOUND', 'EAI_AGAIN', 'FailedToOpenSocket', 'EHOSTUNREACH', 'ENETUNREACH', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code)) return 'failed';
    current = (current as { cause?: unknown }).cause;
  }
  return 'unknown';
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
