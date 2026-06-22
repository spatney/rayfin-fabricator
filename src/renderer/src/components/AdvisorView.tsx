import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AdvisorFinding,
  AdvisorSnapshot,
  StudioProject
} from '@shared/ipc'

interface Props {
  project: StudioProject
  /** Hand a finding to the Build chat so Copilot can fix it. */
  onFix: (finding: AdvisorFinding) => void
}

interface FindingGroup {
  key: string
  title: string
  findings: AdvisorFinding[]
}

/** One live step shown in the analyzing feed. */
interface Step {
  id: number
  text: string
  tool?: string
}

/** Display order + copy for each check category. */
const CATEGORIES: { key: string; title: string }[] = [
  { key: 'auth', title: 'Authentication & access' },
  { key: 'policy', title: 'Data policies' },
  { key: 'version', title: 'Versions & dependencies' }
]

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
    groups.push({ key: 'other', title: 'Other', findings: extras })
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

/** A small emoji icon for the tool driving a live step. */
function toolIcon(tool?: string): string {
  const t = (tool || '').toLowerCase()
  if (!t) return '▹'
  if (/(str_replace|edit|write|create)/.test(t)) return '✏️'
  if (/(bash|shell|powershell|exec|run|command|terminal)/.test(t)) return '⚡'
  if (/(grep|search|ripgrep|find_text)/.test(t)) return '🔎'
  if (/(glob|find|list)/.test(t)) return '📁'
  if (/rayfin/.test(t)) return '🐟'
  if (/(fetch|web|http|url)/.test(t)) return '🌐'
  if (/(view|read|cat|open|file)/.test(t)) return '📄'
  return '▹'
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

/**
 * The Advisor tab: runs a Copilot-driven, read-only security review of the active
 * Rayfin app and presents the findings. The last review is saved per project and
 * reloaded on open; if the code has changed since, it flags the result as stale
 * and offers a re-run. Each finding is a severity-coded card with a one-click
 * "Fix with Copilot" hand-off to the Build chat.
 */
export default function AdvisorView({ project, onFix }: Props): JSX.Element {
  const [snapshot, setSnapshot] = useState<AdvisorSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [steps, setSteps] = useState<Step[]>([])
  const [error, setError] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)

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

  // Load the saved review (with fresh staleness) whenever the project changes.
  useEffect(() => {
    let alive = true
    setLoading(true)
    setSnapshot(null)
    setError(null)
    setSteps([])
    setRunning(false)
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
  }, [project.id])

  // Accumulate live progress into the scanning feed.
  useEffect(() => {
    const off = window.api.advisor.onEvent((env) => {
      if (env.projectId !== project.id) return
      if (env.event.type === 'progress') {
        const { text, tool } = env.event
        setSteps((prev) => {
          const next = [...prev, { id: stepSeq.current++, text, tool }]
          return next.length > 80 ? next.slice(next.length - 80) : next
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
  }, [project.id])

  const cancel = useCallback(() => {
    cancelledRef.current = true
    setRunning(false)
    void window.api.advisor.cancel(project.id)
  }, [project.id])

  const report = snapshot?.report ?? null
  const issueCount = report?.ok ? report.findings.length : 0
  const groups = useMemo(
    () => (report?.ok ? groupFindings(report.findings) : []),
    [report]
  )
  const counts = useMemo(() => severityCounts(report?.findings ?? []), [report])

  return (
    <div className="advisor">
      <div className="advisor-head">
        <div>
          <h2 className="advisor-title">Advisor</h2>
          <p className="advisor-sub">
            A Copilot-powered review of your app. It looks for access that isn’t properly
            authenticated, data policies that are too permissive, and outdated Rayfin CLI or
            SDK versions.
          </p>
        </div>
        <div className="advisor-actions">
          {running ? (
            <button className="btn btn--sm btn--ghost" onClick={cancel}>
              Cancel
            </button>
          ) : snapshot || error ? (
            <button className="btn btn--sm btn--primary" onClick={() => void run()}>
              Re-run analysis
            </button>
          ) : null}
        </div>
      </div>

      {loading && <div className="advisor-loading">Loading saved analysis…</div>}

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
                Copilot is reading your code, checking routes and data policies, and comparing
                your Rayfin versions against the latest release.
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
                  <span className="advisor-feed-icon">{toolIcon(s.tool)}</span>
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
                    ↻
                  </span>
                  <span className="advisor-stale-text">
                    Your code has changed since this analysis — the results may be out of date.
                  </span>
                  <button className="btn btn--sm btn--primary" onClick={() => void run()}>
                    Re-run
                  </button>
                </div>
              )}

              <div className={`advisor-banner advisor-banner--${issueCount === 0 ? 'ok' : 'warn'}`}>
                <div className="advisor-banner-icon" aria-hidden="true">
                  {issueCount === 0 ? '✓' : '!'}
                </div>
                <div className="advisor-banner-main">
                  <div className="advisor-banner-title">
                    {issueCount === 0
                      ? 'No issues found'
                      : `${issueCount} issue${issueCount === 1 ? '' : 's'} found`}
                  </div>
                  <div className="advisor-banner-meta">
                    {issueCount > 0 && (
                      <span className="advisor-sevpills">
                        {counts.high > 0 && (
                          <span className="sevpill sevpill--high">{counts.high} high</span>
                        )}
                        {counts.med > 0 && (
                          <span className="sevpill sevpill--med">{counts.med} medium</span>
                        )}
                        {counts.low > 0 && (
                          <span className="sevpill sevpill--low">{counts.low} low</span>
                        )}
                      </span>
                    )}
                    <span className="advisor-meta-when">
                      Analyzed {relativeTime(snapshot.analyzedAt)} · {formatDuration(snapshot.durationMs)}
                    </span>
                  </div>
                </div>
              </div>

              {report.summary && (
                <p className="advisor-summary">{report.summary}</p>
              )}

              {groups.map((group) => (
                <section className="advisor-group" key={group.key}>
                  <div className="advisor-group-head">
                    <h3 className="advisor-group-title">{group.title}</h3>
                    <span className="advisor-group-count">{group.findings.length}</span>
                  </div>
                  <div className="advisor-grid">
                    {group.findings.map((finding, i) => (
                      <div className="advisor-finding" key={finding.id || `${group.key}-${i}`}>
                        <div className="advisor-finding-top">
                          <span className={`sev sev--${sevClass(finding.severity)}`}>
                            {sevLabel(finding.severity)}
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
                          <div className="advisor-rec">
                            <span className="advisor-rec-label">Fix</span>
                            <span className="advisor-rec-text">{finding.recommendation}</span>
                          </div>
                        )}
                        <div className="advisor-finding-foot">
                          <button
                            className="btn btn--sm btn--primary"
                            onClick={() => onFix(finding)}
                            title="Send this issue to the Build chat for Copilot to fix"
                          >
                            ✨ Fix with Copilot
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            !error && (
              <div className="advisor-intro">
                <div className="advisor-intro-badge" aria-hidden="true">
                  🛡️
                </div>
                <h3 className="advisor-intro-title">Security review</h3>
                <p className="advisor-intro-sub">
                  Ask Copilot to review your app for security and best-practice issues — like
                  access that isn’t properly authenticated, data policies that are too
                  permissive, or an outdated Rayfin CLI or SDK. It reads your code and reports
                  what it finds, without changing anything.
                </p>
                <button
                  className="btn btn--primary advisor-intro-run"
                  onClick={() => void run()}
                >
                  Run analysis
                </button>
                <span className="advisor-intro-foot">Read-only · powered by Copilot</span>
              </div>
            )
          )}
        </>
      )}
    </div>
  )
}
