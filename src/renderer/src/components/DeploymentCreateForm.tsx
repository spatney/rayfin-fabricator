import { useEffect, useRef, useState, type JSX } from 'react'
import { Codicon } from './icons'
import { authErrorMessage } from '../authErrors'
import { REGION_AVAILABILITY_URL, refusalFor, refusedRegions, type Refusal } from '../fabric'
import { Trans, formatList, translator, useTranslation } from '../i18n'
import type {
  DeployTargetCheck,
  FabricCapacity,
  FabricWorkspace,
  FabricWorkspacesResult,
  UnsupportedWorkspace
} from '@shared/ipc'

/** Where to send users who have no Fabric/Premium capacity yet. */
const TRIAL_URL = 'https://learn.microsoft.com/fabric/fundamentals/fabric-trial'
const BUY_URL = 'https://learn.microsoft.com/fabric/enterprise/buy-subscription'

const NO_REFUSALS: readonly UnsupportedWorkspace[] = []

/**
 * `checkTarget` for deploying the active project. A module-level function, so
 * it's stable across renders and the picker checks once per selection.
 */
export function checkActiveDeployTarget(workspaceId: string): Promise<DeployTargetCheck> {
  return window.api.fabric.checkDeployTarget(workspaceId)
}

/**
 * Once the list grows past this, surface a search box to narrow it. Search spans
 * ALL workspaces (including ineligible ones) so a workspace a user expects to
 * find is always reachable, even when it can't be selected.
 */
const SEARCH_THRESHOLD = 10

/** How many of the workspaces your apps use most recently are listed first. */
const RECENT_LIMIT = 5

/** "F-SKU · F2" style label for a workspace's capacity. */
function skuText(w: FabricWorkspace): string {
  if (w.capacityKind === 'unknown') return translator('publish')('create.unknownSku')
  const fam = w.capacityKind === 'fabric' ? 'F-SKU' : w.capacityKind === 'premium' ? 'P-SKU' : ''
  return fam + (w.sku ? ` · ${w.sku}` : '')
}

/** Tooltip for a workspace's capacity chip. */
function skuTitle(w: FabricWorkspace): string | undefined {
  if (w.capacityKind === 'unknown') {
    return translator('publish')('create.unknownSkuTitle')
  }
  return w.capacityName ? `${w.capacityName} (${w.sku})` : w.sku
}

/** Why a workspace can't host a Rayfin app — shown on greyed-out ineligible rows. */
function reasonFor(w: FabricWorkspace): string {
  const t = translator('publish')
  if (w.capacityKind === 'other') {
    return w.sku ? t('create.otherCapacitySku', { sku: w.sku }) : t('create.otherCapacity')
  }
  return t('create.noCapacity')
}

/** Why publishing to `w` will likely fail: Fabric turned down an app in it, on its capacity or in its region. */
function refusalText(w: FabricWorkspace, { refused, by }: Refusal): string {
  const t = translator('publish')
  return by === 'workspace'
    ? t('create.refusal.workspace', { workspace: w.displayName })
    : by === 'capacity'
      ? t('create.refusal.capacity')
      : t('create.refusal.region', { region: refused.region })
}

/** What the picker says about the workspaces Fabric turned apps down in. */
function refusedNote(refused: readonly UnsupportedWorkspace[]): string {
  const t = translator('publish')
  const regions = refusedRegions(refused)
  if (regions.length > 1) {
    return t('create.refusedNote.regions', { regions: formatList(regions, 'disjunction') })
  }
  if (regions.length === 1) {
    return t('create.refusedNote.region', { region: regions[0] })
  }
  return t('create.refusedNote.capacity')
}

