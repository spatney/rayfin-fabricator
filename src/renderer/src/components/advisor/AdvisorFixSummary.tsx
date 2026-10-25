import { createContext, useContext, useState, type JSX } from 'react'
import type { ChatAdvisorFix, ChatAdvisorSummary } from '@shared/ipc'
import { categoryById, normalizeSeverity, severityLabel } from '@shared/advisor/catalog'
import type { FixOutcome } from '../../advisor/lifecycle'
import { Codicon } from '../icons'
import { CategoryIcon, CodeText } from './format'
import './advisor.css'

/** The Advisor, as seen from the Build chat's fix cards. */
export interface AdvisorFixLinks {
  /** Where a finding stands now (undefined when the Advisor doesn't know it). */
  outcome: (id: string) => FixOutcome | undefined
  /** Open the finding in the Advisor. */
  show: (id: string) => void
}

/** Provided around the Build chat so fix cards can follow their findings live. */
export const AdvisorFixContext = createContext<AdvisorFixLinks | null>(null)

const CHIPS: Partial<Record<FixOutcome, { label: string; tone: string; tip: string; icon?: string }>> = {
  fixed: { label: 'Fixed', tone: 'fixed', icon: 'pass-filled', tip: 'The Advisor no longer detects this issue' },
  applied: { label: 'Fix applied', tone: 'applied', tip: 'Copilot applied a fix — verify it in the Advisor' },
  still: { label: 'Still detected', tone: 'still', tip: 'The Advisor still detects this issue' },
  dismissed: { label: 'Dismissed', tone: 'muted', tip: 'Dismissed in the Advisor' },
  muted: { label: 'Rule muted', tone: 'muted', tip: 'This rule is muted in the Advisor' }
}

/** Rows shown before the rest fold behind "Show more". */
const LIMIT = 5

function FixRow({
  fix,
  outcome,
  onShow
}: {
  fix: ChatAdvisorFix
  outcome?: FixOutcome
  onShow?: () => void
}): JSX.Element {
  const sev = normalizeSeverity(fix.severity)
  const category = categoryById(fix.category)?.title ?? fix.category
  const where = fix.file ? (fix.line ? `${fix.file}:${fix.line}` : fix.file) : undefined
  const chip = outcome ? CHIPS[outcome] : undefined
  const body = (
    <>
      <i
        className={`adv-sev-dot adv-sev-dot--${sev}`}
        role="img"
        aria-label={`${severityLabel(sev)} severity`}
        title={`${severityLabel(sev)} severity`}
      />
      <span className="adv-fix-main">
        <span className="adv-fix-name">
          <CodeText text={fix.title} />
          {fix.places && fix.places > 1 ? <span className="adv-fix-count">×{fix.places}</span> : null}
        </span>
        <span className="adv-fix-meta">
          <CategoryIcon id={fix.category} className="adv-fix-cat" />
          <span className="adv-fix-cat-name">{category}</span>
          {where && (
            <>
              <span aria-hidden="true">·</span>
              <span className="adv-fix-where" title={where}>
                {where}
              </span>
            </>
          )}
        </span>
      </span>
      {chip && (
        // Keyed so a changed outcome pops in.
        <span key={outcome} className={`adv-status adv-status--${chip.tone}`} title={chip.tip}>
          {chip.icon && <Codicon name={chip.icon} />}
          {chip.label}
        </span>
      )}
    </>
  )
  return (
    <li>
      {onShow ? (
        <button type="button" className="adv-fix-row" onClick={onShow} title="Show in the Advisor">
          {body}
        </button>
      ) : (
        <div className="adv-fix-row">{body}</div>
      )}
    </li>
  )
}

/**
 * The Advisor findings a message handed to Copilot, as a card in the transcript:
 * each issue with its severity, area, and place, then where it stands — fixed,
 * still detected, and so on — as the Advisor re-checks the app. While the turn
 * runs the card just says it's fixing. The full prompt stays behind a disclosure.
 */
export function AdvisorFixSummary({
  summary,
  prompt,
  working = false
}: {
  summary: ChatAdvisorSummary
  prompt?: string
  /** The turn this message started is still running. */
  working?: boolean
}): JSX.Element {
  const links = useContext(AdvisorFixContext)
  const [expanded, setExpanded] = useState(false)
  const fixes = summary.fixes
  const n = fixes.length
  const outcomes = fixes.map((f) => (working ? undefined : links?.outcome(f.id)))
  const fixed = outcomes.filter((o) => o === 'fixed').length
  const checking = outcomes.includes('checking')
  const collapsible = n > LIMIT + 1
  const shown = collapsible && !expanded ? fixes.slice(0, LIMIT) : fixes

  let progress: JSX.Element | null = null
  if (working || checking) {
    progress = (
      <span className="adv-fix-progress is-busy">
        <span className="step-spin" aria-hidden="true" />
        {working ? 'Fixing…' : 'Checking…'}
      </span>
    )
  } else if (n > 1 && fixed > 0) {
    const all = fixed === n
    progress = (
      <span key={all ? 'all' : 'some'} className={`adv-fix-progress${all ? ' is-done' : ''}`}>
        <Codicon name={all ? 'pass-filled' : 'check'} />
        {all ? `All ${n} fixed` : `${fixed} of ${n} fixed`}
      </span>
    )
  }

  return (
    <div className="adv-fix" role="group" aria-label={`Advisor issues to fix (${n})`}>
      <div className="adv-fix-head">
        <Codicon name="shield" className="adv-fix-ico" />
        <span className="adv-fix-title">{n === 1 ? 'Fix an Advisor issue' : `Fix ${n} Advisor issues`}</span>
        {progress}
      </div>
      <ol className="adv-fix-list">
        {shown.map((fix, i) => (
          <FixRow
            key={fix.id}
            fix={fix}
            outcome={outcomes[i]}
            onShow={links ? () => links.show(fix.id) : undefined}
          />
        ))}
      </ol>
      {collapsible && (
        <button type="button" className="adv-fix-more" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show fewer' : `Show ${n - LIMIT} more`}
        </button>
      )}
      {prompt && (
        <details className="adv-fix-details">
          <summary>Details sent to Copilot</summary>
          <pre>{prompt}</pre>
        </details>
      )}
    </div>
  )
}
