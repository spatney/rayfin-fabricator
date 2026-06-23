import { useCallback, useEffect, useRef, useState } from 'react'
import type { DeployResult, PreviewBounds, StudioProject } from '@shared/ipc'
import { usePreviewSuppressed } from '../overlay'
import AnnotateOverlay from './AnnotateOverlay'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ReloadIcon,
  FabricIcon,
  AnnotateIcon,
  CookieIcon,
  ExpandIcon,
  CollapseIcon
} from './icons'

export interface DeployUiState {
  running: boolean
  log: string[]
  result?: DeployResult
}

/**
 * An annotated screenshot pending attachment to the next chat message. Produced
 * by {@link AnnotateOverlay} after the user draws on a frozen capture of the
 * preview, and consumed by the chat composer (see {@link Props.onCapture}).
 */
export interface PendingShot {
  /** Absolute temp-file path passed to copilot as `--attachment`. */
  path: string
  /** Data URL used only to render a thumbnail in the UI. */
  thumb: string
}

interface Props {
  project: StudioProject
  deploy: DeployUiState | undefined
  /** Deploy the project; pass a workspace target (name / portal URL / GUID) when known. */
  onDeploy: (workspace?: string, force?: boolean) => void
  /** Called with an annotated screenshot to stage as a chat attachment. */
  onCapture: (shot: PendingShot) => void
  /** True when the preview pane is expanded to fill the build view (chat hidden). */
  focused: boolean
  /** Toggle preview focus (full-width preview ⇄ split with chat). */
  onToggleFocus: () => void
}

function statusLabel(running: boolean, status: string | undefined): string {
  if (running) return 'Deploying…'
  switch (status) {
    case 'success':
      return 'Live'
    case 'error':
      return 'Deploy failed'
    case 'deploying':
      return 'Deploying…'
    default:
      return 'Not deployed'
  }
}

