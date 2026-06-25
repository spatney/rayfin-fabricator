import { useState } from 'react'
import type { FabricWorkspace, FabricWorkspacesResult } from '@shared/ipc'

/** Where to send users who have no Fabric/Premium capacity yet. */
const TRIAL_URL = 'https://learn.microsoft.com/fabric/fundamentals/fabric-trial'
const BUY_URL = 'https://learn.microsoft.com/fabric/enterprise/buy-subscription'

/**
 * Once the list grows past this, surface a search box to narrow it. Search spans
 * ALL workspaces (including ineligible ones) so a workspace a user expects to
 * find is always reachable, even when it can't be selected.
 */
const SEARCH_THRESHOLD = 10

/** "F-SKU · F2" style label for a workspace's capacity. */
function skuText(w: FabricWorkspace): string {
  if (w.capacityKind === 'unknown') return 'Capacity'
  const fam = w.capacityKind === 'fabric' ? 'F-SKU' : w.capacityKind === 'premium' ? 'P-SKU' : ''
  return fam + (w.sku ? ` · ${w.sku}` : '')
}

/** Tooltip for a workspace's capacity chip. */
function skuTitle(w: FabricWorkspace): string | undefined {
  if (w.capacityKind === 'unknown') {
    return 'On a dedicated capacity, but its SKU isn’t visible to you (you don’t administer it) — verified when you deploy'
  }
  return w.capacityName ? `${w.capacityName} (${w.sku})` : w.sku
}

/** Why a workspace can't host a Rayfin app — shown on greyed-out ineligible rows. */
function reasonFor(w: FabricWorkspace): string {
  if (w.capacityKind === 'other') {
    return `Capacity ${w.sku ? `(${w.sku}) ` : ''}isn’t Fabric (F-SKU) or Premium (P-SKU)`
  }
  return 'No Fabric/Premium capacity assigned'
}

interface Props {
  /** The signed-in user's Fabric workspaces (with capacity / eligibility info). */
  wsResult: FabricWorkspacesResult | null
  /** True while the workspace list is loading. */
  loadingWs: boolean
  /** True while re-signing-in after an expired session (shown during the reload). */
  reauthing?: boolean
  /** Re-fetch the workspace list (the error-state "Retry"). */
  onReload: () => void
  /** True while a `rayfin up` is streaming (disables submit). */
  running?: boolean
  /** Primary button label (idle). */
  submitLabel?: string
  /** Primary button label while `running`. */
  busyLabel?: string
  /** Secondary button label. */
  cancelLabel?: string
  /** Secondary action; the Cancel button is hidden when omitted. */
  onCancel?: () => void
  /** Submit: deploy `name` (friendly, may be empty) into `workspaceId`. */
  onSubmit: (name: string, workspaceId: string) => void
  /** Pre-fill the (editable) deployment name — e.g. "Development" for a first deploy. */
  defaultName?: string
}

/**
 * The presentational "pick a workspace and deploy" form. Extracted so the
 * project-header deployments popover and the fullscreen create/deploy flow share
 * one consistent picker (eligible F-SKU/P-SKU list, greyed-out ineligible rows
 * with reasons, search, optional name, and the no-capacity / error empty states).
 * It owns only its transient input state; the workspace data is supplied (and
 * cached) by the parent.
 */
