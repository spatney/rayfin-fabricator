/**
 * Static parser for a Rayfin project's data model.
 *
 * Rayfin has no schema/introspect CLI command, so the model is recovered by
 * statically reading the file that registers the entities (the aggregator:
 * `rayfin/data/schema.ts`, or a data package's `src/index.ts`; see
 * {@link projectLayout}) and the entity files it references. Entities are plain
 * classes decorated with the `@microsoft/rayfin-core` decorator vocabulary:
 *
 *   - field decorators: uuid/text/email/int/decimal/boolean/date/blob/set, plus
 *     the explicit relations one(() => X) / many(() => X);
 *   - class decorators: entity(name?), role('authenticated'|'anonymous', actions,
 *     { policy, include, exclude }), authenticated(...), anonymous(...).
 *
 * Rather than bundle the multi-megabyte TypeScript compiler into the Tauri
 * WebView just to read a tiny, fully-enumerated DSL, this is a small,
 * dependency-free, depth-aware scanner: it strips comments, skips string
 * literals, and captures balanced `(...)`/`{...}` decorator arguments so nested
 * option objects and arrow-function policies don't trip it up. Unknown
 * decorators degrade gracefully (the field keeps its TypeScript type).
 */

import { projectLayout, SINGLE_PACKAGE_LAYOUT, type ProjectLayout } from './projectLayout'

/** A reader that returns a project file's UTF-8 text, or null if missing/unreadable. */
export type FileReader = (path: string) => Promise<string | null>

/** Semantic field type, derived from the field decorator (falls back to the TS type). */
export type FieldType =
  | 'uuid'
  | 'text'
  | 'email'
  | 'int'
  | 'decimal'
  | 'boolean'
  | 'date'
  | 'blob'
  | 'enum'
  | 'relation'
  | 'unknown'

export interface ModelField {
  name: string
  /** Semantic type from the decorator. */
  type: FieldType
  /** The decorator name as written (e.g. `text`, `one`), if any. */
  decorator?: string
  /** Raw TypeScript type annotation (e.g. `string`, `Date`, `User`). */
  tsType?: string
  /** Nullable — `optional: true` in options, or a `?` on the property. */
  optional: boolean
  /** `unique: true` in the field options. */
  unique?: boolean
  /** True for the `@uuid()` primary key. */
  primaryKey?: boolean
  /** `min`/`max` for text fields. */
  min?: number
  max?: number
  /** Allowed values for a `@set(...)` enum field. */
  enumValues?: string[]
  /** Target entity for an explicit `@one`/`@many` relation. */
  relationTo?: string
  relationKind?: 'one' | 'many'
  /** Target entity inferred from a `<x>_id` foreign-key-by-convention field. */
  fkTo?: string
  /** 1-based line of the property in its file (when parsed from a file). */
  line?: number
  /** The property is declared with a `?` (as opposed to `optional: true`). */
  markedOptional?: boolean
  /** A field decorator sets `optional: true`. */
  optionFlag?: boolean
  /** Every decorator on the property, as written, with its line. */
  decorators?: SourceDecorator[]
}

/** A decorator as written in the source: name, raw argument text, and 1-based line. */
export interface SourceDecorator {
  name: string
  args: string
  line: number
}

/** One role grant on an entity (from @role/@authenticated/@anonymous). */
export interface EntityPermission {
  /** `authenticated`, `anonymous`, or a custom role name. */
  role: string
  /** Granted actions; `*` means all. */
  actions: string[]
  /** True when a row-level `policy` callback narrows access. */
  hasPolicy: boolean
  /** The decorator that declared it (`role`/`authenticated`/`anonymous`). */
  decorator: string
}

/** How broadly an entity's rows are exposed — drives the access badge. */
export type AccessLevel = 'public' | 'authenticated' | 'scoped' | 'mixed' | 'default'

export interface EntityAccess {
  level: AccessLevel
  /** Short badge label, e.g. "Any signed-in user". */
  label: string
  /** Longer explanation for tooltips / chat hand-off. */
  detail: string
}

