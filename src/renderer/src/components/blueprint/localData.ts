import type { LocalColumn, LocalFile } from '@shared/ipc'
import { formatList, formatLocale, translator } from '../../i18n'
import type { DataModel } from '../../model/parseSchema'

/** Rows the Data explorer reads at a time (the control API allows up to 500). */
export const PAGE_SIZE = 50

/** The first row of the last page of `total` rows (or files). */
export function lastPage(total: number): number {
  return total > 0 ? Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE : 0
}

/** The most of a value a cell renders; the full value is on hover. */
const MAX_CELL_TEXT = 300

const NUMBER_TYPE =
  /^(int\d*|integer|bigint|smallint|tinyint|long|short|byte|single|decimal|numeric|money|float\d*|double|real|number)$/i
const BOOLEAN_TYPE = /^(boolean|bool|bit)$/i
const DATE_TYPE = /date|time/i
const ID_TYPE = /^(uuid|uniqueidentifier|guid)$/i
const JSON_TYPE = /^jsonb?$/i
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/** The date and date-time formatters, per locale. */
const DATE_FORMATS = new Map<string, Intl.DateTimeFormat>()

function dateFormat(dateOnly: boolean): Intl.DateTimeFormat {
  const locale = formatLocale()
  const key = `${dateOnly ? 'date' : 'time'} ${locale}`
  let format = DATE_FORMATS.get(key)
  if (!format) {
    format = new Intl.DateTimeFormat(
      locale,
      dateOnly
        ? { dateStyle: 'medium', timeZone: 'UTC' }
        : { dateStyle: 'medium', timeStyle: 'short' }
    )
    DATE_FORMATS.set(key, format)
  }
  return format
}

export type CellKind = 'null' | 'empty' | 'boolean' | 'number' | 'date' | 'json' | 'id' | 'text'

/** How a cell shows a value: its text, and the full value on hover when that says more. */
export interface CellView {
  kind: CellKind
  text: string
  title?: string
}

function clip(text: string): string {
  return text.length > MAX_CELL_TEXT ? `${text.slice(0, MAX_CELL_TEXT)}…` : text
}

/** A date-time in the local time zone; a date alone as written. In the interface's language. */
export function formatDate(text: string): string | null {
  const time = Date.parse(text)
  if (Number.isNaN(time)) return null
  return dateFormat(DATE_ONLY.test(text)).format(time)
}

function json(value: unknown): CellView {
  try {
    return {
      kind: 'json',
      text: clip(JSON.stringify(value)),
      title: JSON.stringify(value, null, 2)
    }
  } catch {
    return { kind: 'text', text: clip(String(value)), title: String(value) }
  }
}

/**
 * A value as the Data explorer shows it, by its column's type and its own:
 * `null` and empty text faintly, booleans and numbers as such, dates in local
 * time, objects as JSON, ids in a monospace font, and text clipped (CSS
 * truncates it further).
 */
export function formatCell(value: unknown, column?: Pick<LocalColumn, 'type'>): CellView {
  const type = column?.type?.trim() ?? ''
  if (value === null || value === undefined) return { kind: 'null', text: 'null' }
  if (typeof value === 'boolean') return { kind: 'boolean', text: String(value) }
  if (typeof value === 'number') {
    if (BOOLEAN_TYPE.test(type) && (value === 0 || value === 1))
      return { kind: 'boolean', text: value === 1 ? 'true' : 'false' }
    return { kind: 'number', text: String(value) }
  }
  if (typeof value === 'object') return json(value)
  const text = String(value)
  if (text === '') return { kind: 'empty', text: '""', title: translator('data')('cell.emptyText') }
  if (DATE_TYPE.test(type)) {
    const date = formatDate(text)
    if (date) return { kind: 'date', text: date, title: text }
  }
  if (NUMBER_TYPE.test(type) && text.trim() !== '' && Number.isFinite(Number(text)))
    return { kind: 'number', text }
  if (JSON_TYPE.test(type)) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed !== null && typeof parsed === 'object') return json(parsed)
    } catch {
      /* not JSON after all: show it as text */
    }
  }
  if (ID_TYPE.test(type)) return { kind: 'id', text: clip(text), title: text }
  return { kind: 'text', text: clip(text), title: text }
}

