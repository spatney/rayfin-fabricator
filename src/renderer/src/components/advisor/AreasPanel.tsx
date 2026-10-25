import { useMemo, useState, type JSX } from 'react'
import type { AdvisorCategoryId } from '@shared/ipc'
import { RULES, ruleById } from '@shared/advisor/catalog'
import {
  isIssueOutcome,
  outcomeRank,
  type CategorySummary,
  type CheckOutcome,
  type CheckView
} from '../../advisor/lifecycle'
import { ChevronRightIcon, Codicon } from '../icons'
import { CategoryIcon, CodeText, plural } from './format'

const CATALOG_ORDER = new Map(RULES.map((r, i) => [r.id, i]))

type AreaTone = 'high' | 'medium' | 'low' | 'note' | 'running' | 'pending' | 'skipped' | 'pass' | 'na' | 'loading'

interface AreaCounts {
  high: number
  medium: number
  low: number
  note: number
  passed: number
  dismissed: number
  skipped: number
  waiting: number
  running: boolean
  applicable: number
}

function countArea(checks: CheckView[]): AreaCounts {
  const n: AreaCounts = {
    high: 0,
    medium: 0,
    low: 0,
    note: 0,
    passed: 0,
    dismissed: 0,
    skipped: 0,
    waiting: 0,
    running: false,
    applicable: 0
  }
  for (const c of checks) {
    if (c.outcome === 'na') continue
    n.applicable++
    n[c.outcome]++
    if (c.running) n.running = true
  }
  return n
}

/** The area's one-line status and its tone. */
export function areaStatus(n: AreaCounts, loading: boolean): { text: string; tone: AreaTone } {
  if (loading) return { text: 'Checking…', tone: 'loading' }
  if (n.applicable === 0) return { text: 'Doesn’t apply to this app', tone: 'na' }
  const issues = n.high + n.medium + n.low
  const parts: string[] = []
  if (issues) parts.push(plural(issues, 'issue'))
  if (n.note) parts.push(plural(n.note, 'suggestion'))
  if (n.passed) parts.push(`${n.passed} passed`)
  if (n.dismissed) parts.push(`${n.dismissed} dismissed`)
  if (n.skipped) parts.push(`${n.skipped} not checked`)
  if (n.waiting) parts.push(n.running ? `${n.waiting} being checked` : `${n.waiting} need a deep review`)
  const text = n.passed === n.applicable ? `All ${plural(n.passed, 'check')} passed` : parts.join(' · ')
  const tone: AreaTone = n.high
    ? 'high'
    : n.medium
      ? 'medium'
      : n.low
        ? 'low'
        : n.waiting
          ? n.running
            ? 'running'
            : 'pending'
          : n.skipped
            ? 'skipped'
            : n.note
              ? 'note'
              : 'pass'
  return { text, tone }
}

/** A small ring showing how many of the area's checks are settled. */
function MiniRing({ done, total }: { done: number; total: number }): JSX.Element {
  const r = 7
  const c = 2 * Math.PI * r
  const dash = total > 0 ? (done / total) * c : 0
  return (
    <svg className="adv-mini-ring" viewBox="0 0 18 18" aria-hidden="true">
      <circle className="adv-mini-ring-track" cx="9" cy="9" r={r} />
      <circle
        className="adv-mini-ring-value"
        cx="9"
        cy="9"
        r={r}
        strokeDasharray={`${dash} ${c}`}
        transform="rotate(-90 9 9)"
      />
    </svg>
  )
}

function AreaMark({ n, tone }: { n: AreaCounts; tone: AreaTone }): JSX.Element | null {
  const issues = n.high + n.medium + n.low
  if (tone === 'loading') return null
  if (tone === 'na') return <Codicon name="dash" className="adv-area-na" />
  if (issues > 0) return <span className="adv-area-pill">{issues}</span>
  if (n.waiting > 0 || n.skipped > 0) {
    return <MiniRing done={n.applicable - n.waiting - n.skipped} total={n.applicable} />
  }
  return <Codicon name="pass-filled" className="adv-area-ok" />
}

const GLYPH: Record<CheckOutcome, string> = {
  high: 'error',
  medium: 'error',
  low: 'error',
  note: 'lightbulb',
  waiting: 'circle-large-outline',
  skipped: 'question',
  dismissed: 'eye-closed',
  passed: 'pass-filled',
  na: 'dash'
}

