import { useEffect, useId, type JSX, type ReactNode } from 'react'
import type { PortConflict } from '@shared/ipc'
import { useSuppressPreview } from '../overlay'
import { useModalFocus } from '../modalFocus'
import { openDocs } from '../docsLinks'
import { Codicon } from './icons'

/** `plan`: a turn is already running, so nothing can be pushed to Fabric yet. */
export type PortPromptContext = 'turn' | 'plan'

/** Whether "Use port N" can run now: a free port exists and any push is allowed. */
export function canUsePort(conflict: PortConflict, context: PortPromptContext): boolean {
  return conflict.suggestedPort !== undefined && !(context === 'plan' && conflict.needsPush)
}

/**
 * Whether Fabricator can stop what holds the port: the process it was shown, or
 * another app's local backend, which the supervisor stops.
 */
export function canStopHolder(conflict: PortConflict): boolean {
  return (
    conflict.holder?.kind === 'backend' || (conflict.canStop && conflict.occupant !== undefined)
  )
}

/** Whether the prompt has any choice besides skipping. */
export function hasPortChoice(conflict: PortConflict, context: PortPromptContext): boolean {
  return canUsePort(conflict, context) || canStopHolder(conflict)
}

/** What holds the address, in the words the dialog uses. */
export type Holder =
  /** Another app in this window: its local backend (the app on this computer) or its live preview. */
  | { kind: 'project'; name: string; what: 'backend' | 'preview' }
  /** A preview rayfin-local serves for an app; `self` when it's the app this live preview is for. */
  | { kind: 'app'; name: string; self: boolean }
  /** A Vite dev server, named for the folder it serves when that shows. */
  | { kind: 'dev-server'; name: string | null }
  /** Any other program. */
  | { kind: 'program'; name: string }
  /** Something Fabricator couldn't identify. */
  | { kind: 'unknown' }

const slashes = (path: string): string => path.replace(/\\/g, '/')
const folderPath = (path: string): string => slashes(path).toLowerCase().replace(/\/+$/, '')

