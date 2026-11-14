import { useEffect, useRef, useState, type JSX } from 'react'
import type { ChatToolCall } from '@shared/ipc'
import type { DerivedAdvisor } from '../../advisor/lifecycle'
import type { NormalizedSnapshot } from '../../advisor/legacy'
import type { QuickCheckResult } from '../../advisor/engine'
import type { ReviewRun } from '../../advisor/store'
import { PENALTY, CATEGORY_CAP, type HealthScore } from '../../advisor/score'
import { translator, useTranslation } from '../../i18n'
import { StepRow } from '../chat/StepRow'
import { describeStep, stepLabel } from '../chat/toolPresentation'
import { ChevronRightIcon, Codicon } from '../icons'
import { ChecksMeter } from './ChecksMeter'
import { clock, relativeTime } from './format'

function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = window.setInterval(() => setNow(Date.now()), ms)
    return () => window.clearInterval(t)
  }, [active, ms])
  return now
}

function gradeTone(score: HealthScore): 'ok' | 'warn' | 'bad' {
  if (score.grade === 'A' || score.grade === 'B') return 'ok'
  if (score.grade === 'C') return 'warn'
  return 'bad'
}

const RADIUS = 30
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

export function GradeRing({
  score,
  updating = false,
  loading = false
}: {
  score: HealthScore
  /** A deep review is running, so the grade is about to change. */
  updating?: boolean
  loading?: boolean
}): JSX.Element {
  const { t } = useTranslation('advisor')
  const tone = gradeTone(score)
  const dash = loading ? 0 : (Math.max(0, Math.min(100, score.score)) / 100) * CIRCUMFERENCE
  const how =
    t('posture.how', {
      score: score.score,
      high: PENALTY.high,
      medium: PENALTY.medium,
      low: PENALTY.low,
      cap: CATEGORY_CAP
    }) +
    (score.capped ? t('posture.howCapped') : '') +
    (score.provisional ? t('posture.howProvisional') : '')
  return (
    <div
      className={`adv-grade adv-grade--${tone}${score.provisional ? ' is-provisional' : ''}${updating ? ' is-updating' : ''}${loading ? ' is-loading' : ''}`}
      title={loading ? t('checkingApp') : how}
      role="img"
      aria-label={
        loading
          ? t('posture.gradePending')
          : t(score.provisional ? 'posture.gradeProvisional' : 'posture.grade', {
              grade: score.grade,
              score: score.score
            })
      }
    >
      <svg viewBox="0 0 72 72" aria-hidden="true">
        <circle className="adv-grade-track" cx="36" cy="36" r={RADIUS} />
        {dash > 0 && (
          <circle
            className="adv-grade-value"
            cx="36"
            cy="36"
            r={RADIUS}
            strokeDasharray={`${dash} ${CIRCUMFERENCE}`}
            transform="rotate(-90 36 36)"
          />
        )}
        {(updating || loading) && <circle className="adv-grade-sweep" cx="36" cy="36" r={RADIUS} />}
      </svg>
      <span className="adv-grade-letter">{loading ? '–' : score.grade}</span>
      <span className="adv-grade-score">{loading ? '' : score.score}</span>
    </div>
  )
}

/** What the deep review is doing right now, in a few words. */
export function livePhase(review: ReviewRun, projectPath: string): string {
  const t = translator('advisor')
  const running = [...review.activity].reverse().find((step) => step.state === 'running')
  if (running) return `${stepLabel(describeStep(running, projectPath))}…`
  if (review.activity.length === 0) return t('posture.phase.starting')
  if (review.results.length > 0 || review.findings.length > 0) return t('posture.phase.recording')
  return t('posture.phase.thinking')
}

/** The review's step log, newest at the bottom; follows new steps unless you scroll up. */
function ActivityLog({
  tools,
  projectPath,
  onOpenFile
}: {
  tools: ChatToolCall[]
  projectPath: string
  onOpenFile: (path: string) => void
}): JSX.Element {
  const { t } = useTranslation('advisor')
  const ref = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (el && follow.current) el.scrollTop = el.scrollHeight
  }, [tools])
  return (
    <div
      className="adv-activity"
      ref={ref}
      role="log"
      aria-label={t('posture.activity')}
      onScroll={(e) => {
        const el = e.currentTarget
        follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      }}
    >
      <div className="worklog worklog--live is-open">
        <div className="worklog-body">
          {tools.map((tool) => (
            <StepRow key={tool.id} tool={tool} projectPath={projectPath} onOpenFile={onOpenFile} />
          ))}
        </div>
      </div>
    </div>
  )
}

