import type { PortConflict } from '@shared/ipc'
import ConfirmModal from './ConfirmModal'
import { openDocs } from '../docsLinks'

/** `plan`: a turn is already running, so nothing can be pushed to Fabric yet. */
export type PortPromptContext = 'turn' | 'plan'

/** Whether "Use port N" can run now: a free port exists and any push is allowed. */
export function canUsePort(conflict: PortConflict, context: PortPromptContext, localOnly = false): boolean {
  return conflict.suggestedPort !== undefined && !(context === 'plan' && conflict.needsPush && !localOnly)
}

/** Whether the prompt has any choice besides skipping. */
export function hasPortChoice(conflict: PortConflict, context: PortPromptContext, localOnly = false): boolean {
  return canUsePort(conflict, context, localOnly) || (conflict.canStop && conflict.occupant !== undefined)
}

interface Props {
  conflict: PortConflict
  context: PortPromptContext
  localOnly?: boolean
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
 * Live local preview: every port the app's sign-in accepts is taken. Offers to
 * use the next free port (registering only when auto-deploy is enabled) or
 * stop the process that holds the preferred one.
 */
export default function PortConflictModal({
  conflict,
  context,
  localOnly = false,
  busy,
  error,
  log,
  onUsePort,
  onStop,
  onSkip
}: Props): JSX.Element {
  const { port, occupant, ownProject, suggestedPort: next, needsPush } = conflict
  const usePort = canUsePort(conflict, context, localOnly)
  const stop = conflict.canStop && occupant !== undefined
  const stopLabel = `Stop ${occupant?.name ?? 'it'}`
  const origin = `http://localhost:${next}`
  return (
    <ConfirmModal
      title={`localhost:${port} is in use`}
      confirmLabel={usePort ? `Use port ${next}` : stopLabel}
      danger={!usePort}
      busy={busy === (usePort ? 'register' : 'stop')}
      busyLabel={usePort ? (localOnly ? 'Starting local preview…' : needsPush ? 'Pushing to Fabric…' : 'Updating rayfin.yml…') : 'Stopping…'}
      secondaryLabel={usePort && stop ? stopLabel : undefined}
      onSecondary={usePort && stop ? onStop : undefined}
      secondaryBusy={usePort && busy === 'stop'}
      secondaryBusyLabel="Stopping…"
      cancelLabel="Skip live preview"
      onConfirm={usePort ? onUsePort : onStop}
      onCancel={onSkip}
      message={
        <>
          <p>
            {ownProject ? (
              <>
                Your live preview for <strong>{ownProject}</strong> is using it.
              </>
            ) : occupant ? (
              <>
                <strong>{occupant.name}</strong> (PID {occupant.pid}) is listening on it.
              </>
            ) : (
              <>Another app is listening on it, and Fabricator couldn&apos;t tell which one.</>
            )}{' '}
            {localOnly
              ? 'Auto-deploy is paused. You can preview locally on another port without pushing anything to Fabric.'
              : <>The live preview has to run on a port your app&apos;s sign-in accepts.</>}
          </p>
          {occupant?.commandLine && (
            <p className="confirm-path port-conflict-command" title={occupant.path}>
              {occupant.commandLine}
            </p>
          )}
          <ul className="port-conflict-options">
            {usePort && (
              <li>
                <strong>Use port {next}</strong>
                {localOnly ? (
                  <> starts your local preview at <code>{origin}</code>. No configuration is changed and nothing is pushed to Fabric. Local sign-in is supported, but this port must already be accepted by your backend for browser sign-in to work.</>
                ) : (
                  <> adds <code>{origin}</code> to rayfin.yml
                    {needsPush
                      ? ' and pushes your sign-in settings to Fabric. Your app isn’t rebuilt.'
                      : '. Your next deploy registers it for sign-in.'}{' '}
                    Fabricator reuses it whenever port {port} is busy.
                  </>
                )}
              </li>
            )}
            {stop && (
              <li>
                <strong>{stopLabel}</strong> ends that process, then uses port {port}. Unsaved work
                in it is lost.
              </li>
            )}
            {!usePort && next !== undefined && (
              <li>
                Switching ports pushes settings to Fabric, which can&apos;t happen while Copilot is
                working. Skip for now to be asked again with your next message.
              </li>
            )}
          </ul>
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
          <p>
            <button
              type="button"
              className="btn btn--sm btn--link"
              onClick={() => openDocs('previewPorts')}
            >
              Learn more about preview ports
            </button>
          </p>
        </>
      }
    />
  )
}
