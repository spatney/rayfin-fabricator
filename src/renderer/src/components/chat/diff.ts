// Unified-diff parsing for the chat's inline diff viewer. Handles the shapes the
// Copilot tools emit: `diff --git a/C:/… b/C:/…` headers, `--- a/dev/null` for
// created files, multi-file `apply_patch` diffs, and hunk-only diffs.

export type DiffLineKind = 'add' | 'del' | 'ctx' | 'meta'

export interface DiffLine {
  kind: DiffLineKind
  text: string
  oldNo?: number
  newNo?: number
}

export interface DiffHunk {
  oldStart: number
  newStart: number
  /** Trailing context after the `@@ … @@` marker (often a function name). */
  section: string
  lines: DiffLine[]
}

export type DiffFileStatus = 'added' | 'deleted' | 'modified' | 'renamed'

export interface DiffFile {
  /** The path shown for the file (new path, or old path for deletions). */
  path: string
  oldPath: string | null
  newPath: string | null
  status: DiffFileStatus
  hunks: DiffHunk[]
  added: number
  removed: number
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/

/** `a/src/x.ts` → `src/x.ts`; `/dev/null` (or the tools' `a/dev/null`) → null. */
function headerPath(raw: string): string | null {
  const p = raw.replace(/\t.*$/, '').trim()
  const stripped = /^[ab]\//.test(p) ? p.slice(2) : p
  return stripped === '/dev/null' || stripped === 'dev/null' ? null : stripped
}

/**
 * Parse a unified diff into files and hunks. Hunk bodies are read using the
 * line counts from their `@@` header, so content such as a removed `-- comment`
 * line (`--- comment`) is never mistaken for a file header.
 */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | null = null
  let hunk: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0
  let oldLeft = 0
  let newLeft = 0

  const startFile = (): DiffFile => {
    const f: DiffFile = {
      path: '',
      oldPath: null,
      newPath: null,
      status: 'modified',
      hunks: [],
      added: 0,
      removed: 0
    }
    files.push(f)
    return f
  }

  for (const line of diff.replace(/\r\n?/g, '\n').split('\n')) {
    const open: boolean = hunk !== null && (oldLeft > 0 || newLeft > 0)
    if (open && file && hunk) {
      const h: DiffHunk = hunk
      const first = line[0]
      if (first === '+') {
        h.lines.push({ kind: 'add', text: line.slice(1), newNo: newNo++ })
        file.added++
        newLeft--
        continue
      }
      if (first === '-') {
        h.lines.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++ })
        file.removed++
        oldLeft--
        continue
      }
      if (first === ' ' || line === '') {
        h.lines.push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ })
        oldLeft--
        newLeft--
        continue
      }
      if (first === '\\') {
        h.lines.push({ kind: 'meta', text: line.slice(1).trim() })
        continue
      }
    }
    if (line.startsWith('\\') && hunk) {
      // "\ No newline at end of file" trails the hunk it belongs to.
      ;(hunk as DiffHunk).lines.push({ kind: 'meta', text: line.slice(1).trim() })
      continue
    }
    const m = HUNK_RE.exec(line)
    if (m) {
      if (!file) file = startFile()
      oldNo = Number(m[1])
      newNo = Number(m[3])
      oldLeft = m[2] === undefined ? 1 : Number(m[2])
      newLeft = m[4] === undefined ? 1 : Number(m[4])
      hunk = { oldStart: oldNo, newStart: newNo, section: m[5].trim(), lines: [] }
      file.hunks.push(hunk)
      continue
    }
    if (line.startsWith('diff --git ')) {
      file = startFile()
      hunk = null
      continue
    }
    if (line.startsWith('--- ')) {
      // A `---` header after hunks starts a new file that had no `diff --git` line.
      if (!file || file.hunks.length) file = startFile()
      hunk = null
      file.oldPath = headerPath(line.slice(4))
      continue
    }
    if (!file || file.hunks.length) continue
    if (line.startsWith('+++ ')) file.newPath = headerPath(line.slice(4))
    else if (line.startsWith('new file mode')) file.status = 'added'
    else if (line.startsWith('deleted file mode')) file.status = 'deleted'
    else if (line.startsWith('rename from ')) {
      file.status = 'renamed'
      file.oldPath = line.slice('rename from '.length).trim()
    } else if (line.startsWith('rename to ')) file.newPath = line.slice('rename to '.length).trim()
  }

  for (const f of files) {
    if (f.status === 'modified') {
      if (f.oldPath == null && f.newPath != null) f.status = 'added'
      else if (f.newPath == null && f.oldPath != null) f.status = 'deleted'
    }
    f.path = f.newPath ?? f.oldPath ?? ''
  }
  return files.filter((f) => f.hunks.length > 0 || f.path)
}
