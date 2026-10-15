import { useEffect, useRef, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as ContextMenu from '@radix-ui/react-context-menu'
import { Check, ChevronRight, FolderPlus, Loader2, X } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { NoteDialog } from '@/components/NoteDialogs'
import type { RecordingCollection } from '@/lib/knowledge'
import './knowledge.css'

/** Fired after any collection change so the sidebar and library stay in step. */
export const COLLECTIONS_EVENT = 'openplod:collections-changed'

/** Name (and optionally describe) a new or existing recording collection. */
export function CollectionNameDialog({ title, initial = '', onSubmit, onClose }: { title: string; initial?: string; onSubmit: (name: string) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus(); input.current?.select() }, [])
  return <NoteDialog title={title} description="Collections group recordings; a recording can be in several." onClose={onClose} busy={busy}>
    <form onSubmit={async event => {
      event.preventDefault()
      if (!name.trim() || busy) return
      setBusy(true); setError('')
      try { await onSubmit(name.trim()); onClose() }
      catch (failure) { setError(failure instanceof Error ? failure.message : 'The collection could not be saved.') }
      finally { setBusy(false) }
    }}>
      <label htmlFor="collection-name">Name</label>
      <input ref={input} id="collection-name" value={name} maxLength={80} autoComplete="off" disabled={busy} onChange={event => setName(event.target.value)} />
      {error && <p className="note-error" role="alert">{error}</p>}
      <footer><Button type="button" variant="ghost" disabled={busy} onClick={onClose}><X />Cancel</Button><Button disabled={busy || !name.trim()}>{busy ? <Loader2 className="animate-spin" /> : <Check />}Save</Button></footer>
    </form>
  </NoteDialog>
}

type MenuProps = {
  collections: RecordingCollection[]
  memberOf: string[]
  onToggle: (collection: RecordingCollection, member: boolean) => void
  onCreate: () => void
}

/** "Add to collection" submenu for the recording dropdown menu. */
export function CollectionDropdownSubmenu({ collections, memberOf, onToggle, onCreate }: MenuProps) {
  return <DropdownMenu.Sub>
    <DropdownMenu.SubTrigger className="action-menu-sub"><FolderPlus />Add to collection<ChevronRight className="action-menu-chevron" /></DropdownMenu.SubTrigger>
    <DropdownMenu.Portal><DropdownMenu.SubContent className="action-menu" sideOffset={4}>
      {collections.map(collection => <DropdownMenu.CheckboxItem key={collection.id} checked={memberOf.includes(collection.id)} onSelect={event => event.preventDefault()} onCheckedChange={checked => onToggle(collection, checked === true)}>
        <span className="action-menu-indicator"><DropdownMenu.ItemIndicator><Check /></DropdownMenu.ItemIndicator></span>{collection.name}
      </DropdownMenu.CheckboxItem>)}
      {collections.length > 0 && <DropdownMenu.Separator />}
      <DropdownMenu.Item onSelect={onCreate}><FolderPlus />New collection…</DropdownMenu.Item>
    </DropdownMenu.SubContent></DropdownMenu.Portal>
  </DropdownMenu.Sub>
}

/** The same submenu for the recording right-click menu. */
export function CollectionContextSubmenu({ collections, memberOf, onToggle, onCreate }: MenuProps) {
  return <ContextMenu.Sub>
    <ContextMenu.SubTrigger className="action-menu-sub"><FolderPlus />Add to collection<ChevronRight className="action-menu-chevron" /></ContextMenu.SubTrigger>
    <ContextMenu.Portal><ContextMenu.SubContent className="action-menu" sideOffset={4}>
      {collections.map(collection => <ContextMenu.CheckboxItem key={collection.id} checked={memberOf.includes(collection.id)} onSelect={event => event.preventDefault()} onCheckedChange={checked => onToggle(collection, checked === true)}>
        <span className="action-menu-indicator"><ContextMenu.ItemIndicator><Check /></ContextMenu.ItemIndicator></span>{collection.name}
      </ContextMenu.CheckboxItem>)}
      {collections.length > 0 && <ContextMenu.Separator />}
      <ContextMenu.Item onSelect={onCreate}><FolderPlus />New collection…</ContextMenu.Item>
    </ContextMenu.SubContent></ContextMenu.Portal>
  </ContextMenu.Sub>
}