export interface ModelEntity {
  /** Class name (the GraphQL/type name unless `@entity('Custom')` overrides it). */
  name: string
  /** Optional explicit name from `@entity('Name')`. */
  customName?: string
  /** Project-relative file the class lives in. */
  file: string
  fields: ModelField[]
  permissions: EntityPermission[]
  access: EntityAccess
  /** 1-based line of the `class` declaration in {@link file}. */
  line?: number
  /** Class decorators as written (`@entity`, `@authenticated`, …), with lines. */
  decorators?: SourceDecorator[]
}

export interface ModelRelation {
  /** Owning entity (the one declaring the field). */
  from: string
  /** Referenced entity. */
  to: string
  kind: 'one' | 'many' | 'fk'
  /** The field that expresses the relation. */
  via: string
  /** True for explicit `@one`/`@many`; false for `*_id` convention. */
  explicit: boolean
}

export interface DataModel {
  entities: ModelEntity[]
  relations: ModelRelation[]
  /** Non-fatal issues (unresolved imports, empty schema, etc.). */
  warnings: string[]
  /** True when the file that registers the entities ({@link schemaFile}) exists at all. */
  hasSchema: boolean
  /** Where the entities live: `rayfin/data`, or a data package's `src` folder. */
  dataDir: string
  /** The file that registers the entities: `rayfin/data/schema.ts`, or a data package's `src/index.ts`. */
  schemaFile: string
}

/** A model with no entities, for an app laid out as `layout` (single-package by default). */
export function emptyDataModel(
  layout: Pick<ProjectLayout, 'dataDir' | 'schemaFile'> = SINGLE_PACKAGE_LAYOUT
): DataModel {
  return {
    entities: [],
    relations: [],
    warnings: [],
    hasSchema: false,
    dataDir: layout.dataDir,
    schemaFile: layout.schemaFile
  }
}

/* ------------------------------------------------------------------ *
 * Low-level scanning helpers
 * ------------------------------------------------------------------ */

/**
 * Blank out `//` and block comments while preserving string-literal contents.
 * Comment characters become spaces (newlines are kept), so every offset in the
 * result maps to the same offset — and line — in the original source.
 */
export function maskComments(src: string): string {
  let out = ''
  let i = 0
  const n = src.length
  const blank = (from: number, to: number): string => src.slice(from, to).replace(/[^\n]/g, ' ')
  while (i < n) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      const end = skipString(src, i)
      out += src.slice(i, end)
      i = end
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      const start = i
      while (i < n && src[i] !== '\n') i++
      out += blank(start, i)
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const start = i
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++
      i = Math.min(n, i + 2)
      out += blank(start, i)
      continue
    }
    out += c
    i++
  }
  return out
}

/** Maps string offsets to 1-based line numbers. */
export class LineIndex {
  private readonly starts: number[] = [0]

  constructor(src: string) {
    for (let i = 0; i < src.length; i++) if (src[i] === '\n') this.starts.push(i + 1)
  }

  /** 1-based line containing `offset`. */
  lineAt(offset: number): number {
    let lo = 0
    let hi = this.starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.starts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
}

/** Given `src[i]` is a quote, return the index just past the closing quote. */
export function skipString(src: string, i: number): number {
  const quote = src[i]
  i++
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === quote) return i + 1
    // Template-literal interpolation can contain anything; skip nested ${...}.
    if (quote === '`' && c === '$' && src[i + 1] === '{') {
      i = skipBalanced(src, i + 1, '{', '}')
      continue
    }
    i++
  }
  return i
}

/**
 * Given `src[i]` is the opening delimiter, return the index just past the match,
 * honouring nesting and skipping over string literals.
 */
export function skipBalanced(src: string, i: number, open: string, close: string): number {
  let depth = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(src, i)
      continue
    }
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return i + 1
    }
    i++
  }
  return i
}

const WORD_RE = /[A-Za-z_$][\w$]*/y

/** Read an identifier starting at `i`; returns the word and the next index. */
function readWord(src: string, i: number): { word: string; next: number } {
  WORD_RE.lastIndex = i
  const m = WORD_RE.exec(src)
  if (m && m.index === i) return { word: m[0], next: i + m[0].length }
  return { word: '', next: i }
}

function skipWs(src: string, i: number): number {
  while (i < src.length && /\s/.test(src[i])) i++
  return i
}

