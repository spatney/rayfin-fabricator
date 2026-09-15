import { useEffect, useRef, useState } from 'react'
import type { AuthStatus, DoctorReport, InstallResult, ProcLogEvent, ProcResult } from '@shared/ipc'
import { FabricatorMark } from '../components/FabricatorMark'
import nodeSvg from '../assets/brands/node.svg'
import npmSvg from '../assets/brands/npm.svg'
import gitSvg from '../assets/brands/git.svg'
import azureSvg from '../assets/brands/azure.svg'
import { CopilotLogo } from '../components/brand-icons'
import { CheckIcon, DownloadIcon, ReloadIcon, TerminalIcon } from '../components/icons'
import { signInToCopilot } from '../copilotAuth'

/** Official product logo (as an <img> src) for each tool, keyed by the doctor's tool id. */
const TOOL_LOGOS: Record<string, string> = {
  node: nodeSvg,
  npm: npmSvg,
  git: gitSvg,
  az: azureSvg
}

interface Props {
  doctor: DoctorReport | null
  auth: AuthStatus | null
  refreshing: boolean
  error?: string
  onRefresh: () => Promise<void> | void
  onEnter: () => void
}

export default function SetupScreen({ doctor, auth, refreshing, error, onRefresh, onEnter }: Props): JSX.Element {
  const [log, setLog] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [finalizing, setFinalizing] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const [needsRelaunch, setNeedsRelaunch] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const logRef = useRef<HTMLPreElement>(null)
  const activeProc = useRef<string | null>(null)

  useEffect(() => {
    return window.api.onProcLog((e: ProcLogEvent) => {
      if (
        e.channel !== activeProc.current &&
        !(activeProc.current?.startsWith('install:') && e.channel.startsWith('install:'))
      ) return
      setLog((prev) => prev + e.data)
    })
  }, [])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log])

  async function runAction(key: string, label: string, fn: () => Promise<ProcResult>): Promise<void> {
    activeProc.current = key
    setBusy(key)
    setActionError(null)
    setShowLog(true)
    setLog(`\u203a ${label}\n`)
    try {
      const result = await fn()
      if (!result.ok) {
        const detail = result.error ?? `${label} did not complete. Please try again.`
        setActionError(detail)
        setLog((p) => `${p}\n[error] ${detail}\n`)
      }
    } catch (err) {
      setActionError(String(err))
      setLog((p) => `${p}\n[error] ${String(err)}\n`)
    } finally {
      // Keep the sign-in overlay up through the auth re-check and the screen swap
      // so the setup screen never flashes its pre-sign-in state before the
      // workbench takes over.
      setFinalizing(true)
      try {
        await onRefresh()
      } catch (err) {
        setActionError(`Could not verify sign-in: ${String(err)}`)
      } finally {
        activeProc.current = null
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
    activeProc.current = key
    setBusy(key)
    setActionError(null)
    setShowLog(true)
    setLog((p) => `${p}\n\u203a ${label}\n`)
    try {
      const res = await fn()
      if (!res.ok && !res.manual) {
        const detail = res.error ?? `${label} did not complete. Check the process output.`
        setActionError(detail)
        setLog((p) => `${p}\n[error] ${detail}\n`)
      }
      if (res?.requiresRelaunch) setNeedsRelaunch(true)
      if (res?.manual) {
        setLog((p) => `${p}\nFinish the install in the page that opened, then click “Restart”.\n`)
      }
    } catch (err) {
      setActionError(String(err))
      setLog((p) => `${p}\n[error] ${String(err)}\n`)
    } finally {
      activeProc.current = null
      setBusy(null)
      try {
        await onRefresh()
      } catch (err) {
        setActionError(`Could not re-check the environment: ${String(err)}`)
      }
    }
  }

  async function recheck(): Promise<void> {
    setActionError(null)
    try {
      await onRefresh()
    } catch (error) {
      setActionError(`Could not re-check the environment: ${String(error)}`)
    }
  }

  const tools = doctor?.tools ?? []
  const needsAuto = tools.filter((t) => t.required && !t.satisfied && !t.checkError && t.autoInstallable)
  const hasToolCheckErrors = tools.some((t) => t.required && t.checkError)
  const toolsSatisfied = tools.filter((t) => t.satisfied).length

  // Azure sign-in shells out to the global `az` CLI, so it can't work until that
  // CLI is installed. Gate the card on that.
  const azTool = tools.find((t) => t.id === 'az')
  const azReady = azTool?.satisfied ?? false

  const providers = [
    auth?.copilot.signedIn ?? false,
    auth?.az.signedIn ?? false
  ]
  const signedInCount = providers.filter(Boolean).length

  const allReady = !refreshing && !error && (doctor?.ready ?? false) && signedInCount === providers.length

  const totalSteps = tools.length + providers.length
  const doneSteps = toolsSatisfied + signedInCount
  const pct = totalSteps ? Math.round((doneSteps / totalSteps) * 100) : 0
  const remaining = totalSteps - doneSteps

  const loginProvider =
    busy === 'login:copilot'
      ? 'GitHub Copilot'
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
    .slice(-20)
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
                    You’re all set — required tools are ready and you’re signed in.
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

          {(error || actionError) && (
            <div className="alert alert--error" role="alert">
              {error || actionError}
            </div>
          )}

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
                      disabled={busy !== null || refreshing || hasToolCheckErrors}
                      title={hasToolCheckErrors ? 'Resolve the CLI check errors first' : undefined}
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
                        <span className="tool-meta" role={t.checkError ? 'alert' : undefined} title={t.checkError}>
                          {t.checkError
                            ? t.checkError
                            : t.satisfied
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
                        ) : t.checkError ? (
                          <button
                            className="btn btn--sm"
                            disabled={busy !== null || refreshing}
                            aria-label={`Re-check ${t.name}`}
                            onClick={() => void recheck()}
                          >
                            <ReloadIcon className={`btn-ico ${refreshing ? 'icon-spin' : ''}`} />
                            Re-check
                          </button>
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
                  error={auth?.copilot.error}
                  checking={refreshing}
                  disabled={busy !== null || refreshing}
                  busy={busy === 'login:copilot'}
                  onSignIn={() =>
                    runAction('login:copilot', 'Sign in to GitHub Copilot', signInToCopilot)
                  }
                />
                <AuthRow
                  icon={<img className="brand-glyph" src={azureSvg} alt="" />}
                  title="Azure CLI"
                  subtitle="Access your Azure resources"
                  signedIn={auth?.az.signedIn ?? false}
                  detail={auth?.az.user}
                  extra={auth?.az.tenant}
                  error={auth?.az.error}
                  checking={refreshing}
                  disabled={busy !== null || refreshing || !azReady}
                  disabledReason={!azReady
                    ? azTool?.checkError
                      ? 'Resolve the Azure CLI check error first'
                      : 'Install the Azure CLI first'
                    : undefined}
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
              {refreshing
                ? 'Checking...'
                : allReady
                ? 'All checks passed'
                : `${remaining} ${remaining === 1 ? 'step' : 'steps'} left`}
            </span>
            <button
              className="btn btn--ghost"
              disabled={refreshing || busy !== null}
              onClick={() => void recheck()}
            >
              <ReloadIcon className={`btn-ico ${refreshing ? 'icon-spin' : ''}`} />
              {refreshing ? 'Checking…' : 'Re-check'}
            </button>
            <button
              className="btn btn--primary setup-enter"
              disabled={!allReady || busy !== null || needsRelaunch}
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
                  : `Finish signing in to ${loginProvider} in your browser, or follow the device-code instructions below.`}
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
  error?: string
  checking?: boolean
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
        {props.checking ? (
          <span className="auth-row-meta">Checking authentication...</span>
        ) : props.signedIn ? (
          <span className="auth-row-meta auth-row-meta--ok">
            {props.detail ?? 'Signed in'}
            {props.extra ? ` · ${props.extra}` : ''}
          </span>
        ) : props.disabledReason ? (
          <span className="auth-row-meta auth-row-meta--warn">{props.disabledReason}</span>
        ) : props.error ? (
          <span className="auth-row-meta auth-row-meta--warn">{props.error}</span>
        ) : (
          <span className="auth-row-meta">{props.subtitle}</span>
        )}
      </div>
      <div className="auth-row-action">
        {props.checking ? (
          <span className="tool-chip">Checking...</span>
        ) : props.signedIn ? (
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
