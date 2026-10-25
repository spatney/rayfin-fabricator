import { useEffect, useMemo, useRef, useState, type ReactNode, type JSX } from 'react'
import type { AdvisorCategoryId, AdvisorFinding, StudioProject } from '@shared/ipc'
import { CATALOG, categoryById } from '@shared/advisor/catalog'
import type { FindingItem } from '../../advisor/lifecycle'
import type { AdvisorController } from '../../advisor/store'
import type { MarkdownLinks } from '../Markdown'
import { ModelPicker } from '../models/ModelPicker'
import { Codicon } from '../icons'
import { AreasPanel } from './AreasPanel'
import { FindingDetail } from './FindingDetail'
import { IssuesPanel, type IssueTab } from './IssuesPanel'
import { PostureHeader } from './PostureHeader'
import { plural, relativeTime } from './format'
import '../chat/chat.css'
import './advisor.css'

interface Props {
  project: StudioProject
  advisor: AdvisorController
  /** The Build chat is mid-turn: fix hand-offs pause until it finishes. */
  chatBusy: boolean
  /** Hand findings to the Build chat for Copilot to fix. */
  onFix: (findings: AdvisorFinding[]) => void
  onOpenFile: (path: string, line?: number) => void
  /** Show this finding (e.g. from a fix card in the Build chat); a new nonce re-opens it. */
  openRequest?: { id: string; nonce: number }
  /** Open Accounts at Model providers (your own API keys). */
  onManageKeys?: () => void
}

function matchesQuery(item: FindingItem, q: string): boolean {
  if (!q) return true
  const f = item.finding
  const hay = `${f.title} ${f.detail} ${f.file ?? ''} ${f.ruleId} ${categoryById(f.category)?.title ?? ''}`
  return hay.toLowerCase().includes(q)
}

function isActionable(item: FindingItem): boolean {
  return item.status !== 'fixing' && item.status !== 'checking'
}

/**
 * The Advisor tab: a health summary (grade, a strip of every check, live
 * review progress) over an issues inbox whose rows open in place, beside the
 * checks for each area. Quick checks run automatically; the Copilot deep review
 * runs on demand and streams findings in. Findings can be fixed with Copilot (one,
 * selected, or all), explained, verified after a fix, or dismissed.
 */
