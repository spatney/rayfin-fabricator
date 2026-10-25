import type { CSSProperties, JSX } from 'react'
import type { SkillInfo } from '@shared/ipc'
import { AccessibilityIcon, Codicon } from '../icons'

/** Where a skill comes from, which decides what you can do with it. */
export type SkillSource = 'rayfin' | 'catalog' | 'library' | 'app'

export function sourceOf(skill: SkillInfo): SkillSource {
  if (skill.base) return 'rayfin'
  if (skill.library) return 'library'
  if (skill.custom) return 'app'
  return 'catalog'
}

/** Rayfin's skills, Fabricator's catalog, and the Universal template's skills. */
const GLYPHS: Record<string, string> = {
  rayfin: 'book',
  'rayfin-functions': 'symbol-method',
  'rayfin-connectors': 'plug',
  'rayfin-storage': 'archive',
  'polished-ui': 'sparkle',
  'buttery-animations': 'play-circle',
  'responsive-layout': 'device-mobile',
  'easy-navigation': 'compass',
  'clear-copy': 'comment',
  'loading-empty-states': 'loading',
  'friendly-forms': 'checklist',
  'data-modeling': 'database',
  'search-and-filter': 'filter',
  'data-viz': 'graph',
  'secure-by-default': 'shield',
  performance: 'zap',
  'app-design': 'symbol-color',
  'build-workflow': 'run-all',
  'capability-router': 'compass',
  'headless-preview': 'eye',
  'rayfin-web-docs': 'book'
}

/** Glyphs for other skills, by what their name suggests. */
const KEYWORDS: [RegExp, string][] = [
  [/auth|sign-?in|login|identity/, 'key'],
  [/secur|permission|access/, 'shield'],
  [/analytic|insight|kpi|dashboard|metric/, 'graph-line'],
  [/chart|visual|graph|viz/, 'graph'],
  [/dax|sql|kusto|kql|query/, 'table'],
  [/data|model|schema|entit/, 'database'],
  [/connector|semantic|fabric/, 'plug'],
  [/function|udf/, 'symbol-method'],
  [/storage|file|upload|blob/, 'archive'],
  [/form|input|valid/, 'checklist'],
  [/design|style|theme|brand/, 'symbol-color'],
  [/preview|test|review/, 'eye'],
  [/doc|guide|reference/, 'book'],
  [/workflow|build|deploy/, 'run-all']
]

/** Category tints for the catalog; other skills get a hue from their name. */
const CATEGORY_HUE: Record<string, number> = {
  'Look & feel': 268,
  Experience: 330,
  Data: 205,
  Quality: 150
}

function hashHue(text: string): number {
  let h = 0
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
}

/** The tile's hue, or null for Rayfin's own skills (a neutral tile). */
function hueFor(skill: SkillInfo): number | null {
  const source = sourceOf(skill)
  if (source === 'rayfin') return null
  if (source === 'catalog') return CATEGORY_HUE[skill.category ?? ''] ?? hashHue(skill.id)
  return hashHue(skill.id)
}

/** An icon someone picked for their own skill (the default puzzle piece doesn't count). */
function chosenEmoji(skill: SkillInfo): string | null {
  const source = sourceOf(skill)
  if (source !== 'library' && source !== 'app') return null
  const icon = skill.icon?.trim()
  return icon && icon !== '🧩' ? icon : null
}

function glyphFor(skill: SkillInfo): string | null {
  return GLYPHS[skill.id] ?? KEYWORDS.find(([pattern]) => pattern.test(skill.id))?.[1] ?? null
}

/** A skill's tile: a tinted glyph, the owner's emoji, or its initial. */
export function SkillMark({ skill, size = 'md' }: { skill: SkillInfo; size?: 'md' | 'lg' }): JSX.Element {
  const hue = hueFor(skill)
  const emoji = chosenEmoji(skill)
  const glyph = emoji ? null : glyphFor(skill)
  return (
    <span
      className={`skl-mark skl-mark--${size}${hue === null ? ' skl-mark--neutral' : ''}`}
      style={hue === null ? undefined : ({ '--hue': hue } as CSSProperties)}
      aria-hidden="true"
    >
      {emoji ? (
        <span className="skl-mark-emoji">{emoji}</span>
      ) : skill.id === 'accessibility' ? (
        <AccessibilityIcon className="skl-mark-svg" />
      ) : glyph ? (
        <Codicon name={glyph} />
      ) : (
        <span className="skl-mark-letter">{(skill.title.trim()[0] ?? '?').toUpperCase()}</span>
      )}
    </span>
  )
}

/** The small label above a skill's name in its details. */
export function kickerFor(skill: SkillInfo): string {
  switch (sourceOf(skill)) {
    case 'rayfin':
      return 'Managed by Rayfin'
    case 'library':
      return 'Your library'
    case 'app':
      return 'This app'
    default:
      return skill.category ? `Built in · ${skill.category}` : 'Built in'
  }
}

/** A skill's state as a small dot and a word. */
export function SkillStatus({ skill }: { skill: SkillInfo }): JSX.Element {
  const [tone, label] = skill.base
    ? ['on', 'Always on']
    : skill.outdated && skill.active
      ? ['update', 'Update available']
      : skill.active
        ? ['on', 'On']
        : ['off', 'Off']
  return (
    <span className={`skl-status skl-status--${tone}`}>
      <span className="skl-status-dot" aria-hidden="true" />
      {label}
    </span>
  )
}

/** An on/off switch. Clicks stay inside it, so a card around it isn't selected too. */
export function SkillSwitch({
  on,
  busy = false,
  label,
  onChange
}: {
  on: boolean
  busy?: boolean
  /** Accessible name, e.g. "Use Fast & snappy in this app". */
  label: string
  onChange: () => void
}): JSX.Element {
  return (
    <span
      className={`skl-switch${on ? ' skl-switch--on' : ''}${busy ? ' skl-switch--busy' : ''}`}
      onClick={(e) => e.stopPropagation()}
    >
      <input
        type="checkbox"
        role="switch"
        checked={on}
        disabled={busy}
        aria-label={label}
        aria-busy={busy || undefined}
        onChange={onChange}
      />
      <span className="skl-switch-knob" aria-hidden="true" />
    </span>
  )
}
