/**
 * Source-reading helpers shared by the quick-check rules: comment-masked source
 * files with line lookup, balanced-argument scanning, import parsing, and small
 * readers for env files, JSON(C), YAML key lines, and semver.
 */
import { LineIndex, maskComments, skipBalanced, skipString } from '../model/parseSchema'

export interface SourceFile {
  path: string
  text: string
  /** `text` with comments blanked — same offsets and lines as `text`. */
  masked: string
  lines: LineIndex
}

export function sourceFile(path: string, text: string): SourceFile {
  return { path, text, masked: maskComments(text), lines: new LineIndex(text) }
}

export function lineOf(file: SourceFile, offset: number): number {
  return file.lines.lineAt(offset)
}

/** Every match of a global regex, with its index. */
export function matchAll(re: RegExp, text: string): RegExpExecArray[] {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`
  const g = new RegExp(re.source, flags)
  const out: RegExpExecArray[] = []
  let m: RegExpExecArray | null
  while ((m = g.exec(text))) {
    out.push(m)
    if (m[0].length === 0) g.lastIndex++
  }
  return out
}

/**
 * The argument text of a call whose `(` sits at `open` (exclusive of the
 * parens), honoring nesting and string literals.
 */
export function callArgs(src: string, open: number): string {
  if (src[open] !== '(') return ''
  const end = skipBalanced(src, open, '(', ')')
  return src.slice(open + 1, Math.max(open + 1, end - 1))
}

/** Calls of `.name(` in `src`: the offset of the dot, where the arguments start, and their text. */
export function methodCalls(src: string, name: string): { index: number; argsStart: number; args: string }[] {
  const out: { index: number; argsStart: number; args: string }[] = []
  for (const m of matchAll(new RegExp(`\\.${name}\\s*\\(`), src)) {
    const open = m.index + m[0].length - 1
    out.push({ index: m.index, argsStart: open + 1, args: callArgs(src, open) })
  }
  return out
}

/** String-literal contents found in `text` (single, double, or template without `${`). */
export function stringLiterals(text: string): { value: string; index: number }[] {
  const out: { value: string; index: number }[] = []
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '"' || c === "'" || c === '`') {
      const end = skipString(text, i)
      const raw = text.slice(i + 1, end - 1)
      if (c !== '`' || !raw.includes('${')) out.push({ value: raw, index: i })
      i = end
      continue
    }
    i++
  }
  return out
}

/**
 * The statement containing `index`: from the previous `;`, `{`, or `}` to the
 * next `;` (bounded), used to inspect one query chain.
 */
export function statementAround(src: string, index: number, max = 800): string {
  let start = index
  const floor = Math.max(0, index - max)
  while (start > floor && !';{}'.includes(src[start - 1])) start--
  let end = index
  const ceil = Math.min(src.length, index + max)
  while (end < ceil && src[end] !== ';') end++
  return src.slice(start, end)
}

export interface ImportSpecifier {
  name: string
  /** Local alias (`import { A as B }` → `B`). */
  local: string
  type: boolean
}

export interface ImportStatement {
  index: number
  /** `import type …` / `export type …`. */
  typeOnly: boolean
  /** True for `export … from` re-exports. */
  reexport: boolean
  /** Named specifiers (`{ a, type b }`). */
  named: ImportSpecifier[]
  /** Default or namespace binding, if any. */
  binding?: string
  /** `export * from` / `import * as`. */
  star: boolean
  from: string
}

const IMPORT_RE =
  /\b(import|export)\s+(type\s+)?((?:(?!\b(?:import|export|from)\b)[\w$*\s,{}])*)\bfrom\s*(['"])([^'"]+)\4|\bimport\s*(['"])([^'"]+)\6/g

/** Static import/export-from statements in a (masked) source. */
export function importsOf(src: string): ImportStatement[] {
  const out: ImportStatement[] = []
  for (const m of matchAll(IMPORT_RE, src)) {
    if (m[7] !== undefined) {
      out.push({ index: m.index, typeOnly: false, reexport: false, named: [], star: false, from: m[7] })
      continue
    }
    const clause = m[3] ?? ''
    const named: ImportSpecifier[] = []
    const braces = /\{([^}]*)\}/.exec(clause)
    if (braces) {
      for (const part of braces[1].split(',')) {
        const t = part.trim()
        if (!t) continue
        const type = /^type\s+/.test(t)
        const [name, local] = t.replace(/^type\s+/, '').split(/\s+as\s+/)
        named.push({ name: name.trim(), local: (local ?? name).trim(), type })
      }
    }
    const rest = clause.replace(/\{[^}]*\}/, '').replace(/,/g, ' ').trim()
    const star = /\*/.test(rest)
    const binding = rest.replace(/\*\s*as\s*/, '').trim() || undefined
    out.push({
      index: m.index,
      typeOnly: Boolean(m[2]),
      reexport: m[1] === 'export',
      named,
      binding,
      star,
      from: m[5]
    })
  }
  return out
}

/** True when the import brings in any runtime value (not only types). */
export function importsValues(stmt: ImportStatement): boolean {
  if (stmt.typeOnly) return false
  if (stmt.star || stmt.binding) return true
  if (stmt.named.length === 0) return !stmt.reexport
  return stmt.named.some((s) => !s.type)
}

/** Dynamic `import('x')` calls. */
export function dynamicImports(src: string): { index: number; from: string }[] {
  return matchAll(/\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/, src).map((m) => ({
    index: m.index,
    from: m[2]
  }))
}

/** Resolve a relative import specifier against the importing file's path. */
export function resolveRelative(fromFile: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined
  const parts = fromFile.split('/')
  parts.pop()
  for (const seg of spec.split('/')) {
    if (seg === '.' || seg === '') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}

/* ------------------------------ env files ------------------------------ */

export interface EnvEntry {
  key: string
  value: string
  line: number
}

export function envEntries(text: string): EnvEntry[] {
  const out: EnvEntry[] = []
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) return
    let value = m[2].trim()
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1)
    else value = value.replace(/\s+#.*$/, '')
    out.push({ key: m[1], value, line: i + 1 })
  })
  return out
}

