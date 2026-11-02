import { useCallback, useEffect, useId, useRef, useState, type JSX, type ReactNode } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { AppActionResult, AppWindowInfo, LocalLogEvent, LocalStatus } from '@shared/ipc'
import { errorMessage } from './errorReport'
import { formatBytes, listNames } from './components/blueprint/localData'
import { ProjectFileProgress, count } from './components/projectFile'
import AppIcon from './components/AppIcon'
import SecurityCheckPanel from './components/security/SecurityCheck'
import { useSecurityCheck } from './components/security/useSecurityCheck'

/** What the window shows while the app isn't on screen. */
type Stage =
  | { kind: 'loading' }
  /** An app file to install, or to update the installed app with: asks first. */
  | { kind: 'ask' }
  | { kind: 'installing'; processed: number; total: number }
  /** Its packages, its build, its backend: until the app shows. */
  | { kind: 'starting' }
  | { kind: 'failed'; code?: string; message: string; hint?: string }
  /** Nothing to run: a file that can't be read, or an app that isn't installed. */
  | { kind: 'error'; message: string }

/** Problems a Node.js install fixes. */
const NODE_CODES = new Set(['node-missing', 'node-too-old'])

/**
 * How long Install and Update wait, after the prompt shows or its window
 * comes to the front, before they work: the window opens from a double-click,
 * often while you type elsewhere, and a keystroke or click meant for another
 * window mustn't install anything.
 */
export const PROMPT_DELAY_MS = 1000

/** The label of this window: `app-<key>`. */
function windowLabel(): string {
  try {
    return getCurrentWindow().label
  } catch {
    return ''
  }
}

