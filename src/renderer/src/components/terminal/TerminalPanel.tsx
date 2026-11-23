import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type { StudioProject, TerminalShell } from '@shared/ipc'
import { useFileDrop } from '../../fileDrop'
import { translator, useTranslation } from '../../i18n'
import { localStateLabel, localTone, runningProblems, type LocalBackend } from '../../localBackend'
import { uiZoom } from '../../menuLayout'
import { isMac, modKey, shortcut } from '../../platform'
import {
  DEFAULT_HEIGHT,
  MIN_HEIGHT,
  projectTerminals,
  tabLabels,
  terminalStore,
  useTerminalState,
  type TerminalTab
} from '../../terminal/store'
import {
  existingSession,
  existingView,
  outputFor,
  outputKey,
  sessionFor,
  setTerminalHooks
} from '../../terminal/session'
import { quotePaths } from '../../terminal/quote'
import { ContextMenu, type ContextMenuEntry } from '../ContextMenu'
import { Codicon } from '../icons'
import TerminalFind from './TerminalFind'
import './terminal.css'

/** Room the project keeps above the panel while it's dragged taller. */
const PROJECT_ROOM = 140

const SHELL_ICONS: Record<string, string> = {
  pwsh: 'terminal-powershell',
  powershell: 'terminal-powershell',
  cmd: 'terminal-cmd',
  'git-bash': 'terminal-git-bash',
  bash: 'terminal-bash'
}

function shellIcon(id: string | undefined): string {
  return (id && SHELL_ICONS[id]) || 'terminal'
}

function statusText(tab: TerminalTab): string {
  const t = translator('code')
  switch (tab.status) {
    case 'starting':
      return t('panel.state.starting')
    case 'running':
      return t('panel.state.running')
    case 'failed':
      return tab.error ? t('panel.state.failedWith', { error: tab.error }) : t('panel.state.failed')
    case 'exited':
      return tab.exitCode === null || tab.exitCode === undefined
        ? t('panel.state.ended')
        : t('panel.state.exited', { code: tab.exitCode })
  }
}

const ctrlShortcut = (key: string): string => (isMac() ? `⌃${key}` : `${modKey()}+${key}`)

/** The Output tab's dot for the app's state, in the shells' colors. */
const OUTPUT_DOTS = {
  ok: 'running',
  warn: 'warn',
  busy: 'starting',
  err: 'failed',
  idle: 'idle'
} as const

interface Props {
  project: StudioProject
  /** Away from the project's own screen (Home, the gallery): kept, but out of sight. */
  hidden: boolean
  /** Open a project file named in the output in the Code tab. */
  onOpenFile: (path: string, line?: number) => void
  /** The app's backend, while the app runs on this computer: its Output is the first tab. */
  local?: LocalBackend
}

/**
 * The project terminal: shells in the project's folder, one per tab, under
 * whichever view is showing, after the app's read-only Output when it runs on
 * this computer. It's sized by dragging its top edge, and can fill the
 * project's area. Hiding it, or opening another project, leaves its shells
 * running; closing a tab ends that shell and what it started.
 */
