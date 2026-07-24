import { useEffect, useId, useMemo, useState } from 'react'
import type { FabricDeployment, StudioProject, WorkspaceModel } from '@shared/ipc'
import { useSuppressPreview } from '../overlay'
import { useModalFocus } from '../modalFocus'
import { useToast } from '../toast'
import { Codicon } from './icons'

interface Props {
  project: StudioProject
  onClose: () => void
  /** Hand a ready-to-send "connect this model" prompt to the chat composer. */
  onConnect: (prompt: string) => void
  /** Notify the parent that a Fabric sign-in just succeeded. */
  onSignedIn?: () => void
}

type LoadState =
  | { status: 'resolving' }
  | { status: 'no-workspace' }
  | { status: 'loading'; workspaceName: string }
  | { status: 'needs-login'; workspaceName: string }
  | { status: 'error'; workspaceName: string; error: string }
  | { status: 'ready'; workspaceName: string; models: WorkspaceModel[] }

/** Compose the prompt the agent acts on to wire the chosen model. */
function connectPrompt(model: WorkspaceModel, workspaceId: string): string {
  const name = model.name ?? model.id
  return (
    `Connect the Fabric semantic model "${name}" to this app and use it as a data source.\n\n` +
    `Workspace ID: ${workspaceId}\n` +
    `Semantic model (dataset) ID: ${model.id}\n\n` +
    `Add it as a Fabric data connection (use the fabric-data skill / capability router to enable ` +
    `Fabric analytics and wire it up), regenerate the config, then help me build with it.`
  )
}

/**
 * Browse the semantic models in the workspace this app deploys to, and hand a
 * "connect this model" prompt to the chat — the agent enables the Fabric data
 * capability and wires it (this works across templates, including ones that
 * install the Fabric tooling on demand).
 */
