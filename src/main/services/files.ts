/**
 * Read-only project file access for the in-app code viewer.
 *
 * The chat agent owns *writing* code; this module only lets the UI browse and
 * read what's on disk. Everything is sandboxed to the project directory: a read
 * path is resolved and rejected if it escapes the project root, and heavy/noisy
 * folders (node_modules, .git, build output) are pruned from the tree.
 */

import { readdirSync, readFileSync, statSync, type Dirent } from 'fs'
import { join, resolve, sep } from 'path'
import { findProject } from './store'
import type { FileContent, FileNode } from '../../shared/ipc'

/** Folders never worth showing in a code viewer (huge and/or generated). */
const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  '.next',
  '.turbo',
  '.cache',
  '.vite',
  'coverage',
  '.DS_Store'
])

/** Caps so a pathological tree can't hang the UI or blow up the IPC payload. */
const MAX_ENTRIES = 8000
const MAX_DEPTH = 12
/** Largest file we'll ship to the viewer (1 MiB). */
const MAX_FILE_BYTES = 1024 * 1024

/** Recursively build a pruned, sorted file tree rooted at `dir`. */
function walk(dir: string, rel: string, depth: number, budget: { n: number }): FileNode[] {
  if (depth > MAX_DEPTH || budget.n >= MAX_ENTRIES) return []
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const dirs: FileNode[] = []
  const files: FileNode[] = []
  for (const entry of entries) {
    if (budget.n >= MAX_ENTRIES) break
    const name = entry.name
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(name)) continue
      budget.n++
      const childRel = rel ? `${rel}/${name}` : name
      dirs.push({
        name,
        path: childRel,
        type: 'dir',
        children: walk(join(dir, name), childRel, depth + 1, budget)
      })
    } else if (entry.isFile()) {
      budget.n++
      files.push({ name, path: rel ? `${rel}/${name}` : name, type: 'file' })
    }
  }

  const byName = (a: FileNode, b: FileNode): number =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  dirs.sort(byName)
  files.sort(byName)
  return [...dirs, ...files]
}

/** Build the project's file tree (pruned + capped). */
export function listProjectFiles(projectId: string): FileNode[] {
  const project = findProject(projectId)
  if (!project) return []
  return walk(project.path, '', 0, { n: 0 })
}

/** Resolve a project-relative path, guarding against directory traversal. */
function safeResolve(root: string, relPath: string): string | null {
  const target = resolve(root, relPath)
  const rootResolved = resolve(root)
  if (target !== rootResolved && !target.startsWith(rootResolved + sep)) return null
  return target
}

/** Heuristic binary check: a NUL byte in the first chunk means "not text". */
function looksBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8192)
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

/** Read a single project file for the viewer (text only, size-capped). */
export function readProjectFile(projectId: string, relPath: string): FileContent {
  const project = findProject(projectId)
  if (!project) return { path: relPath, size: 0, error: 'Project not found.' }

  const target = safeResolve(project.path, relPath)
  if (!target) return { path: relPath, size: 0, error: 'Path is outside the project.' }

  let size = 0
  try {
    const stat = statSync(target)
    if (!stat.isFile()) return { path: relPath, size: 0, error: 'Not a file.' }
    size = stat.size
  } catch {
    return { path: relPath, size: 0, error: 'File not found.' }
  }

  if (size > MAX_FILE_BYTES) {
    return { path: relPath, size, tooLarge: true }
  }

  try {
    const buf = readFileSync(target)
    if (looksBinary(buf)) return { path: relPath, size, binary: true }
    return { path: relPath, size, content: buf.toString('utf8') }
  } catch {
    return { path: relPath, size, error: 'Could not read the file.' }
  }
}
