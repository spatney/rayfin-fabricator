import { useEffect, useRef, useState } from 'react'

/** The coarse stages a scaffold goes through, in order. `done` is authoritative. */
type CreatePhase = 'preparing' | 'customizing' | 'installing' | 'finalizing' | 'done'

interface PhaseDef {
  id: CreatePhase
  label: string
  hint?: string
  /**
   * Loose, lowercase fragments that signal this stage has begun. Kept broad and
   * forgiving on purpose — see {@link markerPhase}.
   */
  markers: string[]
}

/**
 * The visible create stages. `finalizing` keys off our *own* backend `say()`
 * line ("Initializing git repository…"), which we control; `customizing` /
 * `installing` key off the upstream `npm create @microsoft/rayfin` scaffolder.
 * `done` is never marker-derived (see below).
 */
const CREATE_PHASES: PhaseDef[] = [
  { id: 'preparing', label: 'Preparing', markers: [] },
  { id: 'customizing', label: 'Customizing template', markers: ['customiz'] },
  {
    id: 'installing',
    label: 'Installing dependencies',
    hint: 'First run can take a minute or two.',
    markers: ['install']
  },
  { id: 'finalizing', label: 'Finishing up', markers: ['initializing git', 'git repository'] }
]

const PHASE_ORDER: CreatePhase[] = ['preparing', 'customizing', 'installing', 'finalizing', 'done']
const phaseRank = (p: CreatePhase): number => PHASE_ORDER.indexOf(p)

/**
 * Best-effort, **purely cosmetic** mapping of the cumulative create log to the
 * furthest stage reached. Hardened so upstream output changes can never break
 * or stall the actual create:
 *  - It never reports `done` — completion is driven solely by the backend
 *    result, so reworded/removed "finished" lines can't strand the wizard.
 *  - Markers are loose substrings; missing them only softens the indicator
 *    (the spinner + elapsed timer + {@link fallbackPhase} still convey motion).
 *  - Wrapped so a parsing slip degrades gracefully instead of throwing.
 */
function markerPhase(log: string): CreatePhase {
  try {
    const l = log.toLowerCase()
    let reached: CreatePhase = 'preparing'
    for (const def of CREATE_PHASES) {
      if (def.markers.length && def.markers.some((m) => l.includes(m))) reached = def.id
    }
    return reached
  } catch {
    return 'preparing'
  }
}

/**
 * Time-based floor so the indicator keeps advancing even if every upstream
 * output marker changes. Capped at `installing` (the dominant time sink) — it
 * never fabricates `finalizing`/`done`, which require a real signal/result.
 */
function fallbackPhase(elapsedSec: number, running: boolean): CreatePhase {
  if (!running) return 'preparing'
  if (elapsedSec >= 10) return 'installing'
  if (elapsedSec >= 3) return 'customizing'
  return 'preparing'
}

interface Props {
  /** True while a create/scaffold IPC is streaming for this run. */
  running: boolean
  /** True once the backend result confirms success (authoritative). */
  done: boolean
  /** True once the run has ended in failure (reveals the raw log). */
  failed: boolean
}

/**
 * The shared "Preparing → Customizing → Installing → Finishing up" progress card
 * for a project scaffold. Self-contained: it subscribes to the `create:project`
 * proc-log channel, ticks its own elapsed clock, and derives the cosmetic phase.
 * Completion is always driven by the `done`/`failed` props (never by log markers)
 * so upstream output changes can't strand it. Renders nothing until a run starts.
 */
export default function CreateProgress({ running, done, failed }: Props): JSX.Element | null {
  const [log, setLog] = useState('')
  const [showDetails, setShowDetails] = useState(false)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [now, setNow] = useState(0)
  const logRef = useRef<HTMLPreElement>(null)
  const wasRunning = useRef(false)

  // Accumulate the scaffolder's streamed output for the details pane.
  useEffect(() => {
    const off = window.api.onProcLog((e) => {
      if (e.channel === 'create:project') setLog((prev) => prev + e.data)
    })
    return off
  }, [])

  // Reset per run the moment a fresh create begins (false → true).
  useEffect(() => {
    if (running && !wasRunning.current) {
      setLog('')
      setShowDetails(false)
      setStartedAt(Date.now())
      setNow(Date.now())
    }
    wasRunning.current = running
  }, [running])

  // Surface the raw output the instant a run fails, so the real error is visible.
  useEffect(() => {
    if (failed) setShowDetails(true)
  }, [failed])

  // Tick a 1s elapsed clock while a create is in flight. This is the strongest
  // "still working" cue during the output-silent npm install — and it's
  // independent of any scaffolder/CLI log wording, so it survives upstream
  // output changes.
  useEffect(() => {
    if (!running || startedAt == null) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [running, startedAt])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log, showDetails])

  const elapsedSec = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0
  const elapsedLabel = `${Math.floor(elapsedSec / 60)}:${String(elapsedSec % 60).padStart(2, '0')}`
  const detectedPhase = markerPhase(log)
  const fallback = fallbackPhase(elapsedSec, running)
  // Never regress: take the furthest of the parsed marker and the time floor.
  const phase: CreatePhase = done
    ? 'done'
    : phaseRank(detectedPhase) >= phaseRank(fallback)
      ? detectedPhase
      : fallback
  const activeIdx =
    phase === 'done' ? CREATE_PHASES.length : CREATE_PHASES.findIndex((p) => p.id === phase)
  const activePhaseLabel =
    phase === 'done' ? 'Project ready' : (CREATE_PHASES[activeIdx]?.label ?? 'Preparing')

  // Nothing to show until a run has started (or has already produced output).
  if (!running && !done && !failed && !log) return null

  return (
    <div className="create-progress" aria-busy={running}>
      <span className="sr-only" role="status" aria-live="polite">
        {running ? activePhaseLabel : done ? 'Project ready' : ''}
      </span>
      <ol className="create-phases">
        {CREATE_PHASES.map((p, i) => {
          const state =
            phase === 'done' || i < activeIdx ? 'done' : i === activeIdx ? 'active' : 'pending'
          return (
            <li
              key={p.id}
              className={`create-phase create-phase--${state}${
                failed && state === 'active' ? ' create-phase--failed' : ''
              }`}
            >
              <span className="create-phase-ico" aria-hidden="true">
                {state === 'active' ? (
                  running ? (
                    <span className="ws-spinner" />
                  ) : failed ? (
                    '✕'
                  ) : null
                ) : state === 'done' ? (
                  '✓'
                ) : null}
              </span>
              <span className="create-phase-text">
                <span className="create-phase-label">{p.label}</span>
                {p.id === 'installing' && state === 'active' && (
                  <span className="create-phase-hint">
                    {elapsedSec > 75
                      ? 'Still working — large dependency trees take a little longer.'
                      : p.hint}
                  </span>
                )}
              </span>
            </li>
          )
        })}
      </ol>

      <div className="create-progress-meta">
        <span className="create-elapsed" aria-hidden="true">
          {running ? `${elapsedLabel} elapsed` : done ? 'Done' : ''}
        </span>
        <button
          type="button"
          className="link-btn create-progress-toggle"
          onClick={() => setShowDetails((v) => !v)}
        >
          {showDetails ? 'Hide details' : 'Show details'}
        </button>
      </div>

      {showDetails && (
        <pre className="log-console log-console--sm create-progress-details" ref={logRef}>
          {log || 'Starting…'}
        </pre>
      )}
    </div>
  )
}
