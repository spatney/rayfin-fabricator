import type { FileNode } from '@shared/ipc'

/** A file the composer can reference via @-mention. */
export interface MentionFile {
  name: string
  path: string
}

/** Flatten a project file tree to a flat list of files (dirs + ignored dropped). */
export function flattenFiles(nodes: FileNode[], out: MentionFile[] = []): MentionFile[] {
  if (!Array.isArray(nodes)) return out
  for (const n of nodes) {
    if (n.ignored) continue
    if (n.type === 'file') out.push({ name: n.name, path: n.path })
    else if (n.children) flattenFiles(n.children, out)
  }
  return out
}

/**
 * Rank files for an @-mention query: basename prefix beats basename-substring
 * beats path-substring; ties break toward shorter paths. Empty query lists all.
 */
export function rankFiles(files: MentionFile[], query: string): MentionFile[] {
  const q = query.toLowerCase()
  if (!q) return files.slice(0, 8)
  const scored: { f: MentionFile; s: number }[] = []
  for (const f of files) {
    const name = f.name.toLowerCase()
    let s = -1
    if (name.startsWith(q)) s = 0
    else if (name.includes(q)) s = 1
    else if (f.path.toLowerCase().includes(q)) s = 2
    if (s >= 0) scored.push({ f, s })
  }
  scored.sort((a, b) => a.s - b.s || a.f.path.length - b.f.path.length)
  return scored.slice(0, 8).map((x) => x.f)
}

/**
 * The @-token the caret is in, from the text up to the caret: where its `@` is,
 * what follows it, and whether it's quoted (`@"…`, for a path with spaces).
 * `null` when the caret isn't in one.
 */
export function activeMention(
  before: string
): { start: number; query: string; quoted: boolean } | null {
  const m = /(^|\s)@(?:"([^"]*)|([^\s@"]*))$/.exec(before)
  if (!m) return null
  const quoted = m[2] !== undefined
  const query = quoted ? m[2] : m[3]
  return { start: before.length - query.length - (quoted ? 2 : 1), query, quoted }
}

/**
 * An @-query that names a path rather than a project file: `./` or `../`, `~/`,
 * `/` or `\`, or a drive such as `C:\`. It browses folders, in the project or
 * outside it.
 */
export function isPathQuery(query: string): boolean {
  return /^(?:\.{1,2}[\\/]|~[\\/]|[\\/]|[a-z]:[\\/])/i.test(query)
}

/** A path query split at its last separator: the folder so far, and the name being typed in it. */
export function splitPathQuery(query: string): { dir: string; partial: string } {
  const cut = Math.max(query.lastIndexOf('/'), query.lastIndexOf('\\')) + 1
  return { dir: query.slice(0, cut), partial: query.slice(cut) }
}

/** An entry of a folder, as `projects.files.listDir` lists it. */
export interface DirEntry {
  name: string
  dir: boolean
}

/** What the @-picker offers: a file, a folder to browse into, or the folder being browsed. */
export interface MentionOption {
  key: string
  kind: 'file' | 'dir' | 'here'
  name: string
  /** Where it is, as typed. */
  detail: string
  /** The reference that replaces the @-token being typed. */
  insert: string
  /** A folder: picking it lists what's in it instead of closing the picker. */
  browse?: boolean
}

/**
 * The entries of a folder that match the name being typed: names that start
 * with it before names that contain it, folders before files. Hidden entries
 * (a leading dot) show once a dot is typed.
 */
export function rankEntries(entries: readonly DirEntry[], partial: string, limit = 50): DirEntry[] {
  const q = partial.toLowerCase()
  const scored: { e: DirEntry; s: number }[] = []
  for (const e of entries) {
    if (e.name.startsWith('.') && !q.startsWith('.')) continue
    const name = e.name.toLowerCase()
    const s = name.startsWith(q) ? 0 : name.includes(q) ? 1 : -1
    if (s >= 0) scored.push({ e, s })
  }
  scored.sort(
    (a, b) =>
      a.s - b.s ||
      Number(b.e.dir) - Number(a.e.dir) ||
      a.e.name.localeCompare(b.e.name, undefined, { sensitivity: 'base' })
  )
  return scored.slice(0, limit).map((x) => x.e)
}

/**
 * The text that references `path` in a message: `@path`, or `@"path"` when it
 * has spaces or is already quoted. `open` leaves the quote open, to go on
 * browsing inside a folder.
 */
export function mentionText(path: string, quoted = false, open = false): string {
  if (!quoted && !/\s/.test(path)) return `@${path}`
  return `@"${path}${open ? '' : '"'}`
}