/** The last folder before `marker` in a command line, such as the app a `.rayfin-local` cache belongs to. */
function folderBefore(commandLine: string, marker: string): string | null {
  const text = slashes(commandLine)
  const at = text.toLowerCase().indexOf(marker)
  if (at <= 0) return null
  return text.slice(0, at).split('/').pop()?.replace(/^"+/, '') || null
}

/**
 * Who holds the address: another app Fabricator has open, or the process the
 * OS names, recognized from its command line where it's an app's preview
 * (rayfin-local's Vite, in the app's `.rayfin-local` folder) or a Vite dev
 * server. `projects` name the apps, and `projectPath` is the app the live
 * preview is for.
 */
export function describeHolder(
  conflict: PortConflict,
  projects: readonly { name: string; path: string }[] = [],
  projectPath?: string
): Holder {
  if (conflict.holder) {
    return { kind: 'project', name: conflict.holder.name, what: conflict.holder.kind }
  }
  const occupant = conflict.occupant
  if (!occupant) return { kind: 'unknown' }
  const commandLine = occupant.commandLine ?? ''
  const command = slashes(commandLine).toLowerCase()
  const owner = (marker: string): { name: string; path: string } | undefined =>
    projects.find((project) => command.includes(`${folderPath(project.path)}${marker}`))
  if (command.includes('/.rayfin-local/')) {
    const app = owner('/.rayfin-local/')
    return {
      kind: 'app',
      name: app?.name ?? folderBefore(commandLine, '/.rayfin-local/') ?? 'an app',
      self: Boolean(app && projectPath && folderPath(app.path) === folderPath(projectPath))
    }
  }
  if (
    command.includes('/node_modules/vite/') ||
    /(^|[\s/"])vite(\.cmd|\.exe)?(\s|"|$)/.test(command)
  ) {
    return {
      kind: 'dev-server',
      name: owner('/')?.name ?? folderBefore(commandLine, '/node_modules/')
    }
  }
  return /^PID \d+$/.test(occupant.name)
    ? { kind: 'unknown' }
    : { kind: 'program', name: occupant.name }
}

/** The sentence that says who holds the address. */
function holderLead(holder: Holder): ReactNode {
  switch (holder.kind) {
    case 'project':
      return holder.what === 'backend' ? (
        <>
          <strong>{holder.name}</strong>, another app running on this computer, is using it.
        </>
      ) : (
        <>
          The live preview of <strong>{holder.name}</strong> is using it while Copilot works on that
          app.
        </>
      )
    case 'app':
      return holder.self ? (
        <>
          An earlier preview of <strong>{holder.name}</strong> is still running and using it.
        </>
      ) : (
        <>
          A preview of <strong>{holder.name}</strong> is using it.
        </>
      )
    case 'dev-server':
      return holder.name ? (
        <>
          A dev server for <strong>{holder.name}</strong> is using it.
        </>
      ) : (
        <>A dev server is using it.</>
      )
    case 'program':
      return (
        <>
          <strong>{holder.name}</strong>, another program on this computer, is using it.
        </>
      )
    default:
      return <>Another program on this computer is using it, and Fabricator can’t tell which.</>
  }
}

/** The stop choice, for what holds the address: its label, what it costs, and whether it's the safe pick. */
function stopChoice(
  holder: Holder,
  holderWorking: boolean
): { title: string; detail: string; safe: boolean } {
  switch (holder.kind) {
    case 'project':
      return {
        title: `Stop ${holder.name}`,
        detail: holderWorking
          ? `Copilot is working on ${holder.name} right now. It starts again when you open it.`
          : 'It starts again when you open it.',
        safe: !holderWorking
      }
    case 'app':
      return {
        title: holder.self ? 'Stop the earlier preview' : 'Stop that preview',
        detail: 'Nothing is lost: it’s only a preview.',
        safe: true
      }
    case 'dev-server':
      return {
        title: 'Stop the dev server',
        detail: 'Nothing is lost: you can start it again later.',
        safe: true
      }
    case 'program':
      return {
        title: `Stop ${holder.name}`,
        detail: `Anything unsaved in ${holder.name} is lost.`,
        safe: false
      }
    default:
      return { title: 'Stop that program', detail: 'Anything unsaved in it is lost.', safe: false }
  }
}

/** One choice: a button with what it does and what it costs. */
function Choice({
  icon,
  title,
  detail,
  recommended,
  busy,
  busyTitle,
  disabled,
  onClick
}: {
  icon: string
  title: string
  detail: string
  recommended: boolean
  busy: boolean
  busyTitle: string
  disabled: boolean
  onClick: () => void
}): JSX.Element {
  const titleId = useId()
  const tagId = useId()
  const detailId = useId()
  return (
    <button
      type="button"
      className={`port-choice${recommended ? ' port-choice--recommended' : ''}${busy ? ' port-choice--busy' : ''}`}
      aria-labelledby={titleId}
      aria-describedby={recommended ? `${tagId} ${detailId}` : detailId}
      disabled={disabled}
      onClick={onClick}
      autoFocus={recommended}
    >
      <span className="port-choice-ico" aria-hidden="true">
        {busy ? <span className="btn-spin" /> : <Codicon name={icon} />}
      </span>
      <span className="port-choice-text">
        <span className="port-choice-head">
          <span className="port-choice-title" id={titleId}>
            {busy ? busyTitle : title}
          </span>
          {recommended && (
            <span className="port-choice-tag" id={tagId}>
              Recommended
            </span>
          )}
        </span>
        <span className="port-choice-detail" id={detailId}>
          {detail}
        </span>
      </span>
    </button>
  )
}

interface Props {
  conflict: PortConflict
  context: PortPromptContext
  /** Fabricator's apps, to name the one whose preview holds the address. */
  projects?: readonly { name: string; path: string }[]
  /** The folder of the app this live preview is for. */
  projectPath?: string
  /** Copilot is working on the app that holds the address (`conflict.holder`). */
  holderWorking?: boolean
  /** The action in flight, which disables the other controls. */
  busy: 'register' | 'stop' | null
  error: string | null
  /** Output streamed while registering the port. */
  log: string[]
  onUsePort: () => void
  onStop: () => void
  onSkip: () => void
}

/**
 * Live local preview: every address the app's sign-in accepts is taken. Says
 * who has it in plain words, and offers to stop that, or to add the next free
 * address to the app's sign-in settings (rayfin.yml, pushed to Fabric), one
 * click each, the safer one marked. The process the OS reported is under
 * Technical details.
 */
export default function PortConflictModal({
  conflict,
  context,
  projects,
  projectPath,
  holderWorking = false,
  busy,
  error,
  log,
  onUsePort,
  onStop,
  onSkip
}: Props): JSX.Element {
  useSuppressPreview()
  const titleId = useId()
  const dialogRef = useModalFocus<HTMLDivElement>()
  const { port, occupant, suggestedPort: next, needsPush } = conflict
  const holder = describeHolder(conflict, projects, projectPath)
  const usePort = canUsePort(conflict, context)
  const stop = canStopHolder(conflict) ? stopChoice(holder, holderWorking) : null
  /** Stopping something that loses nothing beats changing the app's sign-in settings.
   *  A stop that can lose work is never recommended, even as the only choice. */
  const recommended = stop?.safe ? 'stop' : usePort ? 'use' : null
  const working = busy !== null

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !working) onSkip()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [working, onSkip])

  const stopRow = stop && (
    <Choice
      key="stop"
      icon="stop-circle"
      title={stop.title}
      detail={stop.detail}
      recommended={recommended === 'stop'}
      busy={busy === 'stop'}
      busyTitle="Stopping…"
      disabled={working}
      onClick={onStop}
    />
  )
  const useRow = usePort && (
    <Choice
      key="use"
      icon="arrow-swap"
      title={`Use localhost:${next} instead`}
      detail={
        needsPush
          ? 'Adds it to your app’s sign-in settings and updates them in Fabric. Takes a moment.'
          : 'Adds it to your app’s sign-in settings. Sign-in accepts it once you publish.'
      }
      recommended={recommended === 'use'}
      busy={busy === 'register'}
      busyTitle={needsPush ? 'Updating your sign-in settings…' : 'Updating rayfin.yml…'}
      disabled={working}
      onClick={onUsePort}
    />
  )

  return (
    <div className="modal-backdrop" onClick={working ? undefined : onSkip}>
      <div
        className="modal port-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h2 id={titleId}>Your live preview needs localhost:{port}</h2>
            <p className="modal-sub">It’s the address your app’s sign-in accepts.</p>
          </div>
        </div>
        <div className="modal-body">
          <p className="port-dialog-lead">{holderLead(holder)}</p>
          {(stopRow || useRow) && (
            <div className="port-choices">
              {recommended === 'use' ? [useRow, stopRow] : [stopRow, useRow]}
            </div>
          )}
          {!usePort && next !== undefined && (
            <p className="port-dialog-note">
              Using localhost:{next} instead updates your app’s sign-in settings in Fabric, which
              can’t happen while Copilot is working. Skip for now to choose it with your next
              message.
            </p>
          )}
          {error && (
            <p className="confirm-error" role="alert">
              {error}
            </p>
          )}
          {log.length > 0 && (
            <pre className="deploy-log deploy-log--static" aria-label="Port registration log">
              {log.join('')}
            </pre>
          )}
          {occupant && (
            <details className="port-details">
              <summary>Technical details</summary>
              <dl>
                <dt>Program</dt>
                <dd>
                  {occupant.name} (PID {occupant.pid})
                </dd>
                {(occupant.commandLine || occupant.path) && (
                  <>
                    <dt>Command</dt>
                    <dd>
                      <code>{occupant.commandLine || occupant.path}</code>
                    </dd>
                  </>
                )}
              </dl>
            </details>
          )}
        </div>
        <div className="modal-footer">
          <button
            type="button"
            className="btn btn--sm btn--link"
            onClick={() => openDocs('previewPorts')}
          >
            Learn more
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onSkip}
            disabled={working}
            title="Copilot keeps working, and the preview shows your published app."
          >
            Skip live preview
          </button>
        </div>
      </div>
    </div>
  )
}
