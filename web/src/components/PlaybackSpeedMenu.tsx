import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown, Gauge } from "@/components/icons"
import { Button } from './ui/button'
import { t } from '@/i18n'

export function PlaybackSpeedMenu({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild>
      <Button className="playback-speed" variant="ghost" size="sm" aria-label={t('Playback speed: {value}x', { value })}>
        <Gauge /><span>{value}x</span><ChevronDown />
      </Button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content className="action-menu" align="start" sideOffset={6}>
        <DropdownMenu.Label className="action-menu-label">{t('Playback speed')}</DropdownMenu.Label>
        <DropdownMenu.RadioGroup value={String(value)} onValueChange={next => onChange(Number(next))}>
          {[0.75, 1, 1.25, 1.5, 2].map(rate => <DropdownMenu.RadioItem key={rate} value={String(rate)}>
            <span className="action-menu-indicator"><DropdownMenu.ItemIndicator><Check /></DropdownMenu.ItemIndicator></span>{rate}x
          </DropdownMenu.RadioItem>)}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
}
