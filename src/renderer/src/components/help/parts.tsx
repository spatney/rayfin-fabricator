import { Codicon } from '../icons'

import type { JSX } from 'react'

/** What Help is asked when a failed deploy's **Find out why** opens it. */
export const DEPLOY_QUESTION = 'Why did my last deploy fail?'

/** Starter questions shown on an empty Help screen. */
export const PROMPTS = [
  DEPLOY_QUESTION,
  'What&apos;s new in this release?',
  'The preview won&apos;t start',
  'How do I share my app with someone?'
].map((text) => text.replace(/&apos;/g, '\u2019'))

/**
 * The working indicator: three dots that cycle. Plain CSS so it costs nothing
 * while a turn streams, and it respects reduced-motion.
 */
export function Spinner(): JSX.Element {
  return (
    <span className="help-spin" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  )
}

/** A small status dot, matching the flat treatment used elsewhere. */
export function Dot({ tone }: { tone: 'ok' | 'busy' | 'bad' }): JSX.Element {
  return <span className={`help-dot help-dot--${tone}`} aria-hidden="true" />
}

/** The icon for one work-log step, by tool name. */
export function stepIcon(name: string): string {
  if (/read|view|cat/i.test(name)) return 'file'
  if (/grep|search|find/i.test(name)) return 'search'
  if (/glob|list|tree|dir/i.test(name)) return 'list-tree'
  if (/fetch|url|web/i.test(name)) return 'globe'
  return 'circle-small-filled'
}

/** Render a step's icon. */
export function StepIcon({ name }: { name: string }): JSX.Element {
  return <Codicon name={stepIcon(name)} />
}
