import { useMemo, useRef, type KeyboardEvent, type ReactNode, type JSX } from 'react'
import type { AdvisorResolved } from '@shared/ipc'
import { normalizeSeverity } from '@shared/advisor/catalog'
import type { FindingItem, FindingStatus } from '../../advisor/lifecycle'
import { categoryTitle, findingTitle } from '../../advisor/ruleText'
import { useTranslation } from '../../i18n'
import { ChevronRightIcon, Codicon } from '../icons'
import { CategoryIcon, CodeText, plainText, relativeTime } from './format'

export type IssueTab = 'open' | 'new' | 'resolved' | 'dismissed'

/** The chip for where an issue stands, if it isn't simply open (or dismissed). */
function statusChip(status: FindingStatus) {
  switch (status) {
    case 'fixing':
      return { label: 'issues.status.fixing', tone: 'busy' } as const
    case 'checking':
      return { label: 'issues.status.checkingFix', tone: 'busy' } as const
    case 'applied':
      return { label: 'issues.status.applied', tone: 'applied' } as const
    case 'still':
      return { label: 'issues.status.still', tone: 'still' } as const
    case 'muted':
      return { label: 'issues.status.muted', tone: 'muted' } as const
    default:
      return undefined
  }
}

const GROUPS = [
  { key: 'high', title: 'severity.high' },
  { key: 'medium', title: 'severity.medium' },
  { key: 'low', title: 'severity.low' },
  { key: 'note', title: 'issues.groups.suggestions' }
] as const

const TABS = [
  { key: 'open', label: 'issues.tabs.open' },
  { key: 'new', label: 'issues.tabs.new' },
  { key: 'resolved', label: 'issues.tabs.resolved' },
  { key: 'dismissed', label: 'issues.tabs.dismissed' }
] as const satisfies readonly { key: IssueTab; label: string }[]

function StatusChip({ item }: { item: FindingItem }): JSX.Element | null {
  const { t } = useTranslation('advisor')
  if (item.status === 'dismissed') {
    const label =
      item.dismissal?.reason === 'false-positive'
        ? t('detail.falsePositive')
        : t('detail.acceptedRisk')
    return <span className="adv-status adv-status--muted">{label}</span>
  }
  const chip = statusChip(item.status)
  if (!chip) return null
  return (
    <span className={`adv-status adv-status--${chip.tone}`}>
      {chip.tone === 'busy' && <span className="step-spin" aria-hidden="true" />}
      {t(chip.label)}
    </span>
  )
}

function SourceIcon({ ai }: { ai: boolean }): JSX.Element {
  const { t } = useTranslation('advisor')
  return (
    <span className="adv-source" title={ai ? t('detail.foundByDeep') : t('detail.foundByQuick')}>
      <Codicon name={ai ? 'sparkle' : 'zap'} />
    </span>
  )
}

function IssueRow({
  item,
  open,
  checked,
  selectable,
  onToggle,
  onCheck,
  children
}: {
  item: FindingItem
  open: boolean
  checked: boolean
  selectable: boolean
  onToggle: () => void
  onCheck: () => void
  /** The expanded detail. */
  children: ReactNode
}): JSX.Element {
  const { t } = useTranslation('advisor')
  const f = item.finding
  const sev = normalizeSeverity(f.severity)
  const count = 1 + (f.locations?.length ?? 0)
  const where = f.file ? (f.line ? `${f.file}:${f.line}` : f.file) : undefined
  const category = categoryTitle(f.category)
  const hidden = item.status === 'dismissed' || item.status === 'muted'
  return (
    <li
      className={`adv-issue adv-issue--${sev}${open ? ' is-open' : ''}${hidden ? ' is-hidden' : ''}${selectable ? ' has-check' : ''}`}
    >
      <div className="adv-issue-head">
        {selectable && (
          <input
            type="checkbox"
            className="adv-issue-check"
            checked={checked}
            onChange={onCheck}
            aria-label={t('issues.select', { title: plainText(findingTitle(f)) })}
          />
        )}
        <button
          type="button"
          className="adv-issue-btn"
          aria-expanded={open}
          data-finding-id={f.id}
          onClick={onToggle}
        >
          <i
            className={`adv-sev-dot adv-sev-dot--${sev}`}
            title={t(`severity.${sev}`)}
            aria-label={t(`severity.${sev}Aria`)}
          />
          <span className="adv-issue-main">
            <span className="adv-issue-title">
              <CodeText text={findingTitle(f)} />
              {count > 1 && <span className="adv-issue-count">×{count}</span>}
            </span>
            <span className="adv-issue-meta">
              <CategoryIcon id={f.category} className="adv-issue-cat" />
              {category}
              {where && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="adv-issue-where" title={where}>
                    {where}
                  </span>
                </>
              )}
            </span>
          </span>
          <span className="adv-issue-badges">
            {item.isNew && <span className="adv-badge adv-badge--new">{t('issues.new')}</span>}
            <StatusChip item={item} />
            <SourceIcon ai={f.source === 'ai'} />
          </span>
          <ChevronRightIcon className="adv-issue-caret" />
        </button>
      </div>
      {open && <div className="adv-issue-body">{children}</div>}
    </li>
  )
}

function resolvedHow(r: AdvisorResolved) {
  if (r.via === 'verify') return 'issues.verifiedFixed' as const
  if (r.fixedByCopilot) return 'issues.fixedByCopilot' as const
  return r.via === 'review'
    ? ('issues.notFoundInReview' as const)
    : ('issues.noLongerDetected' as const)
}

