import type { ChatSegment, ChatToolCall } from '@shared/ipc'
import { composeDiffs, formatUnifiedDiff, parseUnifiedDiff, type DiffFile } from './diff'
import { looksLikePath, projectRelative } from './paths'
import { isHiddenTool, kindOf } from './toolPresentation'
import type { UIChatMessage } from './types'

type ReasoningSegment = Extract<ChatSegment, { kind: 'reasoning' }>
type InterjectionSegment = Extract<ChatSegment, { kind: 'interjection' }>

/** One entry in a work log, in stream order. */
export type WorkItem =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'tool'; key: string; tool: ChatToolCall }
  | { kind: 'reasoning'; key: string; seg: ReasoningSegment; live: boolean }

/** A top-level block of an assistant turn, rendered as a direct child of `.turn-feed`. */
export type TurnBlock =
  | {
      kind: 'work'
      key: string
      items: WorkItem[]
      steps: ChatToolCall[]
      live: boolean
      last: boolean
    }
  | { kind: 'text'; key: string; text: string }
  | { kind: 'reasoning'; key: string; seg: ReasoningSegment; live: boolean }
  | { kind: 'question'; key: string; id: string }
  | { kind: 'interjection'; key: string; seg: InterjectionSegment }
  | { kind: 'answer'; key: string; text: string; streaming: boolean }

type Resolved =
  | { kind: 'text'; index: number; text: string }
  | { kind: 'tool'; index: number; tool: ChatToolCall }
  | { kind: 'reasoning'; index: number; seg: ReasoningSegment }
  | { kind: 'question'; index: number; id: string }
  | { kind: 'interjection'; index: number; seg: InterjectionSegment }

/** Legacy turns (persisted before segments existed) ran all tools, then wrote text. */
function segmentsOf(m: UIChatMessage): ChatSegment[] {
  if (m.segments && m.segments.length > 0) return m.segments
  const segs: ChatSegment[] = m.tools.map((t) => ({ kind: 'tool', id: t.id }))
  if (m.text) segs.push({ kind: 'text', text: m.text })
  return segs
}

function resolve(m: UIChatMessage): Resolved[] {
  const tools = new Map(m.tools.map((t) => [t.id, t]))
  const out: Resolved[] = []
  segmentsOf(m).forEach((seg, index) => {
    switch (seg.kind) {
      case 'text':
        if (seg.text.trim()) out.push({ kind: 'text', index, text: seg.text })
        break
      case 'tool': {
        const tool = tools.get(seg.id)
        if (tool && !isHiddenTool(tool.name)) out.push({ kind: 'tool', index, tool })
        break
      }
      case 'reasoning':
        if (seg.text.trim()) out.push({ kind: 'reasoning', index, seg })
        break
      case 'question':
        out.push({ kind: 'question', index, id: seg.id })
        break
      case 'interjection':
        out.push({ kind: 'interjection', index, seg })
        break
    }
  })
  return out
}

/**
 * Lay an assistant turn out as blocks. Prose after the last step is the
 * answer (it streams below the log while the turn is live). Everything before
 * it is grouped into work runs, which question cards and interjections split
 * and which stay in place. A run with at least one visible step becomes a
 * collapsible work log; a run with none renders its reasoning / prose inline.
 */
export function layoutTurn(m: UIChatMessage): TurnBlock[] {
  const items = resolve(m)
  let answerStart = items.length
  while (answerStart > 0 && items[answerStart - 1].kind === 'text') answerStart--
  const lastItem = items[items.length - 1]

  const blocks: TurnBlock[] = []
  let run: Resolved[] = []
  const flush = (last: boolean): void => {
    if (run.length === 0) return
    const steps = run.flatMap((r) => (r.kind === 'tool' ? [r.tool] : []))
    const live = Boolean(m.pending) && last
    const toItem = (r: Resolved): WorkItem | null =>
      r.kind === 'text'
        ? { kind: 'text', key: `t${r.index}`, text: r.text }
        : r.kind === 'tool'
          ? { kind: 'tool', key: `s${r.index}`, tool: r.tool }
          : r.kind === 'reasoning'
            ? {
                kind: 'reasoning',
                key: `r${r.index}`,
                seg: r.seg,
                live: Boolean(m.pending) && r === lastItem
              }
            : null
    if (steps.length > 0) {
      const workItems = run.map(toItem).filter((x): x is WorkItem => x !== null)
      blocks.push({ kind: 'work', key: `w${run[0].index}`, items: workItems, steps, live, last })
    } else {
      for (const r of run) {
        const item = toItem(r)
        if (item?.kind === 'text') blocks.push({ kind: 'text', key: item.key, text: item.text })
        else if (item?.kind === 'reasoning')
          blocks.push({ kind: 'reasoning', key: item.key, seg: item.seg, live: item.live })
      }
    }
    run = []
  }

  for (let i = 0; i < answerStart; i++) {
    const it = items[i]
    if (it.kind === 'question' || it.kind === 'interjection') {
      flush(false)
      blocks.push(
        it.kind === 'question'
          ? { kind: 'question', key: `q${it.index}`, id: it.id }
          : { kind: 'interjection', key: `i${it.index}`, seg: it.seg }
      )
    } else {
      run.push(it)
    }
  }
  flush(true)

  const answer = items.slice(answerStart)
  if (answer.length > 0) {
    blocks.push({
      kind: 'answer',
      key: `a${answer[0].index}`,
      text: answer.map((a) => (a.kind === 'text' ? a.text : '')).join(''),
      streaming: Boolean(m.pending)
    })
  }
  return blocks
}