function exportedOn(iso: string | undefined): string | undefined {
  const at = iso ? new Date(iso) : null
  if (!at || Number.isNaN(at.getTime())) return undefined
  return at.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

/** One thing the file brings in. */
function Fact({
  icon,
  title,
  detail,
  children
}: {
  icon: string
  title: string
  detail?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="project-file-part project-file-part--fact" role="listitem">
      <span className={`project-file-part-icon codicon codicon-${icon}`} aria-hidden="true" />
      <span className="project-file-part-text">
        <span className="project-file-part-head">
          <span className="project-file-part-title">{title}</span>
          {detail && <span className="project-file-part-detail">{detail}</span>}
        </span>
        <span className="project-file-part-desc">{children}</span>
      </span>
    </div>
  )
}

/**
 * Fabricator's page in the window of an app installed from a `.rayfin` file.
 * It asks before installing (or updating) the app, offering to check the file
 * for security risks first, then shows it getting ready, until Fabricator puts
 * the app itself in the window; it comes back when the app stops on an error,
 * to say why and offer to try again.
 */
export default function AppWindow(): JSX.Element {
  const label = useRef(windowLabel()).current
  const titleId = useId()
  const [info, setInfo] = useState<AppWindowInfo | null>(null)
  const [stage, setStage] = useState<Stage>({ kind: 'loading' })
  const [packages, setPackages] = useState(false)
  const [building, setBuilding] = useState(false)
  const [line, setLine] = useState<string | null>(null)
  const [logs, setLogs] = useState<LocalLogEvent[] | null>(null)
  const [installingNode, setInstallingNode] = useState(false)
  const [restartNeeded, setRestartNeeded] = useState(false)
  const [armed, setArmed] = useState(false)
  const key = info?.key ?? ''
  const keyRef = useRef(key)
  keyRef.current = key
  const check = useSecurityCheck(info?.file?.path ?? '', 'app')
  const checking = check.state.phase === 'running'
  const checked = check.state.phase === 'done' ? check.state.report : null
  const risky = checked?.verdict === 'danger'

  // Install and Update work only once the prompt has been in front for a moment.
  const asking = stage.kind === 'ask'
  useEffect(() => {
    if (!asking) return
    let timer = 0
    const arm = (): void => {
      setArmed(false)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setArmed(true), PROMPT_DELAY_MS)
    }
    arm()
    window.addEventListener('focus', arm)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('focus', arm)
      setArmed(false)
    }
  }, [asking])

  // The check belongs to the prompt: opening the installed version instead stops it.
  const stopCheck = check.stop
  useEffect(() => {
    if (!asking) stopCheck()
  }, [asking, stopCheck])

  const fail = useCallback(
    (result: AppActionResult | { code?: string; error?: string; hint?: string }) => {
      setStage({
        kind: 'failed',
        code: result.code,
        message: result.error ?? 'The app didn’t start.',
        hint: 'hint' in result ? result.hint : undefined
      })
    },
    []
  )

  const start = useCallback(async () => {
    setStage({ kind: 'starting' })
    setPackages(false)
    setBuilding(false)
    setLine(null)
    setLogs(null)
    try {
      const result = await window.api.apps.run()
      if (!result.ok) fail(result)
    } catch (reason) {
      fail({ error: errorMessage(reason, 'The app didn’t start.') })
    }
  }, [fail])

  const load = useCallback(async () => {
    let next: AppWindowInfo
    try {
      next = await window.api.apps.window()
    } catch (reason) {
      setStage({
        kind: 'error',
        message: errorMessage(reason, 'Fabricator couldn’t open this app.')
      })
      return
    }
    setInfo(next)
    const name = next.file?.name ?? next.installed?.name
    if (name) document.title = name
    if (next.mode === 'install' || next.mode === 'update') {
      setStage({ kind: 'ask' })
    } else if (next.mode === 'error') {
      setStage({ kind: 'error', message: next.error ?? 'There’s nothing to open.' })
    } else if (next.status.state === 'error' && next.status.error) {
      const problem = next.status.error
      fail({ code: problem.code, error: problem.message, hint: problem.hint ?? undefined })
    } else {
      void start()
    }
  }, [fail, start])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const off = [
      window.api.apps.onWindow((target) => {
        if (target === label) void load()
      }),
      window.api.apps.onProgress((event) => {
        if (event.key !== keyRef.current) return
        if (event.phase === 'unpacking') {
          setStage({ kind: 'installing', processed: event.processed, total: event.total })
        } else {
          setPackages(true)
          if (event.line) setLine(event.line)
        }
      }),
      window.api.apps.onState((status: LocalStatus) => {
        if (status.projectId !== keyRef.current) return
        if (status.state === 'starting' || status.state === 'restarting') {
          setStage((now) => (now.kind === 'failed' ? { kind: 'starting' } : now))
          setPackages(false)
        } else if (
          status.state === 'error' &&
          status.error &&
          status.error.code !== 'port-in-use'
        ) {
          fail({
            code: status.error.code,
            error: status.error.message,
            hint: status.error.hint ?? undefined
          })
        }
      }),
      window.api.apps.onLog((event) => {
        if (event.projectId !== keyRef.current || !event.line.trim()) return
        if (event.source === 'build') setBuilding(true)
        setLine(event.line)
      })
    ]
    return () => off.forEach((unsubscribe) => unsubscribe())
  }, [label, load, fail])

  async function install(): Promise<void> {
    setStage({ kind: 'installing', processed: 0, total: 0 })
    let result: AppActionResult
    try {
      result = await window.api.apps.install()
    } catch (reason) {
      result = { ok: false, error: errorMessage(reason, 'Fabricator couldn’t install the app.') }
    }
    if (result.ok) {
      void start()
      return
    }
    fail(result)
  }

  async function installNode(): Promise<void> {
    setInstallingNode(true)
    try {
      const result = await window.api.doctor.install('node')
      if (result.requiresRelaunch || result.manual) {
        setRestartNeeded(true)
      } else if (result.ok) {
        void start()
      }
    } finally {
      setInstallingNode(false)
    }
  }

  async function showDetails(): Promise<void> {
    setLogs(await window.api.apps.logs().catch(() => []))
  }

  const file = info?.file
  const installed = info?.installed
  const name = file?.name ?? installed?.name ?? 'Rayfin app'
  const icon = file?.icon ?? installed?.icon
  const from = file?.from ?? installed?.from
  const version = file?.version ?? installed?.version
  const lead = [from ? `From ${from}` : null, version ? `Version ${version}` : null]
    .filter(Boolean)
    .join(' · ')
  const updating = info?.mode === 'update'
  const failed = stage.kind === 'failed' ? stage : null
  const needsNode = failed?.code !== undefined && NODE_CODES.has(failed.code)

  return (
    <main
      className="app-window"
      aria-labelledby={titleId}
      aria-busy={stage.kind === 'loading' || undefined}
    >
      <div className="app-window-card">
        <header className="app-window-head">
          <AppIcon name={name} src={icon} size={64} />
          <div className="app-window-title">
            <h1 id={titleId}>{stage.kind === 'loading' ? '' : name}</h1>
            {lead && <p className="app-window-lead">{lead}</p>}
          </div>
        </header>

        {stage.kind === 'ask' && file && (
          <>
            <p className="app-window-text">
              {updating
                ? `${name} is installed${exportedOn(installed?.exportedAt) ? ` (exported ${exportedOn(installed?.exportedAt)})` : ''}. This file has another version${exportedOn(file.exportedAt) ? `, exported ${exportedOn(file.exportedAt)}` : ''}. Updating replaces the app and keeps its data.`
                : 'Install it to use it on this computer. It opens in a window of its own and keeps its data on this computer.'}
            </p>
            <div className="project-file-parts" role="list" aria-label="What it brings">
              <Fact
                icon="file-code"
                title="App code"
                detail={`${count(file.files, 'file')} · ${formatBytes(file.bytes)}`}
              >
                The first time it opens, Fabricator installs its packages and builds it.
              </Fact>
              {file.secrets.length > 0 && (
                <Fact icon="key" title="Secrets" detail={listNames(file.secrets)}>
                  Their values don’t come with it, so what needs them won’t work.
                </Fact>
              )}
            </div>
            <p className="project-file-note">
              <span className="codicon codicon-shield" aria-hidden="true" />
              <span>
                Only install apps from people you trust. Its code runs on this computer, as you.
              </span>
            </p>
            <SecurityCheckPanel check={check} kind="app" />
            <div className="app-window-actions">
              <button
                type="button"
                className="btn"
                onClick={() => void (updating ? start() : window.api.apps.close())}
              >
                {updating ? 'Open the installed one' : 'Cancel'}
              </button>
              <button
                type="button"
                className={risky ? 'btn btn--danger' : 'btn btn--primary'}
                disabled={!armed || checking}
                onClick={() => void install()}
              >
                {updating
                  ? risky
                    ? 'Update anyway'
                    : 'Update'
                  : risky
                    ? 'Install anyway'
                    : 'Install'}
              </button>
            </div>
          </>
        )}

        {stage.kind === 'installing' && (
          <ProjectFileProgress
            label={`Installing ${name}…`}
            name="Install progress"
            processed={stage.processed}
            total={stage.total}
          />
        )}

        {stage.kind === 'starting' && (
          <div className="app-window-status" role="status">
            <span className="app-window-status-text">
              <span className="ws-spinner" aria-hidden="true" />
              {packages
                ? `Getting ${name} ready…`
                : building
                  ? `Building ${name}…`
                  : `Starting ${name}…`}
            </span>
            {packages && (
              <span className="app-window-hint">
                Installing its packages. The first time takes a minute or two.
              </span>
            )}
            {line && (
              <span className="app-window-line" title={line}>
                {line}
              </span>
            )}
          </div>
        )}

        {failed && (
          <>
            <div className="app-window-problem" role="alert">
              <span className="codicon codicon-error" aria-hidden="true" />
              <span>
                <strong>{needsNode ? 'This app needs Node.js' : `${name} didn’t start`}</strong>
                <span>{failed.message}</span>
                {failed.hint && <span className="app-window-hint">{failed.hint}</span>}
              </span>
            </div>
            {restartNeeded && (
              <p className="project-file-note">
                <span className="codicon codicon-info" aria-hidden="true" />
                <span>Once Node.js is installed, restart to use it.</span>
              </p>
            )}
            {logs && (
              <pre className="app-window-log" aria-label="Details">
                {logs.length
                  ? logs
                      .slice(-60)
                      .map((l) => l.line)
                      .join('\n')
                  : 'There’s no output yet.'}
              </pre>
            )}
            <div className="app-window-actions">
              {!logs && (
                <button type="button" className="btn btn--ghost" onClick={() => void showDetails()}>
                  Show details
                </button>
              )}
              <button type="button" className="btn" onClick={() => void window.api.apps.close()}>
                Close
              </button>
              {needsNode && !restartNeeded ? (
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={installingNode}
                  onClick={() => void installNode()}
                >
                  {installingNode ? 'Installing Node.js…' : 'Install Node.js'}
                </button>
              ) : restartNeeded ? (
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => void window.api.relaunch()}
                >
                  Restart
                </button>
              ) : (
                <button type="button" className="btn btn--primary" onClick={() => void start()}>
                  Try again
                </button>
              )}
            </div>
          </>
        )}

        {stage.kind === 'error' && (
          <>
            <div className="app-window-problem" role="alert">
              <span className="codicon codicon-error" aria-hidden="true" />
              <span>
                <strong>Fabricator can’t open this app</strong>
                <span>{stage.message}</span>
              </span>
            </div>
            <div className="app-window-actions">
              <button
                type="button"
                className="btn btn--primary"
                autoFocus
                onClick={() => void window.api.apps.close()}
              >
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </main>
  )
}
