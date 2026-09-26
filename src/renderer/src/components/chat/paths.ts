// Path helpers for the chat: tools report absolute (often Windows) paths, while
// the Code tab and the user think in project-relative, forward-slash paths.

/** Forward slashes, no trailing slash. */
export function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/\/+$/, '')
}

/** True for `C:\…`, `C:/…`, `/…`, and UNC `\\…` paths. */
export function isAbsolutePath(path: string): boolean {
  return /^[a-z]:[\\/]/i.test(path) || path.startsWith('/') || path.startsWith('\\\\')
}

/** A file-ish string: a directory separator or a file extension, and no spaces. */
export function looksLikePath(text: string): boolean {
  return !/\s/.test(text) && (/[\\/]/.test(text) || /\.[a-z0-9]{1,10}$/i.test(text))
}

/**
 * Express `path` relative to the project root, with forward slashes. Relative
 * inputs are taken as already project-relative. Returns null for paths outside
 * the project (e.g. Copilot's own session files).
 */
export function projectRelative(path: string, projectRoot: string): string | null {
  const p = normalizePath(path)
  if (!p) return null
  if (!isAbsolutePath(p)) return p.replace(/^\.\//, '')
  const root = normalizePath(projectRoot)
  if (!root) return null
  // Windows paths compare case-insensitively.
  const fold = /^[a-z]:/i.test(root) || /^[a-z]:/i.test(p)
  const a = fold ? p.toLowerCase() : p
  const b = fold ? root.toLowerCase() : root
  if (a === b) return ''
  return a.startsWith(`${b}/`) ? p.slice(root.length + 1) : null
}

export function basename(path: string): string {
  const p = normalizePath(path)
  return p.slice(p.lastIndexOf('/') + 1)
}

/** A path split for display: dim directory + emphasised file name. */
export interface DisplayPath {
  /** Directory part, with a trailing slash (empty at the project root). */
  dir: string
  base: string
  /** Project-relative path, or null when outside the project. */
  rel: string | null
  /** The full original path, for tooltips. */
  full: string
}

export function displayPath(path: string, projectRoot: string): DisplayPath {
  const full = path.trim()
  const rel = projectRelative(full, projectRoot)
  if (rel === '') return { dir: '', base: 'project folder', rel, full }
  const shown = rel ?? normalizePath(full)
  const cut = shown.lastIndexOf('/')
  const base = cut >= 0 ? shown.slice(cut + 1) : shown
  // Outside the project only the file name is meaningful (the rest is noise
  // like a Copilot session folder); the full path stays in the tooltip.
  const dir = rel == null ? '' : cut >= 0 ? shown.slice(0, cut + 1) : ''
  return { dir, base: base || shown, rel, full }
}

const LINE_SUFFIX = /(?::\d+){1,2}$|#L\d+(?:-L?\d+)?$/i

/** Normalize model-written text to a candidate project-relative path, or null. */
function candidatePath(text: string, projectRoot: string): string | null {
  let t = text.trim().replace(/^["'`]|["'`]$/g, '')
  if (!t || /\s/.test(t) || /^[a-z][a-z0-9+.-]*:\/\//i.test(t) || t.startsWith('mailto:'))
    return null
  t = t.replace(LINE_SUFFIX, '')
  return projectRelative(t, projectRoot) || null
}

/**
 * Resolve text the model wrote (inline code, a link) to a project file, or
 * null. Accepts exact relative paths, absolute paths under the root, `./`
 * prefixes, `:line[:col]` / `#L12` suffixes, a unique basename, or a unique
 * path suffix (`pages/Home.tsx` for `src/pages/Home.tsx`).
 */
export function resolveProjectFile(
  text: string,
  files: readonly string[],
  projectRoot: string
): string | null {
  return createFileResolver(files, projectRoot)(text)
}

/** An indexed {@link resolveProjectFile} for resolving many references against one file list. */
export function createFileResolver(
  files: readonly string[],
  projectRoot: string
): (text: string) => string | null {
  const exact = new Map<string, string>()
  const byBase = new Map<string, string[]>()
  for (const f of files) {
    exact.set(f, f)
    const lower = f.toLowerCase()
    if (!exact.has(lower)) exact.set(lower, f)
    const base = basename(f).toLowerCase()
    const list = byBase.get(base)
    if (list) list.push(f)
    else byBase.set(base, [f])
  }
  return (text) => {
    const rel = candidatePath(text, projectRoot)
    if (!rel) return null
    const lower = rel.toLowerCase()
    const hit = exact.get(rel) ?? exact.get(lower)
    if (hit) return hit
    const sameName = byBase.get(basename(lower)) ?? []
    const candidates = rel.includes('/')
      ? sameName.filter((f) => f.toLowerCase().endsWith(`/${lower}`))
      : sameName
    return candidates.length === 1 ? candidates[0] : null
  }
}
