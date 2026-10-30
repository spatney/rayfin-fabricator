import type { ModelEntity, SourceDecorator, EntityPermission } from '../../model/parseSchema'
import { permissionFromDecorator } from '../../model/parseSchema'
import type { QuickContext } from '../context'
import type { QuickHit } from '../quick'
import { lineOf, matchAll, type SourceFile } from '../source'

export const CODE_FILE = /\.(tsx?|jsx?|mts|cts|mjs|cjs)$/i

/** `access`, `owner`, … as inline code for messages. */
export function code(text: string): string {
  return `\`${text}\``
}

/** Items as a person lists them: "a, b and c". */
export function andList(items: string[]): string {
  return items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** One hit per regex match in each source (masked, so comments don't count). */
export function regexHits(
  files: SourceFile[],
  re: RegExp,
  message: (file: SourceFile, match: RegExpExecArray) => string,
  label?: (file: SourceFile, line: number, match: RegExpExecArray) => string
): QuickHit[] {
  const hits: QuickHit[] = []
  for (const src of files) {
    for (const m of matchAll(re, src.masked)) {
      const line = lineOf(src, m.index)
      hits.push({
        file: src.path,
        line,
        label: label ? label(src, line, m) : `${src.path}:${line}`,
        message: message(src, m)
      })
    }
  }
  return hits
}

export interface Grant {
  decorator: SourceDecorator
  permission: EntityPermission
}

/** The entity's permission decorators, each with its line. */
export function grantsOf(entity: ModelEntity): Grant[] {
  const out: Grant[] = []
  for (const decorator of entity.decorators ?? []) {
    const permission = permissionFromDecorator(decorator.name, decorator.args)
    if (permission) out.push({ decorator, permission })
  }
  return out
}

const WRITE_ACTIONS = new Set(['create', 'update', 'delete', '*'])

export function grantsWrite(permission: EntityPermission): boolean {
  return permission.actions.some((a) => WRITE_ACTIONS.has(a))
}

export function actionsLabel(permission: EntityPermission): string {
  return permission.actions.map((a) => `'${a}'`).join(', ')
}

/** 1-based line of `package.json`'s entry for `name`, if present. */
export function packageLine(ctx: QuickContext, name: string): number | undefined {
  const text = ctx.snapshot.contents['package.json']
  if (text === undefined) return undefined
  const i = text.indexOf(`"${name}"`)
  return i < 0 ? undefined : text.slice(0, i).split('\n').length
}

/** 1-based line of the first line in `text` containing `needle`. */
export function lineContaining(text: string, needle: string): number | undefined {
  const i = text.indexOf(needle)
  return i < 0 ? undefined : text.slice(0, i).split('\n').length
}
