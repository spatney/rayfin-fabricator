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

/** Responsive preview presets — constrain the webview width to emulate devices. */
type DeviceId = 'desktop' | 'tablet' | 'phone'
const DEVICE_WIDTHS: Record<DeviceId, number | null> = {
  desktop: null,
  tablet: 820,
  phone: 390
}

/** A single line captured from the preview's `console-message` stream. */
interface ConsoleEntry {
  id: number
  level: 'log' | 'info' | 'warn' | 'error'
  text: string
}

/** Normalize Electron's numeric (legacy) or string console level to our union. */
function consoleLevel(level: number | string | undefined): ConsoleEntry['level'] {
  if (typeof level === 'string') {
    const l = level.toLowerCase()
    if (l.startsWith('warn')) return 'warn'
    if (l.startsWith('err')) return 'error'
    if (l.startsWith('info')) return 'info'
    return 'log'
  }
  switch (level) {
    case 2:
      return 'warn'
    case 3:
      return 'error'
    case 1:
      return 'info'
    default:
      return 'log'
  }
}

interface Props {
  project: StudioProject
  deploy: DeployUiState | undefined
  /** Deploy the project; pass a workspace target (name / portal URL / GUID) when known. */
  onDeploy: (workspace?: string, force?: boolean) => void
  /** Called when the user captures a region of the preview. */
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
  const running = deploy?.running ?? false
  const deployedUrl = project.lastDeploy?.url
  const status = running ? 'deploying' : project.lastDeploy?.status
  const error = project.lastDeploy?.error
  // The first deploy of a project has no recorded Fabric workspace — surface a
  // prompt instead of a dead error so the user can pick a target and retry.
  const outcome = deploy?.result?.outcome ?? project.lastDeploy?.outcome
  const needsWorkspace = !running && outcome === 'needs-workspace'
  // A destructive schema change needs an explicit --force opt-in (data loss risk).
  const needsForce = !running && outcome === 'needs-force'
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

  // Preview-depth: responsive device width + captured console output.
  const [device, setDevice] = useState<DeviceId>('desktop')
  const [consoleLogs, setConsoleLogs] = useState<ConsoleEntry[]>([])
  const [showConsole, setShowConsole] = useState(false)
  const consoleSeq = useRef(0)
  const consoleListRef = useRef<HTMLDivElement>(null)

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

  // Keep the console panel pinned to the newest line while it's open.
  useEffect(() => {
    if (showConsole && consoleListRef.current) {
      consoleListRef.current.scrollTop = consoleListRef.current.scrollHeight
    }
  }, [consoleLogs, showConsole])

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
    setConsoleLogs([])
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
    // Capture the guest's console into a panel so deploy issues are visible
    // without opening devtools (Electron 33 emits numeric `level`).
    wv.addEventListener('console-message', (e: Event) => {
      const ev = e as unknown as { level?: number | string; message?: string }
      const entry: ConsoleEntry = {
        id: ++consoleSeq.current,
        level: consoleLevel(ev.level),
        text: ev.message ?? ''
      }
      setConsoleLogs((prev) => {
        const next = prev.concat(entry)
        return next.length > 200 ? next.slice(next.length - 200) : next
      })
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
  const stageWidth = DEVICE_WIDTHS[device]
  const stageStyle = stageWidth ? { width: stageWidth, maxWidth: '100%' } : undefined
  const consoleIssues = consoleLogs.reduce(
    (n, l) => (l.level === 'warn' || l.level === 'error' ? n + 1 : n),
    0
  )

  return (
    <div className="preview">
      <div className="preview-toolbar">
        <div className="preview-toolbar-left">
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
          {capturing && <span className="preview-loading">Capturing…</span>}
          {loading && showWebview && <span className="preview-loading">Loading…</span>}
          <select
            className="device-select"
            value={device}
            onChange={(e) => setDevice(e.target.value as DeviceId)}
            disabled={!showWebview}
            title="Preview at a device width"
          >
            <option value="desktop">🖥 Desktop</option>
            <option value="tablet">▭ Tablet · 820</option>
            <option value="phone">▯ Phone · 390</option>
          </select>
          <button
            className={`btn btn--sm ${showConsole ? 'btn--primary' : 'btn--ghost'}`}
            onClick={() => setShowConsole((s) => !s)}
            disabled={!showWebview && consoleLogs.length === 0}
            title="Show the preview's console output"
          >
            Console
            {consoleIssues > 0 && <span className="console-badge">{consoleIssues}</span>}
          </button>
          <button
            className={`btn btn--sm ${selecting ? 'btn--primary' : 'btn--ghost'}`}
            onClick={() => setSelecting((s) => !s)}
            disabled={!showWebview || capturing}
            title="Drag a region of the preview to attach it to chat"
          >
            {selecting ? 'Cancel' : '⛶ Capture'}
          </button>
          <button
            className={`btn btn--sm ${focused ? 'btn--primary' : 'btn--ghost'}`}
            onClick={onToggleFocus}
            title={focused ? 'Exit focus — show the chat again' : 'Focus the preview — hide the chat'}
          >
            {focused ? '⤡ Exit focus' : '⤢ Focus'}
          </button>
        </div>
      </div>

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
          <div className={`preview-canvas${showConsole ? ' has-console' : ''}`}>
            <div className={`preview-stage preview-stage--${device}`} style={stageStyle}>
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
            </div>
            {showConsole && (
              <div className="preview-console">
                <div className="preview-console-head">
                  <span>Console{consoleLogs.length ? ` · ${consoleLogs.length}` : ''}</span>
                  <span className="preview-console-actions">
                    <button
                      className="btn btn--xs btn--ghost"
                      onClick={() => setConsoleLogs([])}
                      disabled={consoleLogs.length === 0}
                    >
                      Clear
                    </button>
                    <button
                      className="deployments-close"
                      onClick={() => setShowConsole(false)}
                      title="Close console"
                    >
                      ✕
                    </button>
                  </span>
                </div>
                <div className="preview-console-list" ref={consoleListRef}>
                  {consoleLogs.length === 0 ? (
                    <div className="preview-console-empty">
                      No console output yet. Messages logged by the deployed app appear here.
                    </div>
                  ) : (
                    consoleLogs.map((l) => (
                      <div key={l.id} className={`console-row console-row--${l.level}`}>
                        <span className="console-row-level">{l.level}</span>
                        <span className="console-row-text">{l.text}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
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
    </div>
  )
}
