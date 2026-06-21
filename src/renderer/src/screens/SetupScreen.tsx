import { useEffect, useRef, useState } from 'react'
import type { AuthStatus, DoctorReport, ProcLogEvent, ToolId, ToolStatus } from '@shared/ipc'
import logo from '../assets/logo.png'

interface Props {
  doctor: DoctorReport | null
  auth: AuthStatus | null
  refreshing: boolean
  onRefresh: () => Promise<void> | void
}

export default function SetupScreen({ doctor, auth, refreshing, onRefresh }: Props): JSX.Element {
  const [log, setLog] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [showLog, setShowLog] = useState(false)
  const logRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    return window.api.onProcLog((e: ProcLogEvent) => {
      setLog((prev) => prev + e.data)
    })
  }, [])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log])

  async function runAction(key: string, label: string, fn: () => Promise<unknown>): Promise<void> {
    setBusy(key)
    setShowLog(true)
    setLog((p) => `${p}\n\u203a ${label}\n`)
    try {
      await fn()
    } catch (err) {
      setLog((p) => `${p}\n[error] ${String(err)}\n`)
    } finally {
      setBusy(null)
      await onRefresh()
    }
  }

  const tools = doctor?.tools ?? []
  const tool = (id: ToolId): ToolStatus | undefined => tools.find((t) => t.id === id)
  const copilotReady = tool('copilot')?.found ?? false
  const rayfinReady = tool('rayfin')?.found ?? false

  const allReady =
    (doctor?.ready ?? false) &&
    (auth?.copilot.signedIn ?? false) &&
    (auth?.rayfin.signedIn ?? false)

  return (
    <div className="setup">
      <div className="setup-inner">
        <header className="setup-header">
          <div className="brand">
            <img className="brand-mark" src={logo} alt="" />
            <span className="brand-name">Rayfin Studio</span>
          </div>
          <p className="setup-sub">
            Build and ship Rayfin apps by chatting with an AI agent. Let&apos;s get your
            environment ready.
          </p>
        </header>

        <section className="setup-card">
          <h2 className="setup-card-title">1 · Tools</h2>
          <ul className="tool-list">
            {tools.map((t) => (
              <li key={t.id} className="tool-row">
                <span className={`status-dot ${t.found ? 'status-dot--ok' : 'status-dot--bad'}`} />
                <span className="tool-name">{t.name}</span>
                <span className="tool-version">{t.found ? t.version : t.installHint}</span>
                <span className="tool-action">
                  {t.found ? (
                    <span className="tag tag--ok">installed</span>
                  ) : t.autoInstallable ? (
                    <button
                      className="btn btn--sm"
                      disabled={busy !== null}
                      onClick={() =>
                        runAction(`install:${t.id}`, `Install ${t.name}`, () =>
                          window.api.doctor.install(t.id)
                        )
                      }
                    >
                      {busy === `install:${t.id}` ? 'Installing…' : 'Install'}
                    </button>
                  ) : (
                    <a className="btn btn--sm btn--link" href={t.installUrl} target="_blank" rel="noreferrer">
                      Get it
                    </a>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="setup-card">
          <h2 className="setup-card-title">2 · Sign in</h2>
          <div className="auth-grid">
            <AuthCard
              title="GitHub Copilot"
              subtitle="The AI agent that writes your code"
              signedIn={auth?.copilot.signedIn ?? false}
              detail={auth?.copilot.user}
              disabled={!copilotReady || busy !== null}
              disabledReason={!copilotReady ? 'Install the Copilot CLI first' : undefined}
              busy={busy === 'login:copilot'}
              onSignIn={() =>
                runAction('login:copilot', 'Sign in to GitHub Copilot', () =>
                  window.api.auth.loginCopilot()
                )
              }
            />
            <AuthCard
              title="Microsoft Fabric"
              subtitle="Where your Rayfin apps deploy"
              signedIn={auth?.rayfin.signedIn ?? false}
              detail={auth?.rayfin.user}
              extra={auth?.rayfin.tenant ? `Tenant ${auth.rayfin.tenant}` : undefined}
              disabled={!rayfinReady || busy !== null}
              disabledReason={!rayfinReady ? 'Install the Rayfin CLI first' : undefined}
              busy={busy === 'login:rayfin'}
              onSignIn={() =>
                runAction('login:rayfin', 'Sign in to Fabric / Rayfin', () =>
                  window.api.auth.loginRayfin()
                )
              }
            />
          </div>
        </section>

        <footer className="setup-footer">
          <button className="btn btn--ghost" onClick={() => setShowLog((s) => !s)}>
            {showLog ? 'Hide' : 'Show'} log
          </button>
          <div className="setup-footer-right">
            <button className="btn btn--ghost" disabled={refreshing || busy !== null} onClick={() => onRefresh()}>
              {refreshing ? 'Checking…' : 'Re-check'}
            </button>
            <button
              className="btn btn--primary"
              disabled={!allReady || busy !== null}
              onClick={() => onRefresh()}
            >
              Enter Rayfin Studio →
            </button>
          </div>
        </footer>

        {showLog && (
          <pre ref={logRef} className="setup-log">
            {log.trim() || 'Process output will appear here.'}
          </pre>
        )}
      </div>
    </div>
  )
}

interface AuthCardProps {
  title: string
  subtitle: string
  signedIn: boolean
  detail?: string
  extra?: string
  disabled: boolean
  disabledReason?: string
  busy: boolean
  onSignIn: () => void
}

function AuthCard(props: AuthCardProps): JSX.Element {
  return (
    <div className={`auth-card ${props.signedIn ? 'auth-card--ok' : ''}`}>
      <div className="auth-card-head">
        <span className="auth-card-title">{props.title}</span>
        <span className={`status-dot ${props.signedIn ? 'status-dot--ok' : 'status-dot--bad'}`} />
      </div>
      <p className="auth-card-sub">{props.subtitle}</p>
      {props.signedIn ? (
        <div className="auth-card-detail">
          <div className="auth-card-user">{props.detail ?? 'Signed in'}</div>
          {props.extra && <div className="auth-card-extra">{props.extra}</div>}
        </div>
      ) : (
        <button className="btn btn--primary btn--block" disabled={props.disabled} onClick={props.onSignIn}>
          {props.busy ? 'Waiting for sign-in…' : 'Sign in'}
        </button>
      )}
      {!props.signedIn && props.disabledReason && (
        <p className="auth-card-hint">{props.disabledReason}</p>
      )}
    </div>
  )
}
