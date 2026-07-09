import { useEffect, useMemo, useRef, useState, useId, type CSSProperties } from 'react'
import {
  MARK_BRACKET_RX,
  MARK_BRACKETS,
  MARK_TILE_RX,
  MARK_TILES,
  MARK_VIEWBOX,
  MarkGradient
} from './FabricatorMark'

/**
 * The deploy view shown while a deploy streams — a flat, modern take on
 * Fabricator's signature splash: the brand mark quietly builds itself from
 * gliding tiles (looped for a long deploy), under a clean status block with the
 * live deploy phase + a flat segmented progress and a telemetry ticker. The raw
 * `rayfin up` console is one click away via "View logs".
 *
 * Shares the exact tile/bracket geometry + gradient with <FabricatorMark> /
 * <SplashScreen>. Deliberately flat — solid fills, no glow/bloom/shadow — and
 * theme-aware (all color from --accent / --accent-2). Honours
 * prefers-reduced-motion (shows the assembled mark, no motion).
 *
 * The phase label / progress is a best-effort read of the log + an elapsed-time
 * floor, so upstream wording changes can never stall or break the view.
 */

export interface PhaseDef {
  id: string
  label: string
  markers: string[]
}

/**
 * Deploy phases in chronological order, each with loose lowercase fragments of
 * real `rayfin up` output that signal it has begun.
 *
 * Resilience is deliberate: markers are broad and redundant (several synonyms
 * each) so a CLI wording change in a future version degrades gracefully instead
 * of breaking, and they're ordered so an *earlier* log line never contains a
 * *later* phase's marker. In particular the ubiquitous words "deploy" /
 * "deploying" are never markers (they appear from the very first line), and
 * "workspace" / "item" aren't either (they show up in the early Targeting block).
 * Detection only ever moves forward (see {@link resolvePhaseIndex}), so a marker
 * that matches once keeps the phase even if later lines don't repeat it.
 */
export const DEPLOY_PHASES: PhaseDef[] = [
  { id: 'connect', label: 'Connecting to Fabric', markers: [] },
  {
    id: 'prepare',
    label: 'Preparing deployment',
    markers: [
      'targeting',
      'workload endpoint',
      'publishable key',
      'runtime settings',
      'redeploy',
      'reusing',
      'deployment config',
      'wrote deployment',
      'database config'
    ]
  },
  {
    id: 'build',
    label: 'Building your app',
    markers: [
      'build command',
      'build:fabric',
      'tsc -b',
      'vite build',
      'building client',
      'transform',
      'modules transformed',
      'compiling',
      'esbuild',
      'webpack'
    ]
  },
  {
    id: 'package',
    label: 'Packaging assets',
    markers: [
      'rendering chunks',
      'gzip',
      'built in',
      'build command completed',
      'content packaged',
      'packaged (',
      'packaging',
      'bundling'
    ]
  },
  {
    id: 'upload',
    label: 'Uploading to Fabric',
    markers: ['content deployed', 'deployed (', 'uploading', 'pushing', 'hosting url', 'deployment id', 'static hosting']
  },
  {
    id: 'live',
    label: 'Going live',
    markers: ['is now deployed', 'now deployed to fabric', 'deployed to fabric!', 'live at', 'is live', 'next steps', '🎉']
  }
]

/** Furthest phase whose markers appear anywhere in the (lowercased) log. */
function markerPhaseIdx(text: string): number {
  let reached = 0
  DEPLOY_PHASES.forEach((p, i) => {
    if (p.markers.length && p.markers.some((m) => text.includes(m))) reached = i
  })
  return reached
}

/**
 * Time floor so the label still advances during the CLI's initial silent period
 * (and as a last resort if a version renames every marker). Deliberately gentle
 * and capped at `Packaging`: the build dominates deploy time, so we never let the
 * clock alone claim assets are uploaded or the app is live — those need a real
 * marker, keeping the status honest.
 */
function timePhaseIdx(elapsedSec: number): number {
  if (elapsedSec >= 30) return 3
  if (elapsedSec >= 9) return 2
  if (elapsedSec >= 4) return 1
  return 0
}

/** Resolve the current phase index — the furthest of the log markers and the
 *  time floor. Never regresses and never exceeds the last phase. */
export function resolvePhaseIndex(logText: string, elapsedSec: number): number {
  const text = logText.toLowerCase()
  return Math.min(DEPLOY_PHASES.length - 1, Math.max(markerPhaseIdx(text), timePhaseIdx(elapsedSec)))
}

const TELEMETRY = [
  'handshaking with fabric…',
  'allocating compute lattice…',
  'linking dependency graph…',
  'optimizing render bundle…',
  'verifying artifact signatures…',
  'streaming assets to workspace…',
  'provisioning host runtime…',
  'warming the edge cache…'
]

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false
  )
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!mq) return
    const on = (): void => setReduced(mq.matches)
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [])
  return reduced
}

/** Per-brick fly-in offset + stagger, keyed by the shared MARK_* class name. The
 *  bricks glide in from these small offsets, hold assembled, then glide back out
 *  on a slow loop — the "builds itself" motion, kept subtle for a long deploy. */