export interface RawDecorator {
  name: string
  /** Argument text inside the outer parens (without them); '' when no `()`. */
  args: string
  /** True when the decorator is called (`@text()`), false for a bare `@text`. */
  called?: boolean
  /** Offset of the `@` in the (masked) source. */
  offset: number
}

/** Read a decorator at `src[i] === '@'`; returns it and the next index. */
function readDecorator(src: string, i: number): { deco: RawDecorator; next: number } {
  const offset = i
  i++ // past '@'
  const { word, next } = readWord(src, i)
  i = skipWs(src, next)
  let args = ''
  let called = false
  if (src[i] === '(') {
    const end = skipBalanced(src, i, '(', ')')
    args = src.slice(i + 1, end - 1)
    called = true
    i = end
  }
  return { deco: { name: word, args, called, offset }, next: i }
}

/** Split a comma-separated argument list at top level (depth 0). */
export function splitTopLevel(args: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  let i = 0
  const n = args.length
  while (i < n) {
    const c = args[i]
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(args, i)
      continue
    }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    else if (c === ',' && depth === 0) {
      parts.push(args.slice(start, i).trim())
      start = i + 1
    }
    i++
  }
  const tail = args.slice(start).trim()
  if (tail) parts.push(tail)
  return parts
}

/** Unwrap a leading/trailing quote pair from a string-literal argument. */
export function unquote(s: string): string {
  const t = s.trim()
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'" || t[0] === '`')) {
    return t.slice(1, -1)
  }
  return t
}

/* ------------------------------------------------------------------ *
 * Decorator interpretation
 * ------------------------------------------------------------------ */

const SCALAR_TYPES: Record<string, FieldType> = {
  uuid: 'uuid',
  text: 'text',
  email: 'email',
  int: 'int',
  decimal: 'decimal',
  boolean: 'boolean',
  date: 'date',
  blob: 'blob',
  set: 'enum'
}

const PERMISSION_DECORATORS = new Set(['role', 'authenticated', 'anonymous'])

const PROPERTY_MODIFIERS = new Set([
  'readonly',
  'public',
  'private',
  'protected',
  'static',
  'declare',
  'abstract',
  'override',
  'accessor'
])

/** Pull a numeric option (e.g. `max: 100`) out of a decorator's argument text. */
function numOption(args: string, key: string): number | undefined {
  const m = new RegExp(`\\b${key}\\s*:\\s*(-?\\d+)`).exec(args)
  return m ? Number(m[1]) : undefined
}

/** True when a boolean option is set truthy (e.g. `optional: true`). */
function boolOption(args: string, key: string): boolean {
  return new RegExp(`\\b${key}\\s*:\\s*true\\b`).test(args)
}

interface RawField {
  name: string
  optional: boolean
  tsType?: string
  decorators: RawDecorator[]
  /** Offset of the property name in the (masked) file source. */
  offset: number
}

function toSourceDecorator(deco: RawDecorator, lines?: LineIndex): SourceDecorator {
  return { name: deco.name, args: deco.args, line: lines ? lines.lineAt(deco.offset) : 0 }
}

/** Interpret a parsed field + its decorators into a typed {@link ModelField}. */
function buildField(raw: RawField, lines?: LineIndex): ModelField {
  const field: ModelField = {
    name: raw.name,
    type: 'unknown',
    optional: raw.optional,
    tsType: raw.tsType,
    markedOptional: raw.optional
  }
  if (lines) {
    field.line = lines.lineAt(raw.offset)
    field.decorators = raw.decorators.map((d) => toSourceDecorator(d, lines))
  }
  for (const deco of raw.decorators) {
    const scalar = SCALAR_TYPES[deco.name]
    if (scalar) {
      field.type = scalar
      field.decorator = deco.name
      if (deco.name === 'uuid') field.primaryKey = true
      if (boolOption(deco.args, 'optional')) {
        field.optional = true
        field.optionFlag = true
      }
      if (boolOption(deco.args, 'unique')) field.unique = true
      const min = numOption(deco.args, 'min')
      const max = numOption(deco.args, 'max')
      if (min !== undefined) field.min = min
      if (max !== undefined) field.max = max
      if (deco.name === 'set') {
        // `set({ enum: ['a','b'] })` form: pull the array contents.
        const enumMatch = /enum\s*:\s*\[([^\]]*)\]/.exec(deco.args)
        if (enumMatch) {
          field.enumValues = splitTopLevel(enumMatch[1]).map(unquote).filter(Boolean)
        } else {
          // `set({ ... }, 'a', 'b')` variadic form: take trailing string literals.
          const vals = splitTopLevel(deco.args)
            .filter((v) => /^['"`]/.test(v.trim()))
            .map(unquote)
            .filter(Boolean)
          if (vals.length) field.enumValues = vals
        }
      }
    } else if (deco.name === 'one' || deco.name === 'many') {
      field.type = 'relation'
      field.decorator = deco.name
      field.relationKind = deco.name === 'one' ? 'one' : 'many'
      const m = /=>\s*([A-Za-z_$][\w$]*)/.exec(deco.args)
      if (m) field.relationTo = m[1]
      if (boolOption(deco.args, 'optional')) {
        field.optional = true
        field.optionFlag = true
      }
    }
  }
  return field
}

