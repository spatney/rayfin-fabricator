import { useEffect, useRef, useState } from 'react'
import { useSuppressPreview } from '../overlay'

interface Props {
  /** Disable controls + show progress while the fork is being created. */
  busy?: boolean
  error?: string | null
  onCreate: (firstTask: string) => void
  onCancel: () => void
}

/**
 * Modal for forking a new side thread. The user only describes the first task —
 * the thread is named automatically from it — so there's no name field to fill.
 * Mirrors the flat modal style used elsewhere.
 */
export default function NewThreadModal({ busy = false, error, onCreate, onCancel }: Props): JSX.Element {
  useSuppressPreview()
  const [task, setTask] = useState('')
  const taskRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    taskRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  const canCreate = task.trim().length > 0 && !busy

  function submit(): void {
    if (!canCreate) return
    onCreate(task.trim())
  }

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onCancel}>
      <div className="modal modal--sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2>New side thread</h2>
            <p className="modal-sub">
              Fork a parallel agent to work on something else. It merges back into main and
              redeploys when it’s done.
            </p>
          </div>
        </div>
        <div className="modal-body">
          <label className="field">
            <span className="field-label">What should it work on?</span>
            <textarea
              ref={taskRef}
              className="field-input field-textarea"
              placeholder="e.g. Make the whole app look great on mobile"
              value={task}
              disabled={busy}
              rows={4}
              onChange={(e) => setTask(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
              }}
            />
            <span className="field-hint">We’ll name the thread for you based on this.</span>
          </label>
          {error && <div className="alert alert--error">{error}</div>}
        </div>
        <div className="modal-footer">
          <button className="btn btn--ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={submit} disabled={!canCreate}>
            {busy ? (
              <span className="btn-busy">
                <span className="btn-spin" aria-hidden="true" />
                Forking…
              </span>
            ) : (
              'Start thread'
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
