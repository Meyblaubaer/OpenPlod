import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { QRCodeSVG } from 'qrcode.react'
import { Bluetooth, Check, ChevronRight, Copy, HardDrive, KeyRound, Loader2, Monitor, Pencil, RefreshCw, ShieldCheck, Smartphone, Unplug } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { NoteDialog } from '@/components/NoteDialogs'
import { apiUrl, authenticatedHeaders, forgetMobilePairing, getRuntime } from '@/lib/runtime'
import { api, type IssuedClient, type PairedClient } from '@/lib/api'
import './android.css'

export function AndroidPage() {
  const runtime = getRuntime()
  const desktop = runtime.mode === 'desktop'
  const mobile = runtime.mode === 'mobile'
  const canPair = desktop && !!runtime.lanAddress && !!runtime.pairingToken
  const [revealed, setRevealed] = useState(false)
  // Each QR reveal issues a fresh per-client credential; it lives only in memory while shown.
  const [issued, setIssued] = useState<IssuedClient | null>(null)
  const [issuing, setIssuing] = useState(false)
  const [pairError, setPairError] = useState('')
  const [clientsVersion, setClientsVersion] = useState(0)
  const [forgetting, setForgetting] = useState(false)
  const [check, setCheck] = useState(0)
  const [health, setHealth] = useState<'checking' | 'available' | 'unavailable'>('checking')
  useEffect(() => {
    const controller = new AbortController()
    fetch(apiUrl('/info'), { headers: authenticatedHeaders(), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) })
      .then(async response => {
        if (!response.ok || (await response.json()).status !== 'ok') throw new Error('Unavailable')
        if (!controller.signal.aborted) setHealth('available')
      }).catch(() => { if (!controller.signal.aborted) setHealth('unavailable') })
    return () => controller.abort()
  }, [check])
  useEffect(() => {
    if (!revealed) return
    const hide = () => { if (document.hidden) { setRevealed(false); setIssued(null) } }
    const timer = window.setTimeout(() => { setRevealed(false); setIssued(null) }, 60000)
    document.addEventListener('visibilitychange', hide)
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', hide) }
  }, [revealed])
  return <div className="android-page">
    <header className="android-heading"><div><h1>Android</h1><span>Connections</span></div><IconButton label="Check vault connection" disabled={health === 'checking'} onClick={() => { setHealth('checking'); setCheck(v => v + 1) }}>{health === 'checking' ? <Loader2 className="animate-spin" /> : <RefreshCw />}</IconButton></header>
    <div className="android-workspace">
      <section className="android-pairing" aria-labelledby="android-pairing-title">
        <div className="android-section-title"><Smartphone /><div><h2 id="android-pairing-title">{mobile ? 'Paired desktop' : 'Pair your phone'}</h2><p>{desktop ? 'Local network / Private vault' : mobile ? 'Desktop vault connection' : 'Desktop app required'}</p></div></div>
        {desktop ? <>
          <div className="android-qr-area">
            {revealed && canPair && issued ? <div className="android-qr" aria-label="Private pairing QR code"><QRCodeSVG value={JSON.stringify({ type: 'openplod-pairing', version: 1, origin: runtime.lanAddress, token: issued.token })} size={200} marginSize={3} level="M" /></div> : <div className="android-qr-hidden"><ShieldCheck /><span>{canPair ? 'Private pairing code' : 'Network address unavailable'}</span></div>}
            <Button variant={revealed ? 'outline' : 'default'} disabled={!canPair || issuing} onClick={async () => {
              if (revealed) { setRevealed(false); setIssued(null); return }
              setIssuing(true); setPairError('')
              try { setIssued(await api.issuePairedClient()); setRevealed(true); setClientsVersion(v => v + 1) }
              catch (error) { setPairError(error instanceof Error ? error.message : 'A pairing code could not be issued.') }
              finally { setIssuing(false) }
            }}>{issuing ? <Loader2 className="animate-spin" /> : <Smartphone />}{revealed ? 'Hide pairing QR' : 'Show pairing QR'}</Button>
            {pairError && <p className="android-status-error" role="alert">{pairError}</p>}
          </div>
          <p className="android-privacy">Each code pairs one phone with its own revocable access and expires after one hour if unused. Share it only with a trusted phone on your local network.</p>
          <details className="android-manual"><summary>Manual connection</summary><ConnectionValue label="Desktop address" value={runtime.lanAddress || ''} /><ConnectionValue label="Private pairing code" value={revealed && issued ? issued.token : ''} secret />{!(revealed && issued) && <p className="android-manual-hint">Show a pairing QR to issue a code.</p>}</details>
          <PairedClients version={clientsVersion} onIssued={value => { setIssued(value); setRevealed(true); setClientsVersion(v => v + 1) }} />
        </> : mobile ? <>
          <ConnectionValue label="Desktop address" value={runtime.serviceOrigin} />
          <Button variant="outline" onClick={() => setForgetting(true)}><Unplug />Forget desktop</Button>
        </> : <div className="android-browser-state"><Monitor /><h3>Open OpenPlod on your desktop</h3><p>Pairing credentials are available only in the installed app.</p><a href="https://github.com/RemiPelloux/OpenPlod/releases" target="_blank" rel="noreferrer">Releases & build instructions<ChevronRight /></a></div>}
      </section>
      <aside className="android-details" aria-label="Connection details">
        <section><div className="android-section-title"><HardDrive /><h2>Recording vault</h2></div><dl><div><dt>Service</dt><dd className={`android-health ${health}`} role="status">{health === 'checking' ? 'Checking...' : health === 'available' ? 'Reachable' : 'Unavailable'}</dd></div><div><dt>Access</dt><dd>{mobile ? 'Paired desktop' : desktop ? 'This desktop' : 'Browser'}</dd></div>{desktop && <div><dt>Phone connection</dt><dd>Not monitored</dd></div>}</dl>{health === 'unavailable' && <p className="android-status-error" role="alert">The vault did not respond. Check the desktop app and network, then retry.</p>}</section>
        <section><div className="android-section-title"><Bluetooth /><h2>Plaud Note Pro</h2></div><Link className="android-destination" to="/devices"><span>Device access<small>Bluetooth & recordings</small></span><ChevronRight /></Link></section>
        <section><div className="android-section-title"><ShieldCheck /><h2>Storage & privacy</h2></div><dl><div><dt>Original audio</dt><dd>Desktop vault</dd></div><div><dt>Mobile storage</dt><dd>Local cache & queue</dd></div></dl></section>
      </aside>
    </div>
    {forgetting && <NoteDialog title="Forget this desktop?" description="Local pairing credentials will be removed. Recordings in the desktop vault are not deleted." onClose={() => setForgetting(false)}><footer><Button variant="ghost" onClick={() => setForgetting(false)}>Cancel</Button><Button variant="destructive" onClick={() => { forgetMobilePairing(); window.location.reload() }}><Unplug />Forget desktop</Button></footer></NoteDialog>}
  </div>
}

