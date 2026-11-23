import { memo, useMemo, type ReactNode, type JSX } from 'react'
import { ruleById } from '@shared/advisor/catalog'
import type { CheckOutcome, CheckTally, CheckView } from '../../advisor/lifecycle'
import { ruleText } from '../../advisor/ruleText'
import { useTranslation } from '../../i18n'
import { plainText } from './format'

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

const OUTCOME_LABEL = {
  high: 'meter.outcome.high',
  medium: 'meter.outcome.medium',
  low: 'meter.outcome.low',
  note: 'meter.outcome.note',
  passed: 'meter.outcome.passed',
  dismissed: 'meter.outcome.dismissed',
  skipped: 'meter.outcome.skipped',
  waiting: 'meter.outcome.waiting',
  na: 'meter.outcome.na'
} as const satisfies Record<CheckOutcome, string>

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
  const { t } = useTranslation('advisor')
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
              const label = c.running ? t('meter.checkingNow') : t(OUTCOME_LABEL[c.outcome])
              return (
                <span
                  key={c.ruleId}
                  className={`adv-meter-block adv-meter-block--${c.outcome}`}
                  title={t('meter.blockTitle', {
                    rule: plainText(rule ? ruleText(rule, 'summary') : c.ruleId),
                    outcome: label
                  })}
                />
              )
            })}
      </div>
      <div className="adv-meter-legend">
        {loading ? (
          <span className="shimmer-text">{t('meter.running')}</span>
        ) : (
          <>
            {tally.issues > 0 && (
              <span className="adv-meter-item">
                <i className={`adv-key adv-key--${issueKey}`} aria-hidden="true" />
                {t('meter.issues', { count: tally.issues })}
              </span>
            )}
            {tally.notes > 0 && (
              <span className="adv-meter-item">
                <i className="adv-key adv-key--note" aria-hidden="true" />
                {t('counts.suggestions', { count: tally.notes })}
              </span>
            )}
            <span className="adv-meter-item">
              <i className="adv-key adv-key--passed" aria-hidden="true" />
              {t('counts.passed', { count: tally.passed })}
            </span>
            {tally.dismissed > 0 && (
              <span className="adv-meter-item">
                <i className="adv-key adv-key--dismissed" aria-hidden="true" />
                {t('counts.dismissed', { count: tally.dismissed })}
              </span>
            )}
            {tally.skipped > 0 && (
              <span className="adv-meter-item">
                <i className="adv-key adv-key--skipped" aria-hidden="true" />
                {t('meter.skipped', { count: tally.skipped })}
              </span>
            )}
            {tally.waiting > 0 && (
              <span className="adv-meter-item">
                <i className="adv-key adv-key--waiting" aria-hidden="true" />
                {running
                  ? t('meter.beingCheckedByCopilot', { count: tally.waiting })
                  : t('counts.needDeep', { count: tally.waiting })}
              </span>
            )}
            <span className="adv-meter-total">{t('meter.total', { count: tally.applicable })}</span>
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
