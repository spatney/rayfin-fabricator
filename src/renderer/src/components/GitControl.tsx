import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitRemoteStatus, GitStatus } from '../../../shared/ipc'
import { useSuppressPreview } from '../overlay'
import { BranchIcon } from './icons'

interface Props {
  projectId: string
  /** Bumped by the parent when the working tree likely changed (deploy/turn). */
  refreshKey: number
  /** Called after a successful pull/push so the parent can refresh the app. */
  onSynced?: () => void
}

/** How often we re-fetch the remote to keep ahead/behind fresh (ms). */
const FETCH_PERIOD_MS = 3 * 60 * 1000

/**
 * Compact git status pill for the project header: shows the branch, the number of
 * uncommitted changes, and — when the repo has a remote — how many changes are
 * waiting to be pulled (behind) or pushed (ahead). The popover stages-all + commits
 * and offers "Get latest changes" (pull) / "Push your changes" (push).
 */
export default function GitControl({ projectId, refreshKey, onSynced }: Props): JSX.Element | null {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [remote, setRemote] = useState<GitRemoteStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [syncing, setSyncing] = useState<'pull' | 'push' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fetchingRef = useRef(false)

  const refresh = useCallback(async (): Promise<void> => {
    setStatus(await window.api.projects.git.status(projectId))
  }, [projectId])

  // Network-touching: runs `git fetch` to refresh the known divergence. Guarded so
  // overlapping ticks (timer + refreshKey + manual) don't pile up.
  const loadRemote = useCallback(async (): Promise<void> => {
    if (fetchingRef.current) return
    fetchingRef.current = true
    try {
      setRemote(await window.api.projects.git.remoteStatus(projectId))
    } finally {
      fetchingRef.current = false
    }
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

  // Derive the actionable state before the early return so the hooks below run
  // unconditionally (Rules of Hooks). `status` may still be null on first paint.
  const dirty = (status?.changedCount ?? 0) > 0
  const behind = remote?.behind ?? 0
  const ahead = remote?.ahead ?? 0
  const canPush = ahead > 0 && Boolean(remote?.hasUpstream)
  const actionable = dirty || behind > 0 || canPush

  // The popover is HTML; the live preview is a native webview that paints above
  // all HTML, so it must be hidden (frozen to a still frame) while the popover
  // is open — otherwise the popover renders behind the preview.
  useSuppressPreview(open && actionable)

  if (!status || !status.isRepo) return null

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
    <div className="git-control" onClick={(e) => e.stopPropagation()}>
      <button
        className={`chip git-chip${dirty ? ' git-chip--dirty' : ' git-chip--clean'}${actionable ? ' git-chip--actionable' : ''}`}
        title={status.branch ? `Branch: ${status.branch}` : 'git'}
        onClick={() => {
          void refresh()
          void loadRemote()
          if (actionable) setOpen((o) => !o)
        }}
      >
        <BranchIcon className="git-branch-ico" />
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

      {open && actionable && (
        <div className="git-popover">
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
                disabled={syncing !== null || busy}
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
                disabled={syncing !== null || busy}
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
                disabled={busy || syncing !== null}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commit()
                  else if (e.key === 'Escape') setOpen(false)
                }}
              />
            </>
          )}

          {error && <div className="git-error">{error}</div>}

          {dirty && (
            <div className="git-popover-actions">
              <button className="btn btn--xs btn--ghost" disabled={busy} onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button
                className="btn btn--xs btn--primary"
                disabled={busy || syncing !== null || !message.trim()}
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