function when(value: string | null, never: string): string {
  if (!value) return never
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? never : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/**
 * Paired devices (MOB-06). Shows when each phone was last seen and last synchronized; a saved
 * pairing is never presented as "online".
 */
function PairedClients({ version, onIssued }: { version: number; onIssued: (issued: IssuedClient) => void }) {
  const [clients, setClients] = useState<PairedClient[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [revoking, setRevoking] = useState<PairedClient | null>(null)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let cancelled = false
    api.listPairedClients().then(list => { if (!cancelled) { setClients(list); setError('') } })
      .catch(loadError => { if (!cancelled) setError(loadError instanceof Error ? loadError.message : 'Paired devices could not be loaded.') })
    return () => { cancelled = true }
  }, [version, reload])
  const act = async (id: string, action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(id); setError('')
    try { await action(); setReload(v => v + 1); return true }
    catch (actionError) { setError(actionError instanceof Error ? actionError.message : 'The change could not be saved.'); return false }
    finally { setBusy(null) }
  }
  return <section className="android-clients" aria-labelledby="android-clients-title">
    <div className="android-section-title"><KeyRound /><div><h2 id="android-clients-title">Paired devices</h2><p>Last seen and last sync times, not live presence</p></div></div>
    {error && <p className="android-status-error" role="alert">{error}</p>}
    {clients === null ? !error && <p className="android-clients-empty"><Loader2 className="animate-spin" />Loading...</p>
      : clients.length === 0 ? <p className="android-clients-empty">No phone has been paired yet.</p>
      : <ul>{clients.map(client => {
        const pending = !client.lastSeenAt && !client.revokedAt && !client.legacy
        const expired = pending && client.pairingExpiresAt !== null && new Date(client.pairingExpiresAt) <= new Date()
        return <li key={client.id} className={client.revokedAt ? 'revoked' : ''}>
          <div className="android-client-main">
            {renaming?.id === client.id
              ? <form onSubmit={event => {
                  event.preventDefault()
                  const name = renaming.name.trim()
                  if (name) void act(client.id, () => api.renamePairedClient(client.id, name)).then(saved => { if (saved) setRenaming(null) })
                }}>
                  <input aria-label="Device name" value={renaming.name} maxLength={80} autoFocus onChange={event => setRenaming({ id: client.id, name: event.target.value })} />
                  <Button size="sm" type="submit" disabled={busy === client.id || !renaming.name.trim()}>Save</Button>
                  <Button size="sm" variant="ghost" type="button" onClick={() => setRenaming(null)}>Cancel</Button>
                </form>
              : <strong>{client.legacy ? `${client.name} (shared desktop code)` : client.name}</strong>}
            <dl>
              <div><dt>Status</dt><dd>{client.revokedAt ? `Revoked ${when(client.revokedAt, '')}` : expired ? 'Pairing code expired' : pending ? 'Waiting for first connection' : 'Paired'}</dd></div>
              <div><dt>Last seen</dt><dd>{when(client.lastSeenAt, 'Never')}</dd></div>
              <div><dt>Last successful sync</dt><dd>{when(client.lastSuccessfulSyncAt, 'Never')}</dd></div>
              {client.platform !== 'unknown' && <div><dt>Platform</dt><dd>{client.platform}</dd></div>}
              <div><dt>Access</dt><dd>{client.permissions.join(', ') || 'None'}</dd></div>
            </dl>
          </div>
          {!client.revokedAt && renaming?.id !== client.id && <div className="android-client-actions">
            <IconButton label={`Rename ${client.name}`} disabled={busy === client.id} onClick={() => setRenaming({ id: client.id, name: client.name })}><Pencil /></IconButton>
            <IconButton label={client.legacy ? 'Replace the shared code with a device code' : `Issue a new code for ${client.name}`} disabled={busy === client.id} onClick={() => void act(client.id, async () => onIssued(await api.rotatePairedClient(client.id)))}><RefreshCw /></IconButton>
            <Button size="sm" variant="destructive" disabled={busy === client.id} onClick={() => setRevoking(client)}>Revoke</Button>
          </div>}
        </li>
      })}</ul>}
    {revoking && <NoteDialog title={`Revoke ${revoking.name}?`} description={revoking.legacy
      ? 'Phones using the shared desktop code lose access immediately. This desktop keeps working. Recordings already in the vault are not deleted.'
      : 'This phone loses access immediately. Recordings already in the vault are not deleted, and audio still waiting on the phone stays there.'} onClose={() => setRevoking(null)}>
      <footer><Button variant="ghost" onClick={() => setRevoking(null)}>Cancel</Button><Button variant="destructive" onClick={() => { const target = revoking; setRevoking(null); void act(target.id, () => api.revokePairedClient(target.id)) }}>Revoke access</Button></footer>
    </NoteDialog>}
  </section>
}

function ConnectionValue({ label, value, secret = false }: { label: string; value: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  return <div className="android-value"><label>{label}</label><div><code>{value ? secret ? '************************' : value : 'Unavailable'}</code><IconButton label={copied ? `${label} copied` : `Copy ${label}`} disabled={!value} onClick={async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setError(''); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 2000) }
    catch { setError('Clipboard unavailable.') }
  }}>{copied ? <Check /> : <Copy />}</IconButton></div>{error && <p role="alert">{error}</p>}</div>
}