/** Env files that document placeholders rather than holding real values. */
export function isTemplateEnvFile(path: string): boolean {
  return /\.env\.(example|sample|template|defaults|preview|dist)$/i.test(path)
}

/** Values that are clearly placeholders or references, not real data. */
export function isPlaceholderValue(value: string): boolean {
  const v = value.trim()
  return (
    v === '' ||
    v.startsWith('${') ||
    v.startsWith('<') ||
    /^(x+|\*+|\.\.\.|changeme|change-me|todo|tbd|none|null|placeholder|your[-_ ].*|replace[-_ ]?me.*)$/i.test(v) ||
    /\b(example|placeholder|dummy|fake|preview)\b/i.test(v)
  )
}

/* ------------------------------ JSON / YAML ------------------------------ */

/** Parse JSON with comments and trailing commas (tsconfig style); null on failure. */
export function parseJsonc(text: string): unknown {
  try {
    const stripped = maskComments(text).replace(/,(\s*[}\]])/g, '$1')
    return JSON.parse(stripped)
  } catch {
    return null
  }
}

/** 1-based line of the first `"key"` property in a JSON document. */
export function jsonKeyLine(text: string, key: string): number | undefined {
  const re = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"\\s*:`)
  const m = re.exec(text)
  if (!m) return undefined
  return text.slice(0, m.index).split('\n').length
}

/**
 * 1-based line of a nested YAML key (`['services', 'data', 'dialect']`),
 * following indentation; undefined when the path isn't present.
 */
export function yamlKeyLine(text: string, path: string[]): number | undefined {
  const lines = text.split(/\r?\n/)
  let start = 0
  let parentIndent = -1
  let found = -1
  for (const key of path) {
    found = -1
    for (let i = start; i < lines.length; i++) {
      const line = lines[i]
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const indent = line.length - line.trimStart().length
      if (parentIndent >= 0 && indent <= parentIndent) break
      const m = /^\s*(?:-\s+)?["']?([A-Za-z0-9_.-]+)["']?\s*:/.exec(line)
      if (m && m[1] === key) {
        found = i
        parentIndent = indent
        break
      }
    }
    if (found < 0) return undefined
    start = found + 1
  }
  return found + 1
}

/** 1-based line of the first line matching `re`, or undefined. */
export function firstLine(text: string, re: RegExp): number | undefined {
  const m = re.exec(text)
  return m ? text.slice(0, m.index).split('\n').length : undefined
}

/* ------------------------------ semver ------------------------------ */

export type SemverCore = [number, number, number]

export function semverCore(version: string | undefined | null): SemverCore | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(version ?? '')
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

export function compareSemver(a: SemverCore, b: SemverCore): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

export function isPrerelease(version: string | undefined | null): boolean {
  return /\d+\.\d+\.\d+-/.test(version ?? '')
}

/* ------------------------------ npm ranges ------------------------------ */

/**
 * The releases an npm range allows, by version core: from `lo` up to, but
 * not including, `hi` (`null`: no upper bound).
 */
export interface VersionSpan {
  lo: SemverCore
  hi: SemverCore | null
}

const ZERO: SemverCore = [0, 0, 0]

/** A full or partial version (`1`, `1.36`, `1.36.x`, `v1.36.2-alpha`) and how many numbers it gives. */
function partialVersion(text: string): { core: SemverCore; parts: number } | null {
  const m =
    /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      text.trim()
    )
  if (!m) return null
  const nums: number[] = []
  for (const part of [m[1], m[2], m[3]]) {
    if (part === undefined || !/^\d+$/.test(part)) break
    nums.push(Number(part))
  }
  return { core: [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0], parts: nums.length }
}

