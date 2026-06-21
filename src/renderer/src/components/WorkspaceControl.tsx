import { useEffect, useState } from 'react'
import type { StudioProject } from '../../../shared/ipc'

interface Props {
  project: StudioProject
  /** Persist the change and refresh the project list. */
  onChanged: () => void
}

/** Trim a portal URL down to something readable for the chip label. */
function shortLabel(workspace: string): string {
  const ws = workspace.trim()
  if (/^https?:\/\//i.test(ws)) {
    const m = ws.match(/groups\/([0-9a-f-]{8,})/i)
    return m ? `ws ${m[1].slice(0, 8)}…` : 'portal URL'
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(ws)) return `${ws.slice(0, 8)}…`
  return ws
}

/**
 * Compact Fabric-workspace pill for the project header: shows the deploy
 * target and offers a popover to change or clear it (`projects.setWorkspace`).
 */
export default function WorkspaceControl({ project, onChanged }: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(project.workspace ?? '')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setValue(project.workspace ?? '')
  }, [project.workspace])

  useEffect(() => {
    if (!open) return
    const close = (): void => setOpen(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [open])

  const workspace = project.workspace?.trim()

  async function save(next?: string): Promise<void> {
    setBusy(true)
    try {
      await window.api.projects.setWorkspace(project.id, next ?? (value.trim() || undefined))
      onChanged()
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ws-control" onClick={(e) => e.stopPropagation()}>
      <button
        className={`chip ws-chip${workspace ? ' ws-chip--set' : ''}`}
        title={workspace ? `Fabric workspace: ${workspace}` : 'No Fabric workspace set'}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="ws-chip-icon">◆</span>
        <span className="ws-chip-label">
          {workspace ? shortLabel(workspace) : 'set workspace'}
        </span>
      </button>

      {open && (
        <div className="ws-popover">
          <div className="ws-popover-title">Fabric workspace</div>
          <input
            className="ws-input"
            placeholder="Name, portal URL, or workspace ID"
            value={value}
            autoFocus
            spellCheck={false}
            disabled={busy}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save()
              else if (e.key === 'Escape') setOpen(false)
            }}
          />
          <p className="ws-popover-hint">
            Used as the deploy target. To switch an already-deployed app between
            workspaces, use <strong>Deployments</strong> in the preview.
          </p>
          <div className="ws-popover-actions">
            {workspace && (
              <button
                className="btn btn--xs btn--ghost"
                disabled={busy}
                onClick={() => void save('')}
              >
                Clear
              </button>
            )}
            <span className="ws-popover-spacer" />
            <button className="btn btn--xs btn--ghost" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              className="btn btn--xs btn--primary"
              disabled={busy || value.trim() === (project.workspace ?? '')}
              onClick={() => void save()}
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
