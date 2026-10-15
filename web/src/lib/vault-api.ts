import { apiUrl, authenticatedHeaders } from './runtime'

/** Client for `/api/vault` (REL-05 backup and restore, see `src/api/vault.ts`). */
export type VaultOperation<T = Record<string, unknown>> = {
  id: string
  kind: 'backup' | 'verify' | 'restore'
  state: 'running' | 'complete' | 'failed'
  progress?: { files: number; bytes: number; totalBytes: number }
  result?: T
  error?: string
  code?: 'wrong_passphrase' | 'target_not_empty' | 'failed'
}
export type BackupFile = { name: string; path: string; bytes: number; modifiedAt: string; encrypted: boolean }
export type VaultStatus = { dataDirectory: string; database: string; library: string; backupsDirectory: string; tls: boolean
  recovery: { completed: string[]; rolledBack: { id: string; retainedAt: string | null }[]; orphanedFiles: string[]; errors: string[] } | null }

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(apiUrl(`/vault${path}`), { method, headers: authenticatedHeaders({ 'Content-Type': 'application/json' }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) })
  const payload = await response.json().catch(() => ({ success: false, error: `Request failed (HTTP ${response.status}).` }))
  if (!response.ok || !payload.success) throw new Error(payload.error || 'Request could not be completed.')
  return payload.data
}

export const vaultApi = {
  status: () => request<VaultStatus>('/status'),
  backups: () => request<{ directory: string; files: BackupFile[] }>('/backups'),
  createBackup: (input: { passphrase?: string; directory?: string }) => request<VaultOperation>('/backups', 'POST', input),
  verify: (input: { path: string; passphrase?: string }) => request<VaultOperation>('/backups/verify', 'POST', input),
  restore: (input: { path: string; passphrase?: string; targetDirectory: string; confirmOverwrite?: boolean }) => request<VaultOperation>('/restore', 'POST', input),
  operation: (id: string) => request<VaultOperation>(`/operations/${id}`),
  /** Polls until the operation finishes. */
  async wait(id: string, onUpdate?: (operation: VaultOperation) => void): Promise<VaultOperation> {
    for (;;) {
      const operation = await vaultApi.operation(id)
      onUpdate?.(operation)
      if (operation.state !== 'running') return operation
      await new Promise(resolve => window.setTimeout(resolve, 700))
    }
  },
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024, unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value.toFixed(1)} ${units[unit]}`
}
