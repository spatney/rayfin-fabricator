import { useEffect, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import type {
  DeployResult,
  FabricDeployment,
  FabricWorkspace,
  FabricWorkspacesResult,
  PendingChanges,
  StudioProject,
  UnsupportedWorkspace
} from '@shared/ipc'
import { useSuppressPreview } from '../overlay'
import { useToast } from '../toast'
import { authErrorMessage } from '../authErrors'
import {
  REGION_AVAILABILITY_URL,
  fabricItemUrl,
  fabricWorkspaceUrl,
  publishedItem
} from '../fabric'
import { clockLabel, meterStepLabel, useDeployMeter } from '../deployMeter'
import { Trans, useTranslation } from '../i18n'
import { Codicon } from './icons'
import DeploymentCreateForm, { checkActiveDeployTarget } from './DeploymentCreateForm'
import ShareDeploymentModal from './ShareDeploymentModal'
import type { DeployUiState } from './PreviewPane'
import { timeAgo, useNow } from './team/runProgress'

interface Props {
  project: StudioProject
  /** True while a `rayfin up` is streaming for this project. */
  running: boolean
  /** Copilot is mid-turn in this project, which holds its source: deploys wait for the turn. */
  chatBusy?: boolean
  /** The project's deploy: its log and start while it runs, and how the last one ended. */
  deploy?: DeployUiState
  /** True while the recorded deployment is being reconciled with on-disk state. */
  reconciling?: boolean
  /** What the next deploy would ship; `null` or absent while it isn't known. */
  pending?: PendingChanges | null
  /** A deploy running to a new deployment, by its name: shown instead of the active one's until it's done. */
  deployingTo?: string
  /** Remember a friendly name for the chosen workspace, then deploy into it: into
   *  its existing app `itemName` when one was chosen. */
  onCreate: (name: string, workspaceId: string, workspaceName?: string, itemName?: string) => void
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
  /**
   * Set by an outside caller (the failed-publish notice's Choose another
   * workspace) to open the workspace picker for this project. Honoured on mount
   * too, and reported back through `onChooseRequestHandled` so the caller drops it.
   */
  chooseRequest?: { projectId: string; nonce: number } | null
  /** The `chooseRequest` with this nonce has been acted on. */
  onChooseRequestHandled?: (nonce: number) => void
  /** Workspaces Fabric turned down an app in this session: the workspace picker marks them. */
  refused?: readonly UnsupportedWorkspace[]
  /** The workspaces your apps use, most recent first: the workspace picker lists them first. */
  recentWorkspaces?: readonly string[]
  /**
   * Whether chat turns publish the app as they finish; off, the default, the
   * user publishes when they choose (see `publishesAfterTurn`).
   */
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

/** Workspace ids (or names) compare without case. */
function sameWorkspace(a?: string, b?: string): boolean {
  return Boolean(a?.trim() && b?.trim() && a.trim().toLowerCase() === b.trim().toLowerCase())
}

/** Host-only label for an app's address (the full URL is in the tooltip). */
function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/** Most recently deployed first. */
function byDeployedAt(a: FabricDeployment, b: FabricDeployment): number {
  return (Date.parse(b.deployedAt ?? '') || 0) - (Date.parse(a.deployedAt ?? '') || 0)
}

/**
 * The publish control in the app bar: what state the app's published copy is in
 * on the left, the one thing to do about it on the right, lit only when it
 * matters (changes waiting, a failed publish, nothing published yet). Share sits
 * apart from it: it's about people, not publishing.
 *
 * The panel the state opens is the published app's details: how it is and since
 * when, its address, workspace and account, the project's other published apps,
 * whether chat turns publish, and Publish to another workspace. It opens straight
 * away from what Fabricator knows, refreshes behind, and never starts a sign-in
 * by itself.
 */
export default function DeploymentsControl({
  project,
  running,
  chatBusy = false,
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
  chooseRequest,
  onChooseRequestHandled,
  refused,
  recentWorkspaces,
  autoDeploy,
  onDiagnose,
  onWatch,
  onShowChanges,
  onOpen
}: Props): JSX.Element {
  const { t } = useTranslation('publish')
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
  /** The published app (by key) whose Delete is asking to be confirmed. */
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  /** The published app (by key) being deleted. */
  const [deleting, setDeleting] = useState<string | null>(null)
  const [renamingKey, setRenamingKey] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [sharing, setSharing] = useState<FabricDeployment | null>(null)
  /** Share was clicked and the deployment it targets is still loading. */
  const [openingShare, setOpeningShare] = useState(false)
  /** What was just copied: the app's link or its item's id. */
  const [copied, setCopied] = useState<'link' | 'item' | null>(null)
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
        toast.error(authErrorMessage(reason, t('control.errors.loadApps')), {
          title: t('control.errors.appCheck')
        })
      }
    }
  }

  /**
   * List the Fabric workspaces. `signIn`: a missing or expired Fabric session
   * signs in again once and retries, so publishing to a workspace doesn't need a
   * manual sign-out and back in. Only picking a workspace to publish to asks for
   * that; the details look quietly and do without.
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
          const error = authErrorMessage(login.error, t('signIn.incomplete'))
          res = { ...res, error }
          toast.error(error, { title: t('signIn.failed') })
        }
      }
      if (seq === wsSeqRef.current) {
        for (const w of res.ok ? (res.workspaces ?? []) : []) workspaceDetails.set(w.id.toLowerCase(), w)
        setWsResult(res)
      }
    } catch (reason) {
      if (seq === wsSeqRef.current) {
        const error = authErrorMessage(reason, t('control.errors.loadWorkspaces'))
        setWsResult({ ok: false, needsLogin, error })
        if (signIn) {
          toast.error(error, {
            title: needsLogin ? t('signIn.failed') : t('control.errors.workspaceCheck')
          })
        }
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
      setConfirmDelete(null)
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
  const lastOutcome = deploy?.result ? deploy.result.outcome : project.lastDeploy?.outcome
  /** Fabric turned the last publish down: Fabric apps aren't available in the workspace it went to. */
  const turnedDown = !running && lastOutcome === 'workspace-unsupported'
  const turnedDownIn = turnedDown ? deploy?.result?.unsupported : undefined
  // Fabric created nothing there, so the app is back on the workspace it
  // published to before, if any, which is as it was: not failed.
  const elsewhere = Boolean(turnedDownIn?.id) && !sameWorkspace(turnedDownIn?.id, project.workspace)
  const failed =
    !running &&
    (deploy?.result ? !deploy.result.ok : project.lastDeploy?.status === 'error') &&
    !(turnedDown && elsewhere)
  const meter = useDeployMeter(project.id, deploy?.log, deploy?.startedAt, running)
  const percent = meter ? Math.round(meter.fraction * 100) : null
  const files = pending?.changed ? pending.files : undefined
  const waiting = Boolean(pending?.changed) && hasDeployment && !running && !failed
  const now = useNow(open)

  /** Publishing to a new workspace: the control is named for that one until it's done. */
  const toNew = running && deployingTo ? deployingTo : undefined
  const name = toNew ?? (activeLabel || t('control.yourApp'))
  const status: Status =
    running || (reconciling && !hasDeployment) ? 'busy' : !hasDeployment ? 'none' : failed ? 'err' : 'ok'
  const label =
    toNew ?? (activeLabel || (reconciling ? t('status.checking') : t('control.notPublished')))
  const deployedAt = activeDep?.deployedAt
  const workspaceId =
    activeDep?.workspaceId ?? (fabricWorkspaceUrl(project.workspace) ? project.workspace : undefined)
  const workspaceName = activeDep?.workspaceName ?? project.workspaceName
  const workspace = workspaceById(workspaceId)
  const workspaceLink = fabricWorkspaceUrl(workspaceId)
  // The address and workspace are the active deployment's: not yet the new one's.
  const appUrl = toNew ? undefined : activeDep?.hostingUrl || project.lastDeploy?.url || activeDep?.apiUrl
  const shownWorkspace = toNew ? undefined : workspaceName
  // Its item in Fabric: the active deployment's, or the one `rayfin up` linked to. For the
  // same item, that link wins: it opens the item in its tenant (`ctid`).
  const recordedItem = publishedItem(project)
  const itemId = toNew ? undefined : activeDep?.itemId?.trim() || recordedItem?.id
  const itemLink = toNew
    ? undefined
    : recordedItem && recordedItem.id.toLowerCase() === itemId?.toLowerCase()
      ? recordedItem.url
      : fabricItemUrl(workspaceId, itemId)
  const others = (deployments ?? []).filter((d) => !d.active).sort(byDeployedAt)

  function openCreate(): void {
    setOpen(true)
    startCreate()
  }

  function startCreate(): void {
    setCreating(true)
    if (!wsResult?.ok) void loadWorkspaces(true)
  }

  /** A chat turn holds the project's source, so a publish started now could only fail. */
  const held = chatBusy && !running
  const heldTitle = t('control.held.publish')
  const deletingTitle = t('control.held.deleting')
  /** Why a published app can't be deleted just now: publishing and chat turns hold the project. */
  const deleteWait = running
    ? t('control.held.deleteWhilePublishing')
    : held
      ? t('control.held.delete')
      : undefined

  /** What the button beside the state does now. */
  const nextAction: {
    label: string
    title: string
    primary: boolean
    disabled?: boolean
    run: () => void
  } = running
    ? {
        label:
          percent === null
            ? t('button.publishing')
            : t('control.next.publishingPercent', { percent }),
        title: t('control.next.publishingTitle'),
        primary: false,
        run: () => setOpen(true)
      }
    : !hasDeployment
      ? {
          label: t('button.publish'),
          title: t('control.next.publishTitle'),
          primary: true,
          disabled: reconciling,
          run: openCreate
        }
      : failed
        ? turnedDown
          ? {
              label: t('control.next.chooseWorkspace'),
              title: t('control.next.chooseWorkspaceTitle'),
              primary: true,
              run: openCreate
            }
          : {
              label: t('actions.tryAgain'),
              title: t('control.next.again', { name }),
              primary: true,
              run: onRedeploy
            }
        : waiting
          ? {
              label: files
                ? t('control.next.publishChanges', { count: files })
                : t('control.next.publishSomeChanges'),
              title: files
                ? t('control.next.filesChanged', { count: files, name })
                : t('control.next.changesWaiting', { name }),
              primary: true,
              run: onRedeploy
            }
          : {
              label: t('button.publish'),
              title: pending
                ? t('control.next.upToDate', { name })
                : t('control.next.again', { name }),
              primary: false,
              run: onRedeploy
            }
  const action = held
    ? { ...nextAction, disabled: true, title: heldTitle }
    : deleting && !running
      ? { ...nextAction, disabled: true, title: deletingTitle }
      : nextAction

  const chipState = running
    ? t('control.chip.publishing', { name })
    : !hasDeployment
      ? reconciling
        ? t('control.checkingForApp')
        : t('control.chip.none')
      : failed
        ? t('control.chip.failed', { name })
        : workspaceName && workspaceName !== name
          ? t('control.chip.liveIn', { name, workspace: workspaceName })
          : t('control.chip.live', { name })
  // When chat turns publish, the chip says so without opening the panel: "· Auto".
  // Off, the default, goes unsaid.
  const modeNote = autoDeploy && hasDeployment && autoDeploy.on ? t('control.chip.auto') : null
  const chipTitle = autoDeploy
    ? `${chipState}\n${autoDeploy.on ? t('control.chip.autoOn') : t('control.chip.autoOff')}`
    : chipState

  const statusText = running
    ? meter
      ? `${t('progress.publishing')} · ${t('progress.position', { step: meter.step, steps: meter.steps })} · ${clockLabel(meter.elapsed)}`
      : t('button.publishing')
    : !hasDeployment
      ? reconciling
        ? t('control.checkingForApp')
        : t('control.notPublishedYet')
      : failed
        ? `${t('control.status.failed')}${project.lastDeploy?.at ? ` · ${timeAgo(project.lastDeploy.at, now)}` : ''}`
        : deployedAt
          ? t('control.status.publishedWhen', { when: timeAgo(deployedAt, now) })
          : t('control.status.published')
  const failure = (deploy?.result?.error ?? project.lastDeploy?.error ?? '')
    .trim()
    .split('\n')[0]
    // The CLI's own "❌ Deployment failed:" adds nothing to "Publishing didn't finish".
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
        toast.error(
          authErrorMessage(
            result.error,
            result.outcome === 'not-signed-in'
              ? t('control.switchError.signIn')
              : t('control.switchError.failed')
          ),
          { title: t('control.switchError.title') }
        )
        return
      }
      await loadDeployments()
    } catch (reason) {
      toast.error(authErrorMessage(reason, t('control.switchError.failed')), {
        title: t('control.switchError.title')
      })
    } finally {
      setSwitching(null)
    }
  }

  function startRename(d: FabricDeployment): void {
    setRenamingKey(d.workspaceId ?? d.workspaceName)
    setRenameValue(d.name ?? '')
  }

  /**
   * Delete a published app: in Fabric, with its data, then from the project. A
   * missing or expired Fabric session signs in again once and retries.
   */
  async function doDelete(d: FabricDeployment): Promise<void> {
    const key = d.workspaceId ?? d.workspaceName
    if (!key || deleteWait || deleting) return
    const shown = d.name || d.workspaceName
    const failed = (reason: unknown): void => {
      toast.error(authErrorMessage(reason, t('control.delete.failed', { name: shown })), {
        title: t('control.delete.failedTitle')
      })
    }
    setDeleting(key)
    try {
      let result = await window.api.deploy.remove(project.id, key)
      if (!result.ok && result.needsLogin) {
        const login = await window.api.auth.loginRayfin()
        if (!login.ok) {
          toast.error(authErrorMessage(login.error, t('signIn.incomplete')), {
            title: t('signIn.failed')
          })
          return
        }
        await onSignedIn?.()
        result = await window.api.deploy.remove(project.id, key)
      }
      if (!result.ok) {
        failed(result.error)
        return
      }
      setConfirmDelete(null)
      toast.success(t('control.delete.done', { name: shown }))
      onChanged()
      await loadDeployments()
    } catch (reason) {
      failed(reason)
    } finally {
      setDeleting(null)
    }
  }

  /**
   * Asks before deleting `d`. `then` is what the project publishes to afterwards:
   * for the app it publishes to now, the most recently published of the others.
   */
  function deleteConfirm(d: FabricDeployment, then?: FabricDeployment | null): JSX.Element {
    const shown = d.name || d.workspaceName
    const inWorkspace = workspaceById(d.workspaceId)?.displayName || d.workspaceName
    const removing = deleting === (d.workspaceId ?? d.workspaceName)
    const after =
      then === undefined
        ? t('control.delete.keep')
        : then
          ? t('control.delete.keepThen', { name: then.name || then.workspaceName })
          : t('control.delete.keepUnpublished')
    return (
      <div className="dep-callout" role="alert">
        <span className="dep-callout-text">
          <Trans
            t={t}
            i18nKey="control.delete.confirm"
            values={{ name: shown, workspace: inWorkspace }}
            components={{ strong: <strong /> }}
          />
          <span className="dep-callout-detail">{t('control.delete.detail', { after })}</span>
        </span>
        <div className="dep-actions">
          <button
            type="button"
            className="btn btn--sm btn--danger"
            disabled={Boolean(deleting || deleteWait)}
            title={deleteWait}
            onClick={() => void doDelete(d)}
          >
            {removing ? t('status.deleting') : t('actions.delete')}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            disabled={removing}
            onClick={() => setConfirmDelete(null)}
          >
            {t('actions.cancel')}
          </button>
        </div>
      </div>
    )
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

  async function copyText(text: string, what: 'link' | 'item'): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(what)
      window.clearTimeout(copiedTimer.current)
      copiedTimer.current = window.setTimeout(() => setCopied(null), 1200)
    } catch {
      toast.error(what === 'link' ? t('copy.linkFailed') : t('copy.itemFailed'), {
        title: t('copy.failed')
      })
    }
  }

  /** Open the Share dialog for the active published app. When the list isn't loaded
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
        toast.error(t('control.share.nothing'), {
          title: t('control.share.nothingTitle')
        })
        return
      }
      setOpen(false)
      setSharing(target)
    } catch (reason) {
      if (projectIdRef.current !== projectId) return
      toast.error(authErrorMessage(reason, t('control.share.loadFailed')), {
        title: t('control.errors.appCheck')
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

  // The failed-publish notice asked for the workspace picker. Like a share
  // request, it's reported handled at once. The picker opens once the click that
  // asked for it is over: opened during it, that click would go on to reach the
  // window and close the panel again.
  const openCreateRef = useRef(openCreate)
  openCreateRef.current = openCreate
  const onChooseHandledRef = useRef(onChooseRequestHandled)
  onChooseHandledRef.current = onChooseRequestHandled
  const handledChooseRef = useRef<number | null>(null)
  const chooseTimer = useRef(0)
  useEffect(() => {
    if (!chooseRequest || chooseRequest.projectId !== project.id) return
    if (handledChooseRef.current === chooseRequest.nonce) return
    handledChooseRef.current = chooseRequest.nonce
    onChooseHandledRef.current?.(chooseRequest.nonce)
    window.clearTimeout(chooseTimer.current)
    chooseTimer.current = window.setTimeout(() => openCreateRef.current(), 0)
  }, [chooseRequest, project.id])
  useEffect(() => () => window.clearTimeout(chooseTimer.current), [])

  /** Leave the panel, then do `then`. */
  const leave = (then: () => void) => (): void => {
    setOpen(false)
    then()
  }

  function renameInput(): JSX.Element {
    return (
      <input
        className="ws-input dep-rename"
        aria-label={t('control.renameLabel')}
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
  /** The first publish picks a workspace; later ones add another. */
  const createTitle = hasDeployment ? t('control.create.another') : t('control.create.first')

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
          <span className="sr-only">{t('control.chip.label')}</span>
          <span className="dep-chip-label">{label}</span>
          {status === 'err' ? (
            <span className="dep-chip-note">· {t('control.chip.failedNote')}</span>
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
            title={openingShare ? t('control.share.opening') : t('control.share.title')}
            onClick={() => void openShareForActive()}
          >
            {openingShare ? (
              <Codicon name="loading" className="codicon-modifier-spin" />
            ) : (
              <Codicon name="person-add" />
            )}
            <span className="dep-share-label">{t('share.share')}</span>
          </button>
        </div>
      )}

      {open && (
        <div
          className="dep-pop"
          role="dialog"
          aria-label={creating ? createTitle : t('control.panel')}
        >
          {creating ? (
            <div className="dep-sec">
              <span className="dep-pop-title">{createTitle}</span>
              {account && (
                <div className="dep-account">
                  <span
                    className="dep-account-text"
                    title={[account.user, account.tenant].filter(Boolean).join(' · ')}
                  >
                    <Trans
                      t={t}
                      i18nKey="control.publishesAs"
                      values={{ user: account.user ?? t('control.yourAccountInSentence') }}
                      components={{ strong: <strong /> }}
                    />
                    {account.tenant ? ` · ${account.tenant}` : ''}
                  </span>
                  {onManageAccounts && (
                    <button type="button" className="link-btn dep-account-change" onClick={leave(onManageAccounts)}>
                      {t('control.change')}
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
                onSubmit={(depName, workspaceId, itemName) => {
                  onCreate(depName, workspaceId, workspaceById(workspaceId)?.displayName, itemName)
                  setOpen(false)
                  setCreating(false)
                }}
                checkTarget={checkActiveDeployTarget}
                recentWorkspaces={recentWorkspaces}
                refused={refused}
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
                      {toNew ??
                        (activeLabel ||
                          (reconciling ? t('status.checking') : t('control.notPublishedYet')))}
                    </span>
                  )}
                  {activeDep && !toNew && renamingKey !== activeKey && (
                    <span className="dep-title-actions">
                      <button
                        type="button"
                        className="dep-ico"
                        title={t('control.rename')}
                        aria-label={t('control.rename')}
                        onClick={() => startRename(activeDep)}
                      >
                        <Codicon name="edit" />
                      </button>
                      <button
                        type="button"
                        className="dep-ico"
                        title={deleteWait ?? t('control.delete.title')}
                        aria-label={t('control.delete.title')}
                        disabled={Boolean(deleting || deleteWait)}
                        onClick={() => setConfirmDelete(activeKey)}
                      >
                        <Codicon name="trash" />
                      </button>
                    </span>
                  )}
                </div>
                <div className="dep-status">
                  <StatusDot status={status} />
                  <span>{statusText}</span>
                </div>
                {activeDep &&
                  !toNew &&
                  confirmDelete === activeKey &&
                  deleteConfirm(activeDep, others[0] ?? null)}

                {running && meter && (
                  <div className="dep-running">
                    <div
                      className="dep-bar"
                      role="progressbar"
                      aria-label={t('progress.label')}
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
                          {t('progress.watch')}
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {turnedDown ? (
                  <div className="dep-callout">
                    <span className="dep-callout-text">
                      {turnedDownIn?.name
                        ? t('control.turnedDown.named', { name: turnedDownIn.name })
                        : t('control.turnedDown.unnamed')}
                      <span className="dep-callout-detail">
                        {turnedDownIn?.region
                          ? t('control.turnedDown.region', { region: turnedDownIn.region })
                          : t('control.turnedDown.noRegion')}
                      </span>
                    </span>
                    <div className="dep-actions">
                      <button
                        type="button"
                        className="btn btn--sm btn--primary"
                        disabled={held}
                        title={held ? heldTitle : undefined}
                        onClick={startCreate}
                      >
                        {t('region.chooseAnother')}
                      </button>
                      <button
                        type="button"
                        className="btn btn--sm btn--ghost"
                        title={t('region.availabilityTitle')}
                        onClick={() => void window.api.openExternal(REGION_AVAILABILITY_URL)}
                      >
                        <Codicon name="link-external" />
                        {t('region.availability')}
                      </button>
                    </div>
                  </div>
                ) : (
                  status === 'err' && (
                    <div className="dep-callout">
                      <span className="dep-callout-text">
                        {t('control.failedCallout')}
                        {failure && <span className="dep-callout-detail">{failure}</span>}
                      </span>
                      {onDiagnose && (
                        <div className="dep-actions">
                          <button
                            type="button"
                            className="btn btn--sm btn--primary"
                            onClick={leave(onDiagnose)}
                          >
                            <Codicon name="comment-discussion" />
                            {t('findOutWhy')}
                          </button>
                        </div>
                      )}
                    </div>
                  )
                )}

                {waiting && (
                  <div className="dep-callout">
                    <span className="dep-callout-text">
                      {files ? (
                        <Trans
                          t={t}
                          i18nKey="control.waiting.files"
                          count={files}
                          values={{ name }}
                          components={{ strong: <strong /> }}
                        />
                      ) : (
                        t('control.waiting.changes', { name })
                      )}
                    </span>
                    <div className="dep-actions">
                      <button
                        type="button"
                        className="btn btn--sm btn--primary"
                        disabled={held}
                        title={held ? heldTitle : undefined}
                        onClick={leave(onRedeploy)}
                      >
                        {action.label}
                      </button>
                      {onShowChanges && (
                        <button type="button" className="btn btn--sm btn--ghost" onClick={leave(onShowChanges)}>
                          {t('control.seeChanges')}
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
                      <dt>{t('control.facts.app')}</dt>
                      <dd>
                        <span className="dep-url" title={appUrl}>
                          {hostOf(appUrl)}
                        </span>
                        <button
                          type="button"
                          className="dep-ico"
                          title={copied === 'link' ? t('actions.copied') : t('copy.link')}
                          aria-label={copied === 'link' ? t('actions.copied') : t('copy.link')}
                          onClick={() => void copyText(appUrl, 'link')}
                        >
                          <Codicon name={copied === 'link' ? 'check' : 'copy'} />
                        </button>
                        <button
                          type="button"
                          className="dep-ico"
                          title={t('control.openInBrowser')}
                          aria-label={t('control.openInBrowser')}
                          onClick={() => void window.api.openExternal(appUrl)}
                        >
                          <Codicon name="link-external" />
                        </button>
                      </dd>
                    </>
                  )}
                  {itemLink && itemId && (
                    <>
                      <dt>{t('control.facts.item')}</dt>
                      <dd>
                        <span className="dep-val dep-id" title={itemId}>
                          {itemId}
                        </span>
                        <button
                          type="button"
                          className="dep-ico"
                          title={copied === 'item' ? t('actions.copied') : t('copy.itemId')}
                          aria-label={copied === 'item' ? t('actions.copied') : t('copy.itemId')}
                          onClick={() => void copyText(itemId, 'item')}
                        >
                          <Codicon name={copied === 'item' ? 'check' : 'copy'} />
                        </button>
                        <button
                          type="button"
                          className="dep-ico"
                          title={t('control.openInFabric')}
                          aria-label={t('control.openInFabric')}
                          onClick={() => void window.api.openExternal(itemLink)}
                        >
                          <Codicon name="link-external" />
                        </button>
                      </dd>
                    </>
                  )}
                  {shownWorkspace && (
                    <>
                      <dt>{t('control.facts.workspace')}</dt>
                      <dd>
                        <span className="dep-val" title={shownWorkspace}>
                          {shownWorkspace}
                          {workspaceMeta(workspace) && <span className="dep-dim"> · {workspaceMeta(workspace)}</span>}
                        </span>
                        {workspaceLink && (
                          <button
                            type="button"
                            className="dep-ico"
                            title={t('control.openWorkspace')}
                            aria-label={t('control.openWorkspace')}
                            onClick={() => void window.api.openExternal(workspaceLink)}
                          >
                            <Codicon name="link-external" />
                          </button>
                        )}
                      </dd>
                    </>
                  )}
                  <dt>{t('control.facts.account')}</dt>
                  <dd>
                    {account ? (
                      <>
                        <span className="dep-val" title={[account.user, account.tenant].filter(Boolean).join(' · ')}>
                          {account.user ?? t('control.yourAccount')}
                          {account.tenant && <span className="dep-dim"> · {account.tenant}</span>}
                        </span>
                        {onManageAccounts && (
                          <button type="button" className="link-btn dep-link-btn" onClick={leave(onManageAccounts)}>
                            {t('control.change')}
                          </button>
                        )}
                      </>
                    ) : (
                      <>
                        <span className="dep-val dep-dim">{t('control.notSignedIn')}</span>
                        {onSignIn && (
                          <button type="button" className="link-btn dep-link-btn" onClick={leave(onSignIn)}>
                            {t('actions.signIn')}
                          </button>
                        )}
                      </>
                    )}
                  </dd>
                </dl>
              </div>

              {others.length > 0 && (
                <div className="dep-sec">
                  <span className="dep-sec-title">{t('control.others')}</span>
                  <ul className="dep-list">
                    {others.map((d) => {
                      const key = d.workspaceId ?? d.workspaceName
                      const meta = [
                        d.workspaceName,
                        workspaceById(d.workspaceId)?.sku,
                        d.deployedAt
                          ? t('control.publishedAgo', { when: timeAgo(d.deployedAt, now) })
                          : undefined
                      ]
                        .filter(Boolean)
                        .join(' · ')
                      return (
                        <li key={key} className="dep-item">
                          <div className="dep-row">
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
                                title={t('control.rename')}
                                aria-label={t('control.renameNamed', {
                                  name: d.name || d.workspaceName
                                })}
                                onClick={() => startRename(d)}
                              >
                                <Codicon name="edit" />
                              </button>
                            )}
                            {renamingKey !== key && (
                              <button
                                type="button"
                                className="dep-ico dep-row-edit"
                                title={deleteWait ?? t('control.delete.title')}
                                aria-label={t('control.delete.named', {
                                  name: d.name || d.workspaceName
                                })}
                                disabled={Boolean(deleting || deleteWait)}
                                onClick={() => setConfirmDelete(key)}
                              >
                                <Codicon name="trash" />
                              </button>
                            )}
                            <button
                              type="button"
                              className="btn btn--xs btn--ghost"
                              disabled={Boolean(switching) || Boolean(deleting) || running || held}
                              title={
                                held
                                  ? heldTitle
                                  : t('control.switchTitle', { name: d.name || d.workspaceName })
                              }
                              onClick={() => void doSwitch(d)}
                            >
                              {switching === key ? t('control.switching') : t('control.switch')}
                            </button>
                          </div>
                          {confirmDelete === key && deleteConfirm(d)}
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
                      <span className="dep-toggle-title">{t('control.auto.title')}</span>
                      <span className="dep-toggle-hint">
                        {autoDeploy.on ? t('control.auto.on') : t('control.auto.off')}
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
                <button
                  type="button"
                  className="dep-new"
                  onClick={startCreate}
                  disabled={running || held || Boolean(deleting)}
                  title={held ? heldTitle : deleting ? deletingTitle : undefined}
                >
                  <Codicon name="add" />
                  {hasDeployment
                    ? t('control.create.anotherButton')
                    : t('control.create.firstButton')}
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
