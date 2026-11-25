/**
 * How supporting items read in the interface: a model's summary and sources,
 * what changes, and the checks and problems Fabricator found. Shared by the
 * review card in the chat and Blueprint's Supporting items view.
 */
import type {
  SupportingChange,
  SupportingCheck,
  SupportingProblem,
  SupportingSource,
  SupportingSummary
} from '@shared/ipc'
import { formatList, formatLocale, translator } from '../../i18n'
import { formatBytes } from '../blueprint/localData'

const tr = (): ReturnType<typeof translator<'supporting'>> => translator('supporting')

/** A translation that falls back to `fallback` when the catalog has no `key`. */
function known(key: string, values: Record<string, unknown>, fallback: () => string): string {
  const text = tr()(key as 'check.other', values as { code: string })
  return text === key || !text ? fallback() : text
}

/** "Semantic model". */
export function itemTypeLabel(type: string): string {
  return known(`itemType.${type}`, {}, () => type)
}

/** The icon Blueprint gives a type of item: a semantic model's, or a lakehouse's. */
export function itemIcon(type: string): string {
  return type === 'Lakehouse' ? 'folder-library' : 'graph'
}

/** A table's data at a glance: "orders.csv · 2.1 MB · 12,345 rows", or a folder's file count. */
export function tableLine(table: {
  source: string
  bytes: number
  rows?: number
  files?: number
}): string {
  const t = tr()
  const leaf = table.source.split('/').filter(Boolean).pop() ?? table.source
  const parts = [
    (table.files ?? 1) > 1 ? t('table.files', { name: leaf, count: table.files }) : leaf,
    formatBytes(table.bytes)
  ]
  if (table.rows !== undefined) {
    const rows = table.rows.toLocaleString(formatLocale())
    parts.push(t('table.rows', { count: table.rows, rows }))
  }
  return parts.join(' · ')
}

/** "4 tables · 23 columns · 12 measures · 3 relationships". */
export function countsLine(summary: SupportingSummary): string {
  const t = tr()
  return [
    t('counts.tables', { count: summary.tables }),
    t('counts.columns', { count: summary.columns }),
    t('counts.measures', { count: summary.measures }),
    ...(summary.relationships > 0
      ? [t('counts.relationships', { count: summary.relationships })]
      : [])
  ].join(' · ')
}

/** "Snowflake (xy12345.snowflakecomputing.com · COMPUTE_WH)", values entered in the model, or the app's lakehouse. */
export function sourceLabel(source: SupportingSource): string {
  if (source.function === '#table') return tr()('enteredData')
  if (source.item) return tr()('lakehouseSource', { name: source.item })
  // A OneLake address says nothing more to the user than its kind.
  if (/onelake\./i.test(source.args[0] ?? '')) return source.kind
  const detail = source.local
    ? tr()('localSource')
    : source.args.filter(Boolean).slice(0, 2).join(' · ')
  return detail ? `${source.kind} (${detail})` : source.kind
}

/** "Import from Snowflake (…)", or just the storage mode or the sources. */
export function storageLine(summary: SupportingSummary): string {
  const storage = summary.storage
    ? known(`storage.${summary.storage}`, {}, () => summary.storage ?? '')
    : ''
  const sources = summary.sources.length
    ? tr()('fromSource', { source: formatList(summary.sources.map(sourceLabel)) })
    : ''
  return [storage, sources].filter(Boolean).join(' ')
}

/** "Changes the measure Sales[Total Revenue] (expression)". */
export function changeText(change: SupportingChange): string {
  const name =
    change.table && change.kind !== 'table' ? `${change.table}[${change.name}]` : change.name
  const text = known(`change.${change.op}.${change.kind}`, { name }, () => name)
  return change.op === 'changed' && change.fields.length
    ? `${text} ${tr()('change.fields', { fields: change.fields.join(', ') })}`
    : text
}

/** What a check found, in a sentence. */
export function checkText(check: SupportingCheck): string {
  const values = {
    table: check.table ?? '',
    column: check.column ?? '',
    detail: check.detail ?? '',
    code: check.code
  }
  return known(`check.${check.code}`, values, () => tr()('check.other', values))
}

/** What stops an item from being applied, in a sentence. */
export function problemText(problem: SupportingProblem): string {
  const values = {
    file: problem.file ?? '',
    line: problem.line ?? '',
    table: problem.table ?? '',
    column: problem.column ?? '',
    detail: problem.detail ?? '',
    code: problem.code
  }
  return known(`problem.${problem.code}`, values, () => tr()('problem.other', values)).trim()
}