const BUILD: Record<string, { tx: number; ty: number; d: number }> = {
  'tile--topbar': { tx: 0, ty: -22, d: 0 },
  'tile--stem': { tx: -22, ty: 0, d: 0.08 },
  'tile--mid': { tx: 22, ty: 0, d: 0.16 },
  'tile--botleft': { tx: 0, ty: 22, d: 0.24 },
  'tile--square': { tx: 0, ty: 12, d: 0.32 },
  'bracket--tl': { tx: -12, ty: -12, d: 0.42 },
  'bracket--br': { tx: 12, ty: 12, d: 0.48 }
}

const brickStyle = (cls: string): CSSProperties => {
  const b = BUILD[cls] ?? { tx: 0, ty: 0, d: 0 }
  return { ['--tx']: `${b.tx}px`, ['--ty']: `${b.ty}px`, ['--d']: `${b.d}s` } as CSSProperties
}

function BuildingMark(): JSX.Element {
  const gid = 'dstage-mark-' + useId().replace(/:/g, '')
  const fill = `url(#${gid})`
  return (
    <svg className="dstage-logo" viewBox={MARK_VIEWBOX} aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <MarkGradient id={gid} />
      </defs>
      <g className="dstage-logo-inner">
        {MARK_TILES.map((t) => (
          <rect
            key={t.cls}
            className={`dstage-brick ${t.cls}`}
            style={brickStyle(t.cls)}
            x={t.x}
            y={t.y}
            width={t.w}
            height={t.h}
            rx={MARK_TILE_RX}
            fill={fill}
          />
        ))}
        {MARK_BRACKETS.map((b) => (
          <g key={b.cls} className={`dstage-brick bracket ${b.cls}`} style={brickStyle(b.cls)} fill={fill}>
            {b.rects.map((r, i) => (
              <rect key={i} x={r[0]} y={r[1]} width={r[2]} height={r[3]} rx={MARK_BRACKET_RX} />
            ))}
          </g>
        ))}
      </g>
    </svg>
  )
}

export default function DeployStage({ log, name }: { log: string[]; name?: string }): JSX.Element {
  const [elapsed, setElapsed] = useState(0)
  const [showLog, setShowLog] = useState(false)
  const startRef = useRef(Date.now())
  const logRef = useRef<HTMLPreElement>(null)
  const reduced = usePrefersReducedMotion()

  useEffect(() => {
    const id = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000))
    }, 1000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    if (showLog && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log, showLog])

  const logText = useMemo(() => log.join('\n'), [log])
  const idx = resolvePhaseIndex(logText, elapsed)
  const phase = DEPLOY_PHASES[idx]
  const isLast = idx === DEPLOY_PHASES.length - 1

  // Smoothly fill the active phase's segment: remember when this phase became
  // active, then ease its fill toward ~0.9 over a few seconds (never full until
  // the phase actually advances), so progress reads as continuous, not stepwise.
  const phaseAtRef = useRef({ idx: -1, at: Date.now() })
  if (phaseAtRef.current.idx !== idx) phaseAtRef.current = { idx, at: Date.now() }
  const inPhaseSec = (Date.now() - phaseAtRef.current.at) / 1000
  const activeFrac = isLast ? 1 : Math.min(0.9, 0.14 + inPhaseSec / 8)

  const elapsedLabel = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`

  const lastLine = useMemo(() => {
    for (let i = log.length - 1; i >= 0; i--) {
      const t = log[i].trim()
      if (t) return t
    }
    return ''
  }, [log])
  const ticker = lastLine || TELEMETRY[Math.floor(elapsed / 3) % TELEMETRY.length]

  return (
    <div className="dstage" data-reduced={reduced ? 'true' : undefined}>
      <div className="dstage-scene">
        <span className="dstage-timer" aria-hidden="true">
          {elapsedLabel}
        </span>

        <div className="dstage-mark">
          <BuildingMark />
        </div>

        <div className="dstage-hud">
          <span className="dstage-eyebrow">Fabricating</span>
          <h3 className="dstage-title">
            Deploying <b>{name?.trim() || 'your app'}</b>
          </h3>
          <div className="dstage-phase" role="status" aria-live="polite">
            <span className="dstage-phase-dot" />
            <span key={idx} className="dstage-phase-label">
              {phase.label}
            </span>
            <span className="dstage-phase-count">
              {idx + 1}/{DEPLOY_PHASES.length}
            </span>
          </div>
          <div className="dstage-steps" aria-hidden="true">
            {DEPLOY_PHASES.map((p, i) => {
              const state = i < idx ? 'done' : i === idx ? 'active' : 'todo'
              return (
                <span key={p.id} className="dstage-step" data-state={state}>
                  {state === 'active' && (
                    <span className="dstage-step-fill" style={{ width: `${Math.round(activeFrac * 100)}%` }} />
                  )}
                </span>
              )
            })}
          </div>
        </div>
      </div>

      <div className="dstage-foot">
        <div className="dstage-ticker">
          <span className="dstage-ticker-caret">›</span>
          <span className="dstage-ticker-text">{ticker}</span>
          <span className="dstage-ticker-cursor" aria-hidden="true" />
        </div>
        <button className="dstage-logbtn" type="button" onClick={() => setShowLog((s) => !s)}>
          {showLog ? 'Hide logs' : 'View logs'}
        </button>
      </div>

      {showLog && (
        <pre className="deploy-log deploy-log--static dstage-fulllog" ref={logRef}>
          {log.join('') || 'Starting deploy…'}
        </pre>
      )}
    </div>
  )
}
