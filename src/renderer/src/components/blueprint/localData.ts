import type { LocalColumn, LocalFile } from '@shared/ipc'
import type { DataModel } from '../../model/parseSchema'

/** Rows the Data view reads at a time (the control API allows up to 500). */
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

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' })
const DATE_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short'
})

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

/** A date-time in the local time zone; a date alone as written. */
export function formatDate(text: string): string | null {
  const time = Date.parse(text)
  if (Number.isNaN(time)) return null
  return (DATE_ONLY.test(text) ? DATE_FORMAT : DATE_TIME_FORMAT).format(time)
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
 * A value as the Data view shows it, by its column's type and its own:
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
  if (text === '') return { kind: 'empty', text: '""', title: 'Empty text' }
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

/** `1 row`, `1,204 rows`. */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`
}

/** `A`, `A and B`, `A, B and C`. */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

const BYTE_UNITS = ['KB', 'MB', 'GB']

/** `512 bytes`, `1.5 KB`, `12 MB`: a file's size, in 1,024s. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes === 1 ? '1 byte' : `${bytes.toLocaleString('en-US')} bytes`
  let value = bytes
  let unit = ''
  for (const next of BYTE_UNITS) {
    value /= 1024
    unit = next
    if (value < 1024) break
  }
  return `${value < 10 ? value.toFixed(1).replace(/\.0$/, '') : Math.round(value)} ${unit}`
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