export default function PreviewPane({
  project,
  deploy,
  onDeploy,
  onCapture,
  focused,
  onToggleFocus
}: Props): JSX.Element {
  const suppressed = usePreviewSuppressed()
  const running = deploy?.running ?? false
  const deployedUrl = project.lastDeploy?.url
  // The deployed item can also be viewed embedded in the Fabric portal shell
  // (`…/groups/{workspace}/appbackends/{item}`). The CLI hands us that deep link
  // as `lastDeploy.portalUrl`; a toolbar toggle switches the webview between the
  // direct app URL and this Fabric-hosted view.
  const fabricUrl = project.lastDeploy?.portalUrl
  const status = running ? 'deploying' : project.lastDeploy?.status
  const error = project.lastDeploy?.error
  // The first deploy of a project has no recorded Fabric workspace — surface a
  // prompt instead of a dead error so the user can pick a target and retry.
  const outcome = deploy?.result?.outcome ?? project.lastDeploy?.outcome
  const needsWorkspace = !running && outcome === 'needs-workspace'
  // A destructive schema change needs an explicit --force opt-in (data loss risk).
  const needsForce = !running && outcome === 'needs-force'

  const hostRef = useRef<HTMLDivElement>(null)
  const logRef = useRef<HTMLPreElement>(null)
  const prevRunningRef = useRef(running)
  const [reloadNonce, setReloadNonce] = useState(0)
  const [displayUrl, setDisplayUrl] = useState(deployedUrl ?? '')
  const [loading, setLoading] = useState(false)
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)
  const [clearing, setClearing] = useState(false)
  // Annotate-and-attach: `captured` holds the frozen PNG (data URL) being drawn on.
  const [captured, setCaptured] = useState<string | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [captureErr, setCaptureErr] = useState<string | null>(null)
  // While an HTML overlay suppresses the native preview, `frozen` holds a PNG of
  // the last visible frame so the placeholder shows that still image, not black.
  const [frozen, setFrozen] = useState<string | null>(null)

  const showWebview = !running && Boolean(deployedUrl)
  // Which URL the embedded webview actually loads. Falls back to the direct URL
  // whenever the Fabric link is unavailable or the toggle is off.
  const [previewMode, setPreviewMode] = useState<'direct' | 'fabric'>('direct')
  const previewUrl = previewMode === 'fabric' && fabricUrl ? fabricUrl : deployedUrl

  // Switching projects shouldn't carry a prior project's Fabric view over.
  useEffect(() => {
    setPreviewMode('direct')
  }, [project.id])

  // Auto-reload the preview after a successful (re)deploy.
  useEffect(() => {
    const wasRunning = prevRunningRef.current
    prevRunningRef.current = running
    if (wasRunning && !running && deploy?.result?.ok) {
      setReloadNonce((n) => n + 1)
    }
  }, [running, deploy?.result])

  useEffect(() => {
    if (deployedUrl) setDisplayUrl(deployedUrl)
  }, [deployedUrl])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [deploy?.log])

  // Subscribe to navigation state pushed from the native webview (Rust side).
  useEffect(() => {
    return window.api.preview.onNavState((s) => {
      if (s.url) setDisplayUrl(s.url)
      setLoading(s.loading)
      setCanBack(s.canGoBack)
      setCanForward(s.canGoForward)
    })
  }, [])

  // Position the native webview over its host placeholder and keep it tracking
  // the host's bounds. The webview is a real OS surface that paints above all
  // HTML, so when it is not meant to be visible (deploying, no deployment, a
  // covering modal, the pane collapsed to 0×0) we hide it instead.
  useEffect(() => {
    const visible = showWebview && !suppressed && Boolean(deployedUrl)
    const host = hostRef.current
    if (!visible || !host || !deployedUrl || !previewUrl) {
      // An HTML overlay (a dropdown/menu/modal) covering a live preview suppresses
      // the native webview, which would otherwise paint over it. Rather than blank
      // the pane to black, freeze the last visible frame to a PNG and paint it into
      // the placeholder so the overlay appears to float over a still preview.
      if (suppressed && showWebview && deployedUrl) {
        let cancelled = false
        void (async () => {
          try {
            const frame = await window.api.preview.capture()
            if (!cancelled) setFrozen(frame)
          } catch {
            // Capture can fail (e.g. no surface yet) — fall back to a blank pane.
          } finally {
            // Skip the hide if the overlay closed mid-capture: the visible branch
            // has already re-shown the webview and cleared the frozen frame, and a
            // late hide() here would wrongly blank the now-visible preview.
            if (!cancelled) void window.api.preview.hide()
          }
        })()
        return () => {
          cancelled = true
        }
      }
      setFrozen(null)
      void window.api.preview.hide()
      return
    }

    // Becoming visible again — drop any frozen frame so the live webview shows through.
    setFrozen(null)

    let raf = 0
    // `shownKey` is the bounds key the webview is currently shown at; '' means
    // the webview is hidden. The webview is a separate OS surface, so after it
    // has been hidden (e.g. the pane collapsed to 0×0 when chat is focused) it
    // must be re-`show()`n — not merely repositioned — once its host reappears.
    let shownKey = ''
    const measure = (): PreviewBounds | null => {
      const r = host.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) return null
      return { x: r.left, y: r.top, width: r.width, height: r.height }
    }

    const tick = (): void => {
      const b = measure()
      if (!b) {
        if (shownKey !== '') {
          shownKey = ''
          void window.api.preview.hide()
        }
      } else {
        const key = `${b.x}|${b.y}|${b.width}|${b.height}`
        if (shownKey === '') {
          // Was hidden → show + position (showUrl re-shows the surface).
          shownKey = key
          void window.api.preview.showUrl(previewUrl, b)
        } else if (key !== shownKey) {
          shownKey = key
          void window.api.preview.setBounds(b)
        }
      }
      raf = requestAnimationFrame(tick)
    }

    const initial = measure()
    if (initial) {
      shownKey = `${initial.x}|${initial.y}|${initial.width}|${initial.height}`
      void window.api.preview.showUrl(previewUrl, initial)
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
    }
  }, [deployedUrl, previewUrl, showWebview, suppressed])

  // The positioning effect hides the webview whenever a dependency change makes it
  // not-visible (and its rAF loop hides it when the host collapses to 0×0); this
  // hides it once more when the pane itself unmounts.
  useEffect(() => () => void window.api.preview.hide(), [])

  // Refresh the page after a successful (re)deploy (URL is often unchanged).
  useEffect(() => {
    if (reloadNonce > 0) void window.api.preview.reload()
  }, [reloadNonce])

  const reload = useCallback((): void => {
    void window.api.preview.reload()
  }, [])
  // Drop the preview's cached WebView2 session (cookies + tokens) and reload, so
  // a previously cached Entra/AAD identity no longer auto-signs-in.
  const clearSession = useCallback(async (): Promise<void> => {
    setClearing(true)
    try {
      await window.api.preview.clearData()
    } finally {
      setClearing(false)
    }
  }, [])
  const goBack = useCallback((): void => {
    void window.api.preview.back()
  }, [])
  const goForward = useCallback((): void => {
    void window.api.preview.forward()
  }, [])
  const openExternal = (): void => {
    const u = displayUrl || deployedUrl
    if (u) void window.api.openExternal(u)
  }
  // Freeze the current preview to a PNG, then open the annotate overlay on top.
  // Capture runs while the webview is still visible; the overlay then hides it.
  const startAnnotate = useCallback(async (): Promise<void> => {
    setCaptureErr(null)
    setCapturing(true)
    try {
      const dataUrl = await window.api.preview.capture()
      setCaptured(dataUrl)
    } catch (e) {
      setCaptureErr(e instanceof Error ? e.message : String(e))
    } finally {
      setCapturing(false)
    }
  }, [])

  const dotClass =
    status === 'success'
      ? 'ok'
      : status === 'error'
        ? 'err'
        : running || status === 'deploying'
          ? 'busy'
          : 'idle'

  return (
    <div className="preview">
      <div className="preview-toolbar">
        <div className="preview-toolbar-left">
          <div className="seg seg--toolbar preview-nav">
            <button
              className="seg-btn seg-btn--icon"
              onClick={goBack}
              disabled={!showWebview || !canBack}
              aria-label="Back"
              title="Back"
            >
              <ChevronLeftIcon />
            </button>
            <button
              className="seg-btn seg-btn--icon"
              onClick={goForward}
              disabled={!showWebview || !canForward}
              aria-label="Forward"
              title="Forward"
            >
              <ChevronRightIcon />
            </button>
            <button
              className="seg-btn seg-btn--icon"
              onClick={reload}
              disabled={!showWebview}
              aria-label="Reload"
              title="Reload"
            >
              <ReloadIcon />
            </button>
          </div>
          <span className={`preview-status preview-status--${dotClass}`}>
            <span className="preview-dot" />
            {statusLabel(running, status)}
          </span>
          {(displayUrl || deployedUrl) && (
            <button
              className="preview-url"
              title={displayUrl || deployedUrl}
              onClick={openExternal}
            >
              {displayUrl || deployedUrl}
            </button>
          )}
        </div>
        <div className="preview-toolbar-right">
          {loading && showWebview && <span className="preview-loading">Loading…</span>}
          <div className="seg seg--toolbar">
            <button
              className={`seg-btn ${previewMode === 'fabric' ? 'seg-btn--on' : ''}`}
              onClick={() => setPreviewMode((m) => (m === 'fabric' ? 'direct' : 'fabric'))}
              disabled={!showWebview || !fabricUrl}
              title={
                !fabricUrl
                  ? 'The Fabric portal view is unavailable for this deployment'
                  : previewMode === 'fabric'
                    ? 'Viewing inside the Fabric portal shell — click to return to the direct app view'
                    : 'View the app embedded in the Fabric portal shell'
              }
            >
              <FabricIcon />
              Fabric
            </button>
            <button
              className="seg-btn"
              onClick={() => void startAnnotate()}
              disabled={!showWebview || capturing}
              title="Take a screenshot of the preview, draw on it, and attach it to your message"
            >
              <AnnotateIcon />
              {capturing ? 'Capturing…' : 'Annotate'}
            </button>
            <button
              className="seg-btn seg-btn--icon"
              onClick={() => void clearSession()}
              disabled={!showWebview || clearing}
              aria-label="Clear cookies"
              title="Clear the preview's cookies and cached sign-in, then reload — use this to sign in as a different account or Entra tenant"
            >
              {clearing ? <ReloadIcon className="btn-ico icon-spin" /> : <CookieIcon />}
            </button>
            <button
              className={`seg-btn seg-btn--icon ${focused ? 'seg-btn--on' : ''}`}
              onClick={onToggleFocus}
              aria-label={focused ? 'Exit focus' : 'Focus'}
              title={
                focused ? 'Exit focus — show the chat again' : 'Focus the preview — hide the chat'
              }
            >
              {focused ? <CollapseIcon /> : <ExpandIcon />}
            </button>
          </div>
        </div>
      </div>

      {captureErr && (
        <div className="preview-error-banner" title={captureErr}>
          ⚠ Couldn’t capture the preview: {captureErr}
        </div>
      )}

      {status === 'error' && error && !running && !needsWorkspace && !needsForce && (
        <div className="preview-error-banner" title={error}>
          ⚠ {error}
        </div>
      )}

      {needsForce && (
        <div className="preview-force-banner">
          <span className="preview-force-msg" title={error}>
            ⚠ Destructive schema change — applying may drop data.
          </span>
          <button
            className="btn btn--xs btn--danger"
            onClick={() => onDeploy(undefined, true)}
            disabled={running}
          >
            Apply anyway (--force)
          </button>
        </div>
      )}

      <div className="preview-body">
        {running ? (
          <pre className="deploy-log" ref={logRef}>
            {deploy?.log.join('') || 'Starting deploy…'}
          </pre>
        ) : showWebview ? (
          <div className="preview-canvas">
            <div className="preview-stage">
              {/* Placeholder the native WebView2 child is positioned over. When an
                  overlay suppresses the native child, `frozen` paints the last frame
                  here so the overlay floats over a still preview instead of black. */}
              <div className="preview-webview-host" ref={hostRef}>
                {frozen && <img className="preview-frozen" src={frozen} alt="" draggable={false} />}
              </div>
            </div>
          </div>
        ) : needsWorkspace ? (
          <div className="preview-placeholder">
            <div className="ws-prompt">
              <h3 className="ws-prompt-title">Choose where to deploy</h3>
              <p className="ws-prompt-sub">
                <strong>{project.name}</strong> hasn’t been deployed yet. Hit{' '}
                <strong>Deploy</strong> in the header above to name a deployment and pick the Fabric
                workspace to publish it into.
              </p>
              {error && <div className="alert alert--error ws-prompt-err">{error}</div>}
            </div>
          </div>
        ) : (
          <div className="preview-placeholder">
            {error ? (
              <>
                <div className="alert alert--error">{error}</div>
                {deploy?.log.length ? (
                  <pre className="deploy-log deploy-log--static">{deploy.log.join('')}</pre>
                ) : null}
              </>
            ) : (
              <p>
                Your deployed app will render here after a full <code>rayfin up</code>. Ask Copilot
                to build something, or hit <strong>Deploy</strong>.
              </p>
            )}
          </div>
        )}
      </div>

      {captured && (
        <AnnotateOverlay
          image={captured}
          onCancel={() => setCaptured(null)}
          onConfirm={(shot) => {
            onCapture(shot)
            setCaptured(null)
          }}
        />
      )}
    </div>
  )
}
