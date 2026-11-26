// A unified diff of two versions of a tool's code, for the chat's DiffView.

/** Lines of context around each change. */
const CONTEXT = 3
/** Past this many pairs of lines, the diff shows the changed part replaced whole. */
const MAX_PAIRS = 1_000_000

interface Op {
  kind: 'ctx' | 'del' | 'add'
  text: string
}

function linesOf(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** How `a` becomes `b`, line by line, keeping their longest common lines. */
function opsOf(a: string[], b: string[]): Op[] {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const out: Op[] = a.slice(0, start).map((text) => ({ kind: 'ctx', text }))
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  const n = midA.length
  const m = midB.length
  if (n * m > MAX_PAIRS) {
    for (const text of midA) out.push({ kind: 'del', text })
    for (const text of midB) out.push({ kind: 'add', text })
  } else {
    // common[i * w + j]: how many lines midA[i..] and midB[j..] have in common.
    const w = m + 1
    const common = new Uint32Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        common[i * w + j] =
          midA[i] === midB[j]
            ? common[(i + 1) * w + j + 1] + 1
            : Math.max(common[(i + 1) * w + j], common[i * w + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        out.push({ kind: 'ctx', text: midA[i] })
        i++
        j++
      } else if (common[(i + 1) * w + j] >= common[i * w + j + 1]) {
        out.push({ kind: 'del', text: midA[i++] })
      } else {
        out.push({ kind: 'add', text: midB[j++] })
      }
    }
    while (i < n) out.push({ kind: 'del', text: midA[i++] })
    while (j < m) out.push({ kind: 'add', text: midB[j++] })
  }
  for (const text of a.slice(endA)) out.push({ kind: 'ctx', text })
  return out
}

/** The unified diff from `before` to `after` of the file at `path`; empty when they're the same. */
export function unifiedDiff(before: string, after: string, path: string): string {
  const ops = opsOf(linesOf(before), linesOf(after))
  const oldNo: number[] = []
  const newNo: number[] = []
  let o = 1
  let n = 1
  for (const op of ops) {
    oldNo.push(o)
    newNo.push(n)
    if (op.kind !== 'add') o++
    if (op.kind !== 'del') n++
  }
  const out: string[] = []
  let i = 0
  while (i < ops.length) {
    if (ops[i].kind === 'ctx') {
      i++
      continue
    }
    // One hunk holds the changes whose context touches.
    let last = i
    for (let k = i; k < ops.length && k - last <= 2 * CONTEXT; k++) {
      if (ops[k].kind !== 'ctx') last = k
    }
    const start = Math.max(0, i - CONTEXT)
    const end = Math.min(ops.length, last + CONTEXT + 1)
    const hunk = ops.slice(start, end)
    const oldCount = hunk.filter((op) => op.kind !== 'add').length
    const newCount = hunk.filter((op) => op.kind !== 'del').length
    const oldStart = oldCount ? oldNo[start] : oldNo[start] - 1
    const newStart = newCount ? newNo[start] : newNo[start] - 1
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
    for (const op of hunk) {
      out.push((op.kind === 'add' ? '+' : op.kind === 'del' ? '-' : ' ') + op.text)
    }
    i = end
  }
  return out.length ? [`--- a/${path}`, `+++ b/${path}`, ...out].join('\n') : ''
}
