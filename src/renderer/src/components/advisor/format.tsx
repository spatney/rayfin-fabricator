import type { AdvisorCategoryId } from '@shared/ipc'
import { AccessibilityIcon, Codicon } from '../icons'

import type { JSX } from 'react'

const GLYPHS: Record<AdvisorCategoryId, string> = {
  access: 'shield',
  policy: 'key',
  secrets: 'lock',
  'data-model': 'database',
  queries: 'search',
  config: 'settings-gear',
  platform: 'package',
  performance: 'zap',
  accessibility: ''
}

/** The glyph for an Advisor category. */
export function CategoryIcon({ id, className = '' }: { id: string; className?: string }): JSX.Element {
  if (id === 'accessibility') return <AccessibilityIcon className={`adv-cat-svg ${className}`.trim()} />
  return <Codicon name={GLYPHS[id as AdvisorCategoryId] || 'circle-large-outline'} className={className} />
}

/** Coarse "x ago" for when something happened. */
export function relativeTime(iso: string | undefined, now = Date.now()): string {
  const then = iso ? new Date(iso).getTime() : NaN
  if (!then || Number.isNaN(then)) return 'recently'
  const s = Math.max(0, Math.floor((now - then) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(then).toLocaleDateString()
}

/** `1:07` style elapsed clock. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** `src/pages/Home.tsx:12` → `Home.tsx:12`. */
export function shortLocation(file?: string, line?: number): string | undefined {
  if (!file) return undefined
  const base = file.split('/').pop() ?? file
  return line ? `${base}:${line}` : base
}

/** Catalog text with its `backticked` spans rendered as inline code. */
export function CodeText({ text }: { text: string }): JSX.Element {
  const parts = text.split(/(`[^`]+`)/g)
  return (
    <>
      {parts.map((part, i) =>
        part.length > 2 && part.startsWith('`') && part.endsWith('`') ? (
          <code key={i} className="adv-code">
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        )
      )}
    </>
  )
}

/** The same text without backticks (for labels and tooltips). */
export function plainText(text: string): string {
  return text.replace(/`/g, '')
}