interface Props {
  /** The signed-in user's Fabric workspaces (with capacity / eligibility info). */
  wsResult: FabricWorkspacesResult | null
  /** True while the workspace list is loading. */
  loadingWs: boolean
  /** True while re-signing-in after an expired session (shown during the reload). */
  reauthing?: boolean
  /** Re-fetch the workspace list (the error-state "Retry"). */
  onReload: () => Promise<void> | void
  /** Refresh app auth after sign-in; rejection prevents retrying with an unverified account. */
  onSignedIn?: () => Promise<void> | void
  /** True while a `rayfin up` is streaming (disables submit). */
  running?: boolean
  /** Primary button label (idle); "Publish" when omitted. */
  submitLabel?: string
  /** Primary button label while `running`; "Publishing…" when omitted. */
  busyLabel?: string
  /** Secondary button label; "Cancel" when omitted. */
  cancelLabel?: string
  /** Secondary action; the Cancel button is hidden when omitted. */
  onCancel?: () => void
  /** Submit: publish as `name` (friendly, may be empty) into `workspaceId`,
   *  into the existing app `itemName` there when one was chosen. */
  onSubmit: (name: string, workspaceId: string, itemName?: string) => void
  /** Pre-fill the (editable) published app's name — e.g. "Development" for a first publish. */
  defaultName?: string
  /**
   * Check a selected workspace for an app this publish would replace. While it
   * runs, Publish waits; a conflict needs an explicit "Replace it anyway".
   */
  checkTarget?: (workspaceId: string) => Promise<DeployTargetCheck>
  /** The workspaces your apps use, most recent first (ids, or names in older
   *  records). Eligible ones are listed first, under Recent. */
  recentWorkspaces?: readonly string[]
  /**
   * Workspaces Fabric turned down an app in ("The feature is not available").
   * They, and others on their capacity or in their region, are marked and
   * listed last, and publishing to one asks first.
   */
  refused?: readonly UnsupportedWorkspace[]
}

/**
 * The presentational "pick a workspace and publish" form, in the app bar's
 * publish popover: one consistent picker (eligible F-SKU/P-SKU list, greyed-out
 * ineligible rows with reasons, search, optional name, and the no-capacity /
 * error empty states).
 * It owns only its transient input state; the workspace data is supplied (and
 * cached) by the parent.
 */