function CheckRow({
  check,
  onShowIssue,
  onOpenUrl
}: {
  check: CheckView
  onShowIssue: (findingId: string) => void
  onOpenUrl: (url: string) => void
}): JSX.Element | null {
  const rule = ruleById(check.ruleId)
  if (!rule) return null
  const note =
    check.outcome === 'waiting'
      ? check.running
        ? 'Copilot is checking this now.'
        : 'Waiting for a deep review.'
      : check.outcome === 'dismissed'
        ? 'Dismissed for this app.'
        : check.outcome === 'skipped'
          ? check.note || 'Couldn’t be checked this time.'
          : check.outcome === 'na'
            ? undefined
            : check.note
  const ai = rule.engine === 'ai'
  return (
    <li className={`adv-check adv-check--${check.outcome}${check.running ? ' is-running' : ''}`}>
      <Codicon name={GLYPH[check.outcome]} className="adv-check-glyph" />
      <span className="adv-check-text">
        <span className="adv-check-title">
          <CodeText text={rule.summary} />
        </span>
        {note && <span className="adv-check-note">{note}</span>}
        {check.findingId && isIssueOutcome(check.outcome) && (
          <button type="button" className="adv-link adv-check-issue" onClick={() => onShowIssue(check.findingId!)}>
            View issue <Codicon name="arrow-right" />
          </button>
        )}
        {check.findingId && check.outcome === 'note' && (
          <button type="button" className="adv-link adv-check-issue" onClick={() => onShowIssue(check.findingId!)}>
            View suggestion <Codicon name="arrow-right" />
          </button>
        )}
      </span>
      <span className="adv-check-side">
        <button
          type="button"
          className="adv-check-doc"
          onClick={() => onOpenUrl(rule.docs[0].url)}
          title={`Learn more: ${rule.docs[0].title}`}
          aria-label={`Learn more about “${rule.title}”`}
        >
          <Codicon name="link-external" />
        </button>
        {ai && (
          <span className="adv-source" title="Checked by Copilot’s deep review">
            <Codicon name="sparkle" />
          </span>
        )}
      </span>
    </li>
  )
}

function AreaChecks({
  checks,
  onShowIssue,
  onOpenUrl
}: {
  checks: CheckView[]
  onShowIssue: (findingId: string) => void
  onOpenUrl: (url: string) => void
}): JSX.Element {
  const [showNa, setShowNa] = useState(false)
  const sorted = useMemo(
    () =>
      checks
        .filter((c) => c.outcome !== 'na')
        .sort(
          (a, b) =>
            outcomeRank(a.outcome) - outcomeRank(b.outcome) ||
            (CATALOG_ORDER.get(a.ruleId) ?? 0) - (CATALOG_ORDER.get(b.ruleId) ?? 0)
        ),
    [checks]
  )
  const na = checks.filter((c) => c.outcome === 'na')
  return (
    <div className="adv-checks">
      {sorted.length > 0 && (
        <ul className="adv-checks-list">
          {sorted.map((c) => (
            <CheckRow key={c.ruleId} check={c} onShowIssue={onShowIssue} onOpenUrl={onOpenUrl} />
          ))}
        </ul>
      )}
      {na.length > 0 && (
        <>
          <button
            type="button"
            className="adv-checks-na"
            aria-expanded={showNa}
            onClick={() => setShowNa((s) => !s)}
          >
            <ChevronRightIcon className="adv-checks-na-caret" />
            {plural(na.length, 'check')} {na.length === 1 ? 'doesn’t' : 'don’t'} apply to this app
          </button>
          {showNa && (
            <ul className="adv-checks-list adv-checks-list--na">
              {na.map((c) => (
                <CheckRow key={c.ruleId} check={c} onShowIssue={onShowIssue} onOpenUrl={onOpenUrl} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

/**
 * Every area the Advisor covers, with its status at a glance. Opening an area
 * lists each rule it checks — what passed (and Copilot's note on why), what's
 * waiting on a deep review, and links to the issues it found.
 */
export function AreasPanel({
  categories,
  checks,
  loading,
  open,
  onToggle,
  onShowIssue,
  onOpenUrl
}: {
  categories: CategorySummary[]
  checks: CheckView[]
  loading: boolean
  open: ReadonlySet<AdvisorCategoryId>
  onToggle: (id: AdvisorCategoryId) => void
  onShowIssue: (findingId: string) => void
  onOpenUrl: (url: string) => void
}): JSX.Element {
  const byArea = useMemo(() => {
    const map = new Map<string, CheckView[]>()
    for (const c of checks) {
      const list = map.get(c.category)
      if (list) list.push(c)
      else map.set(c.category, [c])
    }
    return map
  }, [checks])
  const settled = checks.filter((c) => c.outcome !== 'na' && c.outcome !== 'waiting').length
  const applicable = checks.filter((c) => c.outcome !== 'na').length

  return (
    <section className="adv-card adv-areas" aria-label="Checks by area">
      <header className="adv-card-head">
        <h3 className="adv-card-title">Checks by area</h3>
        {!loading && (
          <span className="adv-card-sub">
            {settled} of {applicable} checked
          </span>
        )}
      </header>
      <ul className="adv-areas-list">
        {categories.map((c) => {
          const list = byArea.get(c.id) ?? []
          const n = countArea(list)
          const status = areaStatus(n, loading)
          const isOpen = open.has(c.id)
          return (
            <li key={c.id} className={`adv-area adv-area--${status.tone}${isOpen ? ' is-open' : ''}`}>
              <button
                type="button"
                className="adv-area-btn"
                aria-expanded={isOpen}
                onClick={() => onToggle(c.id)}
                title={status.text}
              >
                <span className="adv-area-icon" aria-hidden="true">
                  <CategoryIcon id={c.id} />
                </span>
                <span className="adv-area-text">
                  <span className="adv-area-title">{c.title}</span>
                  <span className="adv-area-status">{status.text}</span>
                </span>
                <span className="adv-area-mark">
                  <AreaMark n={n} tone={status.tone} />
                </span>
                <ChevronRightIcon className="adv-area-caret" />
              </button>
              {isOpen && !loading && <AreaChecks checks={list} onShowIssue={onShowIssue} onOpenUrl={onOpenUrl} />}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
