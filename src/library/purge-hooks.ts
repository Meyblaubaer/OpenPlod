import type { Database } from 'bun:sqlite';

/**
 * REL-04: purge hook registry. Modules that keep data derived from a recording
 * (search passages, embeddings, sync tombstones, in-memory caches) register a hook
 * here instead of being hard-coded into the purge. This module has no imports from
 * the database client so any module can register without creating import cycles.
 */
export type PurgeContext = {
  database: Database;
  recordingId: string;
  filePath: string;
  libraryDirectory: string;
  sourceProvider: string | null;
  sourceRecordingId: string | null;
  sourceTransport: string | null;
  fingerprint: string | null;
  purgedAt: string;
  reason: 'manual' | 'trash-expiry';
};

export type PurgeHook = {
  name: string;
  /** Runs synchronously inside the purge transaction; throwing aborts the whole purge. */
  inTransaction?: (context: PurgeContext) => void;
  /** Runs after the database commit; failures are reported, never undo the purge. */
  afterCommit?: (context: PurgeContext) => void | Promise<void>;
};

const hooks = new Map<string, PurgeHook>();

/** Registers (or replaces, by name) a purge hook. Returns an unregister function. */
export function registerPurgeHook(hook: PurgeHook): () => void {
  hooks.set(hook.name, hook);
  return () => { if (hooks.get(hook.name) === hook) hooks.delete(hook.name); };
}

export function purgeHooks(): PurgeHook[] { return [...hooks.values()]; }
