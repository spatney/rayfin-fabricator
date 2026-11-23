import { Codicon } from '../icons'
import { LOCAL_QUESTION } from '../local/problems'
import { translator } from '../../i18n'

import type { JSX } from 'react'

/** What Help is asked when a failed publish's **Find out why** opens it. */
export const DEPLOY_QUESTION = 'Why did my last publish fail?'

/**
 * The starter questions and their catalog keys. The English text stays each
 * question's id, so callers can match on it whatever the language.
 */
const STARTERS = [
  [DEPLOY_QUESTION, 'prompts.deploy'],
  ['What\u2019s new in this release?', 'prompts.whatsNew'],
  ['The preview won\u2019t start', 'prompts.previewWontStart'],
  ['How do I share my app with someone?', 'prompts.share']
] as const

/** Starter questions shown on an empty Help screen. */
export const PROMPTS: string[] = STARTERS.map(([text]) => text)

/** Questions other screens open Help with, keyed the same way. */
const KNOWN = [...STARTERS, [LOCAL_QUESTION, 'prompts.localStart']] as const

/** A known question as the user reads and asks it; any other question as it is. */
export function promptText(question: string): string {
  const key = KNOWN.find(([text]) => text === question)?.[1]
  return key ? translator('help')(key) : question
}

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
  // `help_local_output`: the app's output on this computer.
  if (/output/i.test(name)) return 'output'
  return 'circle-small-filled'
}

/** Render a step's icon. */
export function StepIcon({ name }: { name: string }): JSX.Element {
  return <Codicon name={stepIcon(name)} />
}
