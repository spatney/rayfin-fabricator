import { createContext, useContext, useState, type JSX } from 'react'
import type { ChatAdvisorFix, ChatAdvisorSummary } from '@shared/ipc'
import { normalizeSeverity } from '@shared/advisor/catalog'
import type { FixOutcome } from '../../advisor/lifecycle'
import { categoryTitle, findingTitle } from '../../advisor/ruleText'
import { useTranslation } from '../../i18n'
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

/** Where an issue stands once it isn't fixed (a fixed one gets a check instead of its dot). */
function chipFor(outcome: FixOutcome) {
  switch (outcome) {
    case 'applied':
      return { label: 'fixSummary.applied', tone: 'applied', tip: 'fixSummary.appliedTip' } as const
    case 'still':
      return { label: 'fixSummary.still', tone: 'still', tip: 'fixSummary.stillTip' } as const
    case 'dismissed':
      return {
        label: 'fixSummary.dismissed',
        tone: 'muted',
        tip: 'fixSummary.dismissedTip'
      } as const
    case 'muted':
      return { label: 'fixSummary.muted', tone: 'muted', tip: 'fixSummary.mutedTip' } as const
    default:
      return undefined
  }
}

/** Rows shown before the rest fold behind "Show more". */
const LIMIT = 5

/** The file's name and line, e.g. `Contact.ts:12` (the full path is its tooltip). */
function shortPlace(file: string, line?: number): string {
  const name = file.split(/[\\/]/).pop() || file
  return line ? `${name}:${line}` : name
}

function FixRow({
  fix,
  outcome,
  onShow
}: {
  fix: ChatAdvisorFix
  outcome?: FixOutcome
  onShow?: () => void
}): JSX.Element {
  const { t } = useTranslation('advisor')
  const sev = normalizeSeverity(fix.severity)
  const category = categoryTitle(fix.category)
  const where = fix.file ? (fix.line ? `${fix.file}:${fix.line}` : fix.file) : undefined
  const fixed = outcome === 'fixed'
  const chip = outcome && !fixed ? chipFor(outcome) : undefined
  const body = (
    <>
      <span className="adv-fix-mark">
        {fixed ? (
          <i
            className="codicon codicon-pass-filled adv-fix-done"
            role="img"
            aria-label={t('fixSummary.fixed')}
            title={t('fixSummary.fixedTitle')}
          />
        ) : (
          <i
            className={`adv-sev-dot adv-sev-dot--${sev}`}
            role="img"
            aria-label={t(`severity.${sev}Aria`)}
            title={t(`severity.${sev}Aria`)}
          />
        )}
      </span>
      <span className="adv-fix-main">
        <span className="adv-fix-name">
          <CodeText text={findingTitle(fix)} />
          {fix.places && fix.places > 1 ? <span className="adv-fix-count">×{fix.places}</span> : null}
        </span>
        <span className="adv-fix-meta">
          <CategoryIcon id={fix.category} className="adv-fix-cat" />
          <span className="adv-fix-cat-name">{category}</span>
          {fix.file && (
            <>
              <span aria-hidden="true">·</span>
              <span className="adv-fix-where" title={where}>
                {shortPlace(fix.file, fix.line)}
              </span>
            </>
          )}
        </span>
      </span>
      {chip && (
        // Keyed so a changed outcome pops in.
        <span key={outcome} className={`adv-status adv-status--${chip.tone}`} title={t(chip.tip)}>
          {t(chip.label)}
        </span>
      )}
    </>
  )
  return (
    <li>
      {onShow ? (
        <button
          type="button"
          className="adv-fix-row"
          onClick={onShow}
          title={t('fixSummary.showInAdvisor')}
        >
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
 * each issue with its severity, area, and place, then where it stands as the
 * Advisor re-checks the app — a check once it's fixed, else a word (still
 * detected, dismissed, and so on). While the turn runs the card just says it's
 * fixing. The full prompt stays behind a disclosure.
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
  const { t } = useTranslation('advisor')
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
        {working ? t('fixSummary.fixing') : t('status.checking')}
      </span>
    )
  } else if (n > 1 && fixed > 0) {
    const all = fixed === n
    progress = (
      <span key={all ? 'all' : 'some'} className={`adv-fix-progress${all ? ' is-done' : ''}`}>
        <Codicon name={all ? 'pass-filled' : 'check'} />
        {all
          ? t('fixSummary.allFixed', { total: n })
          : t('fixSummary.someFixed', { fixed, total: n })}
      </span>
    )
  }

  return (
    <div className="adv-fix" role="group" aria-label={t('fixSummary.label', { total: n })}>
      <div className="adv-fix-head">
        <Codicon name="shield" className="adv-fix-ico" />
        <span className="adv-fix-title">{t('fixSummary.title', { count: n })}</span>
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
          {expanded ? t('fixSummary.showFewer') : t('fixSummary.showMore', { more: n - LIMIT })}
        </button>
      )}
      {prompt && (
        <details className="adv-fix-details">
          <summary>{t('fixSummary.details')}</summary>
          <pre>{prompt}</pre>
        </details>
      )}
    </div>
  )
}
