import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { GitBranch, GitRemoteStatus, GitStatus, GitSyncResult } from '../../../shared/ipc'
import { useSuppressPreview } from '../overlay'
import { Codicon } from './icons'

interface Props {
  projectId: string
  /** Bumped by the parent when the working tree likely changed (deploy/turn). */
  refreshKey: number
  /** A chat turn is running: what would change the app's files waits for it. */
  busy?: boolean
  /**
   * Called after a commit, pull, push, merge or switch of branch went through,
   * so the parent can refresh the app; `packagesChanged` when it changed the
   * app's packages, which need installing again.
   */
  onSynced?: (packagesChanged?: boolean) => void
  /** Send Copilot a request in the app's chat (`display` is what the chat shows). */
  onSendToChat?: (display: string, prompt: string) => void
}

/** How often we re-fetch the remote to keep ahead/behind fresh (ms). */
const FETCH_PERIOD_MS = 3 * 60 * 1000
/** Conflicted files the popover names before "and N more". */
const SHOWN_CONFLICTS = 4

type Syncing = 'pull' | 'push' | 'merge' | 'finish' | 'abort' | 'switch'

const FAILED: Record<Syncing, string> = {
  pull: 'Could not get the latest changes.',
  push: 'Could not push your changes.',
  merge: 'Couldn’t combine the latest changes.',
  finish: 'Couldn’t finish the merge.',
  abort: 'Couldn’t cancel the merge.',
  switch: 'Couldn’t switch branches.'
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** What Copilot is asked to do with a merge's conflicts (files relative to the project). */
export function conflictsPrompt(files: string[], branch?: string): string {
  return [
    `Getting the latest changes${branch ? ` into ${branch}` : ''} stopped at merge conflicts: git started the merge and marked where my changes and the latest ones overlap, in ${files.length === 1 ? 'this file' : 'these files'} (relative to the project folder):`,
    ...files.map((file) => `- ${file}`),
    '',
    'Resolve every conflict: read both sides, keep what each side meant to do, and remove all the conflict markers (<<<<<<<, ======= and >>>>>>>). Where package.json conflicted, settle it first, then run npm install so package-lock.json follows it, rather than merging the lockfile by hand.',
    'Then check that the app still type-checks and builds, and fix what the combined changes broke.',
    'When you’re done, finish the merge: git add the files you resolved, then git commit --no-edit. Don’t abort or reset the merge, and don’t push.'
  ].join('\n')
}

/**
 * Compact git status pill for the status bar: shows the branch, the number of
 * uncommitted changes (or a merge's conflicts), and — when the repo has a
 * remote — how many changes are waiting to be pulled (behind) or pushed
 * (ahead). The popover switches branches, gets the latest changes, pushes and
 * commits. When your changes and the latest ones overlap, it merges them and
 * asks Copilot to resolve the conflicts, then finishes (or cancels) the merge.
 */
export default function GitControl({
  projectId,
  refreshKey,
  busy: chatBusy = false,
  onSynced,
  onSendToChat
}: Props): JSX.Element | null {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [remote, setRemote] = useState<GitRemoteStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'main' | 'branches'>('main')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  /** Copilot is writing the commit message. */
  const [writing, setWriting] = useState(false)
  const [syncing, setSyncing] = useState<Syncing | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** The last pull found your changes and the latest ones overlap. */
  const [overlap, setOverlap] = useState(false)
  const [branches, setBranches] = useState<GitBranch[] | null>(null)
  const [query, setQuery] = useState('')
  const [switchingTo, setSwitchingTo] = useState<string | null>(null)
  const fetchRef = useRef<Promise<void> | null>(null)
  const projectRef = useRef(projectId)
  projectRef.current = projectId
  const inputRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setStatus(await window.api.projects.git.status(projectId))
  }, [projectId])

  // Network-touching: runs `git fetch` to refresh the known divergence. One at
  // a time, so overlapping ticks (timer + refreshKey + manual) don't pile up.
  const loadRemote = useCallback((): Promise<void> => {
    if (fetchRef.current) return fetchRef.current
    const fetching = (async () => {
      try {
        setRemote(await window.api.projects.git.remoteStatus(projectId))
      } finally {
        fetchRef.current = null
      }
    })()
    fetchRef.current = fetching
    return fetching
  }, [projectId])

  useEffect(() => {
    void refresh()
    void loadRemote()
  }, [refresh, loadRemote, refreshKey])

  // Periodically re-fetch (skipped while the window is hidden), and refresh on focus.
  useEffect(() => {
    const tick = (): void => {
      if (!document.hidden) void loadRemote()
    }
    const timer = window.setInterval(tick, FETCH_PERIOD_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [loadRemote])

  // Close the popover on any outside click.
  useEffect(() => {
    if (!open) return
    const close = (): void => setOpen(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [open])

  // Each opening starts on the main view, without the last one's error.
  useEffect(() => {
    if (open) return
    setView('main')
    setQuery('')
    setError(null)
    setOverlap(false)
  }, [open])

  // The popover is HTML; the live preview is a native webview that paints above
  // all HTML, so it must be hidden (frozen to a still frame) while the popover
  // is open — otherwise the popover renders behind the preview.
  useSuppressPreview(open)

  if (!status || !status.isRepo) return null

  const dirty = status.changedCount > 0
  const behind = remote?.behind ?? 0
  const ahead = remote?.ahead ?? 0
  const canPush = ahead > 0 && Boolean(remote?.hasUpstream)
  const merging = Boolean(status.merging)
  const conflicts = status.conflicts ?? []
  const locked = chatBusy || syncing !== null || busy
  const waitTitle = chatBusy ? 'Wait for Copilot to finish this turn' : undefined

  async function commit(): Promise<void> {
    const msg = message.trim()
    if (!msg) return
    setBusy(true)
    setError(null)
    try {
      const res = await window.api.projects.git.commit(projectId, msg)
      setStatus(res.status)
      if (!res.ok) {
        setError(res.error ?? 'Commit failed.')
        return
      }
      setMessage('')
      void loadRemote()
      onSynced?.()
    } finally {
      setBusy(false)
    }
  }

  /** Have Copilot, on its Auto model, write the message from the changes. */
  async function writeMessage(): Promise<void> {
    const asked = projectId
    let wrote = false
    setWriting(true)
    setError(null)
    try {
      const res = await window.api.projects.git.message(asked)
      if (projectRef.current !== asked) return
      if (res.ok && res.message) {
        setMessage(res.message)
        wrote = true
      } else {
        setError(res.error ?? 'Couldn’t write a commit message.')
      }
    } catch (reason) {
      if (projectRef.current === asked) {
        setError(reason instanceof Error ? reason.message : 'Couldn’t write a commit message.')
      }
    } finally {
      setWriting(false)
      // The box is disabled while Copilot writes; focus it once it's back, to edit or commit.
      if (wrote) requestAnimationFrame(() => inputRef.current?.focus())
    }
  }

  /** Run a sync, taking its status; one that went through tells the parent. */
  async function sync(
    kind: Syncing,
    call: (id: string) => Promise<GitSyncResult>
  ): Promise<GitSyncResult | null> {
    setSyncing(kind)
    setError(null)
    try {
      const res = await call(projectId)
      setStatus(res.status)
      setRemote(res.remote)
      if (res.ok) onSynced?.(res.packagesChanged)
      else setError(res.error ?? FAILED[kind])
      return res
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : FAILED[kind])
      return null
    } finally {
      setSyncing(null)
    }
  }

  /** Close once nothing is left to do here. */
  function closeIfSynced(res: GitSyncResult): void {
    if (
      res.status.changedCount === 0 &&
      !res.status.merging &&
      res.remote.behind === 0 &&
      res.remote.ahead === 0
    ) {
      setOpen(false)
    }
  }

  async function pull(): Promise<void> {
    const res = await sync('pull', window.api.projects.git.pull)
    setOverlap(Boolean(res && !res.ok && res.conflict))
    if (res?.ok) closeIfSynced(res)
  }

  async function push(): Promise<void> {
    const res = await sync('push', window.api.projects.git.push)
    if (res?.ok && res.remote.ahead === 0) setOpen(false)
  }

  function askCopilot(files: string[]): void {
    if (!onSendToChat || files.length === 0) return
    onSendToChat(
      files.length === 1
        ? `Resolve the merge conflict in ${files[0]}`
        : `Resolve the merge conflicts in ${files.length} files`,
      conflictsPrompt(files, status?.branch)
    )
    setOpen(false)
  }

  /** Merge the latest changes for Copilot to resolve; one that goes through on its own is done. */
  async function mergeLatest(): Promise<void> {
    const res = await sync('merge', window.api.projects.git.mergeLatest)
    setOverlap(false)
    if (!res) return
    if (res.ok) closeIfSynced(res)
    else if (res.conflict && res.status.conflicts?.length) askCopilot(res.status.conflicts)
  }

  async function finishMerge(): Promise<void> {
    const res = await sync('finish', window.api.projects.git.finishMerge)
    if (res?.ok) closeIfSynced(res)
  }

  async function abortMerge(): Promise<void> {
    const res = await sync('abort', window.api.projects.git.abortMerge)
    if (res?.ok) closeIfSynced(res)
  }

  async function loadBranches(): Promise<void> {
    try {
      const list = await window.api.projects.git.branches(projectId)
      if (projectRef.current === projectId) setBranches(list.branches)
    } catch {
      if (projectRef.current === projectId) setBranches([])
    }
  }

  /** The branch list, as known now and again once the remote's been fetched. */
  function showBranches(): void {
    setView('branches')
    setBranches(null)
    setQuery('')
    setError(null)
    void loadBranches()
    void loadRemote().then(loadBranches, () => undefined)
  }

  async function switchTo(name: string): Promise<void> {
    setSwitchingTo(name)
    const res = await sync('switch', (id) => window.api.projects.git.switchBranch(id, name))
    setSwitchingTo(null)
    if (res?.ok) setOpen(false)
  }

  const chipLabel = merging
    ? conflicts.length
      ? plural(conflicts.length, 'conflict')
      : 'merging'
    : dirty
      ? `${status.changedCount} uncommitted`
      : 'clean'
  const q = query.trim().toLowerCase()
  const shown = (branches ?? []).filter((b) => b.name.toLowerCase().includes(q))
  const localShown = shown.filter((b) => !b.remote)
  const remoteShown = shown.filter((b) => b.remote)

  const branchItem = (b: GitBranch): JSX.Element => {
    const current = !b.remote && b.name === status.branch
    return (
      <button
        key={b.name}
        type="button"
        className="git-branch-item"
        aria-current={current || undefined}
        disabled={locked || current}
        title={waitTitle}
        onClick={() => void switchTo(b.name)}
      >
        <Codicon
          name={current ? 'check' : b.remote ? 'cloud' : 'git-branch'}
          className="git-branch-ico"
        />
        <span className="git-branch-name">{b.name}</span>
        {switchingTo === b.name && <span className="git-branch-note">Switching…</span>}
      </button>
    )
  }

  return (
    <div className="git-control" onClick={(e) => e.stopPropagation()}>
      <button
        className={`chip git-chip git-chip--actionable${merging ? ' git-chip--conflict' : dirty ? ' git-chip--dirty' : ' git-chip--clean'}`}
        title={status.branch ? `Branch: ${status.branch}` : 'git'}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          void refresh()
          void loadRemote()
          setOpen((o) => !o)
        }}
      >
        <Codicon name="git-branch" className="statusbar-ico" />
        <span className="git-branch">{status.branch ?? 'git'}</span>
        <span className="git-dot" aria-hidden="true">
          ·
        </span>
        <span className="git-count">{chipLabel}</span>
        {(behind > 0 || ahead > 0) && (
          <span className="git-sync-badges">
            {behind > 0 && (
              <span
                className="git-badge git-badge--behind"
                title={`${plural(behind, 'change')} to get from the remote`}
              >
                ↓{behind}
              </span>
            )}
            {ahead > 0 && (
              <span
                className="git-badge git-badge--ahead"
                title={`${plural(ahead, 'change')} to push`}
              >
                ↑{ahead}
              </span>
            )}
          </span>
        )}
      </button>

      {open && (
        <div
          className="git-popover"
          role="dialog"
          aria-label="Git"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            e.preventDefault()
            if (view === 'branches') setView('main')
            else setOpen(false)
          }}
        >
          {view === 'branches' ? (
            <>
              <div className="git-branches-head">
                <button
                  type="button"
                  className="git-back"
                  aria-label="Back"
                  onClick={() => setView('main')}
                >
                  <Codicon name="arrow-left" />
                </button>
                <span className="git-sync-title">Switch branch</span>
              </div>
              <input
                className="git-msg-input"
                placeholder="Filter branches"
                aria-label="Filter branches"
                value={query}
                autoFocus
                spellCheck={false}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div className="git-branch-list" role="group" aria-label="Branches">
                {localShown.map(branchItem)}
                {remoteShown.length > 0 && (
                  <div className="git-branch-heading" aria-hidden="true">
                    On the remote
                  </div>
                )}
                {remoteShown.map(branchItem)}
                {branches === null && (
                  <div className="git-branch-empty shimmer-text">Loading branches…</div>
                )}
                {branches !== null && shown.length === 0 && (
                  <div className="git-branch-empty">
                    {q ? `No branches match “${query.trim()}”` : 'No other branches yet.'}
                  </div>
                )}
              </div>
              {dirty && (
                <div className="git-sync-sub">
                  Your {plural(status.changedCount, 'uncommitted change')}{' '}
                  {status.changedCount === 1 ? 'is' : 'are'} saved on{' '}
                  {status.branch ?? 'this branch'} first.
                </div>
              )}
              {error && <div className="git-error">{error}</div>}
            </>
          ) : (
            <>
              {merging ? (
                <div className="git-merge">
                  <div className="git-sync-title">
                    {conflicts.length
                      ? `${plural(conflicts.length, 'file')} ${conflicts.length === 1 ? 'has' : 'have'} conflicts`
                      : 'The conflicts are resolved'}
                  </div>
                  <div className="git-sync-sub">
                    {conflicts.length
                      ? 'Getting the latest changes stopped where your changes and the latest ones overlap.'
                      : 'Finish the merge to save it.'}
                  </div>
                  {conflicts.length > 0 && (
                    <ul className="git-conflicts">
                      {conflicts.slice(0, SHOWN_CONFLICTS).map((file) => (
                        <li key={file}>{file}</li>
                      ))}
                      {conflicts.length > SHOWN_CONFLICTS && (
                        <li className="git-conflicts-more">
                          and {conflicts.length - SHOWN_CONFLICTS} more
                        </li>
                      )}
                    </ul>
                  )}
                  <div className="git-popover-actions">
                    <button
                      className="btn btn--xs btn--ghost"
                      disabled={locked}
                      title={waitTitle}
                      onClick={() => void abortMerge()}
                    >
                      {syncing === 'abort' ? 'Cancelling…' : 'Cancel merge'}
                    </button>
                    {conflicts.length > 0 ? (
                      onSendToChat && (
                        <button
                          className="btn btn--xs btn--primary"
                          disabled={locked}
                          title={waitTitle}
                          onClick={() => askCopilot(conflicts)}
                        >
                          <Codicon name="sparkle" /> Ask Copilot to resolve
                        </button>
                      )
                    ) : (
                      <button
                        className="btn btn--xs btn--primary"
                        disabled={locked}
                        title={waitTitle}
                        onClick={() => void finishMerge()}
                      >
                        {syncing === 'finish' ? 'Finishing…' : 'Finish merge'}
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="git-sync-row">
                  <div className="git-sync-text">
                    <div className="git-sync-title git-current">
                      <Codicon name="git-branch" />
                      <span className="git-branch-name">{status.branch ?? 'No branch'}</span>
                    </div>
                    <div className="git-sync-sub">Current branch</div>
                  </div>
                  <button
                    className="btn btn--xs btn--ghost"
                    disabled={locked || Boolean(status.noCommits)}
                    title={waitTitle}
                    onClick={showBranches}
                  >
                    Switch…
                  </button>
                </div>
              )}

              {!merging && behind > 0 && (
                <div className="git-sync-row">
                  <div className="git-sync-text">
                    <div className="git-sync-title">Get latest changes</div>
                    <div className="git-sync-sub">
                      {plural(behind, 'change')} waiting on the remote
                    </div>
                  </div>
                  <button
                    className="btn btn--xs btn--primary"
                    disabled={locked}
                    title={waitTitle}
                    onClick={() => void pull()}
                  >
                    {syncing === 'pull' ? 'Getting…' : 'Get latest'}
                  </button>
                </div>
              )}

              {!merging && overlap && (
                <div className="git-overlap">
                  <div className="git-error">{error}</div>
                  {onSendToChat && (
                    <div className="git-popover-actions">
                      <button
                        className="btn btn--xs btn--primary"
                        disabled={locked}
                        title={waitTitle}
                        onClick={() => void mergeLatest()}
                      >
                        {syncing === 'merge' ? (
                          'Combining…'
                        ) : (
                          <>
                            <Codicon name="sparkle" /> Ask Copilot to resolve
                          </>
                        )}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {!merging && canPush && (
                <div className="git-sync-row">
                  <div className="git-sync-text">
                    <div className="git-sync-title">Push your changes</div>
                    <div className="git-sync-sub">{plural(ahead, 'change')} ready to push</div>
                  </div>
                  <button
                    className="btn btn--xs btn--ghost"
                    disabled={syncing !== null || busy}
                    onClick={() => void push()}
                  >
                    {syncing === 'push' ? 'Pushing…' : 'Push'}
                  </button>
                </div>
              )}

              {!merging && dirty && <div className="git-popover-divider" />}

              {!merging && dirty && (
                <>
                  <div className="git-popover-title">
                    Commit {plural(status.changedCount, 'change')}
                    {status.branch ? ` on ${status.branch}` : ''}
                  </div>
                  <div className="git-msg-field">
                    <input
                      ref={inputRef}
                      className="git-msg-input"
                      placeholder={writing ? 'Writing a message…' : 'Commit message'}
                      aria-label="Commit message"
                      value={message}
                      autoFocus
                      spellCheck={false}
                      disabled={busy || writing || syncing !== null}
                      onChange={(e) => setMessage(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void commit()
                      }}
                    />
                    <button
                      type="button"
                      className="git-msg-write"
                      aria-label="Write a message with Copilot"
                      title="Write a message with Copilot (Auto)"
                      disabled={busy || writing || syncing !== null}
                      onClick={() => void writeMessage()}
                    >
                      <Codicon
                        name={writing ? 'loading' : 'sparkle'}
                        className={writing ? 'codicon-modifier-spin' : ''}
                      />
                    </button>
                  </div>
                </>
              )}

              {error && !overlap && <div className="git-error">{error}</div>}

              {!merging && dirty && (
                <div className="git-popover-actions">
                  <button
                    className="btn btn--xs btn--ghost"
                    disabled={busy}
                    onClick={() => setOpen(false)}
                  >
                    Cancel
                  </button>
                  <button
                    className="btn btn--xs btn--primary"
                    disabled={busy || writing || syncing !== null || !message.trim()}
                    onClick={() => void commit()}
                  >
                    {busy ? 'Committing…' : 'Commit all'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
