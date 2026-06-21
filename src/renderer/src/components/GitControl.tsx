import { useCallback, useEffect, useState } from 'react'
import type { GitStatus } from '../../../shared/ipc'

interface Props {
  projectId: string
  /** Bumped by the parent when the working tree likely changed (deploy/turn). */
  refreshKey: number
}

/**
 * Compact git status pill for the project header: shows the branch and the
 * number of uncommitted changes, with a popover to stage-all + commit.
 */
export default function GitControl({ projectId, refreshKey }: Props): JSX.Element | null {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setStatus(await window.api.projects.git.status(projectId))
  }, [projectId])

  useEffect(() => {
    void refresh()
  }, [refresh, refreshKey])

  // Close the popover on any outside click.
  useEffect(() => {
    if (!open) return
    const close = (): void => setOpen(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [open])

  if (!status || !status.isRepo) return null

  const dirty = status.changedCount > 0

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
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="git-control" onClick={(e) => e.stopPropagation()}>
      <button
        className={`chip git-chip${dirty ? ' git-chip--dirty' : ' git-chip--clean'}`}
        title={status.branch ? `Branch: ${status.branch}` : 'git'}
        onClick={() => {
          void refresh()
          if (dirty) setOpen((o) => !o)
        }}
      >
        <span className="git-branch">{status.branch ?? 'git'}</span>
        <span className="git-dot">·</span>
        <span className="git-count">
          {dirty ? `${status.changedCount} uncommitted` : 'clean'}
        </span>
      </button>

      {open && dirty && (
        <div className="git-popover">
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
            disabled={busy}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commit()
              else if (e.key === 'Escape') setOpen(false)
            }}
          />
          {error && <div className="git-error">{error}</div>}
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
              disabled={busy || !message.trim()}
              onClick={() => void commit()}
            >
              {busy ? 'Committing…' : 'Commit all'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
