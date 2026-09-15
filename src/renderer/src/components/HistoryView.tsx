import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { DiffEditor } from '@monaco-editor/react'
import type {
  GitChange,
  GitChangeStatus,
  GitCommitSummary,
  GitFileDiff,
  GitHistory,
  StudioProject
} from '@shared/ipc'
import { GIT_WORKING_REF } from '@shared/ipc'
import { monacoLanguage } from '../monaco'
import { ChatIcon, CompareIcon, CopyIcon, HistoryIcon, SearchIcon } from './icons'
import ConfirmModal from './ConfirmModal'
import Skeleton from './Skeleton'

interface Props {
  project: StudioProject
  /** Bumped by the parent when history may have changed (e.g. after a deploy). */
  refreshKey: number
  /** Resolved Monaco theme id (light/dark) from the parent. */
  theme: string
  /**
   * Ask the parent to deploy the project's current code. Used after restoring an
   * older version (to publish it) and by the "live version differs" banner.
   */
  onRequestDeploy?: () => void
  /**
   * Hand a slice of history to the Build chat as staged context (a commit, a
   * single file's change, or a comparison), so the user can add their request.
   */
  onSendToChat?: (display: string, prompt: string) => void
}

/** Friendly, non-coder-facing labels for each kind of change. */
const STATUS_LABEL: Record<GitChangeStatus, string> = {
  added: 'Added',
  modified: 'Edited',
  deleted: 'Deleted',
  renamed: 'Renamed'
}

