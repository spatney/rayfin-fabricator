import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  DeployResult,
  FabricDeployment,
  FabricWorkspace,
  FabricWorkspacesResult,
  StudioProject
} from '@shared/ipc'
import { useSuppressPreview } from '../overlay'
import { useToast } from '../toast'
import { authErrorMessage } from '../authErrors'
import { Codicon } from './icons'
import DeploymentCreateForm, { checkActiveDeployTarget } from './DeploymentCreateForm'
import ShareDeploymentModal from './ShareDeploymentModal'

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
  /** Refresh app auth after sign-in; rejection prevents retrying with an unverified account. */
  onSignedIn?: () => Promise<void> | void
  /** The Fabric account deployments use (signed in), shown so it's never a surprise. */
  account?: { user?: string; tenant?: string }
  /** Open the Accounts dialog to change it. */
  onManageAccounts?: () => void
  /**
   * Set by an outside caller (the Help assistant's "share" action) to open the
   * share dialog for this project's live deployment, the same as selecting
   * Share here. It can arrive before this control mounts (Help was opened over
   * Home), so it's honoured on mount too, and reported back through
   * `onShareRequestHandled` so the caller drops it.
   */
  shareRequest?: { projectId: string; nonce: number } | null
  /** The `shareRequest` with this nonce has been acted on. */
  onShareRequestHandled?: (nonce: number) => void
}

/** "F-SKU · F2" style label for a workspace's capacity. */
function skuText(w: FabricWorkspace): string {
  if (w.capacityKind === 'unknown') return 'Capacity'
  const fam = w.capacityKind === 'fabric' ? 'F-SKU' : w.capacityKind === 'premium' ? 'P-SKU' : ''
  return fam + (w.sku ? ` · ${w.sku}` : '')
}

