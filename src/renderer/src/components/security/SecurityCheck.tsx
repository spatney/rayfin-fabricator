import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type {
  ChatToolCall,
  SecurityAreaId,
  SecurityAreaResult,
  SecurityFinding,
  SecurityReport,
  SecuritySeverity
} from '@shared/ipc'
import { StepRow } from '../chat/StepRow'
import { describeStep, stepLabel } from '../chat/toolPresentation'
import { formatTurnDuration } from '../chat/format'
import { EvidenceView } from '../advisor/EvidenceView'
import { CodeText, clock, plainText, plural } from '../advisor/format'
import { ChevronRightIcon, Codicon } from '../icons'
import {
  areasFor,
  type SecurityCheck,
  type SecurityCheckKind,
  type SecurityProgress
} from './useSecurityCheck'
import '../chat/chat.css'
import '../advisor/advisor.css'
import './securityCheck.css'

const AREAS: Record<SecurityAreaId, { label: string; about: string }> = {
  install: { label: 'Install scripts', about: 'What npm runs when its packages install' },
  packages: { label: 'Packages', about: 'Where its packages come from' },
  network: { label: 'Data sent out', about: 'What it sends, and where' },
  hidden: { label: 'Hidden code', about: 'Code written to hide what it does' },
  system: { label: 'System access', about: 'What reaches outside the app' },
  agents: { label: 'Copilot instructions', about: 'What it tells Copilot to do while you build' }
}

const SEVERITY: Record<SecuritySeverity, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  note: 'Note'
}

const RANK: Record<SecuritySeverity, number> = { high: 3, medium: 2, low: 1, note: 0 }

/** Scroll what just opened into view, as much of it as fits, from its top. */
function reveal(el: HTMLElement | null): void {
  if (!el || typeof el.scrollIntoView !== 'function') return
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  el.scrollIntoView({ block: 'nearest', behavior: still ? 'auto' : 'smooth' })
}

type Tone = 'running' | 'clear' | 'caution' | 'danger' | 'idle'

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])
  return now
}

/** Worst first; otherwise in the order they were found. */
function sorted(findings: SecurityFinding[]): SecurityFinding[] {
  return findings
    .map((finding, at) => ({ finding, at }))
    .sort((a, b) => RANK[b.finding.severity] - RANK[a.finding.severity] || a.at - b.at)
    .map(({ finding }) => finding)
}

/** Worth knowing: low or worse. */
function counts(finding: SecurityFinding): boolean {
  return RANK[finding.severity] >= 1
}

/** What Copilot is doing right now, in a few words. */
function liveStep(progress: SecurityProgress): string {
  if (!progress.root) return 'Unpacking it, without running anything…'
  const tool = [...progress.activity].reverse().find((t) => t.state === 'running')
  if (tool) return `${stepLabel(describeStep(tool, progress.root))}…`
  if (progress.activity.length === 0) return 'Starting Copilot (Auto)…'
  return 'Thinking…'
}

/** The check's headline, the line under it, and its color. */
function outcome(
  report: SecurityReport,
  findings: SecurityFinding[],
  kind: SecurityCheckKind
): { tone: Tone; title: string; sub: string } {
  const tone: Tone =
    report.verdict === 'danger' ? 'danger' : report.verdict === 'caution' ? 'caution' : 'clear'
  const worth = findings.filter(counts).length
  if (report.cancelled) {
    // What it found before it stopped still counts.
    return {
      tone: tone === 'clear' ? 'idle' : tone,
      title: 'Check stopped',
      sub: worth
        ? `It had found ${plural(worth, 'thing')} to look at when you stopped it.`
        : 'It hadn’t found anything when you stopped it.'
    }
  }
  if (!report.ok && report.files === 0) {
    return { tone: 'idle', title: 'Fabricator couldn’t check it', sub: report.error ?? '' }
  }
  if (!report.ok) {
    return {
      tone: tone === 'clear' ? 'idle' : tone,
      title: 'Copilot couldn’t check it',
      sub: worth
        ? `Fabricator’s own checks found ${plural(worth, 'thing')} to look at.`
        : 'Fabricator’s own checks found nothing risky, but they don’t read the code the way Copilot does.'
    }
  }
  const serious = findings.filter((f) => f.severity === 'high').length
  if (tone === 'danger') {
    const title = serious
      ? `Found ${plural(serious, 'serious risk')}`
      : 'Copilot advises against it'
    return { tone, title, sub: report.summary }
  }
  if (tone === 'caution') {
    const title = worth ? `Found ${plural(worth, 'thing')} to look at` : 'Worth a look first'
    return { tone, title, sub: report.summary }
  }
  const goAhead = kind === 'project' ? 'import it' : 'install it'
  return {
    tone,
    title: 'No security risks found',
    sub: report.summary || `Nothing in it looks risky to ${goAhead}.`
  }
}

