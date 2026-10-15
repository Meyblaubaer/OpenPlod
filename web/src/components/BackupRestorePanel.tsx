import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, Archive, CheckCircle2, Loader2, RotateCcw, ShieldCheck } from '@/components/icons'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { formatSize, vaultApi, type BackupFile, type VaultOperation } from '@/lib/vault-api'
import { t, tn } from '@/i18n'

type Step = 'create' | 'verify' | 'restore'
const steps = (): { id: Step; label: string }[] => [
  { id: 'create', label: t('1. Create') },
  { id: 'verify', label: t('2. Verify') },
  { id: 'restore', label: t('3. Restore') },
]

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      {children}
      {hint && <p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function Outcome({ operation }: { operation: VaultOperation | null }) {
  if (!operation) return null
  if (operation.state === 'running') {
    const progress = operation.progress
    return (
      <p className="flex items-center gap-2 text-sm" role="status" aria-live="polite">
        <Loader2 className="h-4 w-4 animate-spin" />
        {progress ? tn(progress.files, '{count} file, {done} of {total}', '{count} files, {done} of {total}', { done: formatSize(progress.bytes), total: formatSize(progress.totalBytes) }) : t('Working…')}
      </p>
    )
  }
  if (operation.state === 'failed') {
    return (
      <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive" role="alert">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span>{operation.error}</span>
      </div>
    )
  }
  const result = operation.result ?? {}
  const counts = result.counts as { recordings: number; files: number; bytes: number } | undefined
  return (
    <div className="space-y-1 rounded-md border p-3 text-sm" role="status" aria-live="polite">
      <p className="flex items-center gap-2 font-medium"><CheckCircle2 className="h-4 w-4" />
        {operation.kind === 'backup' ? t('Backup created') : operation.kind === 'verify' ? t('Backup verified') : t('Backup restored')}
      </p>
      <dl className="grid gap-1 text-xs text-muted-foreground">
        {Object.entries(result).filter(([, value]) => value !== null && typeof value !== 'object').map(([key, value]) => (
          <div key={key} className="flex gap-2"><dt className="min-w-36">{key}</dt><dd className="break-all text-foreground">{String(value)}</dd></div>
        ))}
        {counts && (
          <div className="flex gap-2"><dt className="min-w-36">{t('contents')}</dt><dd className="text-foreground">
            {tn(counts.recordings, '{count} recording', '{count} recordings')}, {tn(counts.files, '{count} file', '{count} files')}, {formatSize(counts.bytes)}
          </dd></div>
        )}
      </dl>
    </div>
  )
}

export function BackupRestorePanel() {
  const [step, setStep] = useState<Step>('create')
  const [files, setFiles] = useState<BackupFile[]>([])
  const [directory, setDirectory] = useState('')
  const [error, setError] = useState('')
  const [operation, setOperation] = useState<VaultOperation | null>(null)
  const [encrypt, setEncrypt] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const [confirmPassphrase, setConfirmPassphrase] = useState('')
  const [outputDirectory, setOutputDirectory] = useState('')
  const [archive, setArchive] = useState('')
  const [archivePassphrase, setArchivePassphrase] = useState('')
  const [target, setTarget] = useState('')
  const [confirmOverwrite, setConfirmOverwrite] = useState(false)
  const running = operation?.state === 'running'
  const selected = files.find(file => file.path === archive || file.name === archive)
  const needsPassphrase = selected ? selected.encrypted : archive.endsWith('.opbk')

  const refresh = useCallback(() => {
    vaultApi.backups().then(value => { setFiles(value.files); setDirectory(value.directory) })
      .catch(loadError => setError(loadError instanceof Error ? loadError.message : t('Could not list backups')))
  }, [])
  useEffect(() => { refresh() }, [refresh])

  const start = async (begin: () => Promise<VaultOperation>) => {
    setError('')
    try {
      const started = await begin()
      setOperation(started)
      const finished = await vaultApi.wait(started.id, setOperation)
      if (finished.kind === 'backup' && finished.state === 'complete') {
        refresh()
        const path = (finished.result as { path?: string } | undefined)?.path
        if (path) setArchive(path)
      }
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : t('The operation could not start'))
    }
  }

  const passphraseProblem = encrypt && (passphrase.length < 12 ? t('Use at least 12 characters.') : passphrase !== confirmPassphrase ? t('Passphrases do not match.') : '')

  return (
    <Card id="backup">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base"><Archive className="h-4 w-4" />{t('Backup & restore')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          {t('A backup is a full copy of this vault: the database, every recording, original device files and settings. Archives keep everything they contain until you delete them yourself, including recordings you later move to Trash or purge.')}
        </p>
        <div role="tablist" aria-label={t('Backup steps')} className="flex flex-wrap gap-2">
          {steps().map(item => (
            <Button key={item.id} role="tab" id={`backup-tab-${item.id}`} aria-selected={step === item.id} aria-controls={`backup-panel-${item.id}`}
              variant={step === item.id ? 'default' : 'outline'} size="sm" onClick={() => { setStep(item.id); setOperation(null) }}>{item.label}</Button>
          ))}
        </div>
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}

        {step === 'create' && (
          <div role="tabpanel" id="backup-panel-create" aria-labelledby="backup-tab-create" className="space-y-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={encrypt} onChange={event => setEncrypt(event.target.checked)} />
              {t('Encrypt with a passphrase (includes API keys and the Plaud authorization)')}
            </label>
            {encrypt && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field id="backup-passphrase" label={t('Passphrase')} hint={t('There is no recovery if you forget it.')}>
                  <Input id="backup-passphrase" type="password" autoComplete="new-password" value={passphrase} onChange={event => setPassphrase(event.target.value)} aria-describedby="backup-passphrase-hint" />
                </Field>
                <Field id="backup-passphrase-confirm" label={t('Confirm passphrase')}>
                  <Input id="backup-passphrase-confirm" type="password" autoComplete="new-password" value={confirmPassphrase} onChange={event => setConfirmPassphrase(event.target.value)} />
                </Field>
              </div>
            )}
            {!encrypt && <p className="text-xs text-muted-foreground">{t('Unencrypted backups leave out API keys and the Plaud authorization; re-enter them after a restore.')}</p>}
            <Field id="backup-directory" label={t('Save to folder (optional)')} hint={t('Default: {folder}. Use an absolute path, for example an external drive.', { folder: directory || t('the vault backups folder') })}>
              <Input id="backup-directory" value={outputDirectory} onChange={event => setOutputDirectory(event.target.value)} placeholder={directory} aria-describedby="backup-directory-hint" />
            </Field>
            {passphraseProblem && <p className="text-xs text-destructive">{passphraseProblem}</p>}
            <Button disabled={running || Boolean(passphraseProblem)} onClick={() => start(() => vaultApi.createBackup({ ...(encrypt ? { passphrase } : {}), ...(outputDirectory.trim() ? { directory: outputDirectory.trim() } : {}) }))}>
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}{t('Create backup')}
            </Button>
          </div>
        )}

        {step !== 'create' && (
          <div role="tabpanel" id={`backup-panel-${step}`} aria-labelledby={`backup-tab-${step}`} className="space-y-3">
            <Field id="backup-archive" label={t('Backup file')} hint={t('Pick a backup from the list or paste the absolute path of an archive.')}>
              <Input id="backup-archive" list="backup-archives" value={archive} onChange={event => setArchive(event.target.value)} aria-describedby="backup-archive-hint" />
              <datalist id="backup-archives">{files.map(file => <option key={file.path} value={file.path}>{`${file.name} (${formatSize(file.bytes)})`}</option>)}</datalist>
            </Field>
            {needsPassphrase && (
              <Field id="backup-archive-passphrase" label={t('Passphrase')}>
                <Input id="backup-archive-passphrase" type="password" autoComplete="current-password" value={archivePassphrase} onChange={event => setArchivePassphrase(event.target.value)} />
              </Field>
            )}
            {step === 'verify' && (
              <Button disabled={running || !archive} onClick={() => start(() => vaultApi.verify({ path: archive, ...(needsPassphrase ? { passphrase: archivePassphrase } : {}) }))}>
                {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}{t('Verify backup')}
              </Button>
            )}
            {step === 'restore' && (
              <>
                <Field id="restore-target" label={t('Restore into folder')} hint={t('An empty folder (absolute path). The running vault is never overwritten; start OpenPlod with the restored folder afterwards.')}>
                  <Input id="restore-target" value={target} onChange={event => setTarget(event.target.value)} aria-describedby="restore-target-hint" />
                </Field>
                {operation?.code === 'target_not_empty' && (
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={confirmOverwrite} onChange={event => setConfirmOverwrite(event.target.checked)} />
                    {t("Move the folder's current contents to a .pre-restore folder inside it, then restore")}
                  </label>
                )}
                <Button disabled={running || !archive || !target} onClick={() => start(() => vaultApi.restore({ path: archive, targetDirectory: target, confirmOverwrite, ...(needsPassphrase ? { passphrase: archivePassphrase } : {}) }))}>
                  {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}{t('Verify and restore')}
                </Button>
              </>
            )}
          </div>
        )}
        <Outcome operation={operation} />
      </CardContent>
    </Card>
  )
}
