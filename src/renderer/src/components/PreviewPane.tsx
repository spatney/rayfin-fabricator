import { useCallback, useEffect, useRef, useState } from 'react'
import type { DeployResult, StudioProject } from '@shared/ipc'
import type { PreviewWebview } from '../webview'

export interface DeployUiState {
  running: boolean
  log: string[]
  result?: DeployResult
}

/** A region screenshot pending attachment to the next chat message. */
export interface PendingShot {
  /** Absolute temp-file path passed to copilot as `--attachment`. */
  path: string
  /** Data URL used only to render a thumbnail in the UI. */
  thumb: string
}

interface Props {
  project: StudioProject
  deploy: DeployUiState | undefined
  onDeploy: () => void
  /** Called when the user captures a region of the preview. */
  onCapture: (shot: PendingShot) => void
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

export default function PreviewPane({ project, deploy, onDeploy, onCapture }: Props): JSX.Element {
  const running = deploy?.running ?? false
  const deployedUrl = project.lastDeploy?.url
  const status = running ? 'deploying' : project.lastDeploy?.status
  const error = project.lastDeploy?.error

  const webviewRef = useRef<PreviewWebview | null>(null)
  const deployedUrlRef = useRef(deployedUrl)
  deployedUrlRef.current = deployedUrl
  const logRef = useRef<HTMLPreElement>(null)
  const prevRunningRef = useRef(running)
  const [reloadNonce, setReloadNonce] = useState(0)
  const [displayUrl, setDisplayUrl] = useState(deployedUrl ?? '')
  const [loading, setLoading] = useState(false)
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Region-screenshot selection state.
  const [selecting, setSelecting] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const dragRef = useRef<{ x: number; y: number } | null>(null)
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null)

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

  // Build the <webview> imperatively inside its host container so `allowpopups`
  // and `partition` are present BEFORE the element is connected to the DOM.
  // Electron reads those attributes when the guest attaches (on DOM-connect),
  // which happens earlier than any React ref / setAttribute could run — a late
  // setAttribute leaves the guest without popup permission, so Chromium blocks the
  // deployed app's window.open sign-in popup before our main-process handler runs.
  const attachWebviewHost = useCallback((host: HTMLDivElement | null): void => {
    if (!host) {
      webviewRef.current = null
      return
    }
    const initialUrl = deployedUrlRef.current
    if (!initialUrl) return
    const wv = document.createElement('webview') as unknown as PreviewWebview
    wv.setAttribute('allowpopups', 'true')
    wv.setAttribute('partition', 'persist:rayfin-preview')
    wv.setAttribute('src', initialUrl)
    wv.className = 'preview-webview'
    webviewRef.current = wv
    setLoadError(null)
    setLoading(true)
    const syncNav = (): void => {
      try {
        setCanBack(wv.canGoBack())
        setCanForward(wv.canGoForward())
      } catch {
        /* not ready yet */
      }
    }
    wv.addEventListener('did-start-loading', () => setLoading(true))
    wv.addEventListener('did-stop-loading', () => {
      setLoading(false)
      syncNav()
    })
    const onNavigate = (e: Event): void => {
      const url = (e as unknown as { url?: string }).url
      if (url) setDisplayUrl(url)
      syncNav()
    }
    wv.addEventListener('did-navigate', onNavigate)
    wv.addEventListener('did-navigate-in-page', onNavigate)
    wv.addEventListener('did-fail-load', (e: Event) => {
      const { errorCode, errorDescription } = e as unknown as {
        errorCode?: number
        errorDescription?: string
      }
      // -3 = ERR_ABORTED (superseded navigation) — not a real failure.
      if (typeof errorCode === 'number' && errorCode !== -3) {
        setLoadError(errorDescription || 'Failed to load the preview.')
        setLoading(false)
      }
    })
    host.appendChild(wv)
  }, [])

  const reload = (): void => webviewRef.current?.reload()
  const goBack = (): void => webviewRef.current?.goBack()
  const goForward = (): void => webviewRef.current?.goForward()
  const openExternal = (): void => {
    const u = displayUrl || deployedUrl
    if (u) void window.api.openExternal(u)
  }