export interface RawClass {
  name: string
  decorators: RawDecorator[]
  body: string
  /** Offset of the `class` keyword in the (masked) source. */
  offset: number
  /** Offset of the first character inside the class body braces. */
  bodyOffset: number
}

/** Parse the property fields out of a class body starting at `bodyOffset` in its file. */
function parseFields(body: string, bodyOffset = 0, lines?: LineIndex): ModelField[] {
  const fields: ModelField[] = []
  let i = 0
  let pending: RawDecorator[] = []
  const n = body.length
  while (i < n) {
    i = skipWs(body, i)
    if (i >= n) break
    const c = body[i]
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(body, i)
      pending = []
      continue
    }
    if (c === '@') {
      const { deco, next } = readDecorator(body, i)
      pending.push({ ...deco, offset: bodyOffset + deco.offset })
      i = next
      continue
    }
    if (c === '{') {
      i = skipBalanced(body, i, '{', '}')
      pending = []
      continue
    }
    const { word, next } = readWord(body, i)
    if (!word) {
      i++
      continue
    }
    if (PROPERTY_MODIFIERS.has(word)) {
      i = next
      continue
    }
    // `word` is a member name. Look at what follows to tell field from method.
    let j = skipWs(body, next)
    let optional = false
    if (body[j] === '?') {
      optional = true
      j = skipWs(body, j + 1)
    } else if (body[j] === '!') {
      j = skipWs(body, j + 1)
    }
    if (body[j] === '(') {
      // Method: skip its parameter list and (optional) body, drop decorators.
      j = skipBalanced(body, j, '(', ')')
      j = skipWs(body, j)
      while (j < n && body[j] !== '{' && body[j] !== ';' && body[j] !== '\n') j++
      if (body[j] === '{') j = skipBalanced(body, j, '{', '}')
      pending = []
      i = j
      continue
    }
    // Property field: capture an optional `: Type` up to `;` / newline / `=`.
    let tsType: string | undefined
    if (body[j] === ':') {
      j++
      const startType = skipWs(body, j)
      let k = startType
      let depth = 0
      while (k < n) {
        const ch = body[k]
        if (ch === '"' || ch === "'" || ch === '`') {
          k = skipString(body, k)
          continue
        }
        if (ch === '<' || ch === '(' || ch === '[' || ch === '{') depth++
        else if (ch === '>' || ch === ')' || ch === ']' || ch === '}') depth--
        else if ((ch === ';' || ch === '\n' || ch === '=') && depth <= 0) break
        k++
      }
      tsType = body.slice(startType, k).trim() || undefined
      j = k
    }
    fields.push(
      buildField(
        { name: word, optional, tsType, decorators: pending, offset: bodyOffset + i },
        lines
      )
    )
    pending = []
    while (j < n && body[j] !== ';' && body[j] !== '\n') j++
    i = j + 1
  }
  return fields
}

