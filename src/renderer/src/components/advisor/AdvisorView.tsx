import { useEffect, useMemo, useRef, useState, type ReactNode, type JSX } from 'react'
import type { AdvisorCategoryId, AdvisorFinding, StudioProject } from '@shared/ipc'
import { CATALOG, categoryById } from '@shared/advisor/catalog'
import type { FindingItem } from '../../advisor/lifecycle'
import { categoryTitle, findingTitle } from '../../advisor/ruleText'
import type { AdvisorController } from '../../advisor/store'
import { useTranslation } from '../../i18n'
import type { MarkdownLinks } from '../Markdown'
import { ModelPicker } from '../models/ModelPicker'
import { Codicon } from '../icons'
import { AreasPanel } from './AreasPanel'
import { FindingDetail } from './FindingDetail'
import { IssuesPanel, type IssueTab } from './IssuesPanel'
import { PostureHeader } from './PostureHeader'
import { relativeTime } from './format'
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

/** The English to search by, plus any of `shown` (as the interface shows it) that differs from it. */
function haystack(english: string[], shown: string[]): string {
  return [...english, ...shown.filter((s) => s && !english.includes(s))].join(' ').toLowerCase()
}

function matchesQuery(item: FindingItem, q: string): boolean {
  if (!q) return true
  const f = item.finding
  return haystack(
    [f.title, f.detail, f.file ?? '', f.ruleId, categoryById(f.category)?.title ?? ''],
    [findingTitle(f), categoryTitle(f.category, ''), f.detailText ?? '']
  ).includes(q)
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
  const { t, i18n } = useTranslation('advisor')
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

  // Searches match titles in the interface's language too, so they follow it.
  const lists = useMemo(() => {
    const open = derived.open.filter((i) => matchesQuery(i, q))
    return {
      open,
      new: open.filter((i) => i.isNew),
      dismissed: derived.hidden.filter((i) => matchesQuery(i, q)),
      resolved: derived.resolved.filter((r) => !q || haystack([r.title, r.file ?? ''], [findingTitle(r)]).includes(q))
    }
  }, [derived, q, i18n.language])
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
        <p>{t('view.empty.noMatch', { query: query.trim() })}</p>
        <button type="button" className="adv-link" onClick={() => setQuery('')}>
          {t('view.empty.clearSearch')}
        </button>
      </div>
    )
  } else if (tab === 'new') {
    empty = <div className="adv-empty">{t('view.empty.noNew')}</div>
  } else if (tab === 'resolved') {
    empty = <div className="adv-empty">{t('view.empty.noResolved')}</div>
  } else if (tab === 'dismissed') {
    empty = <div className="adv-empty">{t('view.empty.noDismissed')}</div>
  } else if (loading) {
    empty = (
      <div className="adv-empty">
        <span className="shimmer-text">{t('checkingApp')}</span>
      </div>
    )
  } else if (review.running) {
    empty = (
      <div className="adv-empty">
        <p className="adv-empty-title">{t('view.empty.noneSoFar')}</p>
        <p>{t('view.empty.stillReviewing')}</p>
      </div>
    )
  } else {
    empty = (
      <div className="adv-clear">
        <span className="adv-clear-badge" aria-hidden="true">
          <Codicon name="check" />
        </span>
        <p className="adv-clear-title">{t('view.empty.allClear')}</p>
        <p className="adv-clear-text">
          {deepCurrent && deep
            ? t('view.empty.passedWithDeep', { count: derived.tally.passed, time: relativeTime(deep.analyzedAt) })
            : t('view.empty.quickClean', { count: derived.tally.waiting })}
        </p>
        {!deepCurrent && (
          <button type="button" className="btn btn--sm btn--primary" onClick={() => void advisor.startReview()}>
            <Codicon name="sparkle" /> {t('view.runDeep')}
          </button>
        )}
        {derived.resolved.length > 0 && (
          <button type="button" className="adv-link adv-clear-resolved" onClick={() => setTab('resolved')}>
            <Codicon name="pass-filled" /> {t('view.empty.resolvedSince', { count: derived.resolved.length })}
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
          <span>{t('view.title')}</span>
        </div>
        <span className="adv-bar-sub" title={t('view.catalogVersion', { version: CATALOG.catalogVersion })}>
          {t('view.rulesFor', { version: CATALOG.rayfinBaseline })}
        </span>
        <span className="adv-bar-spacer" />
        <button
          type="button"
          className="chat-tool"
          onClick={advisor.refreshQuick}
          disabled={advisor.quickRunning}
          title={t('view.rerunQuick')}
          aria-label={t('view.rerunQuick')}
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
            label={t('view.model')}
          />
        </div>
        {review.running ? (
          <button type="button" className="btn btn--sm btn--ghost" onClick={advisor.cancelReview}>
            <Codicon name="debug-stop" /> {t('actions.stop')}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--sm btn--primary"
            onClick={() => void advisor.startReview()}
            disabled={advisor.loading}
            title={t('view.reviewTitle')}
          >
            <Codicon name="sparkle" /> {deep?.report.ok ? t('view.rerunDeep') : t('view.runDeep')}
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
                {t('actions.tryAgain')}
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
              <span>{t('view.quickError', { error: advisor.quickError })}</span>
            </div>
          )}
          {!review.running && deep?.report.ok && deep.legacy && (
            <div className="adv-banner">
              <Codicon name="history" />
              <span>{t('view.legacy', { version: CATALOG.rayfinBaseline })}</span>
            </div>
          )}
          {!review.running && deep?.report.ok && !deep.legacy && deep.rulesChanged && (
            <div className="adv-banner">
              <Codicon name="history" />
              <span>{t('view.rulesChanged')}</span>
            </div>
          )}
          {!review.running && deep?.report.ok && !deep.legacy && !deep.rulesChanged && deep.stale && (
            <div className="adv-banner">
              <Codicon name="history" />
              <span>{t('view.stale', { time: relativeTime(deep.analyzedAt) })}</span>
            </div>
          )}
          {applied.length > 0 && !advisor.verify.running && (
            <div className="adv-banner adv-banner--applied">
              <Codicon name="check" />
              <span>{t('view.applied', { count: applied.length })}</span>
              <button
                type="button"
                className="adv-link"
                onClick={() => void advisor.startVerify(applied.map((i) => i.finding))}
              >
                {t('view.verifyFixes')}
              </button>
            </div>
          )}
          {chatBusy && derived.open.length > 0 && (
            <div className="adv-banner adv-banner--busy">
              <span className="step-spin" aria-hidden="true" />
              <span>{t('view.busy')}</span>
            </div>
          )}
          {quick?.truncated && (
            <div className="adv-banner">
              <Codicon name="info" />
              <span>{t('view.truncated')}</span>
            </div>
          )}

          {!review.running && deep?.report.ok && deep.report.summary && (
            <aside className="adv-summary" aria-label={t('view.summary')}>
              <div className="adv-summary-body">
                <span className="adv-summary-label">
                  {t(deepCurrent ? 'view.summaryLabel' : 'view.summaryLabelOutdated', {
                    time: relativeTime(deep.analyzedAt)
                  })}
                </span>
                <p>{deep.report.summary}</p>
              </div>
            </aside>
          )}

          <div className="adv-workspace" ref={workspaceRef}>
            <IssuesPanel
              tab={tab}
              onTab={(next) => {
                setTab(next)
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