/**
 * The findings inbox: filter tabs, search, and severity groups whose rows
 * expand in place into the full detail (evidence, fix, explain, verify).
 */
export function IssuesPanel({
  tab,
  onTab,
  counts,
  items,
  resolved,
  openId,
  onToggle,
  checked,
  onCheck,
  onCheckAll,
  query,
  onQuery,
  renderDetail,
  empty,
  onClearResolved
}: {
  tab: IssueTab
  onTab: (tab: IssueTab) => void
  counts: Record<IssueTab, number>
  items: FindingItem[]
  resolved: (AdvisorResolved & { id: string })[]
  openId: string | null
  onToggle: (id: string) => void
  checked: ReadonlySet<string>
  onCheck: (id: string) => void
  onCheckAll: (ids: string[]) => void
  query: string
  onQuery: (q: string) => void
  renderDetail: (item: FindingItem) => ReactNode
  empty: ReactNode
  onClearResolved: () => void
}): JSX.Element {
  const { t } = useTranslation('advisor')
  const bodyRef = useRef<HTMLDivElement>(null)
  const selectable = tab === 'open' || tab === 'new'
  const groups = useMemo(
    () =>
      GROUPS.map((g) => ({ ...g, items: items.filter((i) => normalizeSeverity(i.finding.severity) === g.key) })).filter(
        (g) => g.items.length > 0
      ),
    [items]
  )
  const allIds = items.map((i) => i.finding.id)
  const allChecked = allIds.length > 0 && allIds.every((id) => checked.has(id))
  const someChecked = allIds.some((id) => checked.has(id))

  // ↑/↓ move focus between rows; Enter or Space opens one.
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const buttons = [...(bodyRef.current?.querySelectorAll<HTMLButtonElement>('.adv-issue-btn') ?? [])]
    if (buttons.length === 0) return
    e.preventDefault()
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = buttons[Math.max(0, Math.min(buttons.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
    next.focus()
  }

  return (
    <section className="adv-card adv-issues" aria-label={t('issues.label')}>
      <header className="adv-card-head adv-issues-head">
        <div className="adv-seg" role="tablist" aria-label={t('issues.show')}>
          {TABS.map((option) => (
            <button
              key={option.key}
              type="button"
              role="tab"
              aria-selected={tab === option.key}
              className={`adv-seg-btn${tab === option.key ? ' is-on' : ''}`}
              onClick={() => onTab(option.key)}
            >
              {t(option.label)}
              {counts[option.key] > 0 && (
                <span className="adv-seg-count">{counts[option.key]}</span>
              )}
            </button>
          ))}
        </div>
        <label className="adv-search">
          <Codicon name="search" />
          <input
            type="search"
            placeholder={t('issues.search')}
            aria-label={t('issues.search')}
            value={query}
            onChange={(e) => onQuery(e.target.value)}
          />
        </label>
      </header>

      {selectable && items.length > 1 && (
        <label className="adv-selectall">
          <input
            type="checkbox"
            checked={allChecked}
            ref={(el) => {
              if (el) el.indeterminate = someChecked && !allChecked
            }}
            onChange={() => onCheckAll(allChecked ? [] : allIds)}
          />
          {allChecked ? t('issues.clearSelection') : t('issues.selectAll', { count: items.length })}
        </label>
      )}

      <div className="adv-issues-body" ref={bodyRef} onKeyDown={onKeyDown}>
        {tab === 'resolved' ? (
          resolved.length === 0 ? (
            empty
          ) : (
            <>
              <ul className="adv-issues-list">
                {resolved.map((r) => (
                  <li key={r.id} className="adv-issue adv-issue--resolved">
                    <div className="adv-issue-head adv-issue-head--static">
                      <Codicon name="pass-filled" className="adv-resolved-ico" />
                      <span className="adv-issue-main">
                        <span className="adv-issue-title">
                          <CodeText text={findingTitle(r)} />
                        </span>
                        <span className="adv-issue-meta">
                          <CategoryIcon id={r.category} className="adv-issue-cat" />
                          {t('issues.resolvedMeta', {
                            how: t(resolvedHow(r)),
                            time: relativeTime(r.at)
                          })}
                          {r.file && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="adv-issue-where">{r.file}</span>
                            </>
                          )}
                        </span>
                      </span>
                      {r.fixedByCopilot && <span className="adv-badge adv-badge--copilot">Copilot</span>}
                    </div>
                  </li>
                ))}
              </ul>
              <div className="adv-issues-foot">
                <button type="button" className="adv-link" onClick={onClearResolved}>
                  {t('issues.clearList')}
                </button>
              </div>
            </>
          )
        ) : items.length === 0 ? (
          empty
        ) : (
          groups.map((g) => (
            <div key={g.key} className="adv-group">
              <div className="adv-group-title">
                {t(g.title)} <span className="adv-group-count">{g.items.length}</span>
              </div>
              <ul className="adv-issues-list">
                {g.items.map((item) => (
                  <IssueRow
                    key={item.finding.id}
                    item={item}
                    open={openId === item.finding.id}
                    checked={checked.has(item.finding.id)}
                    selectable={selectable}
                    onToggle={() => onToggle(item.finding.id)}
                    onCheck={() => onCheck(item.finding.id)}
                  >
                    {openId === item.finding.id ? renderDetail(item) : null}
                  </IssueRow>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </section>
  )
}