export default function AdvisorView({
  project,
  advisor,
  chatBusy,
  onFix,
  onOpenFile,
  openRequest,
  onManageKeys
}: Props): JSX.Element {
  const [tab, setTab] = useState<IssueTab>('open')
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [openAreas, setOpenAreas] = useState<Set<AdvisorCategoryId>>(new Set())
  const workspaceRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setTab('open')
    setQuery('')
    setOpenId(null)
    setChecked(new Set())
    setOpenAreas(new Set())
  }, [project.id])

  const { derived, review, deep, quick, deepCurrent } = advisor
  const loading = !quick && !advisor.quickError
  const q = query.trim().toLowerCase()

  const lists = useMemo(() => {
    const open = derived.open.filter((i) => matchesQuery(i, q))
    return {
      open,
      new: open.filter((i) => i.isNew),
      dismissed: derived.hidden.filter((i) => matchesQuery(i, q)),
      resolved: derived.resolved.filter((r) => !q || `${r.title} ${r.file ?? ''}`.toLowerCase().includes(q))
    }
  }, [derived, q])
  const items = tab === 'dismissed' ? lists.dismissed : tab === 'new' ? lists.new : tab === 'open' ? lists.open : []

  // Drop selections that are no longer open (fixed, dismissed, or gone).
  const openIds = useMemo(() => new Set(derived.open.map((i) => i.finding.id)), [derived.open])
  useEffect(() => {
    setChecked((prev) => {
      const next = new Set([...prev].filter((id) => openIds.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [openIds])

  const fixable = derived.open.filter(isActionable)
  const checkedItems = derived.open.filter((i) => checked.has(i.finding.id) && isActionable(i))
  const applied = derived.open.filter((i) => i.status === 'applied')

  const knownFiles = useMemo(() => new Set(quick?.files ?? []), [quick?.files])
  const links = useMemo<MarkdownLinks | null>(
    () =>
      knownFiles.size
        ? {
            resolveFile: (text) => {
              const clean = text.trim().replace(/^\.\//, '').replace(/:\d+(:\d+)?$/, '')
              return knownFiles.has(clean) ? clean : null
            },
            openFile: (path) => onOpenFile(path)
          }
        : null,
    [knownFiles, onOpenFile]
  )

  const fix = (list: FindingItem[]): void => {
    if (list.length === 0 || chatBusy) return
    onFix(list.map((i) => i.finding))
    setChecked(new Set())
  }
  const openUrl = (url: string): void => void window.api.openExternal(url)

  // Jump to an issue (from an area's checklist, or a fix card in the chat).
  const showIssue = (id: string, where: IssueTab = 'open'): void => {
    setTab(where)
    setQuery('')
    setOpenId(id)
    requestAnimationFrame(() => {
      const row = [...(workspaceRef.current?.querySelectorAll<HTMLElement>('[data-finding-id]') ?? [])].find(
        (el) => el.dataset.findingId === id
      )
      row?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
      row?.focus({ preventScroll: true })
    })
  }

  // Declared after the per-project reset above so a request that mounts the view wins.
  useEffect(() => {
    if (!openRequest) return
    const { id } = openRequest
    if (derived.open.some((i) => i.finding.id === id)) showIssue(id)
    else if (derived.hidden.some((i) => i.finding.id === id)) showIssue(id, 'dismissed')
    else if (derived.resolved.some((r) => r.id === id)) {
      setTab('resolved')
      setQuery('')
      setOpenId(null)
    }
  }, [openRequest?.nonce])

  const counts: Record<IssueTab, number> = {
    open: lists.open.length,
    new: lists.new.length,
    resolved: lists.resolved.length,
    dismissed: lists.dismissed.length
  }

  let empty: ReactNode
  if (q) {
    empty = (
      <div className="adv-empty">
        <p>No issues match “{query.trim()}”.</p>
        <button type="button" className="adv-link" onClick={() => setQuery('')}>
          Clear search
        </button>
      </div>
    )
  } else if (tab === 'new') {
    empty = <div className="adv-empty">No new issues since the last review.</div>
  } else if (tab === 'resolved') {
    empty = <div className="adv-empty">Nothing resolved yet. Issues you fix show up here.</div>
  } else if (tab === 'dismissed') {
    empty = <div className="adv-empty">Nothing dismissed. Dismissed issues and muted rules show up here.</div>
  } else if (loading) {
    empty = (
      <div className="adv-empty">
        <span className="shimmer-text">Checking your app…</span>
      </div>
    )
  } else if (review.running) {
    empty = (
      <div className="adv-empty">
        <p className="adv-empty-title">No issues so far</p>
        <p>Copilot is still reviewing. Anything it confirms shows up here right away.</p>
      </div>
    )
  } else {
    empty = (
      <div className="adv-clear">
        <span className="adv-clear-badge" aria-hidden="true">
          <Codicon name="check" />
        </span>
        <p className="adv-clear-title">Nothing needs your attention</p>
        <p className="adv-clear-text">
          {deepCurrent && deep
            ? `${plural(derived.tally.passed, 'check')} passed, including Copilot’s deep review ${relativeTime(deep.analyzedAt)}.`
            : `The quick checks found nothing. A deep review has Copilot check ${plural(derived.tally.waiting, 'more rule')} that need judgment.`}
        </p>
        {!deepCurrent && (
          <button type="button" className="btn btn--sm btn--primary" onClick={() => void advisor.startReview()}>
            <Codicon name="sparkle" /> Run deep review
          </button>
        )}
        {derived.resolved.length > 0 && (
          <button type="button" className="adv-link adv-clear-resolved" onClick={() => setTab('resolved')}>
            <Codicon name="pass-filled" /> {plural(derived.resolved.length, 'issue')} resolved since the last review
          </button>
        )}
      </div>
    )
  }

  const renderDetail = (item: FindingItem): ReactNode => (
    <FindingDetail
      key={item.finding.id}
      item={item}
      explain={advisor.explains[item.finding.id]}
      explainBusy={advisor.explaining !== null && advisor.explaining !== item.finding.id}
      verifying={advisor.verify.running && advisor.verify.ids.includes(item.finding.id)}
      verifyBusy={advisor.verify.running}
      chatBusy={chatBusy}
      links={links}
      onFix={() => fix([item])}
      onExplain={() => advisor.explain(item.finding)}
      onCancelExplain={advisor.cancelExplain}
      onVerify={() => void advisor.startVerify([item.finding])}
      onDismiss={(reason) => advisor.dismiss(item.finding, reason)}
      onUndismiss={() => advisor.undismiss(item.finding.id)}
      onMute={() => advisor.mute(item.finding.ruleId)}
      onUnmute={() => advisor.unmute(item.finding.ruleId)}
      onOpenFile={onOpenFile}
      onOpenUrl={openUrl}
    />
  )

  return (
    <div className="adv">
      <header className="adv-bar">
        <div className="adv-bar-title">
          <Codicon name="shield" />
          <span>Advisor</span>
        </div>
        <span className="adv-bar-sub" title={`Rule catalog ${CATALOG.catalogVersion}`}>
          Rules for Rayfin {CATALOG.rayfinBaseline}
        </span>
        <span className="adv-bar-spacer" />
        <button
          type="button"
          className="chat-tool"
          onClick={advisor.refreshQuick}
          disabled={advisor.quickRunning}
          title="Re-run the quick checks"
          aria-label="Re-run the quick checks"
        >
          <Codicon name="refresh" className={advisor.quickRunning ? 'icon-spin' : ''} />
        </button>
        <div className="adv-bar-model">
          <ModelPicker
            value={advisor.selection}
            disabled={review.running}
            onChange={advisor.setSelection}
            tiers
            placement="down"
            onManageKeys={onManageKeys}
            label="Advisor model"
          />
        </div>
        {review.running ? (
          <button type="button" className="btn btn--sm btn--ghost" onClick={advisor.cancelReview}>
            <Codicon name="debug-stop" /> Stop
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--sm btn--primary"
            onClick={() => void advisor.startReview()}
            disabled={advisor.loading}
            title="Have Copilot review the app against every rule — read-only, on its own session"
          >
            <Codicon name="sparkle" /> {deep?.report.ok ? 'Re-run deep review' : 'Run deep review'}
          </button>
        )}
      </header>

      <div className="adv-scroll">
        <div className="adv-inner">
          <PostureHeader
            derived={derived}
            review={review}
            deep={deep}
            quick={quick}
            loading={loading}
            deepCurrent={deepCurrent}
            fixCount={fixable.length}
            selectedCount={checkedItems.length}
            chatBusy={chatBusy}
            projectPath={project.path}
            onFix={() => fix(checkedItems.length ? checkedItems : fixable)}
            onStop={advisor.cancelReview}
            onOpenFile={(p) => onOpenFile(p)}
          />

          {review.error && (
            <div className="adv-banner adv-banner--error" role="alert">
              <Codicon name="error" />
              <span>{review.error}</span>
              <button type="button" className="adv-link" onClick={() => void advisor.startReview()}>
                Try again
              </button>
            </div>
          )}
          {advisor.verify.error && (
            <div className="adv-banner adv-banner--error" role="alert">
              <Codicon name="error" />
              <span>{advisor.verify.error}</span>
            </div>
          )}
          {advisor.quickError && (
            <div className="adv-banner adv-banner--warn" role="alert">
              <Codicon name="warning" />
              <span>The quick checks couldn’t read the project: {advisor.quickError}</span>
            </div>
          )}
          {!review.running && deep?.report.ok && deep.legacy && (
            <div className="adv-banner">
              <Codicon name="history" />
              <span>
                This deep review ran with an older rule set. Re-run it to check the app against the rules for
                Rayfin {CATALOG.rayfinBaseline}.
              </span>
            </div>
          )}
          {!review.running && deep?.report.ok && !deep.legacy && deep.rulesChanged && (
            <div className="adv-banner">
              <Codicon name="history" />
              <span>The Advisor’s rules were updated since this review. Re-run it to apply the new rules.</span>
            </div>
          )}
          {!review.running && deep?.report.ok && !deep.legacy && !deep.rulesChanged && deep.stale && (
            <div className="adv-banner">
              <Codicon name="history" />
              <span>
                Your code changed since the deep review ({relativeTime(deep.analyzedAt)}). The quick checks are
                current; re-run the deep review to refresh Copilot’s findings.
              </span>
            </div>
          )}
          {applied.length > 0 && !advisor.verify.running && (
            <div className="adv-banner adv-banner--applied">
              <Codicon name="check" />
              <span>
                Copilot applied fixes for {plural(applied.length, 'deep-review issue')}. Verify them against the
                current code.
              </span>
              <button
                type="button"
                className="adv-link"
                onClick={() => void advisor.startVerify(applied.map((i) => i.finding))}
              >
                Verify fixes
              </button>
            </div>
          )}
          {chatBusy && derived.open.length > 0 && (
            <div className="adv-banner adv-banner--busy">
              <span className="step-spin" aria-hidden="true" />
              <span>
                Copilot is working on a task — Fix is paused until it finishes. You can still explain and review
                issues.
              </span>
            </div>
          )}
          {quick?.truncated && (
            <div className="adv-banner">
              <Codicon name="info" />
              <span>This project is large, so the quick checks skipped some files.</span>
            </div>
          )}

          {!review.running && deep?.report.ok && deep.report.summary && (
            <aside className="adv-summary" aria-label="Copilot’s summary">
              <div className="adv-summary-body">
                <span className="adv-summary-label">
                  Copilot’s summary · {relativeTime(deep.analyzedAt)}
                  {deepCurrent ? '' : ' · outdated'}
                </span>
                <p>{deep.report.summary}</p>
              </div>
            </aside>
          )}

          <div className="adv-workspace" ref={workspaceRef}>
            <IssuesPanel
              tab={tab}
              onTab={(t) => {
                setTab(t)
                setOpenId(null)
              }}
              counts={counts}
              items={items}
              resolved={lists.resolved}
              openId={openId}
              onToggle={(id) => setOpenId((cur) => (cur === id ? null : id))}
              checked={checked}
              onCheck={(id) =>
                setChecked((prev) => {
                  const next = new Set(prev)
                  if (next.has(id)) next.delete(id)
                  else next.add(id)
                  return next
                })
              }
              onCheckAll={(ids) => setChecked(new Set(ids))}
              query={query}
              onQuery={setQuery}
              renderDetail={renderDetail}
              empty={empty}
              onClearResolved={advisor.clearResolved}
            />
            <AreasPanel
              categories={derived.categories}
              checks={derived.checks}
              loading={loading}
              open={openAreas}
              onToggle={(id) =>
                setOpenAreas((prev) => {
                  const next = new Set(prev)
                  if (next.has(id)) next.delete(id)
                  else next.add(id)
                  return next
                })
              }
              onShowIssue={showIssue}
              onOpenUrl={openUrl}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