/** The check's mark, in one slot so its title stays put as the check starts
 *  and ends: a shield before it starts, a spinner while it runs, then the
 *  verdict's dot. */
function Mark({ tone }: { tone: Tone | null }): JSX.Element {
  return (
    <span className="sec-mark" aria-hidden="true">
      {tone === 'running' ? (
        <span className="ws-spinner" />
      ) : tone ? (
        <span className={`sec-dot sec-dot--${tone}`} />
      ) : (
        <Codicon name="shield" />
      )}
    </span>
  )
}

/** The areas, from before the check starts, so you see what it covers; each
 *  dot fills as its area is cleared or flagged. */
function AreaStrip({
  areas,
  results,
  findings,
  phase
}: {
  areas: SecurityAreaId[]
  results: Partial<Record<SecurityAreaId, SecurityAreaResult>>
  findings: SecurityFinding[]
  phase: SecurityCheck['state']['phase']
}): JSX.Element {
  return (
    <ul className="sec-areas" aria-label="What it checks">
      {areas.map((area) => {
        const found = findings.filter((f) => f.area === area && counts(f))
        const worst = found.reduce<SecuritySeverity>(
          (w, f) => (RANK[f.severity] > RANK[w] ? f.severity : w),
          'low'
        )
        const result = results[area]
        const status = found.length
          ? worst
          : result?.status === 'clear'
            ? 'clear'
            : result?.status === 'flagged'
              ? 'medium'
              : phase === 'idle'
                ? 'idle'
                : phase === 'running' && !result
                  ? 'waiting'
                  : 'skipped'
        const said = found.length
          ? plural(found.length, 'thing') + ' to look at'
          : status === 'clear'
            ? 'nothing risky'
            : status === 'medium'
              ? 'worth a look'
              : status === 'waiting'
                ? 'not checked yet'
                : status === 'skipped'
                  ? 'not checked'
                  : null
        const tip = [AREAS[area].about, result?.note].filter(Boolean).join('. ')
        return (
          <li key={area} className={`sec-area sec-area--${status}`} title={tip}>
            <span className="sec-area-dot" aria-hidden="true" />
            <span className="sec-area-name">{AREAS[area].label}</span>
            {found.length > 0 && (
              <span className="sec-area-count" aria-hidden="true">
                {found.length}
              </span>
            )}
            {said && <span className="sr-only">: {said}</span>}
          </li>
        )
      })}
    </ul>
  )
}