/** A column whose values line up on the right. */
export function isNumberColumn(column: Pick<LocalColumn, 'type'>): boolean {
  return NUMBER_TYPE.test(column.type.trim())
}

/** `1 row`, `1,204 rows`, in English (for telemetry and callers' English words). */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`
}

/** `A`, `A and B`, `A, B and C`, in the interface's language. */
export function listNames(names: string[]): string {
  return formatList(names)
}

const BYTE_UNITS = ['size.kilobytes', 'size.megabytes', 'size.gigabytes'] as const

/** `512 bytes`, `1.5 KB`, `12 MB`: a file's size, in 1,024s, in the interface's language. */
export function formatBytes(bytes: number): string {
  const t = translator('data')
  if (bytes < 1024) return t('size.bytes', { count: bytes })
  let value = bytes
  let unit: (typeof BYTE_UNITS)[number] = BYTE_UNITS[0]
  for (const next of BYTE_UNITS) {
    value /= 1024
    unit = next
    if (value < 1024) break
  }
  // One decimal under 10 (`1.5 KB`, `2 KB`), whole numbers from there (`12 MB`, `2048 GB`).
  const size = value.toLocaleString(formatLocale(), {
    maximumFractionDigits: value < 10 ? 1 : 0,
    useGrouping: false
  })
  return t(unit, { size })
}

/** How a stored file previews. */
export type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'none'

const TEXT_TYPE =
  /^text\/|^application\/(json|xml|javascript|x-javascript|ecmascript|yaml|x-yaml|toml|sql|graphql|x-ndjson|csv)$|\+(json|xml|yaml)$/
const EXTENSION_KIND: Record<string, PreviewKind> = {
  ...Object.fromEntries(
    ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg'].map((e) => [e, 'image'])
  ),
  ...Object.fromEntries(['mp4', 'webm', 'mov', 'm4v'].map((e) => [e, 'video'])),
  ...Object.fromEntries(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac'].map((e) => [e, 'audio'])),
  pdf: 'pdf',
  ...Object.fromEntries(
    [
      'txt',
      'md',
      'csv',
      'tsv',
      'json',
      'xml',
      'yaml',
      'yml',
      'log',
      'html',
      'css',
      'js',
      'ts',
      'sql'
    ].map((e) => [e, 'text'])
  )
}

/**
 * How `file` previews, by its content type; by its name's extension when the
 * type says nothing (`application/octet-stream`, which uploads without a type get).
 */
export function previewKind(file: Pick<LocalFile, 'contentType' | 'name'>): PreviewKind {
  const type = file.contentType.split(';')[0].trim().toLowerCase()
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/')) return 'audio'
  if (type === 'application/pdf') return 'pdf'
  if (TEXT_TYPE.test(type)) return 'text'
  if (type === '' || type === 'application/octet-stream') {
    const extension = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? ''
    return EXTENSION_KIND[extension] ?? 'none'
  }
  return 'none'
}

/**
 * The entities whose rows refer to `entity`'s rows, from the data model: those
 * with a key to it (`@one`, or a `<name>_id` field), and the targets of its
 * `@many` relations. Rows that refer to themselves don't count.
 */
export function referrersOf(model: DataModel | undefined, entity: string): string[] {
  if (!model) return []
  const shown = new Map(model.entities.map((e) => [e.name, e.customName || e.name]))
  const target =
    model.entities.find((e) => e.name === entity || e.customName === entity)?.name ?? entity
  const found = new Set<string>()
  for (const relation of model.relations) {
    const referrer =
      relation.kind === 'many'
        ? relation.from === target
          ? relation.to
          : null
        : relation.to === target
          ? relation.from
          : null
    if (referrer && referrer !== target) found.add(shown.get(referrer) ?? referrer)
  }
  return [...found]
}
