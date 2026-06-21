import { useEffect, useRef, useState } from 'react'

interface Props {
  /** Disable controls + show progress while the fork is being created. */
  busy?: boolean
  error?: string | null
  onCreate: (name: string, firstTask: string) => void
  onCancel: () => void
}

/**
 * Modal for forking a new side thread: a display name plus the first task its
 * background agent should start on. Mirrors the flat modal style used elsewhere.
 */
export default function NewThreadModal({ busy = false, error, onCreate, onCancel }: Props): JSX.Element {
  const [name, setName] = useState('')
  const [task, setTask] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    nameRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  const canCreate = name.trim().length > 0 && task.trim().length > 0 && !busy

  function submit(): void {
    if (!canCreate) return
    onCreate(name.trim(), task.trim())
  }

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onCancel}>
      <div className="modal modal--sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>New side thread</h2>
          <p className="modal-sub">
            Fork a parallel agent to work on something else. It merges back into main and
            redeploys when it’s done.
          </p>
        </div>
        <div className="modal-body">
          <label className="field">
            <span className="field-label">Name</span>
            <input
              ref={nameRef}
              className="field-input"
              placeholder="e.g. Mobile view"
              value={name}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">First task</span>
            <textarea
              className="field-input field-textarea"
              placeholder="Describe what this thread should build…"
              value={task}
              disabled={busy}
              rows={4}
              onChange={(e) => setTask(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
              }}
            />
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
              'Create thread'
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
