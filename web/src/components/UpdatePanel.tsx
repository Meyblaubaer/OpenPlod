import { useRef, useState } from 'react'
import type { Update } from '@tauri-apps/plugin-updater'
import { Download, Loader2, RefreshCw } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { getRuntime } from '@/lib/runtime'
import { t } from '@/i18n'

type State = { kind: 'idle' } | { kind: 'checking' } | { kind: 'current' } | { kind: 'available'; version: string; notes: string }
  | { kind: 'installing'; percent: number | null } | { kind: 'installed' } | { kind: 'error'; message: string }

/**
 * Desktop update check (REL-07). The updater verifies each package against the public key
 * built into the app; an unsigned or tampered package is refused by the plugin, not here.
 */
export function UpdatePanel() {
  const [state, setState] = useState<State>({ kind: 'idle' })
  const pending = useRef<Update | null>(null)
  if (getRuntime().mode !== 'desktop') return null
  const check = async () => {
    setState({ kind: 'checking' })
    try {
      const { check: checkForUpdate } = await import('@tauri-apps/plugin-updater')
      const update = await checkForUpdate()
      if (!update) { setState({ kind: 'current' }); return }
      pending.current = update
      setState({ kind: 'available', version: update.version, notes: update.body ?? '' })
    } catch (error) {
      setState({ kind: 'error', message: error instanceof Error ? error.message : t('Updates are not configured for this build.') })
    }
  }
  const install = async () => {
    const update = pending.current
    if (!update) return
    let total = 0, received = 0
    setState({ kind: 'installing', percent: null })
    try {
      await update.downloadAndInstall(event => {
        if (event.event === 'Started') total = event.data.contentLength ?? 0
        if (event.event === 'Progress') { received += event.data.chunkLength; setState({ kind: 'installing', percent: total ? Math.round(received / total * 100) : null }) }
      })
      setState({ kind: 'installed' })
    } catch (error) {
      setState({ kind: 'error', message: error instanceof Error ? error.message : t('The update could not be installed. Your current version is unchanged.') })
    }
  }
  return <div className="grid gap-2 pt-2 text-sm">
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" disabled={state.kind === 'checking' || state.kind === 'installing'} onClick={() => void check()}>{state.kind === 'checking' ? <Loader2 className="animate-spin" /> : <RefreshCw />}{t('Check for updates')}</Button>
      {state.kind === 'available' && <Button onClick={() => void install()}><Download />{t('Install {version}', { version: state.version })}</Button>}
    </div>
    <p role="status" className="text-muted-foreground">
      {state.kind === 'current' && t('OpenPlod is up to date.')}
      {state.kind === 'available' && t('Version {version} is available. Back up your vault before installing; the update replaces the app, not your data.', { version: state.version })}
      {state.kind === 'installing' && (state.percent === null ? t('Installing…') : t('Installing {percent}%', { percent: state.percent }))}
      {state.kind === 'installed' && t('Update installed. Quit and reopen OpenPlod to finish.')}
      {state.kind === 'error' && state.message}
    </p>
  </div>
}
