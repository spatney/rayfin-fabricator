import { useEffect, useRef } from 'react'
import type { DeployResult, StudioProject } from '@shared/ipc'

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
      return 'Deployed'
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
  const url = project.lastDeploy?.url
  const status = running ? 'deploying' : project.lastDeploy?.status
  const error = project.lastDeploy?.error
  const logRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [deploy?.log])

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
        <span className={`preview-status preview-status--${dotClass}`}>
          <span className="preview-dot" />
          {statusLabel(running, status)}
        </span>
        {url && (
          <button
            className="preview-url"
            title={url}
            onClick={() => void window.api.openExternal(url)}
          >
            {url}
          </button>
        )}
        <span className="preview-toolbar-spacer" />
        <button className="btn btn--sm btn--primary" onClick={onDeploy} disabled={running}>
          {running ? 'Deploying…' : url ? 'Redeploy' : 'Deploy'}
        </button>
      </div>

      <div className="preview-body">
        {running ? (
          <pre className="deploy-log" ref={logRef}>
            {deploy?.log.join('') || 'Starting deploy…'}
          </pre>
        ) : url ? (
          <div className="preview-placeholder">
            <p>
              Deployed app at <code>{url}</code>.
            </p>
            <p className="preview-hint">The embedded live preview lands in the next step.</p>
            {error && <div className="alert alert--error">{error}</div>}
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