export function PostureHeader({
  derived,
  review,
  deep,
  quick,
  loading,
  deepCurrent,
  fixCount,
  selectedCount,
  chatBusy,
  projectPath,
  onFix,
  onStop,
  onOpenFile
}: {
  derived: DerivedAdvisor
  review: ReviewRun
  deep: NormalizedSnapshot | null
  quick: QuickCheckResult | null
  /** The quick checks haven't produced a first result yet. */
  loading: boolean
  deepCurrent: boolean
  fixCount: number
  selectedCount: number
  chatBusy: boolean
  projectPath: string
  onFix: () => void
  onStop: () => void
  onOpenFile: (path: string) => void
}): JSX.Element {
  const { t } = useTranslation('advisor')
  const running = review.running
  const now = useNow(running)
  const [showActivity, setShowActivity] = useState(false)
  useEffect(() => {
    if (!running) setShowActivity(false)
  }, [running])
  const { counts } = derived.score
  const issues = counts.high + counts.medium + counts.low
  const target = selectedCount > 0 ? selectedCount : fixCount

  let headline: string
  let sub: string
  if (loading) {
    headline = t('checkingApp')
    sub = t('posture.loadingSub')
  } else if (running) {
    headline = t('posture.running')
    sub = ''
  } else if (issues === 0) {
    headline = t('posture.good')
    sub = deepCurrent ? t('posture.goodDeep') : t('posture.goodQuick')
  } else {
    headline = t('posture.issues', { count: issues })
    sub = deepCurrent ? t('posture.fromDeep') : t('posture.fromQuick')
  }
  const tone = loading ? 'loading' : running ? 'running' : gradeTone(derived.score)

  const activityToggle =
    running && review.activity.length > 0 ? (
      <button
        type="button"
        className="adv-activity-toggle"
        aria-expanded={showActivity}
        onClick={() => setShowActivity((o) => !o)}
      >
        <Codicon name="list-unordered" />{' '}
        {t('posture.activityToggle', { count: review.activity.length })}
        <ChevronRightIcon className="adv-activity-caret" />
      </button>
    ) : null

  return (
    <section className={`adv-hero adv-hero--${tone}`} aria-label={t('posture.section')}>
      <GradeRing score={derived.score} updating={running} loading={loading} />
      <div className="adv-hero-text">
        <h2 className="adv-hero-title">{headline}</h2>
        {running ? (
          <div className="adv-live" role="status" aria-live="polite">
            <span className="agent-status-orb" aria-hidden="true">
              <span className="agent-status-orb-core" />
            </span>
            <span className="adv-live-text">{livePhase(review, projectPath)}</span>
          </div>
        ) : (
          <p className="adv-hero-sub">{sub}</p>
        )}
        <div className="adv-hero-chips">
          {counts.high > 0 && (
            <span className="adv-chip adv-chip--high">
              {t('posture.chips.high', { n: counts.high })}
            </span>
          )}
          {counts.medium > 0 && (
            <span className="adv-chip adv-chip--medium">
              {t('posture.chips.medium', { n: counts.medium })}
            </span>
          )}
          {counts.low > 0 && (
            <span className="adv-chip adv-chip--low">
              {t('posture.chips.low', { n: counts.low })}
            </span>
          )}
          {counts.note > 0 && (
            <span className="adv-chip adv-chip--note">
              {t('posture.chips.notes', { count: counts.note })}
            </span>
          )}
          {derived.newCount > 0 && (
            <span className="adv-chip adv-chip--new">
              {t('posture.chips.new', { n: derived.newCount })}
            </span>
          )}
          {derived.resolved.length > 0 && (
            <span className="adv-chip adv-chip--resolved">
              <Codicon name="check" /> {t('posture.chips.resolved', { n: derived.resolved.length })}
            </span>
          )}
          <span className="adv-hero-meta">
            {quick
              ? t('posture.quickAt', { time: relativeTime(quick.ranAt, now) })
              : t('posture.quickRunning')}
            {' · '}
            {running
              ? t('posture.deepRunning')
              : deep?.report.ok
                ? t(deepCurrent ? 'posture.deepAt' : 'posture.deepAtOutdated', {
                    time: relativeTime(deep.analyzedAt, now)
                  })
                : t('posture.noDeep')}
          </span>
        </div>
      </div>
      <div className="adv-hero-side">
        {running ? (
          <>
            <span className="adv-hero-clock" aria-label={t('posture.elapsed')}>
              {clock(now - review.startedAt)}
            </span>
            <button type="button" className="btn btn--sm btn--ghost" onClick={onStop}>
              <Codicon name="debug-stop" /> {t('posture.stopReview')}
            </button>
          </>
        ) : target > 0 ? (
          <button
            type="button"
            className="btn btn--primary adv-fix-cta"
            onClick={onFix}
            disabled={chatBusy}
            title={chatBusy ? t('detail.fixBusy') : t('posture.fixTitle')}
          >
            <Codicon name="sparkle" />
            {selectedCount > 0
              ? t('posture.fixSelected', { n: selectedCount })
              : t('posture.fixAll', { n: target })}
          </button>
        ) : null}
      </div>
      <ChecksMeter
        checks={derived.checks}
        tally={derived.tally}
        running={running}
        loading={loading}
        aside={activityToggle}
      />
      {running && showActivity && (
        <ActivityLog tools={review.activity} projectPath={projectPath} onOpenFile={onOpenFile} />
      )}
    </section>
  )
}
