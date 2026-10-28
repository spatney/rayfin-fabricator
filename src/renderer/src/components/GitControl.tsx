import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { GitBranch, GitRemoteStatus, GitStatus } from '../../../shared/ipc'
import { useSuppressPreview } from '../overlay'
import { Codicon } from './icons'

interface Props {
  projectId: string
  /** Bumped by the parent when the working tree likely changed (deploy/turn). */
  refreshKey: number
  /** Called after a successful commit, sync, or branch switch. */
  onSynced?: () => void
  switchDisabled?: boolean
}

/** How often we re-fetch the remote to keep ahead/behind fresh (ms). */
const FETCH_PERIOD_MS = 3 * 60 * 1000

/**
 * Compact git status pill for the project header: shows the branch, the number of
 * uncommitted changes, and — when the repo has a remote — how many changes are
 * waiting to be pulled (behind) or pushed (ahead). The popover stages-all + commits
 * and offers branch switching, pull, and push.
 */
export default function GitControl({ projectId, refreshKey, onSynced, switchDisabled = false }: Props): JSX.Element | null {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [remote, setRemote] = useState<GitRemoteStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [syncing, setSyncing] = useState<'pull' | 'push' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [branches, setBranches] = useState<GitBranch[]>([])
  const [loadingBranches, setLoadingBranches] = useState(false)
  const [branchQuery, setBranchQuery] = useState('')
  const [switching, setSwitching] = useState<string | null>(null)
  const fetchingRef = useRef(false)
  const branchGeneration = useRef(0)

  const refresh = useCallback(async (): Promise<void> => {
    setStatus(await window.api.projects.git.status(projectId))
  }, [projectId])

  // Network-touching: runs `git fetch` to refresh the known divergence. Guarded so
  // overlapping ticks (timer + refreshKey + manual) don't pile up.
  const loadRemote = useCallback(async (): Promise<void> => {
    if (fetchingRef.current) return
    fetchingRef.current = true
    const generation = branchGeneration.current
    try {
      const next = await window.api.projects.git.remoteStatus(projectId)
      if (generation === branchGeneration.current) setRemote(next)
    } finally {
      fetchingRef.current = false
    }
  }, [projectId])

  const loadBranches = useCallback(async (): Promise<void> => {
    setLoadingBranches(true)
    try {
      setBranches(await window.api.projects.git.branches(projectId))
    } catch (reason) {
      setError(String(reason))
    } finally {
      setLoadingBranches(false)
    }
  }, [projectId])

  useEffect(() => {
    if (!open) return
    void loadBranches()
  }, [open, loadBranches, remote])

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

  // Derive the actionable state before the early return so the hooks below run
  // unconditionally (Rules of Hooks). `status` may still be null on first paint.
  const dirty = (status?.changedCount ?? 0) > 0
  const behind = remote?.behind ?? 0
  const ahead = remote?.ahead ?? 0
  const canPush = ahead > 0 && Boolean(remote?.hasUpstream)
  const working = busy || syncing !== null || switching !== null

  // The popover is HTML; the live preview is a native webview that paints above
  // all HTML, so it must be hidden (frozen to a still frame) while the popover
  // is open — otherwise the popover renders behind the preview.
  useSuppressPreview(open)

  if (!status || !status.isRepo) return null

  async function switchBranch(branch: GitBranch): Promise<void> {
    if (working || switchDisabled || branch.current) return
    setSwitching(branch.refName)
    setError(null)
    branchGeneration.current += 1
    try {
      const next = await window.api.projects.git.switchBranch(projectId, branch.refName)
      setStatus(next)
      setRemote(null)
      setMessage('')
      onSynced?.()
      setRemote(await window.api.projects.git.divergence(projectId))
      setOpen(false)
    } catch (reason) {
      setError(String(reason))
    } finally {
      setSwitching(null)
    }
  }

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

  async function pull(): Promise<void> {
    setSyncing('pull')
    setError(null)
    try {
      const res = await window.api.projects.git.pull(projectId)
      setStatus(res.status)
      setRemote(res.remote)
      if (!res.ok) {
        setError(res.error ?? 'Could not get the latest changes.')
        return
      }
      onSynced?.()
      if (res.status.changedCount === 0 && res.remote.behind === 0 && res.remote.ahead === 0) {
        setOpen(false)
      }
    } finally {
      setSyncing(null)
    }
  }

  async function push(): Promise<void> {
    setSyncing('push')
    setError(null)
    try {
      const res = await window.api.projects.git.push(projectId)
      setStatus(res.status)
      setRemote(res.remote)
      if (!res.ok) {
        setError(res.error ?? 'Could not push your changes.')
        return
      }
      onSynced?.()
      if (res.remote.ahead === 0) setOpen(false)
    } finally {
      setSyncing(null)
    }
  }

  const countLabel = dirty ? `${status.changedCount} uncommitted` : 'clean'

  return (
    <div
      className="git-control"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setOpen(false)
      }}
    >
      <button
        className={`chip git-chip git-chip--actionable${dirty ? ' git-chip--dirty' : ' git-chip--clean'}`}
        title={status.branch ? `Branch: ${status.branch} — switch branches and manage changes` : 'Switch branches and manage changes'}
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
        <span className="git-count">{countLabel}</span>
        {(behind > 0 || ahead > 0) && (
          <span className="git-sync-badges">
            {behind > 0 && (
              <span className="git-badge git-badge--behind" title={`${behind} change${behind === 1 ? '' : 's'} to get from the remote`}>
                ↓{behind}
              </span>
            )}
            {ahead > 0 && (
              <span className="git-badge git-badge--ahead" title={`${ahead} change${ahead === 1 ? '' : 's'} to push`}>
                ↑{ahead}
              </span>
            )}
          </span>
        )}
      </button>

      {open && (
        <div className="git-popover">
          <div className="git-popover-title">Switch branch</div>
          <input
            className="git-msg-input"
            aria-label="Filter branches"
            placeholder="Filter branches"
            value={branchQuery}
            onChange={(e) => setBranchQuery(e.target.value)}
          />
          <div className="git-sync-sub">
            Switches the entire repository. Commit or stash all changes first.
          </div>
          {switchDisabled && <div className="git-sync-sub">Wait for the current chat or deployment to finish.</div>}
          {loadingBranches && <div className="git-sync-sub" role="status">Loading branches...</div>}
          <div className="git-branch-list" aria-label="Repository branches">
            {branches
              .filter((branch) => branch.name.toLowerCase().includes(branchQuery.toLowerCase()))
              .map((branch) => (
                <button
                  key={branch.refName}
                  className="git-branch-option"
                  disabled={working || switchDisabled || branch.current}
                  title={branch.refName}
                  onClick={() => void switchBranch(branch)}
                >
                  <span>{branch.name}</span>{' '}
                  <span className="git-sync-sub">
                    {switching === branch.refName ? 'Switching...' : branch.current ? 'Current' : branch.remote ? 'Remote' : 'Local'}
                  </span>
                </button>
              ))}
          </div>
          {!loadingBranches && !branches.some((branch) => branch.name.toLowerCase().includes(branchQuery.toLowerCase())) && (
            <div className="git-sync-sub">No matching branches.</div>
          )}
          {(dirty || behind > 0 || canPush) && <div className="git-popover-divider" />}
          {behind > 0 && (
            <div className="git-sync-row">
              <div className="git-sync-text">
                <div className="git-sync-title">Get latest changes</div>
                <div className="git-sync-sub">
                  {behind} change{behind === 1 ? '' : 's'} waiting on the remote
                </div>
              </div>
              <button
                className="btn btn--xs btn--primary"
                disabled={working}
                onClick={() => void pull()}
              >
                {syncing === 'pull' ? 'Getting…' : 'Get latest'}
              </button>
            </div>
          )}

          {canPush && (
            <div className="git-sync-row">
              <div className="git-sync-text">
                <div className="git-sync-title">Push your changes</div>
                <div className="git-sync-sub">
                  {ahead} change{ahead === 1 ? '' : 's'} ready to push
                </div>
              </div>
              <button
                className="btn btn--xs btn--ghost"
                disabled={working}
                onClick={() => void push()}
              >
                {syncing === 'push' ? 'Pushing…' : 'Push'}
              </button>
            </div>
          )}

          {dirty && (behind > 0 || canPush) && <div className="git-popover-divider" />}

          {dirty && (
            <>
              <div className="git-popover-title">
                Commit {status.changedCount} change{status.changedCount === 1 ? '' : 's'}
                {status.branch ? ` on ${status.branch}` : ''}
              </div>
              <input
                className="git-msg-input"
                placeholder="Commit message"
                value={message}
                autoFocus
                spellCheck={false}
                disabled={working}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commit()
                  else if (e.key === 'Escape') setOpen(false)
                }}
              />
            </>
          )}

          {error && <div className="git-error" role="alert">{error}</div>}
          {remote?.fetchError && <div className="git-error" role="alert">{remote.fetchError}</div>}

          {dirty && (
            <div className="git-popover-actions">
              <button className="btn btn--xs btn--ghost" disabled={busy} onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button
                className="btn btn--xs btn--primary"
                disabled={working || !message.trim()}
                onClick={() => void commit()}
              >
                {busy ? 'Committing…' : 'Commit all'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
