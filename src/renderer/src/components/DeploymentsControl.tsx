import { useEffect, useState } from 'react'
import type {
  DeployResult,
  FabricDeployment,
  FabricWorkspace,
  FabricWorkspacesResult,
  StudioProject
} from '@shared/ipc'
import { useSuppressPreview } from '../overlay'
import { Codicon } from './icons'
import DeploymentCreateForm from './DeploymentCreateForm'

interface Props {
  project: StudioProject
  /** True while a `rayfin up` is streaming for this project. */
  running: boolean
  /** True while the recorded deployment is being reconciled with on-disk state. */
  reconciling?: boolean
  /** Remember a friendly name for the chosen workspace, then deploy into it. */
  onCreate: (name: string, workspaceId: string) => void
  /** Redeploy the active deployment (no workspace change). */
  onRedeploy: () => void
  /** Switch the active recorded deployment (`rayfin up switch`). */
  onSwitch: (workspace: string, byId: boolean) => Promise<DeployResult>
  /** Refresh the project list after a rename / switch. */
  onChanged: () => void
  /** Notify the parent that a Fabric sign-in just succeeded (refresh app auth). */
  onSignedIn?: () => void
}

/** "F-SKU · F2" style label for a workspace's capacity. */
function skuText(w: FabricWorkspace): string {
  if (w.capacityKind === 'unknown') return 'Capacity'
  const fam = w.capacityKind === 'fabric' ? 'F-SKU' : w.capacityKind === 'premium' ? 'P-SKU' : ''
  return fam + (w.sku ? ` · ${w.sku}` : '')
}

/**
 * The single deployment control for the project header. It replaces the old
 * standalone workspace picker: deployments and workspaces are the same idea, so
 * this lists the project's deployments (switch / rename) and lets the user
 * create a new named one by picking an eligible (F-SKU / P-SKU) workspace —
 * which runs a real `rayfin up` so every id/url is recorded. The adjacent
 * Deploy / Redeploy button is the primary deploy action.
 */