export default function TerminalPanel({ project, hidden, onOpenFile, local }: Props): JSX.Element {
  const { t } = useTranslation('code')
  const state = useTerminalState()
  const terminals = projectTerminals(state, project.id)
  /** The app runs on this computer, so it has an Output tab. */
  const hasOutput = Boolean(local)
  const showingOutput = terminals.output && hasOutput
  const activeTab = showingOutput
    ? null
    : (terminals.tabs.find((tab) => tab.key === terminals.active) ?? null)
  const fallbackLabel = t('panel.tab')
  const labels = useMemo(
    () => tabLabels(terminals.tabs, fallbackLabel),
    [terminals.tabs, fallbackLabel]
  )
  const panelRef = useRef<HTMLElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const [finding, setFinding] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null)
  const [shells, setShells] = useState<TerminalShell[] | null>(null)
  const [hint, setHint] = useState<{ x: number; y: number; text: string } | null>(null)
  const [dragHeight, setDragHeight] = useState<number | null>(null)
  /** The terminal that's showing, once it is (its first showing makes it). */
  const [shown, setShown] = useState<string | null>(null)
  /** The panel has risen into place since it opened. */
  const [risen, setRisen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [restarting, setRestarting] = useState(false)
  /** Restart app was asked for here, so its failure shows here. */
  const [restartAsked, setRestartAsked] = useState(false)
  const activeKey = activeTab?.key ?? null
  /** What's in front: a shell's tab, or the app's Output. */
  const viewKey = showingOutput ? outputKey(project.id) : activeKey
  const view = shown === viewKey ? existingView(viewKey) : undefined
  /** The shell in front, for what only a shell does: paste, restart, a dropped file. */
  const session = view && !showingOutput ? existingSession(viewKey) : undefined
  const problems = showingOutput ? runningProblems(local?.status) : []

  // The app stopped running on this computer: its Output goes with it.
  useEffect(() => {
    if (terminals.output && !hasOutput) terminalStore.hideOutput(project.id)
  }, [terminals.output, hasOutput, project.id])

  useEffect(() => setRestartAsked(false), [project.id])

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1200)
    return () => window.clearTimeout(timer)
  }, [copied])

  // The shells this computer has, for the picker and the new-terminal tooltip.
  useEffect(() => {
    let live = true
    window.api.terminal
      .shells()
      .then((list) => {
        if (live) setShells(list)
      })
      .catch(() => {
        if (live) setShells([])
      })
    return () => {
      live = false
    }
  }, [])

  // Show the terminal in front; the others keep running out of sight. Only
  // another tab, project or visibility moves it, not the tab's status.
  useLayoutEffect(() => {
    const surface = surfaceRef.current
    if (hidden || !surface) return
    const terminal = showingOutput
      ? outputFor(project.id, project.path)
      : activeTab && sessionFor(project.id, project.path, activeTab)
    if (!terminal) return
    terminal.attach(surface)
    setShown(terminal.key)
    return () => terminal.detach()
  }, [hidden, viewKey, project.id, project.path])

  // Keep it the size of its area: dragging, maximizing, the window resizing.
  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface || hidden) return
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => existingView(viewKey)?.fit())
    })
    observer.observe(surface)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [hidden, viewKey])

  // The keyboard goes to the terminal when it opens, or another tab is chosen.
  useEffect(() => {
    if (!hidden) existingView(viewKey)?.focus()
  }, [hidden, viewKey, state.focusRequest])

  const openFile = useCallback(
    (path: string, line?: number) => {
      setHint(null)
      onOpenFile(path, line)
    },
    [onOpenFile]
  )

  useEffect(() => {
    if (hidden) return
    setTerminalHooks({
      openUrl: (url) => void window.api.openExternal(url),
      openFile,
      find: () => setFinding(true),
      menu: (x, y) => setMenu({ x, y }),
      linkHint: (event, text) =>
        setHint(event && text ? { x: event.clientX, y: event.clientY, text } : null)
    })
    return () => setTerminalHooks(null)
  }, [hidden, openFile])

  const dropping = useFileDrop(
    bodyRef,
    (paths) =>
      existingSession(activeKey)?.insert(
        quotePaths(paths, activeTab?.shellId, !project.path.startsWith('/'))
      ),
    !hidden && Boolean(activeTab)
  )

  const shellNamed = (id: string | null | undefined): TerminalShell | undefined =>
    shells?.find((shell) => shell.id === id)
  const nextShell = shellNamed(state.shell) ?? shells?.find((shell) => shell.default)

  const closeFind = (): void => {
    setFinding(false)
    existingView(viewKey)?.focus()
  }

  const copyOutput = (): void => {
    const text = view?.text()
    if (!text) return
    void navigator.clipboard
      ?.writeText(text)
      .then(() => setCopied(true))
      .catch(() => undefined)
  }

  const restartApp = (): void => {
    if (!local) return
    setRestarting(true)
    setRestartAsked(true)
    void local.restart().finally(() => setRestarting(false))
  }

  const closeTab = (key: string): void => {
    if (key === activeKey) setFinding(false)
    terminalStore.remove(project.id, key)
  }

  const toggleMaximized = (): void => terminalStore.setMaximized(!state.maximized)

  const onResizeStart = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const panel = panelRef.current
    const area = panel?.parentElement
    if (event.button !== 0 || !panel || !area) return
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    // Pointer positions are the window's pixels; the height is in the zoomed page's.
    const zoom = uiZoom()
    const startY = event.clientY
    const startHeight = panel.offsetHeight
    const tallest = Math.max(MIN_HEIGHT, area.clientHeight - PROJECT_ROOM)
    let height = startHeight
    const move = (moved: PointerEvent): void => {
      height = Math.min(
        tallest,
        Math.max(MIN_HEIGHT, startHeight + (startY - moved.clientY) / zoom)
      )
      setDragHeight(height)
    }
    const end = (): void => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
      handle.removeEventListener('pointercancel', end)
      terminalStore.setHeight(height)
      setDragHeight(null)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
    if (state.maximized) terminalStore.setMaximized(false)
    setDragHeight(height)
  }

  const menuEntries: ContextMenuEntry[] = !view
    ? []
    : [
        {
          id: 'copy',
          label: t('actions.copy'),
          icon: 'copy',
          detail: shortcut('C'),
          disabled: !view.hasSelection(),
          run: () => view.copy()
        },
        ...(session
          ? [
              {
                id: 'paste',
                label: t('panel.paste'),
                icon: 'clippy',
                detail: shortcut('V'),
                run: () => session.paste()
              }
            ]
          : []),
        {
          id: 'select-all',
          label: t('panel.selectAll'),
          icon: 'list-selection',
          run: () => view.selectAll()
        },
        'separator',
        {
          id: 'find',
          label: t('panel.findMenu'),
          icon: 'search',
          detail: shortcut('F'),
          run: () => setFinding(true)
        },
        { id: 'clear', label: t('actions.clear'), icon: 'clear-all', run: () => view.clear() },
        ...(session
          ? ([
              'separator',
              {
                id: 'restart',
                label: session.shellRunning ? t('panel.restartShell') : t('panel.startShell'),
                icon: 'debug-restart',
                run: () => session.restart()
              },
              {
                id: 'close',
                label: t('panel.closeTerminal'),
                icon: 'trash',
                run: () => activeKey && closeTab(activeKey)
              }
            ] satisfies ContextMenuEntry[])
          : [])
      ]

  const pickerEntries: ContextMenuEntry[] = (shells ?? []).map((shell) => ({
    id: shell.id,
    label: shell.name,
    icon: shellIcon(shell.id),
    detail: shell.id === nextShell?.id ? t('panel.defaultShell') : undefined,
    run: () => terminalStore.add(project.id, shell.id)
  }))

  const folder = project.path.split(/[\\/]/).filter(Boolean).pop() ?? project.path
  const height = dragHeight ?? state.height
  const style = { '--terminal-height': `${height}px` } as CSSProperties
  const newTerminalShortcut = ctrlShortcut('Shift+`')

  return (
    <section
      ref={panelRef}
      className={`terminal-panel${state.maximized ? ' terminal-panel--max' : ''}${
        dragHeight !== null ? ' terminal-panel--resizing' : ''
      }${risen || state.maximized ? '' : ' terminal-panel--rise'}`}
      style={style}
      hidden={hidden}
      aria-label={t('panel.label')}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) setRisen(true)
      }}
    >
      <div className="terminal-frame">
        {!state.maximized && (
          <div
            className="terminal-resize"
            role="separator"
            aria-orientation="horizontal"
            aria-label={t('panel.resize')}
            title={t('panel.resizeTitle')}
            onPointerDown={onResizeStart}
            onDoubleClick={() => terminalStore.setHeight(DEFAULT_HEIGHT)}
          />
        )}
        <header
          className="terminal-head"
          onDoubleClick={(event) => {
            if (event.target === event.currentTarget) toggleMaximized()
          }}
        >
          <div className="terminal-tabs" role="tablist" aria-label={t('panel.tabs')}>
            {local && (
              <div className={`terminal-tab${showingOutput ? ' terminal-tab--active' : ''}`}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={showingOutput}
                  className="terminal-tab-main terminal-tab-main--solo"
                  title={`${t('panel.outputTitle')}\n${localStateLabel(local.status, !local.status || local.busy)}`}
                  onClick={() => terminalStore.showOutput(project.id)}
                >
                  <Codicon name="output" className="terminal-tab-icon" />
                  <span className="terminal-tab-label">{t('panel.output')}</span>
                  <span
                    className={`terminal-dot terminal-dot--${OUTPUT_DOTS[localTone(local.status, !local.status || local.busy)]}`}
                    aria-label={localStateLabel(local.status, !local.status || local.busy)}
                  />
                </button>
              </div>
            )}
            {terminals.tabs.map((tab) => {
              const label = labels.get(tab.key) ?? fallbackLabel
              const active = tab.key === activeKey
              return (
                <div
                  key={tab.key}
                  className={`terminal-tab${active ? ' terminal-tab--active' : ''}`}
                  onAuxClick={(event) => {
                    if (event.button === 1) closeTab(tab.key)
                  }}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className="terminal-tab-main"
                    title={[tab.shellName, tab.title, statusText(tab)].filter(Boolean).join('\n')}
                    onClick={() => {
                      terminalStore.activate(project.id, tab.key)
                      existingSession(tab.key)?.focus()
                    }}
                  >
                    <Codicon
                      name={shellIcon(tab.shellId ?? tab.requestedShell)}
                      className="terminal-tab-icon"
                    />
                    <span className="terminal-tab-label">{label}</span>
                    <span
                      className={`terminal-dot terminal-dot--${dotOf(tab)}`}
                      aria-label={statusText(tab)}
                    />
                    {tab.unread && (
                      <span className="terminal-unread" aria-label={t('panel.newOutput')} />
                    )}
                  </button>
                  <button
                    type="button"
                    className="terminal-tab-close"
                    aria-label={t('panel.closeTab', { label })}
                    title={t('panel.closeTerminal')}
                    onClick={() => closeTab(tab.key)}
                  >
                    <Codicon name="close" />
                  </button>
                </div>
              )
            })}
            <span className="terminal-new">
              <button
                type="button"
                className="terminal-btn"
                aria-label={t('panel.newTerminal')}
                title={
                  nextShell
                    ? t('panel.newShellTitle', {
                        shell: nextShell.name,
                        shortcut: newTerminalShortcut
                      })
                    : t('panel.newTerminalTitle', { shortcut: newTerminalShortcut })
                }
                onClick={() => terminalStore.add(project.id)}
              >
                <Codicon name="add" />
              </button>
              <button
                type="button"
                className="terminal-btn terminal-btn--narrow"
                aria-label={t('panel.chooseShell')}
                aria-haspopup="menu"
                aria-expanded={Boolean(picker)}
                title={t('panel.chooseShell')}
                disabled={!shells?.length}
                onClick={(event) => {
                  const box = event.currentTarget.getBoundingClientRect()
                  setPicker({ x: box.left, y: box.bottom + 4 })
                }}
              >
                <Codicon name="chevron-down" />
              </button>
            </span>
          </div>
          <span className="terminal-where" title={project.path}>
            <Codicon name="folder" className="terminal-where-icon" />
            <span className="terminal-where-name">{folder}</span>
          </span>
          <div className="terminal-actions">
            <button
              type="button"
              className={`terminal-btn${finding ? ' terminal-btn--on' : ''}`}
              aria-label={t('panel.find')}
              aria-pressed={finding}
              title={t('panel.findTitle', { shortcut: shortcut('F') })}
              disabled={!view}
              onClick={() => (finding ? closeFind() : setFinding(true))}
            >
              <Codicon name="search" />
            </button>
            {showingOutput && (
              <button
                type="button"
                className="terminal-btn"
                aria-label={copied ? t('actions.copied') : t('panel.copyOutput')}
                title={copied ? t('actions.copied') : t('panel.copyOutput')}
                disabled={!view}
                onClick={copyOutput}
              >
                <Codicon name={copied ? 'check' : 'copy'} />
              </button>
            )}
            <button
              type="button"
              className="terminal-btn"
              aria-label={t('actions.clear')}
              title={t('actions.clear')}
              disabled={!view}
              onClick={() => view?.clear()}
            >
              <Codicon name="clear-all" />
            </button>
            {showingOutput ? (
              <button
                type="button"
                className="terminal-btn"
                aria-label={restarting ? t('panel.restartingApp') : t('panel.restartApp')}
                title={t('panel.restartAppTitle')}
                disabled={restarting || !local || local.busy || local.state !== 'running'}
                onClick={restartApp}
              >
                <Codicon name="debug-restart" />
              </button>
            ) : (
              <button
                type="button"
                className="terminal-btn"
                aria-label={
                  session?.shellRunning === false ? t('panel.startShell') : t('panel.restartShell')
                }
                title={
                  session?.shellRunning === false ? t('panel.startShell') : t('panel.restartShell')
                }
                disabled={!session}
                onClick={() => session?.restart()}
              >
                <Codicon name="debug-restart" />
              </button>
            )}
            <button
              type="button"
              className="terminal-btn"
              aria-label={state.maximized ? t('panel.restoreSize') : t('panel.maximize')}
              aria-pressed={state.maximized}
              title={state.maximized ? t('panel.restoreSize') : t('panel.maximize')}
              onClick={toggleMaximized}
            >
              <Codicon name={state.maximized ? 'screen-normal' : 'screen-full'} />
            </button>
            <button
              type="button"
              className="terminal-btn"
              aria-label={t('panel.hide')}
              title={t('panel.hideTitle', { shortcut: ctrlShortcut('`') })}
              onClick={() => terminalStore.close(project.id)}
            >
              <Codicon name="chevron-down" />
            </button>
          </div>
        </header>
        {problems.length > 0 && (
          <ul className="terminal-problems" aria-label={t('panel.problems')}>
            {problems.map((problem) => (
              <li key={problem.kind} className="terminal-problem">
                <span className="terminal-problem-dot" aria-hidden="true" />
                <div className="terminal-problem-text">
                  <p className="terminal-problem-summary">{problem.summary}</p>
                  {problem.detail && (
                    <pre className="terminal-problem-detail" title={problem.detail}>
                      {problem.detail}
                    </pre>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {showingOutput && restartAsked && local?.actionError && (
          <p className="terminal-failed" role="alert">
            {local.actionError.message}
          </p>
        )}
        <div
          ref={bodyRef}
          className={`terminal-body${dropping ? ' terminal-body--drop' : ''}`}
          onMouseLeave={() => setHint(null)}
        >
          <div ref={surfaceRef} className="terminal-surface" />
          {finding && view && <TerminalFind key={viewKey} session={view} onClose={closeFind} />}
        </div>
      </div>
      {hint && (
        <div
          className="terminal-hint"
          style={{ left: (hint.x + 12) / uiZoom(), top: (hint.y + 16) / uiZoom() }}
          role="tooltip"
        >
          {hint.text}
        </div>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={t('panel.label')}
          entries={menuEntries}
          onClose={() => {
            setMenu(null)
            existingView(viewKey)?.focus()
          }}
        />
      )}
      {picker && pickerEntries.length > 0 && (
        <ContextMenu
          x={picker.x}
          y={picker.y}
          label={t('panel.newWith')}
          entries={pickerEntries}
          onClose={() => setPicker(null)}
        />
      )}
    </section>
  )
}

/** The tab's status dot: starting, running, ended well, or ended badly. */
function dotOf(tab: TerminalTab): 'starting' | 'running' | 'done' | 'failed' {
  if (tab.status === 'exited') return tab.exitCode ? 'failed' : 'done'
  return tab.status
}
