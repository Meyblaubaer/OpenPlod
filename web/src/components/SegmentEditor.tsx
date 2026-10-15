import { memo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Pencil, Save, X } from "@/components/icons"
import { Button } from './ui/button'
import { api, type Recording, type TranscriptSegment } from '@/lib/api'
import { t } from '@/i18n'
// Memoized so playback ticks on the recording page do not re-render one dialog per segment.
export const SegmentEditor = memo(function SegmentEditor({ recording, segment, onSaved }: { recording: Recording; segment: TranscriptSegment; onSaved: () => Promise<void> }) {
  const [open, setOpen] = useState(false), [text, setText] = useState(segment.text), [speaker, setSpeaker] = useState(segment.speaker)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const save = async () => {
    setBusy(true); setError('')
    try {
      // Send stored speaker values and word timings back unchanged; only a renamed label replaces its speaker.
      const renamed = speaker.trim() !== segment.speaker
      const segments = (recording.segments || []).map(s => {
        const value = renamed && String(s.speakerId) === String(segment.speakerId) ? speaker.trim() : s.speakerId
        return { start: s.startTime, end: s.endTime, text: s.id === segment.id ? text : s.text,
          ...(value === null ? {} : { speaker: value }), ...(s.words ? { words: s.words } : {}) }
      })
      await api.updateTranscript(recording.id, segments.map(s => s.text).join('\n\n'), recording.revision, segments)
      await onSaved(); setOpen(false)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <Dialog.Root open={open} onOpenChange={value => { if (!busy) { setOpen(value); setText(segment.text); setSpeaker(segment.speaker); setError('') } }}><Dialog.Trigger asChild><Button size="icon" variant="ghost" title={t('Correct transcript segment')} aria-label={t('Correct transcript segment')}><Pencil className="size-3" /></Button></Dialog.Trigger><Dialog.Portal><Dialog.Overlay className="plaud-import-overlay" /><Dialog.Content className="plaud-import-dialog p-6" onEscapeKeyDown={e => { if (busy) e.preventDefault() }} onInteractOutside={e => { if (busy) e.preventDefault() }}>
    <div className="flex items-center justify-between mb-4"><Dialog.Title className="font-semibold">{t('Correct transcript')}</Dialog.Title><Dialog.Close asChild><Button size="icon" variant="ghost" disabled={busy} aria-label={t('Close correction')}><X /></Button></Dialog.Close></div>
    <Dialog.Description className="text-xs text-muted-foreground mb-4">{t('Creates an edited version and preserves timestamps. Speaker changes apply to all segments with this label.')}</Dialog.Description>
    <label className="text-sm">{t('Speaker')}<input className="block border rounded p-2 w-full mt-1 mb-4" value={speaker} maxLength={80} onChange={e => setSpeaker(e.target.value)} /></label>
    <label className="text-sm">{t('Transcript')}<textarea className="block border rounded p-2 w-full mt-1 mb-4" rows={6} maxLength={50000} value={text} onChange={e => setText(e.target.value)} /></label>
    {error && <p role="alert" className="device-error">{error}</p>}<Button disabled={busy || !text.trim() || !speaker.trim()} onClick={() => void save()}><Save />{t('Save version')}</Button>
  </Dialog.Content></Dialog.Portal></Dialog.Root>
})