/**
 * The single deployment control for the app bar. It replaces the old
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
  onSignedIn,
  account,
  onManageAccounts,
  shareRequest,
  onShareRequestHandled
}: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const toast = useToast()
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
  const [sharing, setSharing] = useState<FabricDeployment | null>(null)
  /** Share was clicked and the deployment it targets is still loading. */
  const [openingShare, setOpeningShare] = useState(false)
  const openingShareRef = useRef(false)
  const projectIdRef = useRef(project.id)
  projectIdRef.current = project.id
  const wsBusyRef = useRef(false)
  const wsSeqRef = useRef(0)
  const depsSeqRef = useRef(0)

  useEffect(() => () => {
    ++wsSeqRef.current
    ++depsSeqRef.current
    wsBusyRef.current = false
  }, [])

  async function loadDeployments(): Promise<void> {
    const seq = ++depsSeqRef.current
    setLoadingDeps(true)
    try {
      const next = await window.api.deploy.list(project.id)
      if (seq === depsSeqRef.current) setDeployments(next)
    } catch (reason) {
      if (seq === depsSeqRef.current) {
        setDeployments(null)
        toast.error(authErrorMessage(reason, 'Could not load deployments. Please retry.'), {
          title: 'Deployment check failed'
        })
      }
    } finally {
      if (seq === depsSeqRef.current) setLoadingDeps(false)
    }
  }

  async function loadWorkspaces(): Promise<void> {
    if (wsBusyRef.current) return
    wsBusyRef.current = true
    const seq = ++wsSeqRef.current
    setLoadingWs(true)
    setWsResult(null)
    let needsLogin = false
    try {
      let res = await window.api.fabric.listWorkspaces()
      if (seq !== wsSeqRef.current) return
      // A missing/expired Fabric session: re-sign-in once and retry automatically,
      // so an expired token doesn't force the user to manually sign out and back in
      // just to list their workspaces.
      if (!res.ok && res.needsLogin) {
        needsLogin = true
        setReauthing(true)
        const login = await window.api.auth.loginRayfin()
        if (seq !== wsSeqRef.current) return
        if (login.ok) {
          await onSignedIn?.()
          if (seq !== wsSeqRef.current) return
          res = await window.api.fabric.listWorkspaces()
        } else {
          const error = authErrorMessage(login.error, 'Fabric sign-in did not complete. Please try again.')
          res = { ...res, error }
          toast.error(error, { title: 'Sign-in failed' })
        }
      }
      if (seq === wsSeqRef.current) setWsResult(res)
    } catch (reason) {
      if (seq === wsSeqRef.current) {
        const error = authErrorMessage(reason, 'Could not load workspaces. Please retry.')
        setWsResult({ ok: false, needsLogin, error })
        toast.error(error, { title: needsLogin ? 'Sign-in failed' : 'Workspace check failed' })
      }
    } finally {
      if (seq === wsSeqRef.current) {
        wsBusyRef.current = false
        setLoadingWs(false)
        setReauthing(false)
      }
    }
  }

  // Load the recorded deployments (and workspaces, for SKU badges + the create
  // dropdown) whenever the popover opens.
  useEffect(() => {
    if (!open) {
      setCreating(false)
      setRenamingKey(null)
      setLoadingWs(false)
      setLoadingDeps(false)
      setReauthing(false)
      return
    }
    void loadDeployments()
    // Reopening must not reuse workspaces from an expired or different account.
    void loadWorkspaces()
    return () => {
      ++wsSeqRef.current
      ++depsSeqRef.current
      wsBusyRef.current = false
    }
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
      const result = await onSwitch(target, byId)
      if (!result.ok) {
        toast.error(authErrorMessage(
          result.error,
          result.outcome === 'not-signed-in'
            ? 'Sign in to Fabric before switching deployments.'
            : 'Could not switch deployments. Please retry.'
        ), { title: 'Switch failed' })
        return
      }
      await loadDeployments()
    } catch (reason) {
      toast.error(authErrorMessage(reason, 'Could not switch deployments. Please retry.'), {
        title: 'Switch failed'
      })
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

  /** Open the Share dialog for the active deployment. Loading the list first (when
   * the popover hasn't) runs the Rayfin CLI and takes a moment, so the button
   * shows progress meanwhile and ignores repeat clicks. */
  async function openShareForActive(): Promise<void> {
    if (running || openingShareRef.current) return
    const projectId = project.id
    openingShareRef.current = true
    setOpeningShare(true)
    try {
      let deps = deployments
      if (!deps) {
        deps = await window.api.deploy.list(projectId)
        // The user moved on to another project while this loaded.
        if (projectIdRef.current !== projectId) return
        setDeployments(deps)
      }
      const target =
        deps.find((d) => d.active && d.workspaceId) ?? deps.find((d) => d.workspaceId) ?? null
      if (!target) {
        toast.error('Deploy this app to a workspace before sharing.', { title: 'Nothing to share yet' })
        return
      }
      setOpen(false)
      setSharing(target)
    } catch (reason) {
      if (projectIdRef.current !== projectId) return
      toast.error(authErrorMessage(reason, 'Could not load the deployment to share. Please retry.'), {
        title: 'Deployment check failed'
      })
    } finally {
      openingShareRef.current = false
      setOpeningShare(false)
    }
  }

  // Help's "share" action asked for the dialog. The request is reported
  // handled the moment it's acted on, so the caller drops it. Otherwise every
  // later mount of this control (going Home and back, switching projects)
  // would open the dialog again. The ref keeps a re-run of this effect from
  // acting on the same request twice.
  const shareRef = useRef(openShareForActive)
  shareRef.current = openShareForActive
  const onShareHandledRef = useRef(onShareRequestHandled)
  onShareHandledRef.current = onShareRequestHandled
  const handledShareRef = useRef<number | null>(null)
  useEffect(() => {
    if (!shareRequest || shareRequest.projectId !== project.id) return
    if (handledShareRef.current === shareRequest.nonce) return
    handledShareRef.current = shareRequest.nonce
    onShareHandledRef.current?.(shareRequest.nonce)
    void shareRef.current()
  }, [shareRequest, project.id])

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
          <Codicon name="cloud" className="dep-chip-ico" />
          <span className="sr-only">Deployment:</span>
          <span className="dep-chip-label">
            {activeLabel || (reconciling ? 'Checking…' : 'Not deployed')}
          </span>
          <Codicon name="chevron-down" className="dep-chip-caret" />
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
        <button
          className={`seg-btn dep-share-btn${openingShare ? ' is-busy' : ''}`}
          disabled={running || reconciling || !hasDeployment}
          aria-busy={openingShare || undefined}
          title={
            openingShare
              ? 'Opening the share dialog…'
              : hasDeployment
                ? 'Share this app with people in your tenant'
                : 'Deploy this app before sharing'
          }
          onClick={() => void openShareForActive()}
        >
          {openingShare ? (
            <Codicon name="loading" className="codicon-modifier-spin" />
          ) : (
            <Codicon name="person-add" />
          )}
          <span className="dep-share-label">Share</span>
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

          {account && (
            <div className="dep-account">
              <span
                className="dep-account-text"
                title={[account.user, account.tenant].filter(Boolean).join(' · ')}
              >
                Deploys as <strong>{account.user ?? 'your Fabric account'}</strong>
                {account.tenant ? ` · ${account.tenant}` : ''}
              </span>
              {onManageAccounts && (
                <button
                  type="button"
                  className="link-btn dep-account-change"
                  onClick={() => {
                    setOpen(false)
                    onManageAccounts()
                  }}
                >
                  Change
                </button>
              )}
            </div>
          )}

          {creating ? (
            <DeploymentCreateForm
              wsResult={wsResult}
              loadingWs={loadingWs}
              reauthing={reauthing}
              onReload={loadWorkspaces}
              onSignedIn={onSignedIn}
              running={running}
              onCancel={() => setCreating(false)}
              onSubmit={(name, workspaceId) => {
                onCreate(name, workspaceId)
                setOpen(false)
                setCreating(false)
              }}
              checkTarget={checkActiveDeployTarget}
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

      {/* Rendered at the document root so the dialog always overlays the whole
          window, independent of the app bar's layout. */}
      {sharing &&
        createPortal(
          <ShareDeploymentModal
            project={project}
            deployment={sharing}
            onClose={() => setSharing(null)}
            onSignedIn={onSignedIn}
          />,
          document.body
        )}
    </div>
  )
}