  // Capture the dragged region from the webview and hand it up as an attachment.
  const captureRegion = useCallback(
    async (b: { x: number; y: number; w: number; h: number }): Promise<void> => {
      const wv = webviewRef.current
      if (!wv) return
      setCapturing(true)
      try {
        const img = await wv.capturePage({
          x: Math.round(b.x),
          y: Math.round(b.y),
          width: Math.round(b.w),
          height: Math.round(b.h)
        })
        const thumb = img.toDataURL()
        const path = await window.api.screenshot.save(thumb)
        onCapture({ path, thumb })
      } catch (e) {
        setLoadError(`Screenshot failed: ${String(e)}`)
      } finally {
        setCapturing(false)
      }
    },
    [onCapture]
  )

  // Esc cancels an in-progress region selection.
  useEffect(() => {
    if (!selecting) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setSelecting(false)
        setBox(null)
        dragRef.current = null
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selecting])

  const onShotDown = (e: React.MouseEvent<HTMLDivElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    dragRef.current = { x: e.clientX - r.left, y: e.clientY - r.top }
    setBox({ x: dragRef.current.x, y: dragRef.current.y, w: 0, h: 0 })
  }
  const onShotMove = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (!dragRef.current) return
    const r = e.currentTarget.getBoundingClientRect()
    const cx = e.clientX - r.left
    const cy = e.clientY - r.top
    setBox({
      x: Math.min(dragRef.current.x, cx),
      y: Math.min(dragRef.current.y, cy),
      w: Math.abs(cx - dragRef.current.x),
      h: Math.abs(cy - dragRef.current.y)
    })
  }
  const onShotUp = (): void => {
    const b = box
    dragRef.current = null
    setSelecting(false)
    setBox(null)
    if (b && b.w >= 5 && b.h >= 5) void captureRegion(b)
  }

  const dotClass =
    status === 'success'
      ? 'ok'
      : status === 'error'
        ? 'err'
        : running || status === 'deploying'
          ? 'busy'
          : 'idle'

  const showWebview = !running && Boolean(deployedUrl)

  return (
    <div className="preview">
      <div className="preview-toolbar">
        <div className="preview-nav">
          <button
            className="preview-navbtn"
            onClick={goBack}
            disabled={!showWebview || !canBack}
            title="Back"
          >
            ‹
          </button>
          <button
            className="preview-navbtn"
            onClick={goForward}
            disabled={!showWebview || !canForward}
            title="Forward"
          >
            ›
          </button>
          <button
            className="preview-navbtn"
            onClick={reload}
            disabled={!showWebview}
            title="Reload"
          >
            ⟳
          </button>
        </div>
        <span className={`preview-status preview-status--${dotClass}`}>
          <span className="preview-dot" />
          {statusLabel(running, status)}
        </span>
        {(displayUrl || deployedUrl) && (
          <button className="preview-url" title={displayUrl || deployedUrl} onClick={openExternal}>
            {displayUrl || deployedUrl}
          </button>
        )}
        <span className="preview-toolbar-spacer" />
        {capturing && <span className="preview-loading">Capturing…</span>}
        {loading && showWebview && <span className="preview-loading">Loading…</span>}
        <button
          className={`btn btn--sm ${selecting ? 'btn--primary' : 'btn--ghost'}`}
          onClick={() => setSelecting((s) => !s)}
          disabled={!showWebview || capturing}
          title="Drag a region of the preview to attach it to chat"
        >
          {selecting ? 'Cancel' : '⛶ Capture'}
        </button>
        <button className="btn btn--sm btn--primary" onClick={onDeploy} disabled={running}>
          {running ? 'Deploying…' : deployedUrl ? 'Redeploy' : 'Deploy'}
        </button>
      </div>

      {status === 'error' && error && !running && (
        <div className="preview-error-banner" title={error}>
          ⚠ {error}
        </div>
      )}

      <div className="preview-body">
        {running ? (
          <pre className="deploy-log" ref={logRef}>
            {deploy?.log.join('') || 'Starting deploy…'}
          </pre>
        ) : showWebview ? (
          <>
            <div
              key={`${deployedUrl}#${reloadNonce}`}
              className="preview-webview-host"
              ref={attachWebviewHost}
            />
            {loadError && (
              <div className="preview-overlay">
                <div className="alert alert--error">{loadError}</div>
                <button className="btn btn--sm btn--ghost" onClick={reload}>
                  Retry
                </button>
              </div>
            )}
            {selecting && (
              <div
                className="shot-overlay"
                onMouseDown={onShotDown}
                onMouseMove={onShotMove}
                onMouseUp={onShotUp}
              >
                {box && (
                  <div
                    className="shot-box"
                    style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
                  />
                )}
                <div className="shot-hint">Drag to capture a region · Esc to cancel</div>
              </div>
            )}
          </>
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
    </div>
  )
}
