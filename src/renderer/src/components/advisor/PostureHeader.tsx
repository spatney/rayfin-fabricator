import { useEffect, useRef, useState, type JSX } from 'react'
import type { ChatToolCall } from '@shared/ipc'
import type { DerivedAdvisor } from '../../advisor/lifecycle'
import type { NormalizedSnapshot } from '../../advisor/legacy'
import type { QuickCheckResult } from '../../advisor/engine'
import type { ReviewRun } from '../../advisor/store'
import { PENALTY, CATEGORY_CAP, type HealthScore } from '../../advisor/score'
import { StepRow } from '../chat/StepRow'
import { describeStep, stepLabel } from '../chat/toolPresentation'
import { ChevronRightIcon, Codicon } from '../icons'
import { ChecksMeter } from './ChecksMeter'
import { clock, plural, relativeTime } from './format'

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
  const tone = gradeTone(score)
  const dash = loading ? 0 : (Math.max(0, Math.min(100, score.score)) / 100) * CIRCUMFERENCE
  const how =
    `Score ${score.score}/100. Each open issue takes points off — high ${PENALTY.high}, medium ` +
    `${PENALTY.medium}, low ${PENALTY.low} — with at most ${CATEGORY_CAP} per area.` +
    (score.capped ? ' An open high-severity security issue holds the grade at C.' : '') +
    (score.provisional ? ' Provisional: based on the quick checks until a deep review is current.' : '')
  return (
    <div
      className={`adv-grade adv-grade--${tone}${score.provisional ? ' is-provisional' : ''}${updating ? ' is-updating' : ''}${loading ? ' is-loading' : ''}`}
      title={loading ? 'Checking your app…' : how}
      role="img"
      aria-label={
        loading
          ? 'Health grade pending'
          : `Health grade ${score.grade}, score ${score.score} out of 100${score.provisional ? ', provisional' : ''}`
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
  const running = [...review.activity].reverse().find((t) => t.state === 'running')
  if (running) return `${stepLabel(describeStep(running, projectPath))}…`
  if (review.activity.length === 0) return 'Starting the review…'
  if (review.results.length > 0 || review.findings.length > 0) return 'Recording what it found…'
  return 'Thinking…'
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
      aria-label="Review activity"
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
    headline = 'Checking your app…'
    sub = 'Running the quick checks. This takes a moment.'
  } else if (running) {
    headline = 'Copilot is reviewing your app'
    sub = ''
  } else if (issues === 0) {
    headline = 'Looking good'
    sub = deepCurrent
      ? 'No open issues across the quick checks and the latest deep review.'
      : 'No issues in the quick checks. A deep review has Copilot check the rules that need judgment.'
  } else {
    headline = `${plural(issues, 'issue')} ${issues === 1 ? 'needs' : 'need'} attention`
    sub = deepCurrent
      ? 'From the quick checks and the latest deep review.'
      : 'From the quick checks. A deep review can find issues that need judgment.'
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
        <Codicon name="list-unordered" /> Activity · {plural(review.activity.length, 'step')}
        <ChevronRightIcon className="adv-activity-caret" />
      </button>
    ) : null

  return (
    <section className={`adv-hero adv-hero--${tone}`} aria-label="Advisor summary">
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
          {counts.high > 0 && <span className="adv-chip adv-chip--high">{counts.high} high</span>}
          {counts.medium > 0 && <span className="adv-chip adv-chip--medium">{counts.medium} medium</span>}
          {counts.low > 0 && <span className="adv-chip adv-chip--low">{counts.low} low</span>}
          {counts.note > 0 && <span className="adv-chip adv-chip--note">{plural(counts.note, 'note')}</span>}
          {derived.newCount > 0 && <span className="adv-chip adv-chip--new">{derived.newCount} new</span>}
          {derived.resolved.length > 0 && (
            <span className="adv-chip adv-chip--resolved">
              <Codicon name="check" /> {derived.resolved.length} resolved
            </span>
          )}
          <span className="adv-hero-meta">
            {quick ? `Quick checks ${relativeTime(quick.ranAt, now)}` : 'Quick checks running…'}
            {' · '}
            {running
              ? 'Deep review in progress'
              : deep?.report.ok
                ? `Deep review ${relativeTime(deep.analyzedAt, now)}${deepCurrent ? '' : ' (outdated)'}`
                : 'No deep review yet'}
          </span>
        </div>
      </div>
      <div className="adv-hero-side">
        {running ? (
          <>
            <span className="adv-hero-clock" aria-label="Elapsed time">
              {clock(now - review.startedAt)}
            </span>
            <button type="button" className="btn btn--sm btn--ghost" onClick={onStop}>
              <Codicon name="debug-stop" /> Stop review
            </button>
          </>
        ) : target > 0 ? (
          <button
            type="button"
            className="btn btn--primary adv-fix-cta"
            onClick={onFix}
            disabled={chatBusy}
            title={
              chatBusy
                ? 'Copilot is working on a task — fixes resume when it finishes'
                : 'Send these findings to the Build chat for Copilot to fix in one task'
            }
          >
            <Codicon name="sparkle" />
            {selectedCount > 0 ? `Fix selected (${selectedCount})` : `Fix ${target} with Copilot`}
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