/** Scan a (comment-masked) source file for decorated `class` declarations. */
export function parseClasses(src: string): RawClass[] {
  const classes: RawClass[] = []
  let i = 0
  let pending: RawDecorator[] = []
  const n = src.length
  while (i < n) {
    i = skipWs(src, i)
    if (i >= n) break
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(src, i)
      continue
    }
    if (c === '@') {
      const { deco, next } = readDecorator(src, i)
      pending.push(deco)
      i = next
      continue
    }
    const { word, next } = readWord(src, i)
    if (!word) {
      i++
      continue
    }
    if (word === 'export' || word === 'default' || word === 'abstract' || word === 'declare') {
      i = next // keep pending — these modify the upcoming class
      continue
    }
    if (word === 'class') {
      const classOffset = i
      const nameRead = readWord(src, skipWs(src, next))
      let j = nameRead.next
      while (j < n && src[j] !== '{') j++
      let body = ''
      let bodyOffset = j
      if (src[j] === '{') {
        const end = skipBalanced(src, j, '{', '}')
        body = src.slice(j + 1, end - 1)
        bodyOffset = j + 1
        j = end
      }
      classes.push({ name: nameRead.word, decorators: pending, body, offset: classOffset, bodyOffset })
      pending = []
      i = j
      continue
    }
    // Any other top-level token cannot consume our decorators.
    pending = []
    i = next
  }
  return classes
}

/**
 * Interpret one class decorator as a role grant (`@role`, `@authenticated`,
 * `@anonymous`), or null for any other decorator.
 */
export function permissionFromDecorator(name: string, args: string): EntityPermission | null {
  if (!PERMISSION_DECORATORS.has(name)) return null
  const parts = splitTopLevel(args)
  let role = name
  let actionsArg: string | undefined
  if (name === 'role') {
    role = unquote(parts[0] ?? 'authenticated')
    actionsArg = parts[1]
  } else {
    // authenticated(actions?, opts?) / anonymous(actions?, opts?)
    actionsArg = parts[0] && !parts[0].includes(':') ? parts[0] : undefined
  }
  const actions = parseActions(actionsArg)
  const hasPolicy = /\bpolicy\s*:/.test(args)
  return { role, actions, hasPolicy, decorator: name }
}

/** Interpret a class's decorators into role grants. */
function parsePermissions(decorators: RawDecorator[]): {
  permissions: EntityPermission[]
  customName?: string
} {
  const permissions: EntityPermission[] = []
  let customName: string | undefined
  for (const deco of decorators) {
    if (deco.name === 'entity') {
      const arg = splitTopLevel(deco.args)[0]
      if (arg) customName = unquote(arg)
      continue
    }
    const permission = permissionFromDecorator(deco.name, deco.args)
    if (permission) permissions.push(permission)
  }
  return { permissions, customName }
}

/** Normalise an actions argument (`'*'`, `'read'`, `['read','create']`) to a list. */
function parseActions(arg: string | undefined): string[] {
  if (!arg) return ['*']
  const trimmed = arg.trim()
  if (trimmed.startsWith('[')) {
    const inner = trimmed.slice(1, trimmed.lastIndexOf(']'))
    const list = splitTopLevel(inner).map(unquote).filter(Boolean)
    return list.length ? list : ['*']
  }
  return [unquote(trimmed)]
}

/** Classify an entity's overall exposure from its role grants. */
function classifyAccess(permissions: EntityPermission[]): EntityAccess {
  if (permissions.length === 0) {
    return {
      level: 'default',
      label: 'Any signed-in user',
      detail:
        'No access decorator, so this entity falls back to the Rayfin default of ' +
        '`authenticated: *` — every signed-in user can read and write every row.'
    }
  }
  const anon = permissions.find((p) => p.role === 'anonymous')
  if (anon) {
    return {
      level: 'public',
      label: 'Public',
      detail:
        'An `@anonymous` grant exposes rows to unauthenticated callers ' +
        `(actions: ${anon.actions.join(', ')}).`
    }
  }
  const authed = permissions.filter((p) => p.role === 'authenticated')
  if (authed.length) {
    const withPolicy = authed.filter((p) => p.hasPolicy)
    if (withPolicy.length === authed.length) {
      return {
        level: 'scoped',
        label: 'Row-scoped policy',
        detail: 'Access is narrowed by a row-level `policy` callback for signed-in users.'
      }
    }
    if (withPolicy.length > 0) {
      return {
        level: 'mixed',
        label: 'Mixed policy',
        detail: 'Some signed-in grants are row-scoped by a policy and some are not.'
      }
    }
    return {
      level: 'authenticated',
      label: 'Any signed-in user',
      detail: 'Any signed-in user can access every row (no row-level `policy`).'
    }
  }
  // Custom / other roles.
  return {
    level: 'authenticated',
    label: permissions.map((p) => p.role).join(', '),
    detail: `Custom role grants: ${permissions
      .map((p) => `${p.role} (${p.actions.join(', ')})`)
      .join('; ')}.`
  }
}

