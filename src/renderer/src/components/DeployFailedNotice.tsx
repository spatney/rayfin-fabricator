import { useEffect, useRef, useState, type JSX } from 'react'
import type { DeployOutcome, UnsupportedWorkspace } from '@shared/ipc'
import { REGION_AVAILABILITY_URL } from '../fabric'
import { translator, useTranslation } from '../i18n'
import { Codicon } from './icons'
import { Ray, RAY_VIEWBOX, type RayMood } from './mascot/Ray'
import { SpeechBubble, TYPE_MS } from './mascot/SpeechBubble'
import { useReducedMotion } from './mascot/context'
import { useRayGaze } from './mascot/gaze'
import { isRaySentAway, useRayOnScreen } from './mascot/stage'
import { DEPLOY_TROUBLE_LINES, unsupportedRegionLine, type DeployTrouble } from './mascot/lines'

/**
 * Publishing that failed, above the preview: Ray swims in and offers to find out
 * why, and selecting him (or **Find out why**) opens Help, which asks for you.
 * The publish log is one click away under **View logs** rather than spilled
 * across the pane, because to most people it reads as noise.
 *
 * It sits in the layout rather than over the preview: the preview is a native
 * surface, and nothing on the page can be drawn on top of it.
 *
 * With Ray sent away, it says the same thing plainly.
 */

/** Ray's width, in px. */
const RAY_W = 64
const RAY_H = (RAY_W * RAY_VIEWBOX.h) / RAY_VIEWBOX.w
/** How long he takes to swim in before he speaks. Matches `deployTroubleSwimIn`. */
const ARRIVE_MS = 700
/** How long the notice takes to go once dismissed. Matches `deployTroubleOut`. */
const LEAVE_MS = 240

/** What to offer for a publish that ended with `outcome`. */
export function deployTrouble(outcome: DeployOutcome | undefined): DeployTrouble {
  if (outcome === 'not-signed-in' || outcome === 'auth-cache-error') return 'signin'
  if (outcome === 'cancelled') return 'stopped'
  if (outcome === 'workspace-unsupported') return 'unsupported'
  return 'failed'
}

/** The same news without Ray. */
const PLAIN_LINES = {
  failed: 'failedNotice.plain.failed',
  signin: 'failedNotice.plain.signin',
  stopped: 'failedNotice.plain.stopped',
  unsupported: 'failedNotice.plain.unsupported'
} as const satisfies Record<DeployTrouble, string>

/** What the notice says: Ray's line or the plain one, naming the region when Fabric did. */
function troubleLine(trouble: DeployTrouble, withRay: boolean, region?: string): string {
  const t = translator('publish')
  if (trouble === 'unsupported' && region?.trim()) {
    return withRay
      ? unsupportedRegionLine(region.trim())
      : t('failedNotice.plain.unsupportedRegion', { region: region.trim() })
  }
  return withRay ? DEPLOY_TROUBLE_LINES[trouble] : t(PLAIN_LINES[trouble])
}

export interface DeployFailedNoticeProps {
  outcome?: DeployOutcome
  /** The publish log, when it ran in this session. */
  log?: string[]
  /** The error it ended with: all there is for a publish from an earlier session. */
  error?: string
  /** Open Help and ask why publishing failed. */
  onDiagnose?: () => void
  /** Clear the Fabric credentials and sign in again. Offered for a sign-in failure. */
  onRefreshAuth?: () => void
  /** Another sign-in or publish is running, so a refresh has to wait. */
  authBusy?: boolean
  /** The workspace Fabric turned the app down in (`workspace-unsupported`). */
  unsupported?: UnsupportedWorkspace
  /** Pick another workspace to publish to. Offered when Fabric turned the app down in one. */
  onChooseWorkspace?: () => void
  onDismiss: () => void
}

