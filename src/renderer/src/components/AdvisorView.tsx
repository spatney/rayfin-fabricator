import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AccessibilityIcon,
  BoltIcon,
  ChatIcon,
  CheckIcon,
  Codicon,
  DatabaseIcon,
  InfoIcon,
  KeyIcon,
  PackageIcon,
  ReloadIcon,
  ShieldIcon,
  SparkleIcon,
  StopIcon
} from './icons'
import Markdown from './Markdown'
import type { AdvisorFinding, AdvisorSnapshot, StudioProject } from '@shared/ipc'

/** A monochrome line-icon component (auth/shield, data/database, …). */
type IconCmp = (props: { className?: string }) => JSX.Element

interface Props {
  project: StudioProject
  /** Hand a finding to the Build chat so Copilot can fix it. */
  onFix: (finding: AdvisorFinding) => void
  /** Hand the whole findings list to the Build chat to fix in one task. */
  onFixAll: (findings: AdvisorFinding[]) => void
  /**
   * True while the Build chat is mid-turn. Fix hand-offs are paused while it's
   * busy (a second prompt would collide with the running turn); inline Explain
   * stays available since it runs on its own throwaway session.
   */
  chatBusy?: boolean
}

interface FindingGroup {
  key: string
  title: string
  Icon: IconCmp
  findings: AdvisorFinding[]
}

/** One live step shown in the analyzing feed. */
interface Step {
  id: number
  text: string
  tool?: string
}

/** Progress of an inline "Explain this finding" request, keyed by finding. */
type ExplainStatus = 'loading' | 'streaming' | 'done' | 'error'
interface ExplainState {
  status: ExplainStatus
  text: string
  error?: string
}

/** Display order + copy + icon for each check category. */
const CATEGORIES: { key: string; title: string; Icon: IconCmp }[] = [
  { key: 'auth', title: 'Authentication & access', Icon: ShieldIcon },
  { key: 'policy', title: 'Data policies', Icon: KeyIcon },
  { key: 'data-modeling', title: 'Data model', Icon: DatabaseIcon },
  { key: 'performance', title: 'Performance', Icon: BoltIcon },
  { key: 'accessibility', title: 'Accessibility', Icon: AccessibilityIcon },
  { key: 'version', title: 'Versions & dependencies', Icon: PackageIcon }
]

/** Title + icon for a category key, falling back to a generic "Other" bucket. */
export function categoryMeta(key: string): { title: string; Icon: IconCmp } {
  const found = CATEGORIES.find((c) => c.key === key)
  return found ?? { title: 'Other', Icon: InfoIcon }
}

function sevRank(severity: string): number {
  switch (severity.toLowerCase()) {
    case 'high':
      return 0
    case 'medium':
    case 'med':
      return 1
    case 'low':
      return 2
    default:
      return 3
  }
}

/** Map a severity to its CSS modifier (`high` | `med` | `low`). */
function sevClass(severity: string): string {
  const s = severity.toLowerCase()
  if (s === 'high') return 'high'
  if (s === 'low') return 'low'
  return 'med'
}

function sevLabel(severity: string): string {
  const s = severity.toLowerCase()
  if (s === 'high') return 'High'
  if (s === 'low') return 'Low'
  if (s === 'medium' || s === 'med') return 'Medium'
  return severity ? severity[0].toUpperCase() + severity.slice(1) : 'Info'
}

/** Bucket findings into display groups by category, sorted by severity. */
function groupFindings(findings: AdvisorFinding[]): FindingGroup[] {
  const groups: FindingGroup[] = []
  const seen = new Set<string>()

  for (const cat of CATEGORIES) {
    const matched = findings.filter((f) => (f.category || 'other') === cat.key)
    if (matched.length) {
      seen.add(cat.key)
      groups.push({ ...cat, findings: matched })
    }
  }

  const extras = findings.filter((f) => !seen.has(f.category || 'other'))
  if (extras.length) {
    groups.push({ key: 'other', title: 'Other', Icon: InfoIcon, findings: extras })
  }

  for (const g of groups) {
    g.findings.sort((a, b) => sevRank(a.severity) - sevRank(b.severity))
  }
  return groups
}