/** The first version after every one a partial version matches (`1.36` → 1.37.0). */
function after(p: { core: SemverCore; parts: number }): SemverCore | null {
  const [major, minor, patch] = p.core
  if (p.parts === 0) return null
  if (p.parts === 1) return [major + 1, 0, 0]
  if (p.parts === 2) return [major, minor + 1, 0]
  return [major, minor, patch + 1]
}

function comparatorSpan(token: string): VersionSpan | null {
  const m = /^(<=|>=|<|>|=|~>?|\^)?(.*)$/.exec(token) as RegExpExecArray
  const op = m[1] ?? ''
  const p = partialVersion(m[2])
  if (!p) return null
  if (p.parts === 0) return op === '<' || op === '>' ? null : { lo: ZERO, hi: null }
  const [major, minor] = p.core
  switch (op) {
    case '>=':
      return { lo: p.core, hi: null }
    case '>':
      return { lo: after(p) as SemverCore, hi: null }
    case '<':
      return { lo: ZERO, hi: p.core }
    case '<=':
      return { lo: ZERO, hi: after(p) }
    case '~':
    case '~>':
      return { lo: p.core, hi: p.parts === 1 ? [major + 1, 0, 0] : [major, minor + 1, 0] }
    case '^':
      if (major > 0 || p.parts === 1) return { lo: p.core, hi: [major + 1, 0, 0] }
      if (minor > 0 || p.parts === 2) return { lo: p.core, hi: [0, minor + 1, 0] }
      return { lo: p.core, hi: after(p) }
    default:
      return { lo: p.core, hi: after(p) }
  }
}

/** One `||` alternative: space-separated comparators (all must hold), or a hyphen range. */
function comparatorSetSpan(set: string): VersionSpan | null {
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(set)
  if (hyphen) {
    const from = partialVersion(hyphen[1])
    const to = partialVersion(hyphen[2])
    return from && to ? { lo: from.core, hi: after(to) } : null
  }
  // npm allows a space between an operator and its version (`>= 1.2.3`).
  const tokens = set
    .replace(/(<=|>=|<|>|=|~>?|\^)\s+/g, '$1')
    .split(/\s+/)
    .filter(Boolean)
  let span: VersionSpan = { lo: ZERO, hi: null }
  for (const token of tokens) {
    const s = comparatorSpan(token)
    if (!s) return null
    span = {
      lo: compareSemver(s.lo, span.lo) > 0 ? s.lo : span.lo,
      hi: span.hi === null || (s.hi !== null && compareSemver(s.hi, span.hi) < 0) ? s.hi : span.hi
    }
  }
  return span
}

/**
 * The releases an npm range allows (`>=1.36.0 <1.37.0`, `~1.36.0`, `^1.36.2`,
 * `1.36.x`, `1.2 - 1.4`, `a || b`), as one span that covers them all; `null`
 * for what isn't a range, such as a dist-tag.
 */
export function npmRangeSpan(range: string): VersionSpan | null {
  let span: VersionSpan | null = null
  for (const set of range.split('||')) {
    const s = comparatorSetSpan(set.trim())
    if (!s) return null
    span = !span
      ? s
      : {
          lo: compareSemver(s.lo, span.lo) < 0 ? s.lo : span.lo,
          hi:
            span.hi === null || s.hi === null
              ? null
              : compareSemver(s.hi, span.hi) > 0
                ? s.hi
                : span.hi
        }
  }
  return span
}

export function spanIncludes(span: VersionSpan, version: SemverCore): boolean {
  return (
    compareSemver(version, span.lo) >= 0 &&
    (span.hi === null || compareSemver(version, span.hi) < 0)
  )
}