export default function DeployFailedNotice({
  outcome,
  log,
  error,
  onDiagnose,
  onRefreshAuth,
  authBusy = false,
  unsupported,
  onChooseWorkspace,
  onDismiss
}: DeployFailedNoticeProps): JSX.Element {
  const { t } = useTranslation('publish')
  const [sentAway] = useState(isRaySentAway)
  const withRay = !sentAway
  useRayOnScreen(withRay)
  const reduced = useReducedMotion()

  const trouble = deployTrouble(outcome)
  const line = troubleLine(trouble, withRay, unsupported?.region)
  // A stopped publish is the user's own doing, and a workspace without Fabric
  // apps is already explained: there's nothing to diagnose.
  const diagnose = trouble === 'stopped' || trouble === 'unsupported' ? undefined : onDiagnose
  const refresh = trouble === 'signin' ? onRefreshAuth : undefined
  const choose = trouble === 'unsupported' ? onChooseWorkspace : undefined
  const output = log?.length ? log.join('') : (error ?? '').trim()
  const [showOutput, setShowOutput] = useState(false)

  const [arrived, setArrived] = useState(!withRay || reduced)
  const [wave, setWave] = useState<number | undefined>(undefined)
  const [talking, setTalking] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const gazeRef = useRef<HTMLSpanElement>(null)
  const leaveTimer = useRef(0)
  useRayGaze(gazeRef)

  useEffect(() => {
    if (arrived) return
    const timer = window.setTimeout(() => {
      setArrived(true)
      setWave(1)
    }, ARRIVE_MS)
    return () => window.clearTimeout(timer)
  }, [arrived])

  // His mouth moves while the line types out.
  useEffect(() => {
    if (!withRay || !arrived || reduced) return
    setTalking(true)
    const timer = window.setTimeout(() => setTalking(false), Array.from(line).length * TYPE_MS)
    return () => window.clearTimeout(timer)
  }, [withRay, arrived, reduced, line])

  useEffect(() => () => window.clearTimeout(leaveTimer.current), [])

  function dismiss(): void {
    if (reduced) {
      onDismiss()
      return
    }
    setLeaving(true)
    leaveTimer.current = window.setTimeout(onDismiss, LEAVE_MS)
  }

  const mood: RayMood = talking ? 'talk' : 'worried'
  const rayBody = (
    <span className="deploy-trouble-bob" ref={gazeRef}>
      <Ray mood={mood} wave={wave} />
    </span>
  )

  return (
    <section
      className={`deploy-trouble${withRay ? ' deploy-trouble--ray' : ''}${leaving ? ' is-leaving' : ''}`}
      aria-label={t('failedNotice.label')}
    >
      <div className="deploy-trouble-main">
        {withRay ? (
          diagnose ? (
            <button
              type="button"
              className={`deploy-trouble-ray${arrived ? '' : ' is-arriving'}`}
              style={{ width: RAY_W, height: RAY_H }}
              onClick={diagnose}
              aria-label={t('failedNotice.ray')}
              title={t('findOutWhy')}
            >
              {rayBody}
            </button>
          ) : (
            <span
              className={`deploy-trouble-ray${arrived ? '' : ' is-arriving'}`}
              style={{ width: RAY_W, height: RAY_H }}
              aria-hidden="true"
            >
              {rayBody}
            </span>
          )
        ) : (
          <Codicon name="error" className="deploy-trouble-icon" />
        )}

        <div className="deploy-trouble-say">
          {withRay ? (
            <>
              <div className="deploy-trouble-bubble">
                {arrived && (
                  // Beside him in the pane, which can resize while he talks: no balancing.
                  <SpeechBubble
                    line={{ kind: 'chat', text: line }}
                    typing={!reduced}
                    balance={false}
                  />
                )}
              </div>
              <span className="sr-only" role="alert">
                {line}
              </span>
            </>
          ) : (
            <p className="deploy-trouble-text" role="alert">
              {line}
            </p>
          )}
          <div className="deploy-trouble-actions">
            {choose && (
              <button className="btn btn--sm btn--primary" onClick={choose}>
                {t('region.chooseAnother')}
              </button>
            )}
            {trouble === 'unsupported' && (
              <button
                className="btn btn--sm"
                title={t('region.availabilityTitle')}
                onClick={() => void window.api.openExternal(REGION_AVAILABILITY_URL)}
              >
                <Codicon name="link-external" />
                {t('region.availability')}
              </button>
            )}
            {refresh && (
              <button className="btn btn--sm btn--primary" disabled={authBusy} onClick={refresh}>
                {t('failedNotice.refreshAuth')}
              </button>
            )}
            {diagnose && (
              <button
                className={`btn btn--sm${refresh ? '' : ' btn--primary'}`}
                onClick={diagnose}
                title={t('failedNotice.diagnoseTitle')}
              >
                <Codicon name="comment-discussion" />
                {t('findOutWhy')}
              </button>
            )}
            {output && (
              <button
                className="btn btn--sm btn--link"
                aria-expanded={showOutput}
                onClick={() => setShowOutput((shown) => !shown)}
              >
                {log?.length
                  ? showOutput
                    ? t('logs.hide')
                    : t('logs.show')
                  : showOutput
                    ? t('failedNotice.hideDetails')
                    : t('failedNotice.showDetails')}
              </button>
            )}
          </div>
        </div>

        <button
          type="button"
          className="icon-btn deploy-trouble-close"
          aria-label={t('actions.dismiss')}
          title={t('failedNotice.dismissTitle')}
          onClick={dismiss}
        >
          <Codicon name="close" />
        </button>
      </div>

      {showOutput && <pre className="deploy-log deploy-log--static deploy-trouble-log">{output}</pre>}
    </section>
  )
}
