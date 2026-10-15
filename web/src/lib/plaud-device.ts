import { invoke } from '@tauri-apps/api/core'
import { getRuntime } from './runtime'

export interface DeviceRecording {
  sessionId: string
  size: number
  scene: number
}

export interface LocalPlaudRecording {
  sessionId: string
  sourceRecordingId: string
  filename: string
  durationMs: number
  fingerprint: string
  recordedAt: string
  desktopRecordingId: string | null
  /** Outbox state kept by the native store (MOB-03); absent on older app data. */
  uploadAttempts?: number
  lastUploadError?: string | null
  transferId?: string | null
}

/** Native outbox summary; absent on older app builds. */
export interface NativeOutboxSummary {
  pending: number
  failed: number
  acknowledged: number
  bytes: number
}

export interface DeviceSnapshot {
  configured: boolean
  busy: boolean
  autoImport: boolean
  lastNotice: string | null
  lastCheck: number
  state: 'not_configured' | 'authenticating' | 'disconnected' | 'scanning' | 'connecting' | 'ready'
  error: string | null
  serial: string | null
  battery: number | null
  listLoaded: boolean
  files: DeviceRecording[]
  devices: { serial: string; name: string; rssi: number }[]
  localRecordings: LocalPlaudRecording[]
  outbox?: NativeOutboxSummary
  downloading: boolean
  progress: number
  playingId: string | null
}

export const supportsPlaudDevice = () => getRuntime().mode === 'mobile' && /Android/i.test(navigator.userAgent)

export async function deviceCommand<T = DeviceSnapshot>(action: string, args: Record<string, unknown> = {}): Promise<T> {
  try { return await invoke<T>('plaud_command', { action, args }) }
  catch (error) { throw new Error(typeof error === 'string' ? error : 'The Plaud connection could not be reached.') }
}

export function vaultArguments() {
  const runtime = getRuntime()
  return { origin: runtime.serviceOrigin, pairingToken: runtime.pairingToken }
}