/** The text a Copy action should take: the answer, else all prose. */
export function answerText(m: UIChatMessage): string {
  const answer = layoutTurn(m).find((b) => b.kind === 'answer')
  const text = answer?.kind === 'answer' ? answer.text : m.text
  return text.trim()
}

/** Visible steps in a turn (hidden tools excluded). */
export function visibleSteps(m: UIChatMessage): ChatToolCall[] {
  return m.tools.filter((t) => !isHiddenTool(t.name))
}

export type FileChangeStatus = 'created' | 'edited' | 'deleted'

export interface FileChange {
  /** Project-relative, forward-slash path (what the Code tab opens). */
  path: string
  status: FileChangeStatus
  added?: number
  removed?: number
  /**
   * What the turn did to the file, as a unified diff: its net change when every
   * edit's diff was recorded and they line up, else each recorded edit in turn.
   * Empty when the edits cancel out; absent when no diff was recorded.
   */
  diff?: string
  /** `diff` lists the edits one by one because they couldn't be combined. */
  stepwise?: boolean
  /** Some edits to the file have no recorded diff, or only a shortened one. */
  partial?: boolean
}

interface FileEntry {
  change: FileChange
  /** The file's part of each edit's diff, in order. */
  diffs: DiffFile[]
  /** Some edit to the file has no full diff. */
  gaps: boolean
}

function withPath(file: DiffFile, path: string, projectPath: string): DiffFile {
  const rel = (p: string | null): string | null =>
    p == null ? null : projectRelative(p, projectPath) || p
  return { ...file, path, oldPath: rel(file.oldPath), newPath: rel(file.newPath) }
}

function summarize({ change, diffs, gaps }: FileEntry, projectPath: string): FileChange {
  if (diffs.length === 0) return change
  const net = gaps ? null : composeDiffs(diffs)
  if (net) {
    const diff = net.hunks.length
      ? formatUnifiedDiff([withPath(net, change.path, projectPath)])
      : ''
    return { ...change, added: net.added, removed: net.removed, diff }
  }
  const diff = formatUnifiedDiff(diffs.map((f) => withPath(f, change.path, projectPath)))
  return {
    ...change,
    diff,
    ...(diffs.length > 1 ? { stepwise: true } : {}),
    ...(gaps ? { partial: true } : {})
  }
}

/**
 * Files a turn changed, from its successful edit/create/patch steps, in the
 * order they were first touched, each with the diff of what the turn did to
 * it. Paths outside the project (such as Copilot's own session notes) are left
 * out.
 */
export function filesChanged(tools: readonly ChatToolCall[], projectPath: string): FileChange[] {
  const byPath = new Map<string, FileEntry>()
  const note = (
    raw: string,
    status: FileChangeStatus,
    added?: number,
    removed?: number
  ): FileEntry | undefined => {
    const path = projectRelative(raw, projectPath)
    if (!path) return undefined
    const prev = byPath.get(path)
    if (!prev) {
      const entry: FileEntry = { change: { path, status, added, removed }, diffs: [], gaps: false }
      byPath.set(path, entry)
      return entry
    }
    const sum = (a?: number, b?: number): number | undefined =>
      a == null && b == null ? undefined : (a ?? 0) + (b ?? 0)
    const c = prev.change
    c.added = sum(c.added, added)
    c.removed = sum(c.removed, removed)
    if (status === 'deleted') c.status = 'deleted'
    else if (c.status === 'deleted') c.status = status
    return prev
  }
  for (const t of tools) {
    if (t.state !== 'success') continue
    const kind = kindOf(t)
    if (kind !== 'edit' && kind !== 'create' && kind !== 'delete') continue
    const diffFiles = t.diff ? parseUnifiedDiff(t.diff).filter((f) => f.path) : []
    if (diffFiles.length > 0 && !t.diffTruncated) {
      for (const f of diffFiles) {
        const status =
          f.status === 'added' ? 'created' : f.status === 'deleted' ? 'deleted' : 'edited'
        note(f.path, status, f.added, f.removed)?.diffs.push(f)
      }
      continue
    }
    const status: FileChangeStatus =
      kind === 'create' ? 'created' : kind === 'delete' ? 'deleted' : 'edited'
    // Older transcripts have no `paths`; their title is a path for edits, but just
    // the tool name for patches — only fall back to titles that look like paths.
    const title = t.title?.trim() ?? ''
    const titlePath = title && title !== t.name && looksLikePath(title) ? [title] : []
    const paths = t.paths?.length ? t.paths : titlePath
    for (const p of paths) {
      const entry = note(
        p,
        status,
        paths.length === 1 ? t.added : undefined,
        paths.length === 1 ? t.removed : undefined
      )
      if (entry) entry.gaps = true
    }
    // A shortened diff still shows what it has.
    for (const f of diffFiles) byPath.get(projectRelative(f.path, projectPath) ?? '')?.diffs.push(f)
  }
  return [...byPath.values()].map((entry) => summarize(entry, projectPath))
}

/** How long a work log took: the turn's duration for a sole log, else from step times. */
export function workDuration(
  steps: readonly ChatToolCall[],
  turnElapsedMs: number | undefined,
  soleBlock: boolean
): number | undefined {
  if (soleBlock && turnElapsedMs != null) return turnElapsedMs
  const starts = steps.map((s) => s.startedAt).filter((v): v is number => v != null)
  const ends = steps.map((s) => s.endedAt).filter((v): v is number => v != null)
  if (starts.length === 0 || ends.length === 0) return undefined
  const span = Math.max(...ends) - Math.min(...starts)
  return span >= 0 ? span : undefined
}
