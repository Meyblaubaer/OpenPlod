import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fr } from './fr'
import { setLocale, t, tn } from './index'

const root = join(import.meta.dir, '..')
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'i18n' ? [] : sources(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}
/** Literal first arguments of t() and the two forms of tn(). */
function keys(): Map<string, string> {
  const found = new Map<string, string>()
  const literal = String.raw`(['"\`])((?:\\.|(?!\1)[^\\])*)\1`
  const call = new RegExp(String.raw`\bt\(\s*${literal}`, 'g')
  const plural = new RegExp(String.raw`\btn\([^,]+,\s*${literal}\s*,\s*${literal}`, 'g')
  for (const file of sources(root)) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(call)) if (match[1] !== '`' || !match[2].includes('${')) found.set(match[2].replace(/\\(['"`\\])/g, '$1'), file)
    for (const match of text.matchAll(plural)) { found.set(match[2].replace(/\\(['"`\\])/g, '$1'), file); found.set(match[4].replace(/\\(['"`\\])/g, '$1'), file) }
  }
  return found
}

describe('UI localization', () => {
  test('every translated string has a French entry', () => {
    const missing = [...keys()].filter(([key]) => !(key in fr)).map(([key, file]) => `${file.replace(root, 'src')}: ${key}`)
    expect(missing).toEqual([])
  })
  test('French entries keep their placeholders', () => {
    for (const [key, value] of Object.entries(fr)) {
      const names = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
      expect([key, names(value)]).toEqual([key, names(key)])
    }
  })
  test('interpolation and plurals', () => {
    setLocale('en')
    expect(t('Hello {name}', { name: 'Remi' })).toBe('Hello Remi')
    expect(tn(1, '{count} recording', '{count} recordings')).toBe('1 recording')
    expect(tn(3, '{count} recording', '{count} recordings')).toBe('3 recordings')
  })
})