function FindingRow({
  finding,
  open,
  onToggle
}: {
  finding: SecurityFinding
  open: boolean
  onToggle: () => void
}): JSX.Element {
  const fullWhere = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ''}` : ''
  // Under the title there's room for most paths whole; a long one reads best by its file's name.
  const where =
    fullWhere.length <= 48
      ? fullWhere || undefined
      : `${finding.file?.split('/').pop()}${finding.line ? `:${finding.line}` : ''}`
  const ref = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (open) reveal(ref.current)
  }, [open])
  return (
    <li
      ref={ref}
      className={`sec-finding sec-finding--${finding.severity}${open ? ' is-open' : ''}`}
    >
      <button
        type="button"
        className="sec-finding-line"
        aria-expanded={open}
        title={plainText(finding.title)}
        onClick={onToggle}
      >
        <span className="sec-sev" aria-hidden="true" />
        <span className="sr-only">{SEVERITY[finding.severity]}: </span>
        <span className="sec-finding-text">
          <span className="sec-finding-title">{finding.title}</span>
          {where && (
            <span className="sec-finding-where" title={fullWhere}>
              {where}
            </span>
          )}
        </span>
        <span className="sec-finding-level" aria-hidden="true">
          {SEVERITY[finding.severity]}
        </span>
        <ChevronRightIcon className="sec-finding-caret" />
      </button>
      {open && (
        <div className="sec-finding-body">
          <p>
            <CodeText text={finding.detail} />
          </p>
          {finding.assessment && (
            <p>
              <span className="sec-label">Copilot read it:</span>{' '}
              <CodeText text={finding.assessment} />
            </p>
          )}
          {finding.excerpt && (
            <EvidenceView
              text={finding.excerpt}
              start={finding.excerptStart ?? finding.line ?? 1}
              file={finding.file}
              from={finding.line}
              to={finding.endLine}
            />
          )}
          {finding.places && finding.places.length > 0 && (
            <p className="sec-finding-places">
              Also in{' '}
              {finding.places.map((place, i) => (
                <span key={place}>
                  {i > 0 && ', '}
                  <code className="adv-code">{place}</code>
                </span>
              ))}
            </p>
          )}
          {finding.advice && (
            <p>
              <span className="sec-label">What to do:</span> <CodeText text={finding.advice} />
            </p>
          )}
          <p className="sec-finding-source">
            {SEVERITY[finding.severity]} ·{' '}
            {finding.source === 'fabricator'
              ? 'Found by Fabricator’s own checks'
              : 'Found by Copilot, quoted from the file'}
            {fullWhere && ` · ${fullWhere}`}
          </p>
        </div>
      )}
    </li>
  )
}

/** What Copilot read and searched, newest at the bottom; follows new steps unless you scroll up. */
function Steps({ tools, root }: { tools: ChatToolCall[]; root: string }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  useEffect(() => reveal(ref.current), [])
  useEffect(() => {
    const el = ref.current
    if (el && follow.current) el.scrollTop = el.scrollHeight
  }, [tools])
  return (
    <div
      className="sec-steps"
      ref={ref}
      role="log"
      aria-label="What Copilot read"
      onScroll={(e) => {
        const el = e.currentTarget
        follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      }}
    >
      <div className="worklog worklog--live is-open">
        <div className="worklog-body">
          {tools.map((tool) => (
            <StepRow key={tool.id} tool={tool} projectPath={root} />
          ))}
        </div>
      </div>
    </div>
  )
}

interface Props {
  check: SecurityCheck
  kind: SecurityCheckKind
  /** The dialog is importing or installing: the check can't start again. */
  disabled?: boolean
}

/**
 * The security check of a project or app file, in Import project and an app's
 * install prompt. It offers the check; once started, it shows what Copilot is
 * reading, each area as it's cleared or flagged, and what it finds as it finds
 * it; then the verdict, with each finding's evidence and what to do about it.
 */
export default function SecurityCheckPanel({ check, kind, disabled = false }: Props): JSX.Element {
  const { state } = check
  const running = state.phase === 'running'
  const startedAt = state.phase === 'idle' ? 0 : state.progress.startedAt
  const now = useNow(running)
  const stopRef = useRef<HTMLButtonElement>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [showSteps, setShowSteps] = useState(false)

  useEffect(() => {
    setOpenId(null)
    setShowSteps(false)
  }, [startedAt])

  useEffect(() => {
    if (running) stopRef.current?.focus()
  }, [running])

  const report = state.phase === 'done' ? state.report : null
  const findings = useMemo(
    () =>
      state.phase === 'idle' ? [] : sorted(report ? report.findings : state.progress.findings),
    [state, report]
  )

  if (state.phase === 'idle') {
    return (
      <section className="sec" aria-label="Security check">
        <div className="sec-head">
          <Mark tone={null} />
          <div className="sec-head-text">
            <strong className="sec-title">Check for security risks</strong>
            <span className="sec-sub">
              Copilot reads its code, without running any of it, and tells you what it could do on
              this computer.
            </span>
          </div>
          <button type="button" className="btn btn--sm" disabled={disabled} onClick={check.start}>
            <Codicon name="sparkle" /> Check
          </button>
        </div>
        <AreaStrip areas={areasFor(kind)} results={{}} findings={[]} phase="idle" />
      </section>
    )
  }

  const progress = state.progress
  const results: Partial<Record<SecurityAreaId, SecurityAreaResult>> = report
    ? Object.fromEntries(report.areas.map((r) => [r.area, r]))
    : progress.results
  const told = report
    ? outcome(report, findings, kind)
    : { tone: 'running' as Tone, title: 'Checking for security risks…', sub: liveStep(progress) }
  const problem =
    report && !report.cancelled && report.error && (report.ok || report.files > 0)
      ? report.partial
        ? `Some areas weren’t checked: ${report.error}`
        : report.error
      : null
  const root = progress.root
  const steps = progress.activity
  const files = report?.files || progress.files
  const about = report?.ok
    ? `Checked by Copilot (Auto)${files ? ` · ${plural(files, 'file')}` : ''} · ${formatTurnDuration(report.durationMs)}`
    : running
      ? `Copilot (Auto)${files ? ` · ${plural(files, 'file')}` : ''}`
      : null

  return (
    <section
      className={`sec sec--${told.tone}`}
      aria-label="Security check"
      aria-busy={running || undefined}
    >
      <div className="sec-head">
        <Mark tone={told.tone} />
        <div className="sec-head-text" aria-live="polite">
          <strong className="sec-title">{told.title}</strong>
          {told.sub && (
            <span
              className={`sec-sub${running ? ' sec-sub--live' : ''}`}
              title={running ? told.sub : undefined}
            >
              {told.sub}
            </span>
          )}
        </div>
        {running && (
          <>
            <span className="sec-clock" aria-label="Elapsed time">
              {clock(now - progress.startedAt)}
            </span>
            <button
              ref={stopRef}
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={check.stop}
            >
              <Codicon name="debug-stop" /> Stop
            </button>
          </>
        )}
      </div>

      {problem && (
        <p className="sec-problem" role="alert">
          <Codicon name="warning" />
          <span>{problem}</span>
        </p>
      )}

      {(running || (report && report.files > 0)) && (
        <AreaStrip
          areas={progress.areas}
          results={results}
          findings={findings}
          phase={state.phase}
        />
      )}

      {findings.length > 0 && (
        <ul className="sec-findings" aria-label="What it found">
          {findings.map((finding) => (
            <FindingRow
              key={finding.id}
              finding={finding}
              open={openId === finding.id}
              onToggle={() => setOpenId((now) => (now === finding.id ? null : finding.id))}
            />
          ))}
        </ul>
      )}

      {(steps.length > 0 || report) && (
        <div className="sec-meta">
          {about && <span className="sec-meta-about">{about}</span>}
          <span className="sec-meta-actions">
            {steps.length > 0 && root && (
              <button
                type="button"
                className="sec-action sec-action--steps"
                aria-expanded={showSteps}
                onClick={() => setShowSteps((open) => !open)}
              >
                <Codicon name="list-unordered" /> {plural(steps.length, 'step')}
                <ChevronRightIcon className="sec-action-caret" />
              </button>
            )}
            {report && (
              <button
                type="button"
                className="sec-action"
                disabled={disabled}
                onClick={check.start}
              >
                <Codicon name="refresh" /> Check again
              </button>
            )}
          </span>
        </div>
      )}
      {showSteps && root && <Steps tools={steps} root={root} />}
    </section>
  )
}
