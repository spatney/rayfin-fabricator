import { useEffect, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import type {
  DeployResult,
  FabricDeployment,
  FabricWorkspace,
  FabricWorkspacesResult,
  PendingChanges,
  StudioProject
} from '@shared/ipc'
import { useSuppressPreview } from '../overlay'
import { useToast } from '../toast'
import { authErrorMessage } from '../authErrors'
import { fabricWorkspaceUrl } from '../fabric'
import { clockLabel, meterStepLabel, useDeployMeter } from '../deployMeter'
import { Codicon } from './icons'
import DeploymentCreateForm, { checkActiveDeployTarget } from './DeploymentCreateForm'
import ShareDeploymentModal from './ShareDeploymentModal'
import type { DeployUiState } from './PreviewPane'
import { timeAgo, useNow } from './team/runProgress'

interface Props {
  project: StudioProject
  /** True while a `rayfin up` is streaming for this project. */
  running: boolean
  /** The project's deploy: its log and start while it runs, and how the last one ended. */
  deploy?: DeployUiState
  /** True while the recorded deployment is being reconciled with on-disk state. */
  reconciling?: boolean
  /** What the next deploy would ship; `null` or absent while it isn't known. */
  pending?: PendingChanges | null
  /** A deploy running to a new deployment, by its name: shown instead of the active one's until it's done. */
  deployingTo?: string
  /** Remember a friendly name for the chosen workspace, then deploy into it. */
  onCreate: (name: string, workspaceId: string, workspaceName?: string) => void
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
  /** Sign in to Fabric, offered in the panel while signed out. */
  onSignIn?: () => void
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
  /** The workspaces your apps use, most recent first; New deployment lists them first. */
  recentWorkspaces?: readonly string[]
  /** Whether chat turns deploy the app as they finish (off: the user deploys manually). */
  autoDeploy?: { on: boolean; onChange: (on: boolean) => void }
  /** Open Help about why the last deploy failed. */
  onDiagnose?: () => void
  /** Show the running deploy on its full screen. */
  onWatch?: () => void
  /** Show what changed since the deployed version. */
  onShowChanges?: () => void
  /** The panel opened: a good moment to check what's waiting to deploy. */
  onOpen?: () => void
}

type Status = 'ok' | 'busy' | 'err' | 'none'

/** The state of a deployment, as a small dot. */
function StatusDot({ status }: { status: Status }): JSX.Element {
  return <span className={`dep-dot dep-dot--${status}`} aria-hidden="true" />
}

/**
 * Region and capacity of the workspaces seen this session, so a deployment's
 * details show them straight away when its panel opens again.
 */
const workspaceDetails = new Map<string, FabricWorkspace>()

/** "West US · F2" for a workspace, as far as it's known. */
function workspaceMeta(w: FabricWorkspace | undefined): string {
  if (!w) return ''
  return [w.region, w.capacityKind === 'unknown' ? undefined : w.sku].filter(Boolean).join(' · ')
}

/** Host-only label for an app's address (the full URL is in the tooltip). */
function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** Most recently deployed first. */
function byDeployedAt(a: FabricDeployment, b: FabricDeployment): number {
  return (Date.parse(b.deployedAt ?? '') || 0) - (Date.parse(a.deployedAt ?? '') || 0)
}

/**
 * The deployment control in the app bar: what state the app's deployment is in
 * on the left, the one thing to do about it on the right, lit only when it
 * matters (changes waiting, a failed deploy, nothing deployed yet). Share sits
 * apart from it: it's about people, not deploys.
 *
 * The panel the state opens is the deployment's details: how it is and since
 * when, its address, workspace and account, the project's other deployments,
 * whether chat turns deploy, and New deployment. It opens straight away from
 * what Fabricator knows, refreshes behind, and never starts a sign-in by itself.
 */
export default function DeploymentsControl({
  project,
  running,
  deploy,
  reconciling = false,
  pending,
  deployingTo,
  onCreate,
  onRedeploy,
  onSwitch,
  onChanged,
  onSignedIn,
  account,
  onManageAccounts,
  onSignIn,
  shareRequest,
  onShareRequestHandled,
  recentWorkspaces,
  autoDeploy,
  onDiagnose,
  onWatch,
  onShowChanges,
  onOpen
}: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const toast = useToast()
  const [creating, setCreating] = useState(false)
  const creatingRef = useRef(creating)
  creatingRef.current = creating
  /** The recorded deployments, and the project they're for (the control outlives a switch). */
  const [recorded, setRecorded] = useState<{ projectId: string; list: FabricDeployment[] } | null>(null)
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
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef(0)
  const openingShareRef = useRef(false)
  const projectIdRef = useRef(project.id)
  projectIdRef.current = project.id
  const accountRef = useRef(account)
  accountRef.current = account
  const onOpenRef = useRef(onOpen)
  onOpenRef.current = onOpen
  const wsBusyRef = useRef(false)
  const wsSeqRef = useRef(0)
  const depsSeqRef = useRef(0)

  useEffect(
    () => () => {
      ++wsSeqRef.current
      ++depsSeqRef.current
      wsBusyRef.current = false
      window.clearTimeout(copiedTimer.current)
    },
    []
  )

  const deployments = recorded?.projectId === project.id ? recorded.list : null

  async function loadDeployments(): Promise<void> {
    const projectId = project.id
    const seq = ++depsSeqRef.current
    try {
      const list = await window.api.deploy.list(projectId)
      if (seq === depsSeqRef.current) setRecorded({ projectId, list })
    } catch (reason) {
      if (seq === depsSeqRef.current) {
        toast.error(authErrorMessage(reason, 'Could not load deployments. Please retry.'), {
          title: 'Deployment check failed'
        })
      }
    }
  }

  /**
   * List the Fabric workspaces. `signIn`: a missing or expired Fabric session
   * signs in again once and retries, so creating a deployment doesn't need a
   * manual sign-out and back in. Only New deployment asks for that; the details
   * look quietly and do without.
   */
  async function loadWorkspaces(signIn: boolean): Promise<void> {
    if (wsBusyRef.current) return
    wsBusyRef.current = true
    const seq = ++wsSeqRef.current
    setLoadingWs(true)
    setWsResult(null)
    let needsLogin = false
    try {
      let res = await window.api.fabric.listWorkspaces()
      if (seq !== wsSeqRef.current) return
      if (!res.ok && res.needsLogin && signIn) {
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
      if (seq === wsSeqRef.current) {
        for (const w of res.ok ? (res.workspaces ?? []) : []) workspaceDetails.set(w.id.toLowerCase(), w)
        setWsResult(res)
      }
    } catch (reason) {
      if (seq === wsSeqRef.current) {
        const error = authErrorMessage(reason, 'Could not load workspaces. Please retry.')
        setWsResult({ ok: false, needsLogin, error })
        if (signIn) toast.error(error, { title: needsLogin ? 'Sign-in failed' : 'Workspace check failed' })
      }
    } finally {
      if (seq === wsSeqRef.current) {
        wsBusyRef.current = false
        setLoadingWs(false)
        setReauthing(false)
      }
    }
  }

  // Opening the panel shows what's known at once and refreshes it behind: the
  // recorded deployments (read from disk, so quickly) and, signed in, the
  // workspaces' region and capacity.
  useEffect(() => {
    if (!open) {
      setCreating(false)
      setRenamingKey(null)
      // Reopening must not reuse workspaces from an expired or different account.
      setWsResult(null)
      setLoadingWs(false)
      setReauthing(false)
      return
    }
    onOpenRef.current?.()
    void loadDeployments()
    if (accountRef.current && !creatingRef.current) void loadWorkspaces(false)
    return () => {
      ++wsSeqRef.current
      ++depsSeqRef.current
      wsBusyRef.current = false
    }
  }, [open, project.id])

  // The panel floats above all HTML; hide the native preview webview while it
  // is open so it doesn't cover the panel.
  useSuppressPreview(open)

  // A deploy, a switch or reopening the app can change which deployment is
  // active: once the list is loaded, read it again (from disk, so quickly).
  const deploymentKey = `${project.workspace ?? ''}|${project.lastDeploy?.url ?? ''}|${running}`
  const recordedFor = recorded?.projectId
  useEffect(() => {
    if (recordedFor === project.id) void loadDeployments()
  }, [deploymentKey])

  // Close on any outside click, or Escape.
  useEffect(() => {
    if (!open) return
    const close = (): void => setOpen(false)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const all = wsResult?.ok && wsResult.workspaces ? wsResult.workspaces : []
  const workspaceById = (id?: string): FabricWorkspace | undefined =>
    id ? (all.find((w) => w.id === id) ?? workspaceDetails.get(id.toLowerCase())) : undefined

  const activeDep = deployments?.find((d) => d.active) ?? null
  const fallbackName =
    (project.workspace ? project.deploymentNames?.[project.workspace] : undefined) ||
    project.workspaceName ||
    undefined
  const activeLabel = activeDep ? activeDep.name || activeDep.workspaceName : fallbackName
  const hasDeployment = Boolean(activeDep || project.lastDeploy?.url || project.workspace)
  const failed = !running && (deploy?.result ? !deploy.result.ok : project.lastDeploy?.status === 'error')
  const meter = useDeployMeter(project.id, deploy?.log, deploy?.startedAt, running)
  const percent = meter ? Math.round(meter.fraction * 100) : null
  const files = pending?.changed ? pending.files : undefined
  const waiting = Boolean(pending?.changed) && hasDeployment && !running && !failed
  const now = useNow(open)

  /** A deploy running to a new deployment: it's named for that one until it's done. */
  const toNew = running && deployingTo ? deployingTo : undefined
  const name = toNew ?? (activeLabel || 'your app')
  const status: Status =
    running || (reconciling && !hasDeployment) ? 'busy' : !hasDeployment ? 'none' : failed ? 'err' : 'ok'
  const label = toNew ?? (activeLabel || (reconciling ? 'Checking…' : 'Not deployed'))
  const deployedAt = activeDep?.deployedAt
  const workspaceId =
    activeDep?.workspaceId ?? (fabricWorkspaceUrl(project.workspace) ? project.workspace : undefined)
  const workspaceName = activeDep?.workspaceName ?? project.workspaceName
  const workspace = workspaceById(workspaceId)
  const workspaceLink = fabricWorkspaceUrl(workspaceId)
  // The address and workspace are the active deployment's: not yet the new one's.
  const appUrl = toNew ? undefined : activeDep?.hostingUrl || project.lastDeploy?.url || activeDep?.apiUrl
  const shownWorkspace = toNew ? undefined : workspaceName
  const others = (deployments ?? []).filter((d) => !d.active).sort(byDeployedAt)

  function openCreate(): void {
    setOpen(true)
    startCreate()
  }

  function startCreate(): void {
    setCreating(true)
    if (!wsResult?.ok) void loadWorkspaces(true)
  }

  /** What the button beside the state does now. */
  const action: { label: string; title: string; primary: boolean; disabled?: boolean; run: () => void } =
    running
      ? {
          label: percent === null ? 'Deploying…' : `Deploying… ${percent}%`,
          title: 'See how the deploy is going',
          primary: false,
          run: () => setOpen(true)
        }
      : !hasDeployment
        ? {
            label: 'Deploy',
            title: 'Create your first deployment',
            primary: true,
            disabled: reconciling,
            run: openCreate
          }
        : failed
          ? { label: 'Try again', title: `Deploy ${name} again`, primary: true, run: onRedeploy }
          : waiting
            ? {
                label: files ? `Deploy ${plural(files, 'change')}` : 'Deploy changes',
                title: files
                  ? `${plural(files, 'file')} changed since ${name} was deployed`
                  : `Your latest changes aren't on ${name} yet`,
                primary: true,
                run: onRedeploy
              }
            : {
                label: 'Redeploy',
                title: pending ? `${name} is up to date. Deploy it again anyway.` : `Deploy ${name} again`,
                primary: false,
                run: onRedeploy
              }

  const chipState = running
    ? `Deploying to ${name}…`
    : !hasDeployment
      ? reconciling
        ? 'Checking for an existing deployment…'
        : 'Not deployed yet. Click to choose a workspace.'
      : failed
        ? `The last deploy to ${name} didn't finish. Click for details.`
        : `${name} is live${workspaceName && workspaceName !== name ? ` in ${workspaceName}` : ''}. Click for details, or to switch or add a deployment.`
  // With deploying after each turn off, the chip says so without opening the
  // panel: "· Manual". Auto is the default, so it goes unsaid.
  const modeNote = autoDeploy && !autoDeploy.on && hasDeployment ? 'Manual' : null
  const chipTitle = autoDeploy
    ? `${chipState}\n${autoDeploy.on ? 'Auto deploy is on: chat changes deploy after each turn.' : 'Auto deploy is off: chat changes wait for you to deploy them.'}`
    : chipState

  const statusText = running
    ? meter
      ? `Deploying · step ${meter.step} of ${meter.steps} · ${clockLabel(meter.elapsed)}`
      : 'Deploying…'
    : !hasDeployment
      ? reconciling
        ? 'Checking for a deployment…'
        : 'Not deployed yet'
      : failed
        ? `Last deploy failed${project.lastDeploy?.at ? ` · ${timeAgo(project.lastDeploy.at, now)}` : ''}`
        : deployedAt
          ? `Deployed ${timeAgo(deployedAt, now)}`
          : 'Deployed'
  const failure = (deploy?.result?.error ?? project.lastDeploy?.error ?? '')
    .trim()
    .split('\n')[0]
    // The CLI's own "❌ Deployment failed:" adds nothing to "didn't finish".
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/^deploy(?:ment)? failed[:.]?\s*/i, '')

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

  async function copyLink(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      window.clearTimeout(copiedTimer.current)
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1200)
    } catch {
      toast.error('Could not copy the link.', { title: 'Copy failed' })
    }
  }

  /** Open the Share dialog for the active deployment. When the list isn't loaded
   * yet, it loads first, so the button shows progress meanwhile and ignores
   * repeat clicks. */
  async function openShareForActive(): Promise<void> {
    if (openingShareRef.current) return
    const projectId = project.id
    openingShareRef.current = true
    setOpeningShare(true)
    try {
      let deps = deployments
      if (!deps) {
        deps = await window.api.deploy.list(projectId)
        // The user moved on to another project while this loaded.
        if (projectIdRef.current !== projectId) return
        setRecorded({ projectId, list: deps })
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

  /** Leave the panel, then do `then`. */
  const leave = (then: () => void) => (): void => {
    setOpen(false)
    then()
  }

  function renameInput(): JSX.Element {
    return (
      <input
        className="ws-input dep-rename"
        aria-label="Deployment name"
        autoFocus
        spellCheck={false}
        value={renameValue}
        disabled={busy}
        onChange={(e) => setRenameValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void saveRename()
          else if (e.key === 'Escape') {
            e.stopPropagation()
            setRenamingKey(null)
          }
        }}
        onBlur={() => void saveRename()}
      />
    )
  }

  const activeKey = activeDep ? (activeDep.workspaceId ?? activeDep.workspaceName) : null

  return (
    <div className="dep-control" onClick={(e) => e.stopPropagation()}>
      <div className="seg seg--toolbar dep-seg">
        <button
          type="button"
          className={`seg-btn dep-select${open ? ' is-open' : ''}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          title={chipTitle}
          onClick={() => setOpen((o) => !o)}
        >
          <StatusDot status={status} />
          <span className="sr-only">Deployment:</span>
          <span className="dep-chip-label">{label}</span>
          {status === 'err' ? (
            <span className="dep-chip-note">· Failed</span>
          ) : (
            modeNote && <span className="dep-chip-note">· {modeNote}</span>
          )}
          <Codicon name="chevron-down" className="dep-chip-caret" />
        </button>
        <button
          type="button"
          className={`seg-btn dep-deploy${action.primary ? ' seg-btn--primary' : ''}${running ? ' dep-deploy--busy' : ''}`}
          disabled={action.disabled}
          title={action.title}
          onClick={() => action.run()}
        >
          {action.label}
        </button>
        {running && (
          <span className="dep-progress" aria-hidden="true">
            <span style={{ width: `${Math.max(4, percent ?? 0)}%` }} />
          </span>
        )}
      </div>

      {hasDeployment && (
        <div className="seg seg--toolbar dep-share">
          <button
            type="button"
            className={`seg-btn dep-share-btn${openingShare ? ' is-busy' : ''}`}
            disabled={reconciling}
            aria-busy={openingShare || undefined}
            title={openingShare ? 'Opening the share dialog…' : 'Share this app with people in your tenant'}
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
      )}

      {open && (
        <div className="dep-pop" role="dialog" aria-label={creating ? 'New deployment' : 'Deployments'}>
          {creating ? (
            <div className="dep-sec">
              <span className="dep-pop-title">New deployment</span>
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
                    <button type="button" className="link-btn dep-account-change" onClick={leave(onManageAccounts)}>
                      Change
                    </button>
                  )}
                </div>
              )}
              <DeploymentCreateForm
                wsResult={wsResult}
                loadingWs={loadingWs}
                reauthing={reauthing}
                onReload={() => loadWorkspaces(true)}
                onSignedIn={onSignedIn}
                running={running}
                onCancel={() => setCreating(false)}
                onSubmit={(depName, workspaceId) => {
                  onCreate(depName, workspaceId, workspaceById(workspaceId)?.displayName)
                  setOpen(false)
                  setCreating(false)
                }}
                checkTarget={checkActiveDeployTarget}
                recentWorkspaces={recentWorkspaces}
              />
            </div>
          ) : (
            <>
              <div className="dep-sec dep-head">
                <div className="dep-title-row">
                  {activeDep && !toNew && renamingKey === activeKey ? (
                    renameInput()
                  ) : (
                    <span className="dep-title" title={toNew ?? activeLabel}>
                      {toNew ?? (activeLabel || (reconciling ? 'Checking…' : 'Not deployed yet'))}
                    </span>
                  )}
                  {activeDep && !toNew && renamingKey !== activeKey && (
                    <button
                      type="button"
                      className="dep-ico"
                      title="Rename this deployment"
                      aria-label="Rename this deployment"
                      onClick={() => startRename(activeDep)}
                    >
                      <Codicon name="edit" />
                    </button>
                  )}
                </div>
                <div className="dep-status">
                  <StatusDot status={status} />
                  <span>{statusText}</span>
                </div>

                {running && meter && (
                  <div className="dep-running">
                    <div
                      className="dep-bar"
                      role="progressbar"
                      aria-label="Deploy progress"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={percent ?? 0}
                    >
                      <span style={{ width: `${Math.max(2, percent ?? 0)}%` }} />
                    </div>
                    <span className="dep-step">{meterStepLabel(meter)}</span>
                    {onWatch && (
                      <div className="dep-actions">
                        <button type="button" className="btn btn--sm" onClick={leave(onWatch)}>
                          Watch
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {status === 'err' && (
                  <div className="dep-callout">
                    <span className="dep-callout-text">
                      The last deploy didn&apos;t finish.
                      {failure && <span className="dep-callout-detail">{failure}</span>}
                    </span>
                    {onDiagnose && (
                      <div className="dep-actions">
                        <button type="button" className="btn btn--sm btn--primary" onClick={leave(onDiagnose)}>
                          <Codicon name="comment-discussion" />
                          Find out why
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {waiting && (
                  <div className="dep-callout">
                    <span className="dep-callout-text">
                      {files ? (
                        <>
                          <strong>{plural(files, 'file')}</strong> changed since {name} was deployed.
                        </>
                      ) : (
                        <>Your latest changes aren&apos;t on {name} yet.</>
                      )}
                    </span>
                    <div className="dep-actions">
                      <button type="button" className="btn btn--sm btn--primary" onClick={leave(onRedeploy)}>
                        {action.label}
                      </button>
                      {onShowChanges && (
                        <button type="button" className="btn btn--sm btn--ghost" onClick={leave(onShowChanges)}>
                          See what changed
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div className="dep-sec">
                <dl className="dep-facts">
                  {appUrl && (
                    <>
                      <dt>App</dt>
                      <dd>
                        <span className="dep-url" title={appUrl}>
                          {hostOf(appUrl)}
                        </span>
                        <button
                          type="button"
                          className="dep-ico"
                          title={copied ? 'Copied' : 'Copy link'}
                          aria-label={copied ? 'Copied' : 'Copy link'}
                          onClick={() => void copyLink(appUrl)}
                        >
                          <Codicon name={copied ? 'check' : 'copy'} />
                        </button>
                        <button
                          type="button"
                          className="dep-ico"
                          title="Open in your browser"
                          aria-label="Open in your browser"
                          onClick={() => void window.api.openExternal(appUrl)}
                        >
                          <Codicon name="link-external" />
                        </button>
                      </dd>
                    </>
                  )}
                  {shownWorkspace && (
                    <>
                      <dt>Workspace</dt>
                      <dd>
                        <span className="dep-val" title={shownWorkspace}>
                          {shownWorkspace}
                          {workspaceMeta(workspace) && <span className="dep-dim"> · {workspaceMeta(workspace)}</span>}
                        </span>
                        {workspaceLink && (
                          <button
                            type="button"
                            className="dep-ico"
                            title="Open the workspace in Fabric"
                            aria-label="Open the workspace in Fabric"
                            onClick={() => void window.api.openExternal(workspaceLink)}
                          >
                            <Codicon name="link-external" />
                          </button>
                        )}
                      </dd>
                    </>
                  )}
                  <dt>Account</dt>
                  <dd>
                    {account ? (
                      <>
                        <span className="dep-val" title={[account.user, account.tenant].filter(Boolean).join(' · ')}>
                          {account.user ?? 'Your Fabric account'}
                          {account.tenant && <span className="dep-dim"> · {account.tenant}</span>}
                        </span>
                        {onManageAccounts && (
                          <button type="button" className="link-btn dep-link-btn" onClick={leave(onManageAccounts)}>
                            Change
                          </button>
                        )}
                      </>
                    ) : (
                      <>
                        <span className="dep-val dep-dim">Not signed in to Fabric</span>
                        {onSignIn && (
                          <button type="button" className="link-btn dep-link-btn" onClick={leave(onSignIn)}>
                            Sign in
                          </button>
                        )}
                      </>
                    )}
                  </dd>
                </dl>
              </div>

              {others.length > 0 && (
                <div className="dep-sec">
                  <span className="dep-sec-title">Other deployments</span>
                  <ul className="dep-list">
                    {others.map((d) => {
                      const key = d.workspaceId ?? d.workspaceName
                      const meta = [
                        d.workspaceName,
                        workspaceById(d.workspaceId)?.sku,
                        d.deployedAt ? `deployed ${timeAgo(d.deployedAt, now)}` : undefined
                      ]
                        .filter(Boolean)
                        .join(' · ')
                      return (
                        <li key={key} className="dep-row">
                          <StatusDot status="ok" />
                          <span className="dep-row-main">
                            {renamingKey === key ? (
                              renameInput()
                            ) : (
                              <span className="dep-row-name">{d.name || d.workspaceName}</span>
                            )}
                            <span className="dep-row-sub" title={meta}>
                              {meta}
                            </span>
                          </span>
                          {renamingKey !== key && (
                            <button
                              type="button"
                              className="dep-ico dep-row-edit"
                              title="Rename this deployment"
                              aria-label={`Rename ${d.name || d.workspaceName}`}
                              onClick={() => startRename(d)}
                            >
                              <Codicon name="edit" />
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn--xs btn--ghost"
                            disabled={Boolean(switching) || running}
                            title={`Preview and deploy to ${d.name || d.workspaceName}`}
                            onClick={() => void doSwitch(d)}
                          >
                            {switching === key ? 'Switching…' : 'Switch'}
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}

              {autoDeploy && (
                <div className="dep-sec">
                  <label className="dep-toggle">
                    <span className="dep-toggle-text">
                      <span className="dep-toggle-title">Deploy after each chat turn</span>
                      <span className="dep-toggle-hint">
                        {autoDeploy.on
                          ? 'When a turn changes your app, it deploys as the turn finishes.'
                          : 'Changes stay on this computer, showing in the preview, until you deploy them.'}
                      </span>
                    </span>
                    <span className={`switch${autoDeploy.on ? ' switch--on' : ''}`}>
                      <input
                        type="checkbox"
                        checked={autoDeploy.on}
                        onChange={(e) => autoDeploy.onChange(e.target.checked)}
                      />
                      <span className="switch-knob" />
                    </span>
                  </label>
                </div>
              )}

              <div className="dep-sec dep-foot">
                <button type="button" className="dep-new" onClick={startCreate} disabled={running}>
                  <Codicon name="add" />
                  New deployment…
                </button>
              </div>
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
