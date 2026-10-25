import { useEffect, useRef, useState, type JSX } from 'react'
import type {
  AuthStatus,
  DoctorReport,
  HelpAction,
  InstallResult,
  ProcLogEvent,
  ProcResult
} from '@shared/ipc'
import { FabricatorMark } from '../components/FabricatorMark'
import nodeSvg from '../assets/brands/node.svg'
import npmSvg from '../assets/brands/npm.svg'
import gitSvg from '../assets/brands/git.svg'
import azureSvg from '../assets/brands/azure.svg'
import { CopilotLogo } from '../components/brand-icons'
import { CheckIcon, Codicon, DownloadIcon, ReloadIcon, TerminalIcon } from '../components/icons'
import { getCopilotHost, signInToCopilot, signOutOfCopilot } from '../copilotAuth'
import CopilotHostInput from '../components/CopilotHostInput'
import { HelpView } from '../components/help/HelpView'
import HelpUnavailableModal from '../components/help/HelpUnavailableModal'
import { reportEvent } from '../errorReport'
import { setupFacts } from '../helpFacts'
import { openDocs } from '../docsLinks'
import { reportIssue } from './reportIssue'
import { progressLine, toolLine, toolState } from './setupCopy'
import { setupProblem } from './setupProblems'

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
  /** Return to the app without finishing setup (offered once setup has passed on this computer). */
  onBack?: () => void
}