function severityCounts(findings: AdvisorFinding[]): { high: number; med: number; low: number } {
  let high = 0
  let med = 0
  let low = 0
  for (const f of findings) {
    const c = sevClass(f.severity)
    if (c === 'high') high += 1
    else if (c === 'low') low += 1
    else med += 1
  }
  return { high, med, low }
}

/** A codicon glyph name for the tool driving a live step. */
function toolCodicon(tool?: string): string {
  const t = (tool || '').toLowerCase()
  if (!t) return 'chevron-right'
  if (/(str_replace|edit|write|create)/.test(t)) return 'edit'
  if (/(bash|shell|powershell|exec|run|command|terminal)/.test(t)) return 'terminal'
  if (/(grep|search|ripgrep|find_text)/.test(t)) return 'search'
  if (/(glob|find|list)/.test(t)) return 'folder'
  if (/rayfin/.test(t)) return 'database'
  if (/(fetch|web|http|url)/.test(t)) return 'globe'
  if (/(view|read|cat|open|file)/.test(t)) return 'file'
  return 'chevron-right'
}

/** `0:14` style mm:ss clock for the elapsed timer. */
function formatClock(ms: number): string {
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** Human duration for a completed run (e.g. `8s`, `1m 4s`). */
function formatDuration(ms: number): string {
  if (ms < 1000) return '<1s'
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  const s = total % 60
  return s ? `${m}m ${s}s` : `${m}m`
}

/** Coarse "x ago" for when a saved review ran. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (!then || Number.isNaN(then)) return 'recently'
  const s = Math.floor((Date.now() - then) / 1000)
  if (s < 45) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(then).toLocaleDateString()
}

/** Stable per-finding key for routing inline-explain state (findings may lack an id). */
function findingKey(finding: AdvisorFinding, fallback: string): string {
  const id = finding.id?.trim()
  return id ? id : fallback
}

/**
 * The Advisor tab: runs a Copilot-driven, read-only review of the active Rayfin
 * app and presents the findings. The last review is saved per project and
 * reloaded on open; if the code has changed since, it flags the result as stale
 * and offers a re-run. Each finding is a severity-coded card with a one-click
 * "Fix with Copilot" hand-off to the Build chat and an inline, read-only "Explain"
 * that streams a Copilot answer on a throwaway session (never touching chat).
 */
export default function AdvisorView({
  project,
  onFix,
  onFixAll,
  chatBusy = false
}: Props): JSX.Element {
  const [snapshot, setSnapshot] = useState<AdvisorSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [steps, setSteps] = useState<Step[]>([])
  const [error, setError] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)

  // Inline "Explain this finding" state, keyed by finding key.
  const [explains, setExplains] = useState<Record<string, ExplainState>>({})
  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set())
  const [explainingKey, setExplainingKey] = useState<string | null>(null)
  const explainingRef = useRef<string | null>(null)

  const mountedRef = useRef(true)
  const cancelledRef = useRef(false)
  const startedAtRef = useRef(0)
  const stepSeq = useRef(0)
  const feedRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Clear inline explanations (and cancel any in-flight one) whenever we move to
  // a fresh set of findings — a different project or a re-run invalidates them.
  const resetExplains = useCallback(() => {
    if (explainingRef.current) void window.api.advisor.explainCancel(project.id)
    explainingRef.current = null
    setExplainingKey(null)
    setExplains({})
    setOpenKeys(new Set())
  }, [project.id])

  // Load the saved review (with fresh staleness) whenever the project changes.
  useEffect(() => {
    let alive = true
    setLoading(true)
    setSnapshot(null)
    setError(null)
    setSteps([])
    setRunning(false)
    resetExplains()
    window.api.advisor
      .load(project.id)
      .then((snap) => {
        if (alive) {
          setSnapshot(snap)
          setLoading(false)
        }
      })
      .catch(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
    // resetExplains is stable per project.id; re-running only on project.id
    // change is intentional (avoids a double-run on mount).
  }, [project.id])

  // Accumulate live progress into the scanning feed, and stream inline-explain
  // chunks into the right finding card.
  useEffect(() => {
    const off = window.api.advisor.onEvent((env) => {
      if (env.projectId !== project.id) return
      if (env.event.type === 'progress') {
        const { text, tool } = env.event
        setSteps((prev) => {
          const next = [...prev, { id: stepSeq.current++, text, tool }]
          return next.length > 80 ? next.slice(next.length - 80) : next
        })
      } else if (env.event.type === 'explainDelta') {
        const { explainId, text } = env.event
        setExplains((prev) => {
          const cur = prev[explainId]
          if (!cur) return prev
          return { ...prev, [explainId]: { status: 'streaming', text: cur.text + text } }
        })
      }
    })
    return off
  }, [project.id])

  // Tick the elapsed timer while a review runs.
  useEffect(() => {
    if (!running) return
    const t = window.setInterval(() => setElapsed(Date.now() - startedAtRef.current), 200)
    return () => window.clearInterval(t)
  }, [running])

  // Keep the feed scrolled to the newest step.
  useEffect(() => {
    const el = feedRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [steps])

  const run = useCallback(async () => {
    cancelledRef.current = false
    startedAtRef.current = Date.now()
    setElapsed(0)
    setSteps([])
    setError(null)
    setRunning(true)
    resetExplains()
    try {
      const snap = await window.api.advisor.run(project.id)
      if (!mountedRef.current || cancelledRef.current) return
      if (snap.report.ok) {
        setSnapshot(snap)
        setError(null)
      } else {
        // Keep any prior good snapshot on screen; just surface the failure.
        setError(snap.report.summary)
      }
    } catch (err) {
      if (mountedRef.current) setError(String(err))
    } finally {
      if (mountedRef.current) setRunning(false)
    }
  }, [project.id, resetExplains])

  const cancel = useCallback(() => {
    cancelledRef.current = true
    setRunning(false)
    void window.api.advisor.cancel(project.id)
  }, [project.id])

  // Kick off an inline explanation for a finding on its own throwaway session.
  // Only one runs at a time (the backend enforces this too).
  const startExplain = useCallback(
    (key: string, finding: AdvisorFinding) => {
      if (explainingRef.current) return
      explainingRef.current = key
      setExplainingKey(key)
      setExplains((prev) => ({ ...prev, [key]: { status: 'loading', text: '' } }))
      window.api.advisor
        .explain(project.id, key, finding)
        .then((full) => {
          if (!mountedRef.current) return
          setExplains((prev) => ({ ...prev, [key]: { status: 'done', text: full } }))
        })
        .catch((err) => {
          if (!mountedRef.current) return
          const msg = String(err?.message ?? err)
          setExplains((prev) => {
            // A user cancel with nothing streamed yet resets the slot for a clean retry.
            if (/cancel/i.test(msg) && !prev[key]?.text) {
              const next = { ...prev }
              delete next[key]
              return next
            }
            return { ...prev, [key]: { status: 'error', text: prev[key]?.text ?? '', error: msg } }
          })
        })
        .finally(() => {
          if (explainingRef.current === key) {
            explainingRef.current = null
            if (mountedRef.current) setExplainingKey(null)
          }
        })
    },
    [project.id]
  )

  const toggleExplain = useCallback(
    (key: string, finding: AdvisorFinding) => {
      setOpenKeys((prev) => {
        const next = new Set(prev)
        if (next.has(key)) {
          next.delete(key)
        } else {
          next.add(key)
          if (!explains[key] && !explainingRef.current) startExplain(key, finding)
        }
        return next
      })
    },
    [explains, startExplain]
  )

  const cancelExplain = useCallback(
    (key: string) => {
      if (explainingRef.current !== key) return
      void window.api.advisor.explainCancel(project.id)
    },
    [project.id]
  )

  const report = snapshot?.report ?? null
  const issueCount = report?.ok ? report.findings.length : 0
  const groups = useMemo(() => (report?.ok ? groupFindings(report.findings) : []), [report])
  const counts = useMemo(() => severityCounts(report?.findings ?? []), [report])
  const clean = report?.ok === true && issueCount === 0

  return (
    <div className="advisor">
      <div className="advisor-inner">
        <div className="advisor-head">
          <div className="advisor-head-main">
            <div className="advisor-head-badge" aria-hidden="true">
              <ShieldIcon />
            </div>
            <div>
              <h2 className="advisor-title">Advisor</h2>
              <p className="advisor-sub">
                A Copilot-powered review of your app — security gaps, data-model and performance
                issues, accessibility, and outdated Rayfin versions.
              </p>
            </div>
          </div>
          <div className="advisor-actions">
            {running ? (
              <button className="btn btn--sm btn--ghost" onClick={cancel}>
                <StopIcon className="btn-ico" /> Cancel
              </button>
            ) : snapshot || error ? (
              <button className="btn btn--sm btn--primary" onClick={() => void run()}>
                <ReloadIcon className="btn-ico" /> Re-run
              </button>
            ) : null}
          </div>
        </div>

        {loading && (
          <div className="advisor-loading">
            <span className="advisor-spinner" aria-hidden="true" />
            <span>Loading saved analysis…</span>
          </div>
        )}

        {!loading && running && (
          <div className="advisor-analyze">
            <div className="advisor-scanstrip" aria-hidden="true">
              <span className="advisor-scanline" />
            </div>
            <div className="advisor-analyze-head">
              <span className="advisor-spinner" aria-hidden="true" />
              <div className="advisor-analyze-headmain">
                <span className="advisor-analyze-title">Analyzing your app…</span>
                <span className="advisor-analyze-desc">
                  Copilot is reading your code — auth and data policies, the data model,
                  performance, accessibility, and your Rayfin versions.
                </span>
              </div>
              <div className="advisor-analyze-meta">
                <span className="advisor-analyze-time">{formatClock(elapsed)}</span>
                <span className="advisor-analyze-steps">
                  {steps.length} step{steps.length === 1 ? '' : 's'}
                </span>
              </div>
            </div>
            <div className="advisor-feed" ref={feedRef}>
              {steps.length === 0 ? (
                <div className="advisor-feed-empty">Starting analysis…</div>
              ) : (
                steps.map((s, i) => (
                  <div
                    className={`advisor-feed-item${
                      i === steps.length - 1 ? ' advisor-feed-item--current' : ''
                    }`}
                    key={s.id}
                  >
                    <span className="advisor-feed-icon">
                      <Codicon name={toolCodicon(s.tool)} />
                    </span>
                    <span className="advisor-feed-text">{s.text}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {!loading && !running && (
          <>
            {error && <div className="alert alert--error advisor-error">{error}</div>}

            {snapshot && report?.ok ? (
              <div className="advisor-results">
                {snapshot.stale && (
                  <div className="advisor-stale">
                    <span className="advisor-stale-icon" aria-hidden="true">
                      <ReloadIcon />
                    </span>
                    <span className="advisor-stale-text">
                      Your code has changed since this analysis — the results may be out of date.
                    </span>
                    <button className="btn btn--sm btn--primary" onClick={() => void run()}>
                      Re-run
                    </button>
                  </div>
                )}

                <div className={`advisor-hero advisor-hero--${clean ? 'ok' : 'warn'}`}>
                  <div className="advisor-hero-icon" aria-hidden="true">
                    {clean ? <CheckIcon /> : <span className="advisor-hero-bang">!</span>}
                  </div>
                  <div className="advisor-hero-main">
                    <div className="advisor-hero-title">
                      {clean
                        ? 'No issues found'
                        : `${issueCount} issue${issueCount === 1 ? '' : 's'} found`}
                    </div>
                    <div className="advisor-hero-meta">
                      {issueCount > 0 && (
                        <span className="advisor-sevpills">
                          {counts.high > 0 && (
                            <span className="sevpill sevpill--high">
                              <i className="sevdot" /> {counts.high} high
                            </span>
                          )}
                          {counts.med > 0 && (
                            <span className="sevpill sevpill--med">
                              <i className="sevdot" /> {counts.med} medium
                            </span>
                          )}
                          {counts.low > 0 && (
                            <span className="sevpill sevpill--low">
                              <i className="sevdot" /> {counts.low} low
                            </span>
                          )}
                        </span>
                      )}
                      <span className="advisor-meta-when">
                        Analyzed {relativeTime(snapshot.analyzedAt)} ·{' '}
                        {formatDuration(snapshot.durationMs)}
                      </span>
                    </div>
                  </div>
                  {issueCount > 1 && (
                    <button
                      className="btn btn--sm btn--primary advisor-fixall"
                      onClick={() => onFixAll(report.findings)}
                      disabled={chatBusy}
                      title={
                        chatBusy
                          ? 'Copilot is working on a task — fixes resume when it finishes'
                          : 'Send all findings to the Build chat for Copilot to fix in one task'
                      }
                    >
                      <SparkleIcon className="btn-ico" /> Fix all {issueCount}
                    </button>
                  )}
                </div>

                {chatBusy && issueCount > 0 && (
                  <div className="advisor-busy">
                    <span className="advisor-busy-spinner" aria-hidden="true" />
                    <span>
                      Copilot is working on a task — Fix actions are paused until it finishes. You
                      can still Explain findings.
                    </span>
                  </div>
                )}

                {report.summary && <p className="advisor-summary">{report.summary}</p>}

                {groups.map((group) => (
                  <section className="advisor-group" key={group.key}>
                    <div className="advisor-group-head">
                      <span className="advisor-group-icon" aria-hidden="true">
                        <group.Icon />
                      </span>
                      <h3 className="advisor-group-title">{group.title}</h3>
                      <span className="advisor-group-count">{group.findings.length}</span>
                    </div>
                    <div className="advisor-grid">
                      {group.findings.map((finding, i) => {
                        const key = findingKey(finding, `${group.key}-${i}`)
                        const ex = explains[key]
                        const isOpen = openKeys.has(key)
                        const isGenerating = ex?.status === 'loading' || ex?.status === 'streaming'
                        const hasText = Boolean(ex?.text)
                        const explainBlocked = Boolean(explainingKey && explainingKey !== key)
                        return (
                          <div
                            className={`advisor-finding advisor-finding--${sevClass(
                              finding.severity
                            )}${isOpen ? ' advisor-finding--open' : ''}`}
                            key={key}
                          >
                            <div className="advisor-finding-head">
                              <span className={`sev sev--${sevClass(finding.severity)}`}>
                                <i className="sevdot" /> {sevLabel(finding.severity)}
                              </span>
                              {finding.file && (
                                <span className="advisor-file" title={finding.file}>
                                  {finding.file}
                                </span>
                              )}
                            </div>
                            <h4 className="advisor-finding-title">{finding.title}</h4>
                            <p className="advisor-finding-detail">{finding.detail}</p>
                            {finding.recommendation && (
                              <div className="advisor-fix-hint">
                                <span className="advisor-fix-hint-label">
                                  <SparkleIcon className="btn-ico" /> Suggested fix
                                </span>
                                <span className="advisor-fix-hint-text">
                                  {finding.recommendation}
                                </span>
                              </div>
                            )}

                            {isOpen && (
                              <div className="advisor-explain">
                                {ex?.status === 'error' && !hasText ? (
                                  <div className="advisor-explain-error">
                                    <span>{ex.error || 'Couldn’t generate an explanation.'}</span>
                                    <button
                                      className="btn btn--xs btn--ghost"
                                      onClick={() => startExplain(key, finding)}
                                      disabled={explainBlocked || isGenerating}
                                    >
                                      <ReloadIcon className="btn-ico" /> Try again
                                    </button>
                                  </div>
                                ) : isGenerating && !hasText ? (
                                  <div className="advisor-explain-thinking">
                                    <span className="advisor-explain-dots" aria-hidden="true">
                                      <i />
                                      <i />
                                      <i />
                                    </span>
                                    <span>Copilot is looking into this…</span>
                                    <button
                                      className="advisor-explain-linkbtn"
                                      onClick={() => cancelExplain(key)}
                                    >
                                      Stop
                                    </button>
                                  </div>
                                ) : (
                                  <>
                                    <div
                                      className={`advisor-explain-body${
                                        isGenerating ? ' advisor-explain-body--streaming' : ''
                                      }`}
                                    >
                                      <Markdown>{ex?.text ?? ''}</Markdown>
                                    </div>
                                    <div className="advisor-explain-foot">
                                      {isGenerating ? (
                                        <button
                                          className="btn btn--xs btn--ghost"
                                          onClick={() => cancelExplain(key)}
                                        >
                                          <StopIcon className="btn-ico" /> Stop
                                        </button>
                                      ) : (
                                        <>
                                          <span className="advisor-explain-by">
                                            <SparkleIcon className="btn-ico" /> Explained by Copilot
                                          </span>
                                          <button
                                            className="advisor-explain-linkbtn"
                                            onClick={() => startExplain(key, finding)}
                                            disabled={explainBlocked}
                                            title={
                                              explainBlocked
                                                ? 'Finishing another explanation…'
                                                : 'Generate a fresh explanation'
                                            }
                                          >
                                            <ReloadIcon className="btn-ico" /> Regenerate
                                          </button>
                                        </>
                                      )}
                                    </div>
                                  </>
                                )}
                              </div>
                            )}

                            <div className="advisor-finding-foot">
                              <button
                                className={`btn btn--sm btn--ghost${isOpen ? ' is-active' : ''}`}
                                onClick={() => toggleExplain(key, finding)}
                                disabled={explainBlocked}
                                title={
                                  explainBlocked
                                    ? 'Finishing another explanation…'
                                    : 'Explain this issue inline — read-only, kept out of chat'
                                }
                              >
                                <ChatIcon className="btn-ico" /> {isOpen ? 'Hide' : 'Explain'}
                              </button>
                              <button
                                className="btn btn--sm btn--primary"
                                onClick={() => onFix(finding)}
                                disabled={chatBusy}
                                title={
                                  chatBusy
                                    ? 'Copilot is working on a task — fixes resume when it finishes'
                                    : 'Send this issue to the Build chat for Copilot to fix'
                                }
                              >
                                <SparkleIcon className="btn-ico" /> Fix with Copilot
                              </button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </section>
                ))}
              </div>
            ) : (
              !error && (
                <div className="advisor-intro">
                  <div className="advisor-intro-badge" aria-hidden="true">
                    <ShieldIcon />
                  </div>
                  <h3 className="advisor-intro-title">Review your app</h3>
                  <p className="advisor-intro-sub">
                    Ask Copilot to review your app for security and best-practice issues — access
                    that isn’t properly authenticated, over-permissive data policies, data-model or
                    performance problems, accessibility gaps, or an outdated Rayfin CLI or SDK. It
                    reads your code and reports what it finds, without changing anything.
                  </p>
                  <button
                    className="btn btn--primary advisor-intro-run"
                    onClick={() => void run()}
                  >
                    <SparkleIcon className="btn-ico" /> Run analysis
                  </button>
                  <span className="advisor-intro-foot">Read-only · powered by Copilot</span>
                </div>
              )
            )}
          </>
        )}
      </div>
    </div>
  )
}
