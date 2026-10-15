import { useSyncExternalStore } from 'react'
import { fr } from './fr'

/**
 * French/English UI localization (REL-09). English source strings are the keys, so an untranslated
 * string still reads correctly in English; `bun test` fails when a `t()` key has no French entry.
 * Placeholders use `{name}` and are filled from `vars`.
 */
export type Locale = 'en' | 'fr'
export const LOCALES: { id: Locale; label: string }[] = [{ id: 'en', label: 'English' }, { id: 'fr', label: 'Français' }]
const STORAGE_KEY = 'openplod.locale'
const dictionaries: Record<Locale, Record<string, string>> = { en: {}, fr }
const listeners = new Set<() => void>()

function initial(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'en' || saved === 'fr') return saved
  } catch { /* storage unavailable: fall back to the browser language */ }
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('fr') ? 'fr' : 'en'
}
let current: Locale = initial()
if (typeof document !== 'undefined') document.documentElement.lang = current

export const getLocale = () => current
export function setLocale(locale: Locale) {
  current = locale
  try { localStorage.setItem(STORAGE_KEY, locale) } catch { /* preference is per session only */ }
  if (typeof document !== 'undefined') document.documentElement.lang = locale
  for (const listener of listeners) listener()
}
/** Re-renders the caller when the language changes. */
export function useLocale(): Locale {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener) }, getLocale, () => 'en')
}

const fill = (text: string, vars?: Record<string, string | number>) => vars ? text.replace(/\{(\w+)\}/g, (match, name) => name in vars ? String(vars[name]) : match) : text
/** Translate an English UI string. */
export function t(text: string, vars?: Record<string, string | number>): string {
  return fill(dictionaries[current][text] ?? text, vars)
}
/** Translate a count-dependent string: `tn(n, '{count} recording', '{count} recordings')`. */
export function tn(count: number, one: string, other: string, vars?: Record<string, string | number>): string {
  const plural = new Intl.PluralRules(current).select(count) === 'one' ? one : other
  return t(plural, { count, ...vars })
}
/** Dates and numbers in the UI language. */
export const formatDate = (value: string | number | Date, options?: Intl.DateTimeFormatOptions) => new Date(value).toLocaleString(current === 'fr' ? 'fr-FR' : 'en-US', options)
