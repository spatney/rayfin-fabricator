// Project files named in a terminal's output, such as `src/App.tsx:12:5` from a
// compiler or a stack trace's `C:\app\src\api.ts:40`, to open in the Code tab.

import type { FileNode } from '@shared/ipc'

/** A project file a line of output names, and where in the line. */
export interface FileLink {
  /** Offsets in the line's text; `end` is exclusive. */
  start: number
  end: number
  /** Project-relative, `/`-separated. */
  path: string
  line?: number
  column?: number
}

// An optional `file://` URL or a drive, `./`, `../` or `/` start, folders, a
// name with an extension, then an optional `:line[:column]` or `(line[,column])`.
const CANDIDATE =
  /(?:file:\/\/)?(?:\/?[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/])?(?:[\w@.+-]+[\\/])*[\w@+-][\w@.+-]*\.[A-Za-z0-9]{1,10}(?::(\d+)(?::(\d+))?|\((\d+)(?:, ?(\d+))?\))?/g
const POSITION = /(?::\d+(?::\d+)?|\(\d+(?:, ?\d+)?\))$/

/**
 * A path as a terminal prints it, relative to the project at `root`: `/`
 * separators, no `./`. Null when it's outside the project or relative to
 * somewhere else (`../`, `~`).
 */
export function projectRelative(raw: string, root: string, windows: boolean): string | null {
  let path = raw.replace(/^file:\/\//, '').replace(/\\/g, '/')
  // file:///C:/app becomes /C:/app.
  if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1)
  const absolute = path.startsWith('/') || /^[A-Za-z]:\//.test(path)
  if (!absolute) {
    while (path.startsWith('./')) path = path.slice(2)
    return path.startsWith('../') || path.startsWith('~') || !path ? null : path
  }
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const same = (a: string, b: string): boolean =>
    windows ? a.toLowerCase() === b.toLowerCase() : a === b
  const prefix = `${base}/`
  if (path.length <= prefix.length || !same(path.slice(0, prefix.length), prefix)) return null
  return path.slice(prefix.length)
}

/** The project files `text` names: each candidate path `resolve` maps to one (or null). */
export function findFileLinks(text: string, resolve: (raw: string) => string | null): FileLink[] {
  const links: FileLink[] = []
  for (const match of text.matchAll(CANDIDATE)) {
    const whole = match[0]
    const start = match.index ?? 0
    // Part of a web address, which the URL links have.
    if (
      /[a-z]:\/\/?$/i.test(text.slice(Math.max(0, start - 8), start)) &&
      !whole.startsWith('file:')
    ) {
      continue
    }
    const path = resolve(whole.replace(POSITION, ''))
    if (!path) continue
    const line = match[1] ?? match[3]
    const column = match[2] ?? match[4]
    links.push({
      start,
      end: start + whole.length,
      path,
      line: line ? Number(line) : undefined,
      column: column ? Number(column) : undefined
    })
  }
  return links
}

/** The project's files, as project-relative paths, from its file tree. */
export function filePaths(nodes: readonly FileNode[]): Set<string> {
  const paths = new Set<string>()
  const walk = (list: readonly FileNode[]): void => {
    for (const node of list) {
      if (node.type === 'file') paths.add(node.path)
      else if (node.children) walk(node.children)
    }
  }
  walk(nodes)
  return paths
}