/* ------------------------------------------------------------------ *
 * Schema aggregation
 * ------------------------------------------------------------------ */

/** From `schema.ts`, read the `schema = [...]` entity names and their import files. */
export function readSchemaList(src: string): { names: string[]; imports: Map<string, string> } {
  const imports = new Map<string, string>()
  const importRe = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g
  let im: RegExpExecArray | null
  while ((im = importRe.exec(src))) {
    const mod = im[2]
    for (const raw of im[1].split(',')) {
      const name = raw
        .replace(/^\s*type\s+/, '')
        .split(/\s+as\s+/)[0]
        .trim()
      if (name) imports.set(name, mod)
    }
  }
  let names: string[] = []
  const schemaRe = /schema\s*(?::[^=]+)?=\s*\[([^\]]*)\]/.exec(src)
  if (schemaRe) {
    names = splitTopLevel(schemaRe[1])
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return { names, imports }
}

/**
 * From `schema.ts`, read the entity names listed in the exported schema type
 * (`export type AppSchema = { Todo: Todo; … }`), or null when no such type is
 * found. When several object types are exported, the one sharing the most keys
 * with `arrayNames` (the `schema` array) wins.
 */
export function readSchemaTypeNames(
  src: string,
  arrayNames: readonly string[] = []
): { typeName: string; names: string[]; offset: number } | null {
  const re = /export\s+(?:type\s+([A-Za-z_$][\w$]*)\s*=|interface\s+([A-Za-z_$][\w$]*))\s*\{/g
  const keyRe = /(?:^|[;,\n{])\s*['"]?([A-Za-z_$][\w$]*)['"]?\s*\??\s*:/g
  let best: { typeName: string; names: string[]; offset: number; score: number } | null = null
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const open = m.index + m[0].length - 1
    const end = skipBalanced(src, open, '{', '}')
    const body = src.slice(open + 1, end - 1)
    const names: string[] = []
    let k: RegExpExecArray | null
    keyRe.lastIndex = 0
    while ((k = keyRe.exec(body))) names.push(k[1])
    const typeName = m[1] ?? m[2]
    const score =
      names.filter((n) => arrayNames.includes(n)).length * 10 + (/schema/i.test(typeName) ? 1 : 0)
    if (!best || score > best.score) best = { typeName, names, offset: m.index, score }
  }
  if (!best) return null
  return { typeName: best.typeName, names: best.names, offset: best.offset }
}

/**
 * Resolve a relative module specifier imported from a file in `dir` to a
 * project-relative `.ts` path; `undefined` for a package import, or one that
 * would leave the project.
 */
function resolveEntityFile(dir: string, mod: string): string | undefined {
  if (!mod.startsWith('.')) return undefined
  const parts = dir.split('/').filter(Boolean)
  for (const seg of mod.replace(/\.(js|ts)$/, '').split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg !== '..') parts.push(seg)
    else if (parts.pop() === undefined) return undefined
  }
  return parts.length ? `${parts.join('/')}.ts` : undefined
}

/** Add the `*_id` foreign-key-by-convention relations the explicit ones missed. */
function inferRelations(entities: ModelEntity[], explicit: ModelRelation[]): ModelRelation[] {
  const relations = [...explicit]
  const byLower = new Map<string, string>()
  for (const e of entities) byLower.set(e.name.toLowerCase(), e.name)
  const explicitVias = new Set(explicit.map((r) => `${r.from}.${r.via}`))
  for (const entity of entities) {
    for (const field of entity.fields) {
      if (!/_id$/i.test(field.name)) continue
      if (field.type !== 'uuid' && field.type !== 'text' && field.type !== 'unknown') continue
      if (explicitVias.has(`${entity.name}.${field.name}`)) continue
      const base = field.name.replace(/_id$/i, '').toLowerCase()
      const target =
        byLower.get(base) || byLower.get(base.replace(/s$/, '')) || byLower.get(`${base}s`)
      if (!target) continue
      field.fkTo = target
      if (target !== entity.name) {
        relations.push({ from: entity.name, to: target, kind: 'fk', via: field.name, explicit: false })
      }
    }
  }
  return relations
}

/**
 * Parse a project's data model given a file reader. Pure (no `window` access) so
 * it can be unit-tested with an in-memory reader. `rayfin/rayfin.yml` says where
 * the entities live (see {@link projectLayout}).
 */
export async function parseDataModel(read: FileReader): Promise<DataModel> {
  const yml = (await read('rayfin/rayfin.yml')) ?? (await read('rayfin/rayfin.yaml'))
  const layout = projectLayout(yml)
  const { schemaFile } = layout
  const schemaName = schemaFile.slice(schemaFile.lastIndexOf('/') + 1)
  const warnings: string[] = []
  const schemaSrc = await read(schemaFile)
  if (schemaSrc == null) return emptyDataModel(layout)
  const masked = maskComments(schemaSrc)
  const schemaLines = new LineIndex(schemaSrc)
  const { names, imports } = readSchemaList(masked)

  // Entities can be declared inline in the schema file or imported from sibling files.
  const inline = parseClasses(masked)
  const inlineByName = new Map(inline.map((c) => [c.name, c]))

  const entities: ModelEntity[] = []
  const explicitRelations: ModelRelation[] = []
  const seen = new Set<string>()

  const addClass = (cls: RawClass, file: string, lines: LineIndex): void => {
    const isEntity = cls.decorators.some((d) => d.name === 'entity')
    if (!isEntity || seen.has(cls.name)) return
    seen.add(cls.name)
    const { permissions, customName } = parsePermissions(cls.decorators)
    const fields = parseFields(cls.body, cls.bodyOffset, lines)
    for (const f of fields) {
      if (f.relationTo) {
        explicitRelations.push({
          from: cls.name,
          to: f.relationTo,
          kind: f.relationKind ?? 'one',
          via: f.name,
          explicit: true
        })
      }
    }
    entities.push({
      name: cls.name,
      customName,
      file,
      fields,
      permissions,
      access: classifyAccess(permissions),
      line: lines.lineAt(cls.offset),
      decorators: cls.decorators.map((d) => toSourceDecorator(d, lines))
    })
  }

  const order = names.length ? names : inline.map((c) => c.name)
  for (const name of order) {
    if (inlineByName.has(name)) {
      addClass(inlineByName.get(name)!, schemaFile, schemaLines)
      continue
    }
    const mod = imports.get(name)
    if (!mod) {
      warnings.push(`Entity "${name}" is listed in ${schemaName} but has no import.`)
      continue
    }
    const file = resolveEntityFile(schemaFile.slice(0, schemaFile.lastIndexOf('/')), mod)
    if (!file) {
      warnings.push(`Entity "${name}" is imported from "${mod}", which isn't a file in this app.`)
      continue
    }
    const src = await read(file)
    if (src == null) {
      warnings.push(`Could not read entity file ${file} for "${name}".`)
      continue
    }
    const classes = parseClasses(maskComments(src))
    const match =
      classes.find((c) => c.name === name) ??
      classes.find((c) => c.decorators.some((d) => d.name === 'entity'))
    if (match) addClass(match, file, new LineIndex(src))
    else warnings.push(`No @entity class found in ${file} for "${name}".`)
  }

  if (entities.length === 0 && names.length === 0) {
    warnings.push(`${schemaName} declares no entities yet.`)
  }

  const relations = inferRelations(entities, explicitRelations)
  return { entities, relations, warnings, hasSchema: true, dataDir: layout.dataDir, schemaFile }
}

/** Convenience wrapper that reads a project's files through the Tauri IPC bridge. */
export async function parseProjectDataModel(projectId: string): Promise<DataModel> {
  const read: FileReader = async (path) => {
    try {
      const fc = await window.api.projects.files.read(projectId, path)
      if (fc.error || fc.binary || fc.tooLarge) return null
      return fc.content ?? null
    } catch {
      return null
    }
  }
  return parseDataModel(read)
}
