import { useEffect, useRef, useState } from 'react'
import type { AuthStatus, DoctorReport, InstallResult, ProcLogEvent } from '@shared/ipc'
import { FabricatorMark } from '../components/FabricatorMark'
import rayfinMark from '../assets/brands/rayfin.png'
import nodeSvg from '../assets/brands/node.svg'
import npmSvg from '../assets/brands/npm.svg'
import gitSvg from '../assets/brands/git.svg'
import azureSvg from '../assets/brands/azure.svg'
import fabricSvg from '../assets/brands/fabric.svg'
import { CopilotLogo } from '../components/brand-icons'
import { CheckIcon, DownloadIcon, ReloadIcon, TerminalIcon } from '../components/icons'

/** Official product logo (as an <img> src) for each tool, keyed by the doctor's tool id. */
const TOOL_LOGOS: Record<string, string> = {
  node: nodeSvg,
  npm: npmSvg,
  git: gitSvg,
  rayfin: rayfinMark,
  az: azureSvg
}

interface Props {
  doctor: DoctorReport | null
  auth: AuthStatus | null
  refreshing: boolean
  onRefresh: () => Promise<void> | void
  onEnter: () => void
}

export default function SetupScreen({ doctor, auth, refreshing, onRefresh, onEnter }: Props): JSX.Element {
  const [log, setLog] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [finalizing, setFinalizing] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const [needsRelaunch, setNeedsRelaunch] = useState(false)
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
      // Keep the sign-in overlay up through the auth re-check and the screen swap
      // so the setup screen never flashes its pre-sign-in state (e.g. Fabric still
      // showing "Sign in") before the workbench takes over.
      setFinalizing(true)
      try {
        await onRefresh()
      } finally {
        setBusy(null)
        setFinalizing(false)
      }
    }
  }

  /** Run an install action and react to whether a relaunch is required. */
  async function runInstall(
    key: string,
    label: string,
    fn: () => Promise<InstallResult>
  ): Promise<void> {
    setBusy(key)
    setShowLog(true)
    setLog((p) => `${p}\n\u203a ${label}\n`)
    try {
      const res = await fn()
      if (res?.requiresRelaunch) setNeedsRelaunch(true)
      if (res?.manual) {
        setLog((p) => `${p}\nFinish the install in the page that opened, then click “Restart”.\n`)
      }
    } catch (err) {
      setLog((p) => `${p}\n[error] ${String(err)}\n`)
    } finally {
      setBusy(null)
      await onRefresh()
    }
  }

  const tools = doctor?.tools ?? []
  const needsAuto = tools.filter((t) => t.required && !t.satisfied && t.autoInstallable)
  const toolsSatisfied = tools.filter((t) => t.satisfied).length

  // Fabric / Azure sign-in shell out to the global `rayfin` / `az` CLIs, so they
  // can't work until those CLIs are installed. Gate the cards on that.
  const rayfinReady = tools.find((t) => t.id === 'rayfin')?.satisfied ?? false
  const azReady = tools.find((t) => t.id === 'az')?.satisfied ?? false

  const providers = [
    auth?.copilot.signedIn ?? false,
    auth?.rayfin.signedIn ?? false,
    auth?.az.signedIn ?? false
  ]
  const signedInCount = providers.filter(Boolean).length

  const allReady = (doctor?.ready ?? false) && signedInCount === providers.length

  const totalSteps = tools.length + providers.length
  const doneSteps = toolsSatisfied + signedInCount
  const pct = totalSteps ? Math.round((doneSteps / totalSteps) * 100) : 0
  const remaining = totalSteps - doneSteps

  const loginProvider =
    busy === 'login:copilot'
      ? 'GitHub Copilot'
      : busy === 'login:rayfin'
        ? 'Microsoft Fabric'
        : busy === 'login:az'
          ? 'Azure'
          : null

  // Show only the meaningful tail of the process output in the sign-in overlay:
  // drop our own "› <label>" echo lines and blank lines so it reads as clean
  // status rather than a raw terminal dump.
  const logTail = log
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim().length > 0 && !line.trimStart().startsWith('\u203a'))
    .slice(-6)
    .join('\n')

  return (
    <div className="setup">
      <div className="setup-scroll">
        <div className="setup-inner">
          <header className="setup-hero">
            <div className="setup-hero-mark">
              <FabricatorMark />
            </div>
            <div className="setup-hero-copy">
              <span className="setup-eyebrow">Welcome to</span>
              <h1 className="setup-hero-title">Fabricator</h1>
              <p className="setup-hero-tagline">
                Build and ship Rayfin apps by chatting with an AI agent.
              </p>
            </div>
          </header>

          <div className={`setup-meter ${allReady ? 'setup-meter--done' : ''}`}>
            <div className="setup-meter-head">
              <span className="setup-meter-label">
                {allReady ? (
                  <>
                    <span className="setup-meter-check">
                      <CheckIcon />
                    </span>
                    You’re all set — everything’s installed and you’re signed in.
                  </>
                ) : (
                  'Getting your environment ready'
                )}
              </span>
              <span className="setup-meter-count">
                {doneSteps}/{totalSteps}
              </span>
            </div>
            <div className="setup-meter-track">
              <span className="setup-meter-fill" style={{ width: `${pct}%` }} />
            </div>
          </div>

          {needsRelaunch && (
            <div className="setup-relaunch">
              <div className="setup-relaunch-text">
                <strong>Almost there.</strong> Restart to finish setting up the tools that were
                just installed.
              </div>
              <button className="btn btn--primary btn--sm" onClick={() => window.api.relaunch()}>
                Restart now
              </button>
            </div>
          )}

          <div className="setup-grid">
            <section className="setup-card">
              <div className="setup-card-head">
                <div className="setup-card-heading">
                  <span className="setup-step">1</span>
                  <div className="setup-card-headings">
                    <h2 className="setup-card-title">Tools</h2>
                    <p className="setup-card-note">Command-line tools Fabricator needs locally</p>
                  </div>
                </div>
                <div className="setup-card-head-right">
                  <span
                    className={`setup-count ${
                      tools.length > 0 && toolsSatisfied === tools.length ? 'setup-count--ok' : ''
                    }`}
                  >
                    {toolsSatisfied}/{tools.length}
                  </span>
                  {needsAuto.length > 0 && (
                    <button
                      className="btn btn--primary btn--sm"
                      disabled={busy !== null}
                      onClick={() =>
                        runInstall('install:all', 'Install everything', () =>
                          window.api.doctor.installAll()
                        )
                      }
                    >
                      {busy === 'install:all' ? 'Installing…' : 'Install all'}
                    </button>
                  )}
                </div>
              </div>

              <ul className="tool-list">
                {tools.map((t) => {
                  const logoSrc = TOOL_LOGOS[t.id]
                  const state = t.satisfied ? 'ok' : t.found ? 'warn' : 'bad'
                  return (
                    <li key={t.id} className="tool-row" data-state={state}>
                      <span className="tool-ico">
                        {logoSrc ? (
                          <img className="brand-glyph" src={logoSrc} alt="" />
                        ) : (
                          <TerminalIcon />
                        )}
                      </span>
                      <div className="tool-main">
                        <span className="tool-name">{t.name}</span>
                        <span className="tool-meta">
                          {t.satisfied
                            ? t.version
                            : t.found
                              ? `${t.version} · update to ${t.minVersion}+ needed`
                              : t.installHint}
                        </span>
                      </div>
                      <div className="tool-action">
                        {t.satisfied ? (
                          <span className="tool-chip">
                            <CheckIcon className="tool-chip-ico" />
                            Installed
                          </span>
                        ) : t.autoInstallable ? (
                          <button
                            className="btn btn--sm"
                            disabled={busy !== null}
                            onClick={() =>
                              runInstall(
                                `install:${t.id}`,
                                `${t.found ? 'Update' : 'Install'} ${t.name}`,
                                () => window.api.doctor.install(t.id)
                              )
                            }
                          >
                            {busy === `install:${t.id}` ? (
                              t.found ? (
                                'Updating…'
                              ) : (
                                'Installing…'
                              )
                            ) : (
                              <>
                                <DownloadIcon className="btn-ico" />
                                {t.found ? 'Update' : 'Install'}
                              </>
                            )}
                          </button>
                        ) : (
                          <a
                            className="btn btn--sm"
                            href={t.installUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Get it
                          </a>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </section>

            <section className="setup-card">
              <div className="setup-card-head">
                <div className="setup-card-heading">
                  <span className="setup-step">2</span>
                  <div className="setup-card-headings">
                    <h2 className="setup-card-title">Sign in</h2>
                    <p className="setup-card-note">Accounts Fabricator builds and deploys with</p>
                  </div>
                </div>
                <div className="setup-card-head-right">
                  <span
                    className={`setup-count ${
                      signedInCount === providers.length ? 'setup-count--ok' : ''
                    }`}
                  >
                    {signedInCount}/{providers.length}
                  </span>
                </div>
              </div>

              <ul className="auth-list">
                <AuthRow
                  icon={<CopilotLogo />}
                  title="GitHub Copilot"
                  subtitle="The AI agent that writes your code"
                  signedIn={auth?.copilot.signedIn ?? false}
                  detail={auth?.copilot.user}
                  disabled={busy !== null}
                  busy={busy === 'login:copilot'}
                  onSignIn={() =>
                    runAction('login:copilot', 'Sign in to GitHub Copilot', () =>
                      window.api.auth.loginCopilot()
                    )
                  }
                />
                <AuthRow
                  icon={<img className="brand-glyph" src={fabricSvg} alt="" />}
                  title="Microsoft Fabric"
                  subtitle="Where your Rayfin apps deploy"
                  signedIn={auth?.rayfin.signedIn ?? false}
                  detail={auth?.rayfin.user}
                  extra={auth?.rayfin.tenant}
                  disabled={busy !== null || !rayfinReady}
                  disabledReason={!rayfinReady ? 'Install the Rayfin CLI first' : undefined}
                  busy={busy === 'login:rayfin'}
                  onSignIn={() =>
                    runAction('login:rayfin', 'Sign in to Fabric / Rayfin', () =>
                      window.api.auth.loginRayfin()
                    )
                  }
                />
                <AuthRow
                  icon={<img className="brand-glyph" src={azureSvg} alt="" />}
                  title="Azure CLI"
                  subtitle="Access your Azure resources"
                  signedIn={auth?.az.signedIn ?? false}
                  detail={auth?.az.user}
                  extra={auth?.az.tenant}
                  disabled={busy !== null || !azReady}
                  disabledReason={!azReady ? 'Install the Azure CLI first' : undefined}
                  busy={busy === 'login:az'}
                  onSignIn={() =>
                    runAction('login:az', 'Sign in to Azure', () => window.api.auth.loginAz())
                  }
                />
              </ul>
            </section>
          </div>
        </div>
      </div>

      {showLog && (
        <div className="setup-logwrap">
          <div className="setup-logwrap-inner">
            <pre ref={logRef} className="setup-log">
              {log.trim() || 'Process output will appear here.'}
            </pre>
          </div>
        </div>
      )}

      <div className="setup-actionbar">
        <div className="setup-actionbar-inner">
          <button className="btn btn--ghost btn--sm" onClick={() => setShowLog((s) => !s)}>
            {showLog ? 'Hide log' : 'Show log'}
          </button>
          <div className="setup-actionbar-right">
            <span className="setup-actionbar-status">
              {allReady
                ? 'All checks passed'
                : `${remaining} ${remaining === 1 ? 'step' : 'steps'} left`}
            </span>
            <button
              className="btn btn--ghost"
              disabled={refreshing || busy !== null}
              onClick={() => onRefresh()}
            >
              <ReloadIcon className={`btn-ico ${refreshing ? 'icon-spin' : ''}`} />
              {refreshing ? 'Checking…' : 'Re-check'}
            </button>
            <button
              className="btn btn--primary setup-enter"
              disabled={!allReady || busy !== null}
              onClick={() => onEnter()}
            >
              Enter Fabricator
              <span className="setup-enter-arrow" aria-hidden="true">
                →
              </span>
            </button>
          </div>
        </div>
      </div>

      {loginProvider && (
        <div className="signin-overlay" role="alertdialog" aria-busy="true" aria-label="Signing in">
          <div className="signin-card">
            <div className="signin-mark">
              <FabricatorMark />
              <span className="signin-ring" />
            </div>
            <div className="signin-text">
              <strong>Signing you in…</strong>
              <span>
                {finalizing
                  ? 'Getting things ready…'
                  : `Finish signing in to ${loginProvider} in the window that opened.`}
              </span>
            </div>
            {logTail && <pre className="signin-log">{logTail}</pre>}
          </div>
        </div>
      )}
    </div>
  )
}

interface AuthRowProps {
  icon: JSX.Element
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

function AuthRow(props: AuthRowProps): JSX.Element {
  return (
    <li className={`auth-row ${props.signedIn ? 'auth-row--ok' : ''}`}>
      <span className="auth-ico">{props.icon}</span>
      <div className="auth-row-main">
        <span className="auth-row-title">{props.title}</span>
        {props.signedIn ? (
          <span className="auth-row-meta auth-row-meta--ok">
            {props.detail ?? 'Signed in'}
            {props.extra ? ` · ${props.extra}` : ''}
          </span>
        ) : props.disabledReason ? (
          <span className="auth-row-meta auth-row-meta--warn">{props.disabledReason}</span>
        ) : (
          <span className="auth-row-meta">{props.subtitle}</span>
        )}
      </div>
      <div className="auth-row-action">
        {props.signedIn ? (
          <span className="tool-chip">
            <CheckIcon className="tool-chip-ico" />
            Connected
          </span>
        ) : (
          <button
            className="btn btn--primary btn--sm"
            disabled={props.disabled}
            onClick={props.onSignIn}
          >
            {props.busy ? 'Waiting…' : 'Sign in'}
          </button>
        )}
      </div>
    </li>
  )
}