export default function DeploymentCreateForm({
  wsResult,
  loadingWs,
  reauthing = false,
  onReload,
  onSignedIn,
  running = false,
  submitLabel,
  busyLabel,
  cancelLabel,
  onCancel,
  onSubmit,
  defaultName = '',
  checkTarget,
  recentWorkspaces,
  refused = NO_REFUSALS
}: Props): JSX.Element {
  const { t } = useTranslation('publish')
  const [name, setName] = useState(defaultName)
  const [wsQuery, setWsQuery] = useState('')
  const [selectedWs, setSelectedWs] = useState<string | null>(null)
  const [targetCheck, setTargetCheck] = useState<{ workspaceId: string; result?: DeployTargetCheck } | null>(null)
  /** The workspace whose same-named app the user agreed to replace. */
  const [replaceIn, setReplaceIn] = useState<string | null>(null)
  /** An existing app picked to publish into, in the workspace it's in. */
  const [appIn, setAppIn] = useState<{ workspaceId: string; name: string } | null>(null)
  /** A workspace Fabric turned down before that the user chose to publish to anyway. */
  const [tryIn, setTryIn] = useState<string | null>(null)
  const [showIneligible, setShowIneligible] = useState(false)
  // Inline "create a new workspace" sub-flow: pick a capacity + name.
  const [creatingWs, setCreatingWs] = useState(false)
  const [newWsName, setNewWsName] = useState('')
  const [caps, setCaps] = useState<FabricCapacity[] | null>(null)
  const [loadingCaps, setLoadingCaps] = useState(false)
  const [selectedCap, setSelectedCap] = useState<string>('')
  const [creatingBusy, setCreatingBusy] = useState(false)
  const [createErr, setCreateErr] = useState<string | null>(null)
  const [signingIn, setSigningIn] = useState(false)
  const [signInErr, setSignInErr] = useState<string | null>(null)
  const [authExpired, setAuthExpired] = useState(false)
  const loginSeqRef = useRef(0)
  const loginBusyRef = useRef(false)

  /** Fabric turned down an app on this capacity, or in its region. */
  function capacityRefusal(c: FabricCapacity): Refusal | undefined {
    return refusalFor({ id: '', capacityId: c.id, region: c.region }, refused)
  }

  useEffect(() => () => {
    ++loginSeqRef.current
  }, [])
  useEffect(() => {
    if (wsResult?.ok) setAuthExpired(false)
  }, [wsResult])

  useEffect(() => {
    if (!checkTarget || !selectedWs) {
      setTargetCheck(null)
      return
    }
    let stale = false
    setTargetCheck({ workspaceId: selectedWs })
    void (async () => {
      let result: DeployTargetCheck = {}
      try {
        result = await checkTarget(selectedWs)
      } catch {
        // A failed check never blocks the deploy.
      }
      if (!stale) setTargetCheck({ workspaceId: selectedWs, result })
    })()
    return () => {
      stale = true
    }
  }, [selectedWs, checkTarget])

  async function loadCaps(): Promise<void> {
    setLoadingCaps(true)
    setCreateErr(null)
    try {
      const res = await window.api.fabric.listCapacities()
      const list = res.ok && res.capacities ? res.capacities : []
      setCaps(list)
      setSelectedCap(
        list.find((c) => c.id === selectedCap)?.id ??
          list.find((c) => !capacityRefusal(c))?.id ??
          list[0]?.id ??
          ''
      )
      if (!res.ok) {
        setCreateErr(authErrorMessage(res.error, t('create.errors.capacities')))
        if (res.needsLogin) setAuthExpired(true)
      }
    } catch (reason) {
      setCaps([])
      setSelectedCap('')
      setCreateErr(authErrorMessage(reason, t('create.errors.capacities')))
    } finally {
      setLoadingCaps(false)
    }
  }

  function openCreateWs(): void {
    setCreatingWs(true)
    setCreateErr(null)
    if (!caps) void loadCaps()
  }

  async function submitNewWs(): Promise<void> {
    if (
      !selectedCap || !newWsName.trim() || creatingBusy || loadingCaps || !wsResult?.ok || authExpired
    ) return
    setCreatingBusy(true)
    setCreateErr(null)
    try {
      const res = await window.api.fabric.createWorkspace(newWsName.trim(), selectedCap)
      if (!res.ok) {
        setCreateErr(res.error || t('create.errors.createWorkspace'))
        if (res.needsLogin) setAuthExpired(true)
        return
      }
      setCreatingWs(false)
      setNewWsName('')
      await onReload()
      if (res.workspaceId) setSelectedWs(res.workspaceId)
    } catch (reason) {
      setCreateErr(authErrorMessage(reason, t('create.errors.createWorkspaceRetry')))
    } finally {
      setCreatingBusy(false)
    }
  }

  async function signInToFabric(): Promise<void> {
    if (loginBusyRef.current) return
    loginBusyRef.current = true
    const seq = ++loginSeqRef.current
    setSigningIn(true)
    setSignInErr(null)
    try {
      const res = await window.api.auth.loginRayfin()
      if (seq !== loginSeqRef.current) return
      if (res.ok) {
        await onSignedIn?.()
        if (seq !== loginSeqRef.current) return
        setCaps(null)
        setSelectedCap('')
        await onReload()
        if (seq === loginSeqRef.current) {
          setAuthExpired(false)
          if (creatingWs) await loadCaps()
        }
      } else {
        // Surface why sign-in failed instead of silently resetting the button
        // (issue #17). The backend returns the CLI's reason and also logs it to
        // the diagnostics bundle.
        setSignInErr(authErrorMessage(res.error, t('signIn.incomplete')))
      }
    } catch (reason) {
      if (seq === loginSeqRef.current) {
        setSignInErr(authErrorMessage(reason, t('signIn.incomplete')))
      }
    } finally {
      if (seq === loginSeqRef.current) {
        loginBusyRef.current = false
        setSigningIn(false)
      }
    }
  }

  const all = !authExpired && wsResult?.ok && wsResult.workspaces ? wsResult.workspaces : []
  const eligible = all.filter((w) => w.eligible)
  const ineligible = all.filter((w) => !w.eligible)
  const showWsSearch = all.length > SEARCH_THRESHOLD
  const q = wsQuery.trim().toLowerCase()
  const matchesQuery = (w: FabricWorkspace): boolean =>
    [w.displayName, w.region, w.capacityName, w.sku].some((field) => field?.toLowerCase().includes(q))
  const refusal = (w: FabricWorkspace): Refusal | undefined => refusalFor(w, refused)
  // Where Fabric turned apps down, and workspaces sharing that capacity or region, go last.
  const usableFirst = (list: FabricWorkspace[]): FabricWorkspace[] => [
    ...list.filter((w) => !refusal(w)),
    ...list.filter((w) => refusal(w))
  ]
  const recent: FabricWorkspace[] = []
  for (const key of recentWorkspaces ?? []) {
    if (recent.length === RECENT_LIMIT) break
    const k = key.toLowerCase()
    const w = eligible.find((x) => x.id.toLowerCase() === k || x.displayName.toLowerCase() === k)
    if (w && !recent.includes(w)) recent.push(w)
  }
  const others = usableFirst(eligible.filter((w) => !recent.includes(w)))
  const recentFirst = usableFirst(recent)
  const shownRecent = showWsSearch && q ? recentFirst.filter(matchesQuery) : recentFirst
  const shownOthers = showWsSearch && q ? others.filter(matchesQuery) : others
  const shownEligible = [...shownRecent, ...shownOthers]
  const shownIneligible = showWsSearch && q ? ineligible.filter(matchesQuery) : ineligible
  // Collapse the (often long) ineligible list by default so it can't bury the
  // eligible rows or push the deploy button off-screen. Force it open when there
  // are no eligible workspaces (it's the only list to show) or while searching
  // (matches must be visible since search spans every workspace).
  const ineligibleExpanded = eligible.length === 0 || Boolean(q) || showIneligible
  const selectedWorkspace = eligible.find((w) => w.id === selectedWs)
  const targetState = selectedWorkspace && targetCheck?.workspaceId === selectedWorkspace.id ? targetCheck : null
  const checkingTarget = Boolean(targetState && !targetState.result)
  const replaces = targetState?.result?.conflict
  const apps = targetState?.result?.apps ?? []
  const chosenApp =
    selectedWorkspace && appIn?.workspaceId === selectedWorkspace.id && apps.includes(appIn.name)
      ? appIn.name
      : undefined
  // Choosing the app to publish into settles which one is replaced.
  const blockedByConflict = Boolean(replaces) && replaceIn !== selectedWs && !chosenApp
  const selectedRefusal = selectedWorkspace ? refusal(selectedWorkspace) : undefined
  const blockedByRefusal = Boolean(selectedRefusal) && tryIn !== selectedWs
  const canSubmit =
    Boolean(selectedWorkspace) &&
    !running &&
    !loadingWs &&
    !reauthing &&
    !signingIn &&
    !checkingTarget &&
    !blockedByConflict &&
    !blockedByRefusal

  function submit(): void {
    if (!canSubmit || !selectedWorkspace) return
    const friendly = name.trim() || chosenApp || selectedWorkspace.displayName || ''
    onSubmit(friendly, selectedWorkspace.id, chosenApp)
  }

  const eligibleRow = (w: FabricWorkspace): JSX.Element => {
    const flagged = Boolean(refusal(w))
    return (
      <button
        key={w.id}
        className={`ws-item${selectedWs === w.id ? ' ws-item--sel' : ''}`}
        onClick={() => setSelectedWs(w.id)}
      >
        <span className="ws-item-main">
          <span className="ws-item-name">{w.displayName}</span>
          {flagged ? (
            <span className="ws-item-sub ws-item-flag">
              {w.region ? t('create.unavailableIn', { region: w.region }) : t('create.unavailable')}
            </span>
          ) : (
            w.region && <span className="ws-item-sub">{w.region}</span>
          )}
        </span>
        <span className={`ws-sku ws-sku--${w.capacityKind}`} title={skuTitle(w)}>
          {skuText(w)}
        </span>
      </button>
    )
  }

  return (
    <div className="dep-create">
      <label className="dep-field">
        <span className="dep-field-label">
          {t('create.name')} <span className="dep-field-opt">{t('create.optional')}</span>
        </span>
        <input
          className="ws-input"
          placeholder={t('create.namePlaceholder')}
          value={name}
          autoFocus
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && selectedWs) submit()
          }}
        />
      </label>

      <div className="dep-field">
        <div className="dep-field-head">
          <span className="dep-field-label">{t('create.workspace')}</span>
          <div className="dep-field-head-actions">
            <button
              className="ws-create-link"
              type="button"
              onClick={openCreateWs}
              disabled={loadingWs || creatingWs || signingIn || reauthing || authExpired || !wsResult?.ok}
              title={t('create.newWorkspaceTitle')}
            >
              {t('create.newWorkspace')}
            </button>
            <button
              className="ws-refresh"
              type="button"
              title={t('create.refresh')}
              aria-label={t('create.refresh')}
              disabled={loadingWs || signingIn || reauthing}
              onClick={onReload}
            >
              <Codicon name="refresh" />
            </button>
          </div>
        </div>
        {refused.length > 0 && (
          <div className="ws-refused-note" role="note">
            <Codicon name="warning" />
            <span className="ws-refused-note-text">
              {refusedNote(refused)}{' '}
              <button
                type="button"
                className="link-btn"
                title={t('region.availabilityTitle')}
                onClick={() => void window.api.openExternal(REGION_AVAILABILITY_URL)}
              >
                {t('region.availability')}
              </button>
            </span>
          </div>
        )}
        {creatingWs && (
          <div className="ws-create">
            <input
              className="ws-input"
              placeholder={t('create.newWorkspaceName')}
              value={newWsName}
              autoFocus
              spellCheck={false}
              onChange={(e) => setNewWsName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitNewWs()
                else if (e.key === 'Escape') {
                  // Escape leaves this inline form, not the panel around it.
                  e.stopPropagation()
                  setCreatingWs(false)
                }
              }}
            />
            {loadingCaps ? (
              <div className="ws-loading">
                <span className="ws-spinner" />
                {t('create.loadingCapacities')}
              </div>
            ) : caps && caps.length > 0 ? (
              <select
                className="ws-input"
                value={selectedCap}
                onChange={(e) => setSelectedCap(e.target.value)}
              >
                {[
                  ...caps.filter((c) => !capacityRefusal(c)),
                  ...caps.filter((c) => capacityRefusal(c))
                ].map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName} · {c.sku ?? c.kind}
                    {c.region ? ` · ${c.region}` : ''}
                    {capacityRefusal(c) ? ` · ${t('create.unavailable')}` : ''}
                  </option>
                ))}
              </select>
            ) : (
              <p className="ws-empty-sub">{t('create.noCapacities')}</p>
            )}
            {createErr && <p className="ws-create-err" role="alert">{createErr}</p>}
            <div className="dep-create-actions">
              <button
                className="btn btn--xs btn--ghost"
                onClick={() => setCreatingWs(false)}
                disabled={creatingBusy}
              >
                {t('actions.cancel')}
              </button>
              <button
                className="btn btn--xs btn--primary"
                disabled={
                  !selectedCap || !newWsName.trim() || creatingBusy || loadingCaps ||
                  authExpired || !wsResult?.ok
                }
                onClick={() => void submitNewWs()}
              >
                {creatingBusy ? t('create.creating') : t('create.createWorkspace')}
              </button>
            </div>
          </div>
        )}
        {loadingWs ? (
          <div className="ws-loading">
            <span className="ws-spinner" />
            {reauthing ? t('create.reauthenticating') : t('create.loading')}
          </div>
        ) : all.length > 0 ? (
          <>
            {showWsSearch && (
              <div className="ws-search">
                <span className="ws-search-icon" aria-hidden>
                  <Codicon name="search" />
                </span>
                <input
                  className="ws-input ws-search-input"
                  placeholder={t('create.search', { total: all.length })}
                  value={wsQuery}
                  spellCheck={false}
                  onChange={(e) => setWsQuery(e.target.value)}
                />
                {wsQuery && (
                  <button
                    className="ws-search-clear"
                    title={t('create.clearSearch')}
                    aria-label={t('create.clearSearch')}
                    onClick={() => setWsQuery('')}
                  >
                    ×
                  </button>
                )}
              </div>
            )}
            {eligible.length === 0 && (
              <div className="ws-empty">
                <p className="ws-empty-title">{t('create.noEligible.title')}</p>
                <p className="ws-empty-sub">
                  <Trans
                    t={t}
                    i18nKey="create.noEligible.body"
                    count={all.length}
                    components={{ strong: <strong /> }}
                  />
                </p>
                <div className="ws-empty-actions">
                  <button
                    className="btn btn--xs btn--primary"
                    onClick={() => void window.api.openExternal(TRIAL_URL)}
                  >
                    {t('create.trial')}
                  </button>
                  <button
                    className="btn btn--xs btn--ghost"
                    onClick={() => void window.api.openExternal(BUY_URL)}
                  >
                    {t('create.buy')}
                  </button>
                </div>
              </div>
            )}
            {shownEligible.length > 0 && (
              <div className="ws-list" role="listbox">
                {shownRecent.length > 0 && (
                  <div className="ws-group-label">{t('create.recent')}</div>
                )}
                {shownRecent.map(eligibleRow)}
                {shownRecent.length > 0 && shownOthers.length > 0 && (
                  <div className="ws-group-label">{t('create.others')}</div>
                )}
                {shownOthers.map(eligibleRow)}
              </div>
            )}
            {selectedWorkspace && checkingTarget && (
              <p className="ws-target-note" role="status">
                <span className="ws-spinner" aria-hidden="true" />
                {t('create.checking', { workspace: selectedWorkspace.displayName })}
              </p>
            )}
            {selectedWorkspace && replaces && !chosenApp && (
              <div className="ws-target-conflict" role="alert">
                <span className="codicon codicon-warning" aria-hidden="true" />
                <span className="ws-target-conflict-text">
                  {replaceIn === selectedWorkspace.id
                    ? t('create.willReplace', {
                        app: replaces,
                        workspace: selectedWorkspace.displayName
                      })
                    : t('create.conflict', {
                        app: replaces,
                        workspace: selectedWorkspace.displayName
                      })}
                </span>
                {replaceIn !== selectedWorkspace.id && (
                  <button type="button" className="link-btn" onClick={() => setReplaceIn(selectedWorkspace.id)}>
                    {t('create.replaceAnyway')}
                  </button>
                )}
              </div>
            )}
            {selectedWorkspace && apps.length > 0 && (
              <label className="dep-field ws-app">
                <span className="dep-field-label">{t('create.app')}</span>
                <select
                  className="ws-input"
                  value={chosenApp ?? ''}
                  onChange={(e) =>
                    setAppIn(
                      e.target.value
                        ? { workspaceId: selectedWorkspace.id, name: e.target.value }
                        : null
                    )
                  }
                >
                  <option value="">
                    {replaces
                      ? t('create.sameName', { app: replaces })
                      : targetState?.result?.itemName
                        ? t('create.newAppNamed', { name: targetState.result.itemName })
                        : t('create.newApp')}
                  </option>
                  {apps
                    .filter((app) => app.toLowerCase() !== replaces?.toLowerCase())
                    .map((app) => (
                      <option key={app} value={app}>
                        {app}
                      </option>
                    ))}
                </select>
              </label>
            )}
            {selectedWorkspace && chosenApp && (
              <div className="ws-target-conflict" role="alert">
                <span className="codicon codicon-warning" aria-hidden="true" />
                <span className="ws-target-conflict-text">
                  {t('create.replaces', {
                    app: chosenApp,
                    workspace: selectedWorkspace.displayName
                  })}
                </span>
              </div>
            )}
            {selectedWorkspace && selectedRefusal && (
              <div className="ws-target-conflict ws-target-conflict--refused" role="alert">
                <span className="codicon codicon-warning" aria-hidden="true" />
                <span className="ws-target-conflict-text">
                  {refusalText(selectedWorkspace, selectedRefusal)}
                </span>
                {tryIn !== selectedWorkspace.id && (
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => setTryIn(selectedWorkspace.id)}
                  >
                    {t('create.publishAnyway')}
                  </button>
                )}
              </div>
            )}
            {shownIneligible.length > 0 && (
              <div className="ws-ineligible">
                {eligible.length > 0 &&
                  (q ? (
                    <div className="ws-group-toggle ws-group-toggle--static">
                      <span className="ws-group-label ws-group-label--btn">
                        {t('create.notEligible')}
                      </span>
                      <span className="ws-group-count">{shownIneligible.length}</span>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="ws-group-toggle"
                      aria-expanded={showIneligible}
                      onClick={() => setShowIneligible((v) => !v)}
                    >
                      <span
                        className={`ws-group-chevron${showIneligible ? ' is-open' : ''}`}
                        aria-hidden
                      >
                        ›
                      </span>
                      <span className="ws-group-label ws-group-label--btn">
                        {t('create.notEligible')}
                      </span>
                      <span className="ws-group-count">{shownIneligible.length}</span>
                    </button>
                  ))}
                {ineligibleExpanded && (
                  <>
                    {eligible.length > 0 && (
                      <p className="ws-ineligible-hint">
                        <Trans
                          t={t}
                          i18nKey="create.ineligibleHint"
                          components={{ strong: <strong /> }}
                        />
                      </p>
                    )}
                    <div className="ws-list ws-list--muted" role="list">
                      {shownIneligible.map((w) => (
                        <button
                          key={w.id}
                          type="button"
                          className="ws-item ws-item--ineligible"
                          disabled
                          title={reasonFor(w)}
                        >
                          <span className="ws-item-main">
                            <span className="ws-item-name">{w.displayName}</span>
                            {w.region && <span className="ws-item-sub">{w.region}</span>}
                          </span>
                          <span
                            className={`ws-sku ws-sku--${w.capacityKind}`}
                            title={w.capacityName ?? undefined}
                          >
                            {w.sku ?? '—'}
                          </span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
            {q && shownEligible.length === 0 && shownIneligible.length === 0 && (
              <div className="ws-empty">
                <p className="ws-empty-sub">{t('create.noMatch', { query: wsQuery.trim() })}</p>
                <button className="btn btn--xs btn--ghost" onClick={() => setWsQuery('')}>
                  {t('create.clearSearch')}
                </button>
              </div>
            )}
          </>
        ) : wsResult?.ok && !authExpired ? (
          <div className="ws-empty">
            <p className="ws-empty-title">{t('create.noWorkspaces.title')}</p>
            <p className="ws-empty-sub">{t('create.noWorkspaces.body')}</p>
            <div className="ws-empty-actions">
              <button
                className="btn btn--xs btn--primary"
                onClick={() => void window.api.openExternal(TRIAL_URL)}
              >
                {t('create.trial')}
              </button>
              <button
                className="btn btn--xs btn--ghost"
                onClick={() => void window.api.openExternal(BUY_URL)}
              >
                {t('create.buy')}
              </button>
            </div>
          </div>
        ) : (
          <div className="ws-empty">
            {wsResult?.needsLogin || authExpired ? (
              <>
                <p className="ws-empty-sub">{t('create.signInPrompt')}</p>
                <button
                  className="btn btn--xs btn--primary"
                  disabled={signingIn}
                  onClick={() => void signInToFabric()}
                >
                  {signingIn ? t('signIn.busy') : t('signIn.fabric')}
                </button>
                {/* Needing to sign in is expected, on a first launch or after a session
                    expires, so why the list needed it isn't shown. A failed sign-in is. */}
                {signInErr && (
                  <p className="ws-empty-err" role="alert">{signInErr}</p>
                )}
              </>
            ) : (
              <>
                <p className="ws-empty-sub">
                  {wsResult?.error
                    ? t('create.loadFailedWith', { error: wsResult.error })
                    : t('create.loadFailed')}
                </p>
                <button className="btn btn--xs btn--ghost" onClick={onReload}>
                  {t('actions.retry')}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      <div className="dep-create-actions">
        {onCancel && (
          <button className="btn btn--xs btn--ghost" onClick={onCancel}>
            {cancelLabel ?? t('actions.cancel')}
          </button>
        )}
        <button className="btn btn--xs btn--primary" disabled={!canSubmit} onClick={submit}>
          {running ? (busyLabel ?? t('button.publishing')) : (submitLabel ?? t('button.publish'))}
        </button>
      </div>
    </div>
  )
}