export default function DeploymentCreateForm({
  wsResult,
  loadingWs,
  reauthing = false,
  onReload,
  running = false,
  submitLabel = 'Create & deploy',
  busyLabel = 'Deploying…',
  cancelLabel = 'Cancel',
  onCancel,
  onSubmit,
  defaultName = ''
}: Props): JSX.Element {
  const [name, setName] = useState(defaultName)
  const [wsQuery, setWsQuery] = useState('')
  const [selectedWs, setSelectedWs] = useState<string | null>(null)
  const [showIneligible, setShowIneligible] = useState(false)

  const all = wsResult?.ok && wsResult.workspaces ? wsResult.workspaces : []
  const eligible = all.filter((w) => w.eligible)
  const ineligible = all.filter((w) => !w.eligible)
  const showWsSearch = all.length > SEARCH_THRESHOLD
  const q = wsQuery.trim().toLowerCase()
  const matchesQuery = (w: FabricWorkspace): boolean =>
    [w.displayName, w.region, w.capacityName, w.sku].some((field) => field?.toLowerCase().includes(q))
  const shownEligible = showWsSearch && q ? eligible.filter(matchesQuery) : eligible
  const shownIneligible = showWsSearch && q ? ineligible.filter(matchesQuery) : ineligible
  // Collapse the (often long) ineligible list by default so it can't bury the
  // eligible rows or push the deploy button off-screen. Force it open when there
  // are no eligible workspaces (it's the only list to show) or while searching
  // (matches must be visible since search spans every workspace).
  const ineligibleExpanded = eligible.length === 0 || Boolean(q) || showIneligible

  function submit(): void {
    if (!selectedWs || running) return
    const ws = eligible.find((w) => w.id === selectedWs)
    const friendly = name.trim() || ws?.displayName || ''
    onSubmit(friendly, selectedWs)
  }

  return (
    <div className="dep-create">
      <label className="dep-field">
        <span className="dep-field-label">
          Name <span className="dep-field-opt">optional</span>
        </span>
        <input
          className="ws-input"
          placeholder="e.g. Production"
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
        <span className="dep-field-label">Deploy to workspace</span>
        {loadingWs ? (
          <div className="ws-loading">
            <span className="ws-spinner" />
            {reauthing ? 'Re-authenticating…' : 'Loading your workspaces…'}
          </div>
        ) : all.length > 0 ? (
          <>
            {showWsSearch && (
              <div className="ws-search">
                <span className="ws-search-icon" aria-hidden>
                  ⌕
                </span>
                <input
                  className="ws-input ws-search-input"
                  placeholder={`Search ${all.length} workspaces…`}
                  value={wsQuery}
                  spellCheck={false}
                  onChange={(e) => setWsQuery(e.target.value)}
                />
                {wsQuery && (
                  <button
                    className="ws-search-clear"
                    title="Clear search"
                    aria-label="Clear search"
                    onClick={() => setWsQuery('')}
                  >
                    ×
                  </button>
                )}
              </div>
            )}
            {eligible.length === 0 && (
              <div className="ws-empty">
                <p className="ws-empty-title">No eligible workspaces</p>
                <p className="ws-empty-sub">
                  Rayfin apps need a workspace on a Fabric (<strong>F-SKU</strong>) or Power BI
                  Premium (<strong>P-SKU</strong>) capacity. None of your {all.length} workspace
                  {all.length === 1 ? '' : 's'} qualify — they’re listed below so you can see why.
                  Start a free Fabric trial or add a capacity, then refresh.
                </p>
                <div className="ws-empty-actions">
                  <button
                    className="btn btn--xs btn--primary"
                    onClick={() => void window.api.openExternal(TRIAL_URL)}
                  >
                    Start a free trial
                  </button>
                  <button
                    className="btn btn--xs btn--ghost"
                    onClick={() => void window.api.openExternal(BUY_URL)}
                  >
                    Buy a capacity
                  </button>
                </div>
              </div>
            )}
            {shownEligible.length > 0 && (
              <div className="ws-list" role="listbox">
                {shownEligible.map((w) => (
                  <button
                    key={w.id}
                    className={`ws-item${selectedWs === w.id ? ' ws-item--sel' : ''}`}
                    onClick={() => setSelectedWs(w.id)}
                  >
                    <span className="ws-item-main">
                      <span className="ws-item-name">{w.displayName}</span>
                      {w.region && <span className="ws-item-sub">{w.region}</span>}
                    </span>
                    <span className={`ws-sku ws-sku--${w.capacityKind}`} title={skuTitle(w)}>
                      {skuText(w)}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {shownIneligible.length > 0 && (
              <div className="ws-ineligible">
                {eligible.length > 0 &&
                  (q ? (
                    <div className="ws-group-toggle ws-group-toggle--static">
                      <span className="ws-group-label ws-group-label--btn">Not eligible</span>
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
                      <span className="ws-group-label ws-group-label--btn">Not eligible</span>
                      <span className="ws-group-count">{shownIneligible.length}</span>
                    </button>
                  ))}
                {ineligibleExpanded && (
                  <>
                    {eligible.length > 0 && (
                      <p className="ws-ineligible-hint">
                        These need a Fabric (<strong>F-SKU</strong>) or Power BI Premium (
                        <strong>P-SKU</strong>) capacity.
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
                <p className="ws-empty-sub">No workspaces match “{wsQuery.trim()}”.</p>
                <button className="btn btn--xs btn--ghost" onClick={() => setWsQuery('')}>
                  Clear search
                </button>
              </div>
            )}
          </>
        ) : wsResult?.ok ? (
          <div className="ws-empty">
            <p className="ws-empty-title">No workspaces found</p>
            <p className="ws-empty-sub">
              We couldn’t find any Fabric workspaces for your account. Start a free Fabric trial or
              add a capacity, then refresh.
            </p>
            <div className="ws-empty-actions">
              <button
                className="btn btn--xs btn--primary"
                onClick={() => void window.api.openExternal(TRIAL_URL)}
              >
                Start a free trial
              </button>
              <button
                className="btn btn--xs btn--ghost"
                onClick={() => void window.api.openExternal(BUY_URL)}
              >
                Buy a capacity
              </button>
            </div>
          </div>
        ) : (
          <div className="ws-empty">
            <p className="ws-empty-sub">
              {wsResult?.needsLogin
                ? 'Your Fabric session has expired — sign out and back in to list workspaces.'
                : `Couldn’t load workspaces${wsResult?.error ? `: ${wsResult.error}` : '.'}`}
            </p>
            <button className="btn btn--xs btn--ghost" onClick={onReload}>
              Retry
            </button>
          </div>
        )}
      </div>

      <div className="dep-create-actions">
        {onCancel && (
          <button className="btn btn--xs btn--ghost" onClick={onCancel}>
            {cancelLabel}
          </button>
        )}
        <button className="btn btn--xs btn--primary" disabled={!selectedWs || running} onClick={submit}>
          {running ? busyLabel : submitLabel}
        </button>
      </div>
    </div>
  )
}
