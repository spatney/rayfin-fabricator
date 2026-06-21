import { useCallback, useEffect, useRef, useState } from 'react'
import type { DeployResult, FabricDeployment, StudioProject } from '@shared/ipc'
import type { PreviewWebview } from '../webview'

export interface DeployUiState {
  running: boolean
  log: string[]
  result?: DeployResult
  /** Distinguishes a real `rayfin up` from a `--dry-run` preview. */
  mode?: 'deploy' | 'dryrun'
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
  /** Deploy the project; pass a workspace target (name / portal URL / GUID) when known. */
  onDeploy: (workspace?: string, force?: boolean) => void
  /** Preview the deploy with `rayfin up --dry-run` (no Fabric changes). */
  onDryRun: (workspace?: string) => void
  /** Load the project's recorded Fabric deployments (`rayfin up list`). */
  onListDeployments: () => Promise<FabricDeployment[]>
  /** Switch the active Fabric deployment (`rayfin up switch`). */
  onSwitch: (workspace: string, byId: boolean) => Promise<DeployResult>
  /** Clear a finished dry-run / deploy log from the body. */
  onDismissDeployLog: () => void
  /** Called when the user captures a region of the preview. */
  onCapture: (shot: PendingShot) => void
}

function statusLabel(
  running: boolean,
  status: string | undefined,
  mode?: 'deploy' | 'dryrun'
): string {
  if (running) return mode === 'dryrun' ? 'Previewing…' : 'Deploying…'
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
  onDryRun,
  onListDeployments,
  onSwitch,
  onDismissDeployLog,
  onCapture
}: Props): JSX.Element {
  const running = deploy?.running ?? false
  const mode = deploy?.mode
  const deployedUrl = project.lastDeploy?.url
  const status = running ? 'deploying' : project.lastDeploy?.status
  const error = project.lastDeploy?.error
  // The first deploy of a project has no recorded Fabric workspace — surface a
  // prompt instead of a dead error so the user can pick a target and retry.
  const outcome = deploy?.result?.outcome ?? project.lastDeploy?.outcome
  const needsWorkspace = !running && outcome === 'needs-workspace'
  // A destructive schema change needs an explicit --force opt-in (data loss risk).
  const needsForce = !running && outcome === 'needs-force'
  const [wsInput, setWsInput] = useState(project.workspace ?? '')

  // Deployments switcher (multi-deployment via `rayfin up switch`).
  const [showDeployments, setShowDeployments] = useState(false)
  const [deployments, setDeployments] = useState<FabricDeployment[] | null>(null)
  const [switching, setSwitching] = useState<string | null>(null)

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

  // Keep the workspace input seeded with the project's remembered workspace.
  useEffect(() => {
    setWsInput(project.workspace ?? '')
  }, [project.workspace])

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

  // Deploy: when the project still needs a workspace, send the typed target;
  // otherwise let the main process reuse the project's remembered workspace.
  const submitDeploy = (): void => {
    if (running) return
    onDeploy(needsWorkspace ? wsInput.trim() || undefined : undefined)
  }
  const submitDryRun = (): void => {
    if (running) return
    onDryRun(needsWorkspace ? wsInput.trim() || undefined : undefined)
  }

  const toggleDeployments = async (): Promise<void> => {
    const next = !showDeployments
    setShowDeployments(next)
    if (next) {
      setDeployments(null)
      setDeployments(await onListDeployments())
    }
  }
  const doSwitch = async (d: FabricDeployment): Promise<void> => {
    const byId = Boolean(d.workspaceId)
    const target = d.workspaceId ?? d.workspaceName
    if (!target) return
    setSwitching(target)
    try {
      await onSwitch(target, byId)
      setShowDeployments(false)
    } finally {
      setSwitching(null)
    }
  }

  const dotClass =
    status === 'success'
      ? 'ok'
      : status === 'error'
        ? 'err'
        : running || status === 'deploying'
          ? 'busy'
          : 'idle'

  // A finished dry run keeps its output visible in the body until dismissed.
  const dryRunDone = !running && mode === 'dryrun' && (deploy?.log.length ?? 0) > 0
  const showWebview = !running && !dryRunDone && Boolean(deployedUrl)

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
          {statusLabel(running, status, mode)}
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
        <span className="deployments-wrap">
          <button
            className="btn btn--sm btn--ghost"
            onClick={() => void toggleDeployments()}
            disabled={running}
            title="Switch between Fabric deployments"
          >
            ⇄ Deployments
          </button>
          {showDeployments && (
            <div className="deployments-pop">
              <div className="deployments-pop-head">
                <span>Deployments</span>
                <button
                  className="deployments-close"
                  onClick={() => setShowDeployments(false)}
                  title="Close"
                >
                  ✕
                </button>
              </div>
              {deployments === null ? (
                <div className="deployments-empty">Loading…</div>
              ) : deployments.length === 0 ? (
                <div className="deployments-empty">No deployments recorded yet.</div>
              ) : (
                <ul className="deployments-list">
                  {deployments.map((d) => {
                    const key = (d.workspaceId ?? d.workspaceName) + (d.itemId ?? '')
                    const target = d.workspaceId ?? d.workspaceName
                    return (
                      <li
                        key={key}
                        className={`deployments-item${d.active ? ' is-active' : ''}`}
                      >
                        <div className="deployments-item-main">
                          <span className="deployments-item-name">{d.workspaceName}</span>
                          {d.active && <span className="deployments-badge">active</span>}
                        </div>
                        {(d.hostingUrl || d.apiUrl) && (
                          <span
                            className="deployments-item-url"
                            title={d.hostingUrl || d.apiUrl}
                          >
                            {d.hostingUrl || d.apiUrl}
                          </span>
                        )}
                        {!d.active && (
                          <button
                            className="btn btn--xs btn--ghost"
                            disabled={Boolean(switching)}
                            onClick={() => void doSwitch(d)}
                          >
                            {switching === target ? 'Switching…' : 'Switch'}
                          </button>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )}
        </span>
        <button
          className="btn btn--sm btn--ghost"
          onClick={submitDryRun}
          disabled={running}
          title="Preview the deploy without changing Fabric"
        >
          Dry run
        </button>
        <button className="btn btn--sm btn--primary" onClick={submitDeploy} disabled={running}>
          {running ? statusLabel(true, status, mode) : deployedUrl ? 'Redeploy' : 'Deploy'}
        </button>
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
          <button className="btn btn--xs btn--ghost" onClick={submitDryRun} disabled={running}>
            Preview changes
          </button>
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
            {deploy?.log.join('') || (mode === 'dryrun' ? 'Starting dry run…' : 'Starting deploy…')}
          </pre>
        ) : dryRunDone ? (
          <div className="preview-placeholder">
            <div className="dryrun-result">
              <div className="dryrun-result-head">
                <span>Dry run preview — no changes were made</span>
                <button className="btn btn--xs btn--ghost" onClick={onDismissDeployLog}>
                  Dismiss
                </button>
              </div>
              <pre className="deploy-log deploy-log--static">{deploy?.log.join('')}</pre>
            </div>
          </div>
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
        ) : needsWorkspace ? (
          <div className="preview-placeholder">
            <div className="ws-prompt">
              <h3 className="ws-prompt-title">Choose a Fabric workspace</h3>
              <p className="ws-prompt-sub">
                <strong>{project.name}</strong> hasn’t been deployed yet. Pick the Fabric
                workspace to deploy into — enter its name, portal URL, or workspace ID.
              </p>
              <div className="ws-prompt-row">
                <input
                  className="ws-prompt-input"
                  value={wsInput}
                  placeholder="Workspace name, portal URL, or ID"
                  spellCheck={false}
                  autoFocus
                  onChange={(e) => setWsInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && wsInput.trim()) submitDeploy()
                  }}
                />
                <button
                  className="btn btn--primary"
                  onClick={submitDeploy}
                  disabled={!wsInput.trim()}
                >
                  Deploy here
                </button>
              </div>
              <p className="ws-prompt-hint">
                e.g. <code>Rayfin Apps</code>, a portal URL like{' '}
                <code>https://app.fabric.microsoft.com/groups/&lt;id&gt;/list</code>, or a
                workspace GUID.
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