export default function DeploymentsControl({
  project,
  running,
  reconciling = false,
  onCreate,
  onRedeploy,
  onSwitch,
  onChanged,
  onSignedIn
}: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [deployments, setDeployments] = useState<FabricDeployment[] | null>(null)
  const [loadingDeps, setLoadingDeps] = useState(false)
  const [wsResult, setWsResult] = useState<FabricWorkspacesResult | null>(null)
  const [loadingWs, setLoadingWs] = useState(false)
  const [reauthing, setReauthing] = useState(false)
  const [switching, setSwitching] = useState<string | null>(null)
  const [renamingKey, setRenamingKey] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [busy, setBusy] = useState(false)

  async function loadDeployments(): Promise<void> {
    setLoadingDeps(true)
    try {
      setDeployments(await window.api.deploy.list(project.id))
    } finally {
      setLoadingDeps(false)
    }
  }

  async function loadWorkspaces(): Promise<void> {
    setLoadingWs(true)
    try {
      let res = await window.api.fabric.listWorkspaces()
      // A missing/expired Fabric session: re-sign-in once and retry automatically,
      // so an expired token doesn't force the user to manually sign out and back in
      // just to list their workspaces.
      if (!res.ok && res.needsLogin) {
        setReauthing(true)
        try {
          const login = await window.api.auth.loginRayfin()
          if (login.ok) {
            onSignedIn?.()
            res = await window.api.fabric.listWorkspaces()
          }
        } finally {
          setReauthing(false)
        }
      }
      setWsResult(res)
    } catch (err) {
      setWsResult({ ok: false, error: String(err) })
    } finally {
      setLoadingWs(false)
    }
  }

  // Load the recorded deployments (and workspaces, for SKU badges + the create
  // dropdown) whenever the popover opens.
  useEffect(() => {
    if (!open) {
      setCreating(false)
      setRenamingKey(null)
      return
    }
    void loadDeployments()
    if (!wsResult) void loadWorkspaces()
  }, [open, project.id])

  // The deployments popover floats above all HTML; hide the native preview
  // webview while it is open so it doesn't cover the menu.
  useSuppressPreview(open)

  // Close on any outside click.
  useEffect(() => {
    if (!open) return
    const close = (): void => setOpen(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [open])

  const all = wsResult?.ok && wsResult.workspaces ? wsResult.workspaces : []
  const wsById = (id?: string): FabricWorkspace | undefined =>
    id ? all.find((w) => w.id === id) : undefined

  const activeDep = deployments?.find((d) => d.active) ?? null
  const fallbackName =
    (project.workspace ? project.deploymentNames?.[project.workspace] : undefined) ||
    project.workspaceName ||
    undefined
  const activeLabel = activeDep ? activeDep.name || activeDep.workspaceName : fallbackName
  const hasDeployment = Boolean(activeDep || project.lastDeploy?.url || project.workspace)

  function startCreate(): void {
    setCreating(true)
    if (!wsResult) void loadWorkspaces()
  }

  function openCreate(): void {
    setOpen(true)
    startCreate()
  }

  async function doSwitch(d: FabricDeployment): Promise<void> {
    const byId = Boolean(d.workspaceId)
    const target = d.workspaceId ?? d.workspaceName
    if (!target || running) return
    setSwitching(target)
    try {
      await onSwitch(target, byId)
      await loadDeployments()
    } finally {
      setSwitching(null)
    }
  }

  function startRename(d: FabricDeployment): void {
    setRenamingKey(d.workspaceId ?? d.workspaceName)
    setRenameValue(d.name ?? '')
  }

  async function saveRename(): Promise<void> {
    const key = renamingKey
    if (!key) return
    setBusy(true)
    try {
      await window.api.deploy.setName(project.id, key, renameValue)
      setRenamingKey(null)
      onChanged()
      await loadDeployments()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dep-control" onClick={(e) => e.stopPropagation()}>
      <div className="seg seg--toolbar dep-seg">
        <button
          className="seg-btn dep-select"
          title={
            activeLabel
              ? `Deploys to workspace: ${activeLabel}. Click to switch or create another.`
              : reconciling
                ? 'Checking for an existing deployment…'
                : 'Not deployed yet — click to choose a workspace'
          }
          onClick={() => setOpen((o) => !o)}
        >
          <span className={`seg-dot${hasDeployment ? ' seg-dot--set' : ''}`} />
          <span className="dep-chip-prefix">Deployment:</span>
          <span className="dep-chip-label">
            {activeLabel || (reconciling ? 'Checking…' : 'Not deployed')}
          </span>
          <span className="dep-chip-caret"><Codicon name="chevron-down" /></span>
        </button>
        <button
          className="seg-btn seg-btn--primary dep-deploy"
          disabled={running || (reconciling && !hasDeployment)}
          title={hasDeployment ? 'Redeploy the active deployment' : 'Create your first deployment'}
          onClick={() => {
            if (running || (reconciling && !hasDeployment)) return
            if (hasDeployment) onRedeploy()
            else openCreate()
          }}
        >
          {running ? 'Deploying…' : hasDeployment ? 'Redeploy' : 'Deploy'}
        </button>
      </div>

      {open && (
        <div className="dep-pop" role="dialog" aria-label={creating ? 'New deployment' : 'Deployments'}>
          <div className="dep-pop-head">
            <span className="dep-pop-title">{creating ? 'New deployment' : 'Deployments'}</span>
            {!creating && (
              <button
                className="ws-refresh"
                title="Refresh"
                aria-label="Refresh deployments"
                disabled={loadingDeps}
                onClick={() => void loadDeployments()}
              >
                <Codicon name="refresh" />
              </button>
            )}
          </div>

          {creating ? (
            <DeploymentCreateForm
              wsResult={wsResult}
              loadingWs={loadingWs}
              reauthing={reauthing}
              onReload={() => void loadWorkspaces()}
              onSignedIn={onSignedIn}
              running={running}
              onCancel={() => setCreating(false)}
              onSubmit={(name, workspaceId) => {
                onCreate(name, workspaceId)
                setOpen(false)
                setCreating(false)
              }}
            />
          ) : (
            <>
              {loadingDeps && deployments === null ? (
                <div className="ws-loading">
                  <span className="ws-spinner" />
                  Loading deployments…
                </div>
              ) : !deployments || deployments.length === 0 ? (
                <div className="dep-empty">
                  No deployments yet. Create one to publish your app to a Fabric workspace — Rayfin
                  Fabricator records every id and url for you.
                </div>
              ) : (
                <ul className="dep-list">
                  {deployments.map((d) => {
                    const key = d.workspaceId ?? d.workspaceName
                    const ws = wsById(d.workspaceId)
                    const isRenaming = renamingKey === key
                    const url = d.hostingUrl || d.apiUrl
                    return (
                      <li key={key} className={`dep-item${d.active ? ' dep-item--active' : ''}`}>
                        <div className="dep-item-top">
                          {isRenaming ? (
                            <input
                              className="ws-input dep-rename"
                              autoFocus
                              spellCheck={false}
                              value={renameValue}
                              disabled={busy}
                              onChange={(e) => setRenameValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') void saveRename()
                                else if (e.key === 'Escape') setRenamingKey(null)
                              }}
                              onBlur={() => void saveRename()}
                            />
                          ) : (
                            <button
                              className="dep-item-name"
                              title="Rename this deployment"
                              onClick={() => startRename(d)}
                            >
                              <span className="dep-item-name-text">
                                {d.name || d.workspaceName}
                              </span>
                              <span className="dep-item-edit"><Codicon name="edit" /></span>
                            </button>
                          )}
                          {d.active ? (
                            <span className="dep-badge">active</span>
                          ) : (
                            <button
                              className="btn btn--xs btn--ghost"
                              disabled={Boolean(switching) || running}
                              onClick={() => void doSwitch(d)}
                            >
                              {switching === key ? 'Switching…' : 'Switch'}
                            </button>
                          )}
                        </div>
                        <div className="dep-item-sub">
                          <span className="dep-item-ws" title={d.workspaceName}>
                            {d.workspaceName}
                            {ws?.region ? ` · ${ws.region}` : ''}
                          </span>
                          {ws && (
                            <span className={`ws-sku ws-sku--${ws.capacityKind}`}>
                              {skuText(ws)}
                            </span>
                          )}
                        </div>
                        {url && (
                          <span className="dep-item-url" title={url}>
                            {url}
                          </span>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
              {!(loadingDeps && deployments === null) && (
                <button className="dep-new" onClick={startCreate} disabled={running}>
                  + New deployment
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