export default function SetupScreen({ doctor, auth, refreshing, error, onRefresh, onEnter, onBack }: Props): JSX.Element {
  const [copilotHost, setCopilotHost] = useState(() => auth?.copilot.host ?? getCopilotHost())
  const [log, setLog] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [finalizing, setFinalizing] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const [needsRelaunch, setNeedsRelaunch] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  /** Setup is where people get stuck, so Help has to be reachable from here. */
  const [showHelp, setShowHelp] = useState(false)
  const [showHelpOffline, setShowHelpOffline] = useState(false)
  const [online, setOnline] = useState(() => navigator.onLine)
  /** Which finished steps the user has opened to see the detail. */
  const [open, setOpen] = useState({ copilot: false, tools: false, microsoft: false })
  const toggle = (key: keyof typeof open): void =>
    setOpen((prev) => ({ ...prev, [key]: !prev[key] }))
  const logRef = useRef<HTMLPreElement>(null)
  const activeProc = useRef<string | null>(null)

  // Every install downloads something, so being offline is worth saying out
  // loud rather than letting the attempt fail with a network error.
  useEffect(() => {
    const update = (): void => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

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
    if (activeProc.current || refreshing) return
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
      } else {
        reportEvent('auth', 'auth.signed_in', `${label}: done.`, { operation: key })
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
        setActionError(`Could not verify account status: ${String(err)}`)
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
      } else if (res.ok) {
        reportEvent('setup', 'tool.installed', `${label}: done.`, { operation: key })
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

  /**
   * Run an action Help offered, as far as it makes sense before the workbench
   * exists. Nothing here has a project, so the project-scoped actions are
   * simply ignored rather than pretending to work.
   */
  function runSetupHelpAction(action: HelpAction): void {
    switch (action.id) {
      case 'open-docs':
        if (action.url) void window.api.openExternal(action.url)
        break
      case 'run-doctor':
        setShowHelp(false)
        void recheck()
        break
      case 'sign-in-copilot':
        setShowHelp(false)
        void runAction('login:copilot', 'Sign in to GitHub Copilot', () =>
          signInToCopilot(copilotHost)
        )
        break
      case 'open-logs':
        void window.api.openLogs()
        break
      case 'export-diagnostics':
        void window.api.diagnostics.export()
        break
      case 'report-issue':
        void reportIssue(window.api, null)
        break
      default:
        // Opening a project, sharing an app, Settings and the Accounts dialog
        // all need the workbench, which isn't running yet.
        break
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

  const allReady = busy === null && !refreshing && !error && !actionError && (doctor?.ready ?? false) && signedInCount === providers.length

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

  /** Copilot is bundled, so it can be connected before anything is installed —
   *  which is what makes Help available for the rest of setup. */
  const copilotReady = auth?.copilot.signedIn ?? false

  /** The one problem worth showing, translated out of CLI-speak. */
  const problem = setupProblem(error || actionError)

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

          <div className={`setup-status ${allReady ? 'is-done' : ''}`}>
            <span className={`setup-status-dot ${allReady ? 'is-done' : ''}`} aria-hidden="true" />
            <span className="setup-status-text">
              {progressLine(doneSteps, totalSteps, refreshing)}
            </span>
            <span className="setup-status-count">
              {doneSteps}/{totalSteps}
            </span>
          </div>
          {!allReady && totalSteps > 0 && (
            <div className="setup-track" role="presentation">
              <span className="setup-track-fill" style={{ width: `${pct}%` }} />
            </div>
          )}

          {problem && (
            <div className="setup-problem" role="alert">
              <div className="setup-problem-main">
                <p className="setup-problem-title">{problem.title}</p>
                <p className="setup-problem-fix">{problem.fix}</p>
              </div>
              <div className="setup-problem-actions">
                {copilotReady && (
                  <button className="btn btn--sm" onClick={() => setShowHelp(true)}>
                    Ask Help
                  </button>
                )}
                <button className="btn btn--ghost btn--sm" onClick={() => setShowLog((s) => !s)}>
                  {showLog ? 'Hide details' : 'Show details'}
                </button>
              </div>
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

          <ol className="setup-steps">
            <SetupSection
              n={1}
              title="Connect GitHub Copilot"
              note="The AI that builds your app — and that answers your questions while you set the rest up"
              done={copilotReady}
              summary={
                auth?.copilot.user
                  ? `${auth.copilot.user}${
                      auth.copilot.host ? ` · ${auth.copilot.host.replace(/^https:\/\//, '')}` : ''
                    }`
                  : 'Signed in'
              }
              count={copilotReady ? '1/1' : '0/1'}
              open={open.copilot}
              onToggle={() => toggle('copilot')}
            >
              <ul className="setup-rows">
                <AuthRow
                  icon={<CopilotLogo />}
                  title="GitHub Copilot"
                  subtitle="Sign in to start building, and to unlock Help"
                  signedIn={auth?.copilot.signedIn ?? false}
                  detail={auth?.copilot.user}
                  extra={auth?.copilot.host?.replace(/^https:\/\//, '')}
                  error={auth?.copilot.error}
                  checking={refreshing}
                  disabled={busy !== null || refreshing}
                  busy={busy === 'login:copilot'}
                  signingOut={busy === 'logout:copilot'}
                  onSignIn={() =>
                    runAction('login:copilot', 'Sign in to GitHub Copilot', () => signInToCopilot(copilotHost))
                  }
                  onSignOut={() =>
                    runAction('logout:copilot', 'Sign out of GitHub Copilot', signOutOfCopilot)
                  }
                  signInOptions={
                    <CopilotHostInput
                      value={copilotHost}
                      disabled={busy !== null || refreshing}
                      onChange={setCopilotHost}
                    />
                  }
                />
              </ul>

              {copilotReady && (
                <p className="setup-sec-aside">
                  <CheckIcon className="setup-sec-aside-ico" />
                  <span>
                    Help is available now. If anything below goes wrong, select{' '}
                    <strong>Help</strong> and it will read what happened.
                  </span>
                </p>
              )}
            </SetupSection>

            <SetupSection
              n={2}
              title="Install the tools"
              note="Free tools Fabricator uses behind the scenes. It can install them for you."
              done={tools.length > 0 && toolsSatisfied === tools.length}
              summary={`All ${tools.length} installed`}
              count={`${toolsSatisfied}/${tools.length}`}
              open={open.tools}
              onToggle={() => toggle('tools')}
              action={
                needsAuto.length > 0 ? (
                  <button
                    className="btn btn--primary btn--sm"
                    disabled={busy !== null || refreshing || hasToolCheckErrors || !online}
                    title={
                      !online
                        ? 'Installing needs an internet connection'
                        : hasToolCheckErrors
                          ? 'Resolve the CLI check errors first'
                          : undefined
                    }
                    onClick={() =>
                      runInstall('install:all', 'Install everything', () =>
                        window.api.doctor.installAll()
                      )
                    }
                  >
                    {busy === 'install:all' ? 'Installing…' : 'Install all'}
                  </button>
                ) : undefined
              }
            >
              {!online && needsAuto.length > 0 && (
                <p className="setup-sec-aside is-warn">
                  You&apos;re offline, so Fabricator can&apos;t download these yet. Reconnect and
                  select <strong>Re-check</strong>.
                </p>
              )}

              <ul className="setup-rows">
                {tools.map((t) => {
                  const logoSrc = TOOL_LOGOS[t.id]
                  const state = t.satisfied ? 'ok' : t.found ? 'warn' : 'bad'
                  const status = toolState(t)
                  return (
                    <li key={t.id} className="setup-row" data-state={state}>
                      <span className="setup-row-ico">
                        {logoSrc ? (
                          <img className="brand-glyph" src={logoSrc} alt="" />
                        ) : (
                          <TerminalIcon />
                        )}
                      </span>
                      <div className="setup-row-main">
                        <span className="setup-row-name">{t.name}</span>
                        <span
                          className="setup-row-meta"
                          role={t.checkError ? 'alert' : undefined}
                          title={t.checkError}
                        >
                          {t.checkError ? t.checkError : toolLine(t)}
                        </span>
                      </div>
                      <div className="setup-row-action">
                        {t.satisfied ? (
                          <span className="setup-state is-ok">
                            <span className="setup-state-dot" aria-hidden="true" />
                            {status.word}
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
                            disabled={busy !== null || !online}
                            title={!online ? 'Installing needs an internet connection' : undefined}
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
            </SetupSection>

            <SetupSection
              n={3}
              title="Sign in to Microsoft"
              note="So Fabricator can publish your app where your team can use it"
              done={auth?.az.signedIn ?? false}
              summary={auth?.az.user ?? 'Signed in'}
              count={auth?.az.signedIn ? '1/1' : '0/1'}
              open={open.microsoft}
              onToggle={() => toggle('microsoft')}
            >
              <ul className="setup-rows">
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
                  signingOut={busy === 'logout:az'}
                  onSignIn={() =>
                    runAction('login:az', 'Sign in to Azure', () => window.api.auth.loginAz())
                  }
                  onSignOut={() =>
                    runAction('logout:az', 'Sign out of Azure', () => window.api.auth.logoutAz())
                  }
                />
              </ul>
            </SetupSection>
          </ol>

          {/* The conclusion of the checklist, where the eye already is after
              reading it — not stranded in the corner of a toolbar. When
              everything passes the steps above are collapsed, so this sits one
              glance below the title. */}
          <div className={`setup-finish ${allReady ? 'is-ready' : ''}`}>
            <div className="setup-finish-copy">
              <p className="setup-finish-title">
                {allReady ? "You're all set" : 'Almost there'}
              </p>
              <p className="setup-finish-note">
                {needsRelaunch
                  ? 'Restart Fabricator to finish setting up the tools that were just installed.'
                  : allReady
                    ? 'Your tools are installed and your accounts are connected.'
                    : `Finish the ${remaining === 1 ? 'step' : `${remaining} steps`} above to continue.`}
              </p>
            </div>
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
          {/* Left: ways to get unstuck. Right: ways to move forward. */}
          <div className="setup-actionbar-left">
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => (copilotReady ? setShowHelp(true) : setShowHelpOffline(true))}
              title={
                copilotReady
                  ? 'Ask Help about anything that is not working'
                  : 'Get help with setup — including the documentation'
              }
            >
              <Codicon name="comment-discussion" />
              Help
            </button>
            <button className="btn btn--ghost btn--sm" onClick={() => setShowLog((s) => !s)}>
              {showLog ? 'Hide log' : 'Show log'}
            </button>
          </div>
          <div className="setup-actionbar-right">
            {/* Only worth saying while there is something left to do: when
                everything passes, the heading and the finish block already
                say so, and a third copy is noise. */}
            {!allReady && (
              <span className="setup-actionbar-status">
                {refreshing
                  ? 'Checking...'
                  : busy?.startsWith('logout:')
                    ? 'Signing out...'
                    : error || actionError
                      ? 'Re-check required'
                      : `${remaining} ${remaining === 1 ? 'step' : 'steps'} left`}
              </span>
            )}
            <button
              className="btn btn--ghost btn--sm"
              disabled={refreshing || busy !== null}
              onClick={() => void recheck()}
            >
              <ReloadIcon className={`btn-ico ${refreshing ? 'icon-spin' : ''}`} />
              {refreshing ? 'Checking…' : 'Re-check'}
            </button>
            {onBack && !allReady && (
              <button className="btn btn--ghost btn--sm" disabled={busy !== null} onClick={onBack}>
                Back to Fabricator
              </button>
            )}
          </div>
        </div>
      </div>

      {showHelpOffline && (
        <HelpUnavailableModal
          onSignIn={() => {
            setShowHelpOffline(false)
            void runAction('login:copilot', 'Sign in to GitHub Copilot', () =>
              signInToCopilot(copilotHost)
            )
          }}
          onDocs={() => openDocs('setup')}
          onReportIssue={() => void reportIssue(window.api, null)}
          onClose={() => setShowHelpOffline(false)}
        />
      )}

      {showHelp && (
        <HelpView
          onClose={() => setShowHelp(false)}
          appVersion={undefined}
          facts={setupFacts(doctor, auth, { online })}
          surface="setup"
          onAction={runSetupHelpAction}
          onReportIssue={(issue) => void reportIssue(window.api, null, navigator.userAgent, issue)}
        />
      )}

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

/**
 * One numbered step.
 *
 * A finished step collapses to a single line. Most launches have nothing to do
 * here, and making someone scroll past seven rows of "Ready" to reach **Enter
 * Fabricator** is a worse experience than showing them that it's done. The
 * detail is still one click away for signing out or checking a version.
 */
function SetupSection({
  n,
  title,
  note,
  done,
  summary,
  count,
  open,
  onToggle,
  action,
  children
}: {
  n: number
  title: string
  note: string
  done: boolean
  /** The one line worth seeing when this step is finished. */
  summary: string
  count: string
  open: boolean
  onToggle: () => void
  /** A step-level action, such as "Install all". */
  action?: JSX.Element
  children: React.ReactNode
}): JSX.Element {
  // A step that still needs something is always open: there is no sense in
  // hiding work the user has to do.
  const expanded = !done || open
  return (
    <li className={`setup-sec ${done ? 'is-done' : ''} ${expanded ? 'is-open' : ''}`}>
      <div className="setup-sec-head">
        <span className="setup-sec-n">{done ? <CheckIcon className="setup-sec-tick" /> : n}</span>
        <div className="setup-sec-headings">
          <h2 className="setup-sec-title">{title}</h2>
          <p className="setup-sec-note">{done ? summary : note}</p>
        </div>
        <span className={`setup-sec-count ${done ? 'is-ok' : ''}`}>{count}</span>
        {action}
        {done && (
          <button
            className="setup-sec-toggle"
            aria-expanded={expanded}
            onClick={onToggle}
          >
            {expanded ? 'Hide' : 'Details'}
          </button>
        )}
      </div>
      {expanded && <div className="setup-sec-body">{children}</div>}
    </li>
  )
}

interface AuthRowProps {  icon: JSX.Element
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
  signingOut: boolean
  onSignIn: () => void
  onSignOut: () => void
  signInOptions?: JSX.Element
}

function AuthRow(props: AuthRowProps): JSX.Element {
  return (
    <li className="setup-row" data-state={props.signedIn ? 'ok' : 'bad'}>
      <span className="setup-row-ico">{props.icon}</span>
      <div className="setup-row-main">
        <span className="setup-row-name">{props.title}</span>
        {props.checking ? (
          <span className="setup-row-meta">Checking…</span>
        ) : props.signedIn ? (
          <span
            className="setup-row-meta"
            title={[props.detail ?? 'Signed in', props.extra].filter(Boolean).join(' · ')}
          >
            {props.detail ?? 'Signed in'}
            {props.extra ? ` · ${props.extra}` : ''}
          </span>
        ) : props.disabledReason ? (
          <span className="setup-row-meta is-warn">{props.disabledReason}</span>
        ) : props.error ? (
          <span className="setup-row-meta is-warn">{props.error}</span>
        ) : (
          <span className="setup-row-meta">{props.subtitle}</span>
        )}
      </div>
      <div className="setup-row-action">
        {props.checking ? (
          <span className="setup-state">
            <span className="setup-state-dot" aria-hidden="true" />
            Checking
          </span>
        ) : props.signedIn ? (
          <>
            <span className="setup-state is-ok">
              <span className="setup-state-dot" aria-hidden="true" />
              Connected
            </span>
            <button
              className="btn btn--ghost btn--sm"
              aria-label={`Sign out of ${props.title}`}
              disabled={props.disabled}
              onClick={props.onSignOut}
            >
              {props.signingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </>
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
      {!props.signedIn && props.signInOptions && (
        <div className="setup-row-options">{props.signInOptions}</div>
      )}
    </li>
  )
}
