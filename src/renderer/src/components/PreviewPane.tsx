import { useCallback, useEffect, useRef, useState } from 'react'
import type { DeployResult, StudioProject } from '@shared/ipc'
import type { PreviewWebview } from '../webview'

export interface DeployUiState {
  running: boolean
  log: string[]
  result?: DeployResult
}

interface Props {
  project: StudioProject
  deploy: DeployUiState | undefined
  onDeploy: () => void
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

export default function PreviewPane({ project, deploy, onDeploy }: Props): JSX.Element {
  const running = deploy?.running ?? false
  const deployedUrl = project.lastDeploy?.url
  const status = running ? 'deploying' : project.lastDeploy?.status
  const error = project.lastDeploy?.error

  const webviewRef = useRef<PreviewWebview | null>(null)
  const logRef = useRef<HTMLPreElement>(null)
  const prevRunningRef = useRef(running)
  const [reloadNonce, setReloadNonce] = useState(0)
  const [displayUrl, setDisplayUrl] = useState(deployedUrl ?? '')
  const [loading, setLoading] = useState(false)
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

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

  // Wire webview events whenever it (re)mounts via a stable callback ref.
  const attachWebview = useCallback((node: HTMLElement | null): void => {
    const wv = node as PreviewWebview | null
    webviewRef.current = wv
    if (!wv) return
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
  }, [])

  const reload = (): void => webviewRef.current?.reload()
  const goBack = (): void => webviewRef.current?.goBack()
  const goForward = (): void => webviewRef.current?.goForward()
  const openExternal = (): void => {
    const u = displayUrl || deployedUrl
    if (u) void window.api.openExternal(u)
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
        {loading && showWebview && <span className="preview-loading">Loading…</span>}
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
            <webview
              key={`${deployedUrl}#${reloadNonce}`}
              ref={attachWebview}
              src={deployedUrl}
              className="preview-webview"
              partition="persist:rayfin-preview"
              allowpopups={true}
            />
            {loadError && (
              <div className="preview-overlay">
                <div className="alert alert--error">{loadError}</div>
                <button className="btn btn--sm btn--ghost" onClick={reload}>
                  Retry
                </button>
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