function splitPath(p: string): { name: string; dir: string } {
  const i = p.lastIndexOf('/')
  return i === -1 ? { name: p, dir: '' } : { name: p.slice(i + 1), dir: p.slice(0, i) }
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`
}

/** Bucket a commit into a friendly time group for the timeline headers. */
function dateBucket(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return 'Earlier'
  const sod = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((sod(new Date()) - sod(new Date(t))) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return 'Earlier this week'
  if (days < 30) return 'Earlier this month'
  return 'Older'
}

/** A short, human list of changed file paths for an agent prompt. */
function fileList(changes: GitChange[] | null, max = 12): string {
  if (!changes || changes.length === 0) return '(no files)'
  const names = changes.map((c) => c.path)
  if (names.length <= max) return names.join(', ')
  return `${names.slice(0, max).join(', ')} … (+${names.length - max} more)`
}

/* ----------------------- agent-handoff prompt builders ---------------------- */

function commitPrompt(c: GitCommitSummary, changes: GitChange[] | null): string {
  return [
    "Here's a change from this app's history, for context:",
    '',
    `• Snapshot ${c.shortHash} — “${c.subject}”`,
    `• When: ${c.relativeDate}`,
    `• Files changed (${c.filesChanged}): ${fileList(changes)}`,
    `• To see the exact changes, run: git show ${c.hash}`,
    `  (for a single file: git show ${c.hash} -- <path>)`,
    '',
    'What I’d like you to do: '
  ].join('\n')
}

function workingPrompt(changes: GitChange[] | null): string {
  return [
    "Here are the current uncommitted changes in this app, for context:",
    '',
    `• Files changed (${changes?.length ?? 0}): ${fileList(changes)}`,
    '• To see them, run: git status  and  git diff',
    '',
    'What I’d like you to do: '
  ].join('\n')
}

function filePrompt(change: GitChange, ref: string, commit: GitCommitSummary | null): string {
  let where: string
  let inspect: string
  if (ref === GIT_WORKING_REF) {
    where = 'the current uncommitted changes'
    inspect = `git diff -- ${change.path}`
  } else if (commit) {
    where = `snapshot ${commit.shortHash} (“${commit.subject}”)`
    inspect = `git show ${commit.hash} -- ${change.path}`
  } else {
    where = 'the selected snapshot'
    inspect = `git show ${ref} -- ${change.path}`
  }
  return [
    "Here's a specific file change from this app's history, for context:",
    '',
    `• File: ${change.path}`,
    `• From ${where}`,
    `• To see the exact change, run: ${inspect}`,
    '',
    'What I’d like you to do: '
  ].join('\n')
}

function comparePrompt(
  base: GitCommitSummary,
  target: GitCommitSummary,
  changes: GitChange[] | null
): string {
  return [
    "Here's a comparison between two snapshots of this app, for context:",
    '',
    `• From ${base.shortHash} (“${base.subject}”) → ${target.shortHash} (“${target.subject}”)`,
    `• Files changed (${changes?.length ?? 0}): ${fileList(changes)}`,
    `• To see the exact differences, run: git diff ${base.hash} ${target.hash}`,
    '  (for a single file: add  -- <path>)',
    '',
    'What I’d like you to do: '
  ].join('\n')
}

/** A small "+12 −3" line-change indicator. */
function ChangeStat({ ins, del }: { ins: number; del: number }): JSX.Element | null {
  if (ins === 0 && del === 0) return null
  return (
    <span className="hist-stat">
      {ins > 0 && <span className="hist-stat-add">+{ins}</span>}
      {del > 0 && <span className="hist-stat-del">−{del}</span>}
    </span>
  )
}

const DIFF_OPTIONS = {
  readOnly: true,
  domReadOnly: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  fontSize: 12.5,
  lineHeight: 19,
  fontFamily: "'Cascadia Code', 'Consolas', ui-monospace, monospace",
  automaticLayout: true,
  contextmenu: false,
  renderOverviewRuler: false,
  scrollbar: { useShadows: false }
}

/**
 * The "History" view: a vibe-coder-friendly timeline of everything that changed
 * in the project. Studio commits on the user's behalf (scaffold + every deploy),
 * so the git log reads as a plain-English list of "what happened". Picking an
 * entry lists its changed files; picking a file shows a clear before/after diff.
 *
 * Beyond browsing, it can hand a commit, a single file's change, or a comparison
 * of two snapshots to the Build chat as context, search/group the timeline, show
 * a file's own history, and compare any two snapshots — all read-only (the one
 * exception, "Restore this version", is unchanged).
 */
export default function HistoryView({
  project,
  refreshKey,
  theme,
  onRequestDeploy,
  onSendToChat
}: Props): JSX.Element {
  const [history, setHistory] = useState<GitHistory | null>(null)
  const [ref, setRef] = useState<string | null>(null)
  const [changes, setChanges] = useState<GitChange[] | null>(null)
  const [changesLoading, setChangesLoading] = useState(false)
  const [file, setFile] = useState<GitChange | null>(null)
  const [diff, setDiff] = useState<GitFileDiff | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [sideBySide, setSideBySide] = useState(false)
  const [wrap, setWrap] = useState(false)
  const [query, setQuery] = useState('')
  const [confirmRevert, setConfirmRevert] = useState<GitCommitSummary | null>(null)
  const [reverting, setReverting] = useState(false)
  const [revertError, setRevertError] = useState<string | null>(null)
  const [copiedSha, setCopiedSha] = useState(false)
  const [copiedDiff, setCopiedDiff] = useState(false)

  // Compare mode: diff two arbitrary snapshots (base → target) instead of one.
  const [compareMode, setCompareMode] = useState(false)
  const [base, setBase] = useState<string | null>(null)
  const [target, setTarget] = useState<string | null>(null)

  // File history popover (commits that touched the open file).
  const [fileLog, setFileLog] = useState<GitCommitSummary[] | null>(null)
  const [showFileLog, setShowFileLog] = useState(false)
  const [fileLogLoading, setFileLogLoading] = useState(false)

  // When jumping to another version of the open file, keep that file selected
  // after the changed-files list reloads (instead of snapping to the first file).
  const preferredPathRef = useRef<string | null>(null)

  // Load (and refresh) the timeline; default the selection to the newest entry.
  useEffect(() => {
    let live = true
    void window.api.projects.git.log(project.id).then((h) => {
      if (!live) return
      setHistory(h)
      setRef((prev) => {
        if (prev && (prev === GIT_WORKING_REF || h.commits.some((c) => c.hash === prev))) return prev
        if (h.workingChanges > 0) return GIT_WORKING_REF
        return h.commits[0]?.hash ?? null
      })
    })
    return () => {
      live = false
    }
  }, [project.id, refreshKey])

  const commits = useMemo(() => history?.commits ?? [], [history])

  // Default the compare pickers to "the change just before head → head".
  useEffect(() => {
    if (!compareMode || commits.length < 2) return
    setTarget((t) => t ?? commits[0].hash)
    setBase((b) => b ?? commits[1].hash)
  }, [compareMode, commits])

  // Load the changed files for the current selection (one commit, the working
  // tree, or a base→target comparison) and open the first (or preferred) file.
  useEffect(() => {
    let live = true
    const apply = (c: GitChange[]): void => {
      if (!live) return
      setChanges(c)
      const pref = preferredPathRef.current
      preferredPathRef.current = null
      const pick = pref ? c.find((x) => x.path === pref) : null
      setFile(pick ?? c[0] ?? null)
    }

    if (compareMode) {
      if (!base || !target) {
        setChanges(null)
        setFile(null)
        return
      }
      setChangesLoading(true)
      void window.api.projects.git
        .compareChanges(project.id, base, target)
        .then(apply)
        .finally(() => {
          if (live) setChangesLoading(false)
        })
    } else {
      if (!ref) {
        setChanges(null)
        setFile(null)
        return
      }
      setChangesLoading(true)
      void window.api.projects.git
        .changes(project.id, ref)
        .then(apply)
        .finally(() => {
          if (live) setChangesLoading(false)
        })
    }
    return () => {
      live = false
    }
  }, [project.id, refreshKey, compareMode, base, target, ref])

  // When the selected file changes, load its before/after for the diff editor.
  useEffect(() => {
    if (!file || file.binary) {
      setDiff(null)
      return
    }
    let live = true
    const p =
      compareMode && base && target
        ? window.api.projects.git.compareFileDiff(project.id, base, target, file.path, file.oldPath)
        : !compareMode && ref
          ? window.api.projects.git.fileDiff(project.id, ref, file.path, file.oldPath)
          : null
    if (!p) {
      setDiff(null)
      return () => {
        live = false
      }
    }
    setDiffLoading(true)
    void p
      .then((d) => {
        if (live) setDiff(d)
      })
      .finally(() => {
        if (live) setDiffLoading(false)
      })
    return () => {
      live = false
    }
  }, [project.id, compareMode, base, target, ref, file])

  // Close the file-history popover on any outside click.
  useEffect(() => {
    if (!showFileLog) return
    const close = (): void => setShowFileLog(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [showFileLog])

  const selectRef = useCallback((next: string): void => {
    preferredPathRef.current = null
    setRef(next)
    setFile(null)
    setDiff(null)
  }, [])

  const doRevert = useCallback(async (): Promise<void> => {
    if (!confirmRevert) return
    setReverting(true)
    setRevertError(null)
    try {
      const res = await window.api.projects.git.revert(project.id, confirmRevert.hash)
      if (!res.ok) {
        setRevertError(res.error ?? 'Could not restore that version.')
        return
      }
      setConfirmRevert(null)
      if (!res.noChanges) onRequestDeploy?.()
    } finally {
      setReverting(false)
    }
  }, [confirmRevert, project.id, onRequestDeploy])

  const copySha = useCallback((hash: string): void => {
    void navigator.clipboard.writeText(hash)
    setCopiedSha(true)
    setTimeout(() => setCopiedSha(false), 1200)
  }, [])

  const copyContents = useCallback((): void => {
    if (!diff) return
    void navigator.clipboard.writeText(diff.after || diff.before)
    setCopiedDiff(true)
    setTimeout(() => setCopiedDiff(false), 1200)
  }, [diff])

  const openFileHistory = useCallback(
    async (e: MouseEvent): Promise<void> => {
      e.stopPropagation()
      if (!file) return
      const next = !showFileLog
      setShowFileLog(next)
      if (!next) return
      setFileLogLoading(true)
      setFileLog(null)
      try {
        setFileLog(await window.api.projects.git.fileLog(project.id, file.path))
      } finally {
        setFileLogLoading(false)
      }
    },
    [file, project.id, showFileLog]
  )

  const jumpToVersion = useCallback((hash: string): void => {
    preferredPathRef.current = file?.path ?? null
    setCompareMode(false)
    setShowFileLog(false)
    setRef(hash)
  }, [file])

  const working = history?.workingChanges ?? 0
  const head = history?.head
  const deployedCommit = project.lastDeploy?.commit
  const selectedCommit = ref && ref !== GIT_WORKING_REF ? commits.find((c) => c.hash === ref) : null
  const baseCommit = base ? commits.find((c) => c.hash === base) ?? null : null
  const targetCommit = target ? commits.find((c) => c.hash === target) ?? null : null
  const canRestore = Boolean(selectedCommit) && ref !== head
  const drift = Boolean(deployedCommit) && Boolean(head) && head !== deployedCommit
  const showWorking = working > 0 && query.trim() === ''

  // Filter + group the timeline by friendly time buckets.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commits
    return commits.filter(
      (c) =>
        c.subject.toLowerCase().includes(q) ||
        c.author.toLowerCase().includes(q) ||
        c.shortHash.toLowerCase().includes(q) ||
        c.hash.toLowerCase().includes(q)
    )
  }, [commits, query])

  const groups = useMemo(() => {
    const out: { label: string; items: GitCommitSummary[] }[] = []
    let cur: { label: string; items: GitCommitSummary[] } | null = null
    for (const c of filtered) {
      const label = dateBucket(c.isoDate)
      if (!cur || cur.label !== label) {
        cur = { label, items: [] }
        out.push(cur)
      }
      cur.items.push(c)
    }
    return out
  }, [filtered])

  // Up/Down arrow navigation through the (filtered) timeline in browse mode.
  const onRailKey = useCallback(
    (e: KeyboardEvent): void => {
      if (compareMode) return
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      const order: string[] = []
      if (showWorking) order.push(GIT_WORKING_REF)
      for (const c of filtered) order.push(c.hash)
      if (order.length === 0) return
      const idx = ref ? order.indexOf(ref) : -1
      const next =
        e.key === 'ArrowDown'
          ? idx < 0
            ? 0
            : Math.min(order.length - 1, idx + 1)
          : idx < 0
            ? 0
            : Math.max(0, idx - 1)
      selectRef(order[next])
    },
    [compareMode, showWorking, filtered, ref, selectRef]
  )

  const sendCommit = useCallback((): void => {
    if (!onSendToChat) return
    if (compareMode) {
      if (!baseCommit || !targetCommit) return
      onSendToChat(
        `Compare ${baseCommit.shortHash}→${targetCommit.shortHash}`,
        comparePrompt(baseCommit, targetCommit, changes)
      )
    } else if (ref === GIT_WORKING_REF) {
      onSendToChat('Discuss uncommitted changes', workingPrompt(changes))
    } else if (selectedCommit) {
      onSendToChat(`Discuss snapshot ${selectedCommit.shortHash}`, commitPrompt(selectedCommit, changes))
    }
  }, [onSendToChat, compareMode, baseCommit, targetCommit, changes, ref, selectedCommit])

  const sendFile = useCallback((): void => {
    if (!onSendToChat || !file) return
    if (compareMode) {
      if (!baseCommit || !targetCommit) return
      onSendToChat(
        `Discuss ${splitPath(file.path).name}`,
        comparePrompt(baseCommit, targetCommit, [file])
      )
    } else if (ref) {
      onSendToChat(`Discuss ${splitPath(file.path).name}`, filePrompt(file, ref, selectedCommit ?? null))
    }
  }, [onSendToChat, file, compareMode, baseCommit, targetCommit, ref, selectedCommit])

  const canSendChanges =
    Boolean(onSendToChat) &&
    (compareMode ? Boolean(baseCommit && targetCommit) : Boolean(selectedCommit) || ref === GIT_WORKING_REF)

  if (history && !history.isRepo) {
    return (
      <div className="code-empty">
        This project isn’t tracked by git yet, so there’s no history to show.
      </div>
    )
  }
  if (history && history.commits.length === 0 && working === 0) {
    return (
      <div className="hist-empty">
        <div className="hist-empty-title">No history yet</div>
        <div className="hist-empty-sub">
          Every time you deploy or save, Fabricator records a snapshot here so you can see
          exactly what changed.
        </div>
      </div>
    )
  }

  const filesTitle = compareMode
    ? baseCommit && targetCommit
      ? `${baseCommit.shortHash} → ${targetCommit.shortHash}`
      : 'Pick two snapshots'
    : ref === GIT_WORKING_REF
      ? 'Uncommitted changes'
      : selectedCommit?.subject ?? 'Changes'

  return (
    <div className="hist-shell">
      {drift && (
        <div className="hist-drift">
          <span className="hist-drift-text">
            Your live app is showing an earlier version than your current code.
          </span>
          {onRequestDeploy && (
            <button className="btn btn--xs btn--primary" onClick={onRequestDeploy} disabled={reverting}>
              Publish current version
            </button>
          )}
        </div>
      )}

      <div className="hist">
        <div className="hist-rail">
          <div className="hist-rail-head">
            <span>Timeline</span>
            <button
              className={`hist-cmp-toggle${compareMode ? ' hist-cmp-toggle--on' : ''}`}
              onClick={() => {
                setCompareMode((c) => !c)
                setFile(null)
                setDiff(null)
              }}
              title="Compare any two snapshots"
            >
              <CompareIcon className="btn-ico" />
              Compare
            </button>
          </div>

          {!compareMode && (
            <div className="hist-search">
              <SearchIcon className="hist-search-ico" />
              <input
                className="hist-search-input"
                placeholder="Search by message, author, or hash…"
                value={query}
                spellCheck={false}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                <button className="hist-search-x" onClick={() => setQuery('')} aria-label="Clear search">
                  ×
                </button>
              )}
            </div>
          )}

          {compareMode && (
            <div className="hist-cmp">
              <label className="hist-cmp-row">
                <span className="hist-cmp-label">Base</span>
                <select
                  className="hist-cmp-sel"
                  value={base ?? ''}
                  onChange={(e) => setBase(e.target.value)}
                >
                  {commits.map((c) => (
                    <option key={c.hash} value={c.hash}>
                      {c.shortHash} — {c.subject}
                    </option>
                  ))}
                </select>
              </label>
              <div className="hist-cmp-arrow">↓</div>
              <label className="hist-cmp-row">
                <span className="hist-cmp-label">Target</span>
                <select
                  className="hist-cmp-sel"
                  value={target ?? ''}
                  onChange={(e) => setTarget(e.target.value)}
                >
                  {commits.map((c) => (
                    <option key={c.hash} value={c.hash}>
                      {c.shortHash} — {c.subject}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          <div
            className="hist-rail-body"
            tabIndex={0}
            role="listbox"
            aria-label="Timeline"
            onKeyDown={onRailKey}
          >
            {history === null ? (
              <Skeleton rows={5} avatar />
            ) : (
              <>
                {showWorking && (
                  <button
                    className={`hist-commit hist-commit--working${ref === GIT_WORKING_REF && !compareMode ? ' hist-commit--sel' : ''}`}
                    onClick={() => selectRef(GIT_WORKING_REF)}
                  >
                    <span className="hist-commit-dot hist-commit-dot--working" />
                    <span className="hist-commit-main">
                      <span className="hist-commit-msg">Uncommitted changes</span>
                      <span className="hist-commit-meta">
                        {plural(working, 'file')} changed · not deployed yet
                      </span>
                    </span>
                  </button>
                )}

                {groups.length === 0 && !showWorking ? (
                  <div className="code-tree-empty">No matches.</div>
                ) : (
                  groups.map((group) => (
                    <div key={group.label} className="hist-group-wrap">
                      <div className="hist-group">{group.label}</div>
                      {group.items.map((c) => {
                        const isBase = compareMode && c.hash === base
                        const isTarget = compareMode && c.hash === target
                        const isSel = !compareMode && ref === c.hash
                        const cls = [
                          'hist-commit',
                          isSel ? 'hist-commit--sel' : '',
                          isBase ? 'hist-commit--base' : '',
                          isTarget ? 'hist-commit--target' : ''
                        ]
                          .filter(Boolean)
                          .join(' ')
                        return (
                          <button
                            key={c.hash}
                            className={cls}
                            onClick={() => (compareMode ? setTarget(c.hash) : selectRef(c.hash))}
                            title={`${c.shortHash} · ${new Date(c.isoDate).toLocaleString()}`}
                          >
                            <span className="hist-commit-dot" />
                            <span className="hist-commit-main">
                              <span className="hist-commit-msg">{c.subject}</span>
                              <span className="hist-commit-meta">
                                {c.relativeDate}
                                {c.author ? ` · ${c.author}` : ''}
                              </span>
                            </span>
                            {isBase && <span className="hist-cmp-tag">Base</span>}
                            {isTarget && <span className="hist-cmp-tag hist-cmp-tag--target">Target</span>}
                            {c.hash === deployedCommit && (
                              <span className="hist-live" title="This is the version that's live right now">
                                Live
                              </span>
                            )}
                            {c.filesChanged > 0 && <span className="hist-commit-count">{c.filesChanged}</span>}
                          </button>
                        )
                      })}
                    </div>
                  ))
                )}
              </>
            )}
          </div>
        </div>

        <div className="hist-files">
          <div className="hist-files-head">
            <span className="hist-files-title" title={filesTitle}>
              {filesTitle}
            </span>
            <span className="hist-files-spacer" />
            {canSendChanges && (
              <button
                className="btn btn--xs btn--ghost hist-send"
                onClick={sendCommit}
                title="Use this in the chat — we’ll add it as context for your next message"
              >
                <ChatIcon className="btn-ico" />
                {compareMode ? 'Send comparison' : 'Send to chat'}
              </button>
            )}
            {canRestore && selectedCommit && (
              <button
                className="btn btn--xs btn--ghost hist-restore"
                onClick={() => {
                  setRevertError(null)
                  setConfirmRevert(selectedCommit)
                }}
                title="Take your app back to how it was at this point"
              >
                Restore this version
              </button>
            )}
          </div>

          {!compareMode && selectedCommit && (
            <div className="hist-detail">
              <button
                className="hist-detail-sha"
                onClick={() => copySha(selectedCommit.hash)}
                title="Copy the full version id"
              >
                <CopyIcon className="btn-ico" />
                {copiedSha ? 'Copied' : selectedCommit.shortHash}
              </button>
              <span className="hist-detail-meta">
                {selectedCommit.author ? `${selectedCommit.author} · ` : ''}
                {new Date(selectedCommit.isoDate).toLocaleString()}
              </span>
            </div>
          )}

          <div className="hist-files-body">
            {changesLoading ? (
              <Skeleton rows={4} />
            ) : !changes || changes.length === 0 ? (
              <div className="code-tree-empty">
                {compareMode
                  ? 'No differences between these two snapshots.'
                  : ref === GIT_WORKING_REF
                    ? 'Nothing changed since the last snapshot.'
                    : 'No file changes.'}
              </div>
            ) : (
              <>
                <div className="hist-files-count">{plural(changes.length, 'file')} changed</div>
                {changes.map((f) => {
                  const { name, dir } = splitPath(f.path)
                  const selected = file?.path === f.path
                  return (
                    <button
                      key={f.path}
                      className={`hist-file${selected ? ' hist-file--sel' : ''}`}
                      onClick={() => setFile(f)}
                      title={f.path}
                    >
                      <span className={`hist-file-badge hist-file-badge--${f.status}`}>
                        {STATUS_LABEL[f.status]}
                      </span>
                      <span className="hist-file-name">{name}</span>
                      {dir && <span className="hist-file-dir">{dir}</span>}
                      {f.binary ? (
                        <span className="hist-file-binary">binary</span>
                      ) : (
                        <ChangeStat ins={f.insertions} del={f.deletions} />
                      )}
                    </button>
                  )
                })}
              </>
            )}
          </div>
        </div>

        <div className="hist-diff">
          {file && (
            <div className="hist-diff-head">
              <span
                className="hist-diff-path"
                title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
              >
                {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
              </span>
              <span className="hist-diff-spacer" />

              <div className="hist-filelog" onClick={(e) => e.stopPropagation()}>
                <button
                  className="hist-diff-tool"
                  onClick={(e) => void openFileHistory(e)}
                  title="See every change to this file"
                >
                  <HistoryIcon className="btn-ico" />
                </button>
                {showFileLog && (
                  <div className="hist-filelog-pop">
                    <div className="hist-filelog-title">History of this file</div>
                    <div className="hist-filelog-body">
                      {fileLogLoading ? (
                        <Skeleton rows={3} avatar />
                      ) : !fileLog || fileLog.length === 0 ? (
                        <div className="code-tree-empty">No earlier versions found.</div>
                      ) : (
                        fileLog.map((c) => (
                          <button
                            key={c.hash}
                            className={`hist-filelog-row${!compareMode && ref === c.hash ? ' hist-filelog-row--sel' : ''}`}
                            onClick={() => jumpToVersion(c.hash)}
                            title={new Date(c.isoDate).toLocaleString()}
                          >
                            <span className="hist-filelog-msg">{c.subject}</span>
                            <span className="hist-filelog-meta">
                              {c.shortHash} · {c.relativeDate}
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>

              {onSendToChat && (
                <button className="hist-diff-tool" onClick={sendFile} title="Send this file's change to chat">
                  <ChatIcon className="btn-ico" />
                </button>
              )}
              {diff && !diff.binary && !diff.tooLarge && (
                <button className="hist-diff-tool" onClick={copyContents} title="Copy this version's contents">
                  {copiedDiff ? <span className="hist-diff-copied">Copied</span> : <CopyIcon className="btn-ico" />}
                </button>
              )}

              <span className="hist-diff-divider" />
              <div className="hist-seg" role="tablist" aria-label="Diff layout">
                <button
                  className={`hist-seg-btn${sideBySide ? ' hist-seg-btn--on' : ''}`}
                  onClick={() => setSideBySide(true)}
                >
                  Side by side
                </button>
                <button
                  className={`hist-seg-btn${sideBySide ? '' : ' hist-seg-btn--on'}`}
                  onClick={() => setSideBySide(false)}
                >
                  Unified
                </button>
              </div>
              <button
                className={`hist-diff-tool${wrap ? ' hist-diff-tool--on' : ''}`}
                onClick={() => setWrap((w) => !w)}
                title="Wrap long lines"
              >
                Wrap
              </button>
            </div>
          )}
          <div className="hist-diff-body">
            {!file ? (
              <div className="code-empty">Select a file to see what changed.</div>
            ) : file.binary ? (
              <div className="code-empty">This is an image or binary file — no text diff to show.</div>
            ) : diffLoading ? (
              <div className="code-empty">Loading…</div>
            ) : diff?.error ? (
              <div className="code-empty code-empty--err">{diff.error}</div>
            ) : diff?.tooLarge ? (
              <div className="code-empty">This file is too large to show a diff.</div>
            ) : diff ? (
              <DiffEditor
                key={`${compareMode ? `${base}:${target}` : ref}:${file.path}`}
                height="100%"
                theme={theme}
                language={monacoLanguage(file.path)}
                original={diff.before}
                modified={diff.after}
                loading={<div className="code-empty">Loading editor…</div>}
                options={{
                  ...DIFF_OPTIONS,
                  renderSideBySide: sideBySide,
                  wordWrap: wrap ? 'on' : 'off',
                  diffWordWrap: wrap ? 'on' : 'off'
                }}
              />
            ) : null}
          </div>
        </div>
      </div>

      {confirmRevert && (
        <ConfirmModal
          title="Restore this version?"
          confirmLabel="Restore & redeploy"
          busy={reverting}
          onCancel={() => {
            if (!reverting) setConfirmRevert(null)
          }}
          onConfirm={() => void doRevert()}
          message={
            <>
              <p>
                Your app will go back to how it was at{' '}
                <strong>“{confirmRevert.subject}”</strong>.
              </p>
              <p>
                Your current version stays saved in this timeline, so you can switch back anytime.
                Fabricator will then redeploy so your live app matches.
              </p>
              {revertError && <p className="confirm-error">{revertError}</p>}
            </>
          }
        />
      )}
    </div>
  )
}
