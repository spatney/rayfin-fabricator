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
