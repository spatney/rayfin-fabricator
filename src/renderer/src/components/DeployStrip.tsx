import { useEffect, useRef, useState, type JSX } from 'react'
import { clockLabel, meterStepLabel, useDeployMeter } from '../deployMeter'

interface Props {
  /** The project: the deploy's progress is shared with the app bar and the deploy screen. */
  meterKey: string
  log: string[]
  /** When the deploy started (`Date.now()`). */
  startedAt?: number
  /** The deployment it goes to, e.g. "Production". */
  target?: string
  /** Show the full deploy screen instead. */
  onWatch: () => void
}

/**
 * A redeploy in progress, above the app it's updating. The app stays on screen
 * and usable meanwhile; this says what the deploy is doing, how far it has got
 * and for how long, with the full deploy screen and the log one click away.
 * The preview reloads when the new version is live.
 */
export default function DeployStrip({ meterKey, log, startedAt, target, onWatch }: Props): JSX.Element {
  const [shownAt] = useState(() => Date.now())
  const meter = useDeployMeter(meterKey, log, startedAt ?? shownAt, true)
  const [showLog, setShowLog] = useState(false)
  const logRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    if (showLog && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log, showLog])

  const percent = meter ? Math.round(meter.fraction * 100) : 0
  const position = meter && meter.steps > 1 && !meter.progress.live ? ` · step ${meter.step} of ${meter.steps}` : ''

  return (
    <div className="deploy-strip-wrap">
      <div className="deploy-strip">
        <span className="ws-spinner deploy-strip-spin" aria-hidden="true" />
        {/* Only the words are announced: they change with the step, not every second. */}
        <span className="deploy-strip-text" role="status">
          <strong>{target ? `Deploying to ${target}` : 'Deploying'}</strong>
          <span className="deploy-strip-step">
            {meter ? meterStepLabel(meter) : 'Starting the deploy'}
            {position}
          </span>
        </span>
        <span
          className="deploy-strip-bar"
          role="progressbar"
          aria-label="Deploy progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <span style={{ width: `${Math.max(2, percent)}%` }} />
        </span>
        <span className="deploy-strip-time" aria-hidden="true">
          {clockLabel(meter?.elapsed ?? 0)}
        </span>
        <button type="button" className="btn btn--xs btn--ghost" onClick={onWatch} title="Show the deploy screen">
          Watch
        </button>
        <button
          type="button"
          className="btn btn--xs btn--ghost"
          aria-expanded={showLog}
          onClick={() => setShowLog((shown) => !shown)}
        >
          {showLog ? 'Hide logs' : 'Logs'}
        </button>
      </div>
      {showLog && (
        <pre className="deploy-log deploy-log--static deploy-strip-log" ref={logRef}>
          {log.join('') || 'Starting the deploy…'}
        </pre>
      )}
    </div>
  )
}
