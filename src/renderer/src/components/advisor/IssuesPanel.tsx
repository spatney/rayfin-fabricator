import { useMemo, useRef, type KeyboardEvent, type ReactNode, type JSX } from 'react'
import type { AdvisorResolved } from '@shared/ipc'
import { categoryById, normalizeSeverity, severityLabel } from '@shared/advisor/catalog'
import type { FindingItem, FindingStatus } from '../../advisor/lifecycle'
import { ChevronRightIcon, Codicon } from '../icons'
import { CategoryIcon, CodeText, plainText, plural, relativeTime } from './format'

export type IssueTab = 'open' | 'new' | 'resolved' | 'dismissed'

const STATUS_CHIP: Partial<Record<FindingStatus, { label: string; tone: string }>> = {
  fixing: { label: 'Fixing…', tone: 'busy' },
  checking: { label: 'Checking fix…', tone: 'busy' },
  applied: { label: 'Fix applied', tone: 'applied' },
  still: { label: 'Still detected', tone: 'still' },
  muted: { label: 'Rule muted', tone: 'muted' }
}

const GROUPS: { key: string; title: string }[] = [
  { key: 'high', title: 'High' },
  { key: 'medium', title: 'Medium' },
  { key: 'low', title: 'Low' },
  { key: 'note', title: 'Suggestions' }
]

const TABS: { key: IssueTab; label: string }[] = [
  { key: 'open', label: 'Open' },
  { key: 'new', label: 'New' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'dismissed', label: 'Dismissed' }
]

function StatusChip({ item }: { item: FindingItem }): JSX.Element | null {
  if (item.status === 'dismissed') {
    const label = item.dismissal?.reason === 'false-positive' ? 'False positive' : 'Accepted risk'
    return <span className="adv-status adv-status--muted">{label}</span>
  }
  const chip = STATUS_CHIP[item.status]
  if (!chip) return null
  return (
    <span className={`adv-status adv-status--${chip.tone}`}>
      {chip.tone === 'busy' && <span className="step-spin" aria-hidden="true" />}
      {chip.label}
    </span>
  )
}

function SourceIcon({ ai }: { ai: boolean }): JSX.Element {
  return (
    <span className="adv-source" title={ai ? 'Found by Copilot’s deep review' : 'Found by a quick check'}>
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
  const f = item.finding
  const sev = normalizeSeverity(f.severity)
  const count = 1 + (f.locations?.length ?? 0)
  const where = f.file ? (f.line ? `${f.file}:${f.line}` : f.file) : undefined
  const category = categoryById(f.category)?.title ?? f.category
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
            aria-label={`Select “${plainText(f.title)}”`}
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
            title={severityLabel(sev)}
            aria-label={`${severityLabel(sev)} severity`}
          />
          <span className="adv-issue-main">
            <span className="adv-issue-title">
              <CodeText text={f.title} />
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
            {item.isNew && <span className="adv-badge adv-badge--new">New</span>}
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

function resolvedHow(r: AdvisorResolved): string {
  if (r.via === 'verify') return 'Verified fixed'
  if (r.fixedByCopilot) return 'Fixed by Copilot'
  return r.via === 'review' ? 'Not found in the latest review' : 'No longer detected'
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
    <section className="adv-card adv-issues" aria-label="Issues">
      <header className="adv-card-head adv-issues-head">
        <div className="adv-seg" role="tablist" aria-label="Show">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={`adv-seg-btn${tab === t.key ? ' is-on' : ''}`}
              onClick={() => onTab(t.key)}
            >
              {t.label}
              {counts[t.key] > 0 && <span className="adv-seg-count">{counts[t.key]}</span>}
            </button>
          ))}
        </div>
        <label className="adv-search">
          <Codicon name="search" />
          <input
            type="search"
            placeholder="Search issues"
            aria-label="Search issues"
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
          {allChecked ? 'Clear selection' : `Select all ${plural(items.length, 'issue')}`}
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
                          <CodeText text={r.title} />
                        </span>
                        <span className="adv-issue-meta">
                          <CategoryIcon id={r.category} className="adv-issue-cat" />
                          {resolvedHow(r)} · {relativeTime(r.at)}
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
                  Clear this list
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
                {g.title} <span className="adv-group-count">{g.items.length}</span>
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