export default function ConnectModelModal({
  project,
  onClose,
  onConnect,
  onSignedIn
}: Props): JSX.Element {
  const toast = useToast()
  useSuppressPreview()
  const titleId = useId()
  const dialogRef = useModalFocus<HTMLDivElement>()

  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [state, setState] = useState<LoadState>({ status: 'resolving' })
  const [connectedIds, setConnectedIds] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [reloadTick, setReloadTick] = useState(0)

  // Resolve the app's deployed workspace from the active deployment.
  useEffect(() => {
    let alive = true
    setState({ status: 'resolving' })
    void window.api.deploy.list(project.id).then((deps: FabricDeployment[]) => {
      if (!alive) return
      const target =
        deps.find((d) => d.active && d.workspaceId) ?? deps.find((d) => d.workspaceId) ?? null
      if (!target?.workspaceId) {
        setWorkspaceId(null)
        setState({ status: 'no-workspace' })
        return
      }
      setWorkspaceId(target.workspaceId)
      setState({ status: 'loading', workspaceName: target.workspaceName })
    })
    // Existing connections (to badge already-added models).
    void window.api.fabric.projectSemanticModels(project.id).then((models) => {
      if (alive) setConnectedIds(new Set(models.map((m) => m.itemId)))
    })
    return () => {
      alive = false
    }
  }, [project.id])

  // Load the workspace's models once we know the workspace.
  useEffect(() => {
    if (!workspaceId) return
    let alive = true
    const wsName = 'workspaceName' in state ? state.workspaceName : ''
    setState({ status: 'loading', workspaceName: wsName })
    void window.api.fabric.listWorkspaceModels(workspaceId).then((res) => {
      if (!alive) return
      if (res.ok) setState({ status: 'ready', workspaceName: wsName, models: res.models })
      else if (res.needsLogin) setState({ status: 'needs-login', workspaceName: wsName })
      else setState({ status: 'error', workspaceName: wsName, error: res.error ?? 'Could not load models.' })
    })
    return () => {
      alive = false
    }
  }, [workspaceId, reloadTick])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const models = state.status === 'ready' ? state.models : []
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return models
    return models.filter((m) => (m.name ?? '').toLowerCase().includes(q))
  }, [models, filter])

  async function reauthAndReload(): Promise<void> {
    const login = await window.api.auth.loginRayfin()
    if (login.ok) {
      onSignedIn?.()
      setReloadTick((n) => n + 1)
    } else {
      toast.error(login.error ?? 'Fabric sign-in did not complete. Please try again.', {
        title: 'Sign-in failed'
      })
    }
  }

  function addToChat(modelId?: string): void {
    const id = modelId ?? selectedId
    if (!workspaceId || !id) return
    const model = models.find((m) => m.id === id)
    if (!model) return
    onConnect(connectPrompt(model, workspaceId))
    onClose()
  }

  const wsLabel = 'workspaceName' in state ? state.workspaceName : ''

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal connect-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={titleId}>Connect a semantic model</h2>
        </div>

        <div className="modal-body">
          {state.status === 'resolving' && (
            <div className="connect-state">
              <span className="btn-spin" aria-hidden="true" /> Finding your deployment…
            </div>
          )}

          {state.status === 'no-workspace' && (
            <div className="connect-state connect-state--empty">
              Deploy this app to a Fabric workspace first — then you can connect the semantic models
              in that workspace.
            </div>
          )}

          {state.status === 'needs-login' && (
            <div className="share-banner">
              <span>Your Fabric session expired. Sign in to list this workspace's models.</span>
              <button className="btn btn--sm btn--primary" onClick={() => void reauthAndReload()}>
                Sign in &amp; retry
              </button>
            </div>
          )}

          {state.status === 'error' && (
            <div className="share-banner share-banner--bad">{state.error}</div>
          )}

          {(state.status === 'loading' ||
            state.status === 'ready' ||
            state.status === 'needs-login' ||
            state.status === 'error') && (
            <p className="connect-sub">
              Models in <strong>{wsLabel || 'your workspace'}</strong>
              {' — '}the workspace this app deploys to. Pick one to hand the agent a ready-to-send
              request that wires it up.
            </p>
          )}

          {state.status === 'loading' && (
            <div className="connect-state">
              <span className="btn-spin" aria-hidden="true" /> Loading semantic models…
            </div>
          )}

          {state.status === 'ready' && models.length === 0 && (
            <div className="connect-state connect-state--empty">
              No semantic models in this workspace.
            </div>
          )}

          {state.status === 'ready' && models.length > 0 && (
            <>
              {models.length > 6 && (
                <input
                  className="ws-input connect-filter"
                  placeholder="Filter models…"
                  spellCheck={false}
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              )}
              <ul className="connect-list" role="listbox" aria-label="Semantic models">
                {filtered.map((m) => {
                  const already = m.id ? connectedIds.has(m.id) : false
                  const selected = m.id === selectedId
                  return (
                    <li key={m.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={`connect-item${selected ? ' connect-item--sel' : ''}${already ? ' connect-item--done' : ''}`}
                        disabled={already}
                        onClick={() => m.id && setSelectedId(m.id)}
                        onDoubleClick={() => m.id && addToChat(m.id)}
                      >
                        <Codicon name="database" />
                        <span className="connect-item-text">
                          <span className="connect-item-name">{m.name ?? m.id}</span>
                        </span>
                        {already ? (
                          <span className="connect-badge">Connected</span>
                        ) : selected ? (
                          <Codicon name="check" className="connect-item-check" />
                        ) : null}
                      </button>
                    </li>
                  )
                })}
                {filtered.length === 0 && (
                  <li className="connect-state connect-state--empty">No models match “{filter}”.</li>
                )}
              </ul>
            </>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn--ghost" onClick={onClose}>
            Close
          </button>
          <button className="btn btn--primary" onClick={() => addToChat()} disabled={!selectedId}>
            Add to chat
          </button>
        </div>
      </div>
    </div>
  )
}
