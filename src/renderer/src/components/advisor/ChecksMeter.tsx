import { memo, useMemo, type ReactNode, type JSX } from 'react'
import { ruleById } from '@shared/advisor/catalog'
import type { CheckOutcome, CheckTally, CheckView } from '../../advisor/lifecycle'
import { plainText, plural } from './format'

/** Settled results fill in from the left; checks still waiting trail on the right. */
const STRIP_ORDER: Record<Exclude<CheckOutcome, 'na'>, number> = {
  high: 0,
  medium: 1,
  low: 2,
  note: 3,
  passed: 4,
  dismissed: 5,
  skipped: 6,
  waiting: 7
}

const OUTCOME_LABEL: Record<CheckOutcome, string> = {
  high: 'High-severity issue',
  medium: 'Medium-severity issue',
  low: 'Low-severity issue',
  note: 'Suggestion',
  passed: 'Passed',
  dismissed: 'Dismissed',
  skipped: 'Couldn’t be checked',
  waiting: 'Needs a deep review',
  na: 'Doesn’t apply'
}

/**
 * One block per applicable rule, colored by outcome, with a plain-language
 * legend. While a deep review runs, the waiting blocks shimmer and flip to
 * results as Copilot reports them, so the strip doubles as progress.
 */
export const ChecksMeter = memo(function ChecksMeter({
  checks,
  tally,
  running,
  loading,
  aside
}: {
  checks: CheckView[]
  tally: CheckTally
  running: boolean
  /** The quick checks haven't finished their first run. */
  loading: boolean
  /** Extra controls at the end of the legend (the activity toggle). */
  aside?: ReactNode
}): JSX.Element {
  const blocks = useMemo(
    () =>
      checks
        .filter((c): c is CheckView & { outcome: Exclude<CheckOutcome, 'na'> } => c.outcome !== 'na')
        .sort((a, b) => STRIP_ORDER[a.outcome] - STRIP_ORDER[b.outcome]),
    [checks]
  )
  const worst = blocks[0]?.outcome
  const issueKey = worst === 'high' || worst === 'medium' || worst === 'low' ? worst : 'medium'

  return (
    <div className={`adv-meter${running ? ' is-running' : ''}${loading ? ' is-loading' : ''}`}>
      <div className="adv-meter-strip" aria-hidden="true">
        {loading
          ? null
          : blocks.map((c) => {
              const rule = ruleById(c.ruleId)
              const label = c.running ? 'Copilot is checking it now' : OUTCOME_LABEL[c.outcome]
              return (
                <span
                  key={c.ruleId}
                  className={`adv-meter-block adv-meter-block--${c.outcome}`}
                  title={`${plainText(rule?.summary ?? c.ruleId)} — ${label}`}
                />
              )
            })}
      </div>
      <div className="adv-meter-legend">
        {loading ? (
          <span className="shimmer-text">Running the quick checks…</span>
        ) : (
          <>
            {tally.issues > 0 && (
              <span className="adv-meter-item">
                <i className={`adv-key adv-key--${issueKey}`} aria-hidden="true" />
                {plural(tally.issues, 'check')} with issues
              </span>
            )}
            {tally.notes > 0 && (
              <span className="adv-meter-item">
                <i className="adv-key adv-key--note" aria-hidden="true" />
                {plural(tally.notes, 'suggestion')}
              </span>
            )}
            <span className="adv-meter-item">
              <i className="adv-key adv-key--passed" aria-hidden="true" />
              {tally.passed} passed
            </span>
            {tally.dismissed > 0 && (
              <span className="adv-meter-item">
                <i className="adv-key adv-key--dismissed" aria-hidden="true" />
                {tally.dismissed} dismissed
              </span>
            )}
            {tally.skipped > 0 && (
              <span className="adv-meter-item">
                <i className="adv-key adv-key--skipped" aria-hidden="true" />
                {tally.skipped} couldn’t be checked
              </span>
            )}
            {tally.waiting > 0 && (
              <span className="adv-meter-item">
                <i className="adv-key adv-key--waiting" aria-hidden="true" />
                {running ? `${tally.waiting} being checked by Copilot` : `${tally.waiting} need a deep review`}
              </span>
            )}
            <span className="adv-meter-total">{plural(tally.applicable, 'check')} for this app</span>
          </>
        )}
        {aside && (
          <>
            <span className="adv-meter-spacer" />
            {aside}
          </>
        )}
      </div>
    </div>
  )
})
