/**
 * Quick-check rule plumbing: the shape rule implementations return, and how
 * their hits become one grouped, evidence-backed finding per rule.
 */
import type { TFunction } from 'i18next'
import type { AdvisorFinding, AdvisorRuleDef, AdvisorSeverity } from '@shared/ipc'
import { normalizeSeverity, severityRank } from '@shared/advisor/catalog'
import { currentLanguage, formatList, formatLocale, i18n, translator } from '../i18n'
import type { QuickContext } from './context'
import { maskSecrets } from './mask'
import { andList } from './rules/util'

/**
 * A quick check's sentence: in English, which Copilot reads, and in the
 * interface's language, which is shown.
 */
export interface Said {
  message: string
  text: string
}

/** What a sentence is built with, in one language (the `advisorChecks` catalog's). */
export interface Words {
  t: TFunction<'advisorChecks'>
  /** Items as a person lists them: English "a, b and c" (andList); else Intl list format. */
  list(items: readonly string[]): string
  /** Items one after another: "a, b, c". */
  join(items: readonly string[]): string
  /** A number as the language writes it (English: en-US grouping). */
  number(n: number): string
}

function englishWords(): Words {
  const t = i18n.getFixedT('en', 'advisorChecks')
  return {
    t,
    list: andList,
    join: (items) => items.join(t('common.separator')),
    number: (n) => n.toLocaleString('en-US')
  }
}

function shownWords(): Words {
  const t = translator('advisorChecks')
  return {
    t,
    list: (items) => formatList(items),
    join: (items) => items.join(t('common.separator')),
    number: (n) => n.toLocaleString(formatLocale())
  }
}

/**
 * A sentence in English and in the interface's language: `build` writes it
 * with one language's words, and is called once for each (once in English).
 */
export function say(build: (w: Words) => string): Said {
  const message = build(englishWords())
  return { message, text: currentLanguage() === 'en' ? message : build(shownWords()) }
}

/** One place a quick rule failed. */
export interface QuickHit {
  file?: string
  /** 1-based line of the evidence. */
  line?: number
  endLine?: number
  /** Short name of what's affected (e.g. `Todo.title`), used in grouped details. */
  label: string
  /** One sentence describing this instance, in English (Copilot reads it). */
  message: string
  /** The sentence in the interface's language (`message` when absent). */
  text?: string
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
  summarize?(hits: QuickHit[], ctx: QuickContext): Said
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

/** The first `max` items, then how many more: English "a, b, c, and 2 more". */
export function listSome(items: readonly string[], w: Words, max = MAX_LABELS): string {
  const shown = w.join(items.slice(0, max))
  const more = items.length - max
  return more > 0 ? w.t('common.andMore', { items: shown, count: more }) : shown
}

/** The hits' labels, in English unless `w` is another language's words. */
export function listLabels(hits: QuickHit[], w: Words = englishWords()): string {
  return listSome([...new Set(hits.map((h) => h.label))], w)
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
  const said: Said =
    sorted.length === 1
      ? { message: primary.message, text: primary.text ?? primary.message }
      : (impl.summarize?.(sorted, ctx) ??
        say((w) => w.t('common.places', { count: sorted.length, labels: listLabels(sorted, w) })))

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
    detail: said.message,
    ...(said.text !== said.message ? { detailText: said.text } : {}),
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
