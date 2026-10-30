/**
 * Quick-check rule plumbing: the shape rule implementations return, and how
 * their hits become one grouped, evidence-backed finding per rule.
 */
import type { AdvisorFinding, AdvisorRuleDef, AdvisorSeverity } from '@shared/ipc'
import { normalizeSeverity, severityRank } from '@shared/advisor/catalog'
import type { QuickContext } from './context'
import { maskSecrets } from './mask'

/** One place a quick rule failed. */
export interface QuickHit {
  file?: string
  /** 1-based line of the evidence. */
  line?: number
  endLine?: number
  /** Short name of what's affected (e.g. `Todo.title`), used in grouped details. */
  label: string
  /** One sentence describing this instance. */
  message: string
  /** Overrides the rule's default severity for this instance. */
  severity?: AdvisorSeverity
  /** Custom excerpt (e.g. already masked), instead of the file window. */
  excerpt?: { text: string; start: number }
}

export interface QuickRuleImpl {
  id: string
  /**
   * Hits (empty = pass), `'na'` when the rule doesn't apply to this project, or
   * `'skipped'` when it couldn't be checked (e.g. versions unavailable offline).
   */
  run(ctx: QuickContext): QuickHit[] | 'na' | 'skipped'
  /** Describe several hits in one sentence (defaults to a list of labels). */
  summarize?(hits: QuickHit[], ctx: QuickContext): string
}

const CONTEXT_LINES = 2
const MAX_EXCERPT_LINES = 14
const MAX_LABELS = 6

/** The lines around `line..endLine` (1-based) with a little context, capped. */
export function excerptWindow(
  text: string,
  line: number,
  endLine = line
): { text: string; start: number } {
  const lines = text.split(/\r?\n/)
  const last = Math.max(1, lines.length)
  const from = Math.max(1, Math.min(line, last) - CONTEXT_LINES)
  let to = Math.min(last, Math.max(endLine, line) + CONTEXT_LINES)
  if (to - from + 1 > MAX_EXCERPT_LINES) to = from + MAX_EXCERPT_LINES - 1
  return { text: lines.slice(from - 1, to).join('\n'), start: from }
}

export function listLabels(hits: QuickHit[]): string {
  const labels = [...new Set(hits.map((h) => h.label))]
  const shown = labels.slice(0, MAX_LABELS).join(', ')
  return labels.length > MAX_LABELS ? `${shown}, and ${labels.length - MAX_LABELS} more` : shown
}

/** Group a rule's hits into one finding, anchored on the most severe hit. */
export function toFinding(
  rule: AdvisorRuleDef,
  impl: QuickRuleImpl,
  hits: QuickHit[],
  ctx: QuickContext
): AdvisorFinding {
  const sorted = [...hits].sort(
    (a, b) =>
      severityRank(a.severity ?? rule.severity) - severityRank(b.severity ?? rule.severity) ||
      (a.file ?? '').localeCompare(b.file ?? '') ||
      (a.line ?? 0) - (b.line ?? 0)
  )
  const primary = sorted[0]
  const severity = normalizeSeverity(primary.severity ?? rule.severity)
  const detail =
    sorted.length === 1
      ? primary.message
      : (impl.summarize?.(sorted, ctx) ??
        `Found in ${sorted.length} places: ${listLabels(sorted)}.`)

  let excerpt: string | undefined
  let excerptStart: number | undefined
  if (primary.excerpt) {
    excerpt = primary.excerpt.text
    excerptStart = primary.excerpt.start
  } else if (primary.file && primary.line) {
    const text = ctx.snapshot.contents[primary.file]
    if (text !== undefined) {
      const win = excerptWindow(text, primary.line, primary.endLine)
      excerpt = maskSecrets(win.text)
      excerptStart = win.start
    }
  }

  return {
    id: `quick:${rule.id}`,
    ruleId: rule.id,
    category: rule.category,
    severity,
    source: 'quick',
    title: rule.title,
    detail,
    recommendation: rule.fix,
    file: primary.file,
    line: primary.line,
    endLine: primary.endLine && primary.endLine !== primary.line ? primary.endLine : undefined,
    excerpt,
    excerptStart,
    verified: true,
    locations: sorted.slice(1).map((h) => ({ file: h.file ?? '', line: h.line, label: h.label })).filter((l) => l.file)
  }
}
