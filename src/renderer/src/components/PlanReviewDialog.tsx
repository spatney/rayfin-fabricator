import { lazy, Suspense, useEffect, useId, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ChatPlanArtifact, ChatPlanTodo } from '@shared/ipc'
import { planActionLabel } from '../chatPlan'
import { useSuppressPreview } from '../overlay'
import { useModalFocus } from '../modalFocus'
import { useEditorTheme } from '../useEditorTheme'
import Markdown from './Markdown'
import { Codicon } from './icons'

const Editor = lazy(async () => {
  // Load the local Monaco bootstrap and editor only after the user chooses Edit;
  // Plan mode stays lightweight for everyone else.
  await import('../monaco')
  return import('@monaco-editor/react')
})

export interface PlanReviewDialogProps {
  plan: ChatPlanArtifact
  projectName: string
  busy?: boolean
  /** Whether edits to the plan content are meaningful and should be persisted. */
  editable: boolean
  /** Whether to show the primary/alternate approval actions and "Request changes". */
  approvable: boolean
  primaryAction?: string
  alternateActions: string[]
  onClose: () => void
  onContentChange: (content: string) => void
  onApprove: (action: string) => void
  onRequestChanges: (feedback?: string) => void
  onExport: (content: string) => Promise<void> | void
}

function todoTitle(todos: ChatPlanTodo[], id: string): string {
  return todos.find((t) => t.id === id)?.title ?? id
}

/**
 * Focused, near-fullscreen view of a Plan-mode artifact: the rendered markdown
 * by default, an editable Monaco + live-preview split when editing, the
 * structured todo/dependency overview, and the same approve / request-changes
 * actions as the inline card. Used both for the live "Review full plan" flow
 * and to review/edit a recovered (interrupted) plan before resuming.
 */
export default function PlanReviewDialog({
  plan,
  projectName,
  busy = false,
  editable,
  approvable,
  primaryAction,
  alternateActions,
  onClose,
  onContentChange,
  onApprove,
  onRequestChanges,
  onExport
}: PlanReviewDialogProps): JSX.Element {
  useSuppressPreview()
  const theme = useEditorTheme()
  const titleId = useId()
  const dialogRef = useModalFocus<HTMLDivElement>()

  const [editing, setEditing] = useState(false)
  const [revising, setRevising] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  async function copyPlan(): Promise<void> {
    try {
      await navigator.clipboard.writeText(plan.content)
      setCopied(true)
      setCopyError(null)
      setTimeout(() => setCopied(false), 1200)
    } catch (err) {
      setCopyError(err instanceof Error ? err.message : 'Could not copy the plan to the clipboard.')
    }
  }

  return createPortal(
    <div
      className="modal-backdrop chat-plan-backdrop"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="modal chat-plan-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={titleId}>Plan for {projectName}</h2>
          <div className="chat-plan-dialog-head-actions">
            {editable && (
              <button
                type="button"
                className="btn btn--xs btn--ghost"
                disabled={busy}
                onClick={() => setEditing((v) => !v)}
              >
                {editing ? 'Done editing' : (
                  <>
                    <Codicon name="edit" /> Edit
                  </>
                )}
              </button>
            )}
            <button className="icon-btn" onClick={onClose} aria-label="Close" disabled={busy}>
              ✕
            </button>
          </div>
        </div>

        <div className="modal-body chat-plan-dialog-body">
          {plan.error && (
            <div className="chat-plan-error">
              <Codicon name="warning" /> {plan.error}
            </div>
          )}

          {editing ? (
            <div className="chat-plan-dialog-columns">
              <div className="chat-plan-dialog-editor">
                <Suspense fallback={<div className="code-empty">Loading editor…</div>}>
                  <Editor
                    height="100%"
                    theme={theme}
                    language="markdown"
                    value={plan.content}
                    onChange={(value) => onContentChange(value ?? '')}
                    loading={<div className="code-empty">Loading editor…</div>}
                    options={{
                      readOnly: busy,
                      minimap: { enabled: false },
                      scrollBeyondLastLine: false,
                      fontSize: 12.5,
                      fontFamily: "'Cascadia Code', 'Consolas', ui-monospace, monospace",
                      lineNumbers: 'on',
                      wordWrap: 'on',
                      scrollbar: { useShadows: false }
                    }}
                  />
                </Suspense>
              </div>
              <div className="chat-plan-dialog-preview md">
                <Markdown>{plan.content || '_Nothing written yet._'}</Markdown>
              </div>
            </div>
          ) : (
            <div className="chat-plan-dialog-preview chat-plan-dialog-preview--full md">
              <Markdown>{plan.content || '_No plan content yet._'}</Markdown>
            </div>
          )}

          {plan.todos.length > 0 && (
            <div className="chat-plan-dialog-todos">
              <div className="chat-plan-dialog-section-title">Todos</div>
              {plan.todos.map((todo) => (
                <div key={todo.id} className={`chat-plan-todo chat-plan-todo--${todo.status}`}>
                  <Codicon
                    name={
                      todo.status === 'done'
                        ? 'check'
                        : todo.status === 'in_progress'
                          ? 'sync'
                          : todo.status === 'blocked'
                            ? 'circle-slash'
                            : 'circle-large-outline'
                    }
                    className={`chat-plan-todo-ico${todo.status === 'in_progress' ? ' chat-plan-spin' : ''}`}
                  />
                  <span className="chat-plan-todo-title">{todo.title}</span>
                  {todo.description && (
                    <span className="chat-plan-todo-desc">{todo.description}</span>
                  )}
                </div>
              ))}
              {plan.dependencies.length > 0 && (
                <div className="chat-plan-dialog-deps">
                  <div className="chat-plan-dialog-section-title">Dependencies</div>
                  {plan.dependencies.map((dep, i) => {
                    const prereq = todoTitle(plan.todos, dep.dependsOn)
                    const dependent = todoTitle(plan.todos, dep.todoId)
                    return (
                      <div
                        key={i}
                        className="chat-plan-dialog-dep"
                        aria-label={`${prereq} must finish before ${dependent}`}
                      >
                        {prereq} <Codicon name="chevron-right" aria-hidden="true" /> {dependent}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {approvable && (
            <div className="chat-plan-dialog-actions">
              {primaryAction && (
                <button
                  type="button"
                  className="btn btn--sm btn--primary"
                  disabled={busy}
                  onClick={() => onApprove(primaryAction)}
                >
                  {planActionLabel(primaryAction)}
                </button>
              )}
              {alternateActions.length > 0 && (
                <select
                  className="chat-plan-alt-select"
                  aria-label="Other plan actions"
                  disabled={busy}
                  value=""
                  onChange={(e) => {
                    const action = e.target.value
                    if (action) onApprove(action)
                    e.target.value = ''
                  }}
                >
                  <option value="" disabled>
                    {primaryAction ? 'More options…' : 'Choose an action…'}
                  </option>
                  {alternateActions.map((a) => (
                    <option key={a} value={a}>
                      {planActionLabel(a)}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                disabled={busy}
                onClick={() => setRevising((v) => !v)}
              >
                Request changes
              </button>
            </div>
          )}

          {approvable && revising && (
            <div className="chat-plan-revise">
              <textarea
                className="chat-plan-feedback"
                placeholder="Optional — what should change about the plan?"
                value={feedback}
                rows={2}
                disabled={busy}
                onChange={(e) => setFeedback(e.target.value)}
              />
              <button
                type="button"
                className="btn btn--sm btn--primary"
                disabled={busy}
                onClick={() => {
                  onRequestChanges(feedback.trim() || undefined)
                  setFeedback('')
                  setRevising(false)
                }}
              >
                Send feedback
              </button>
            </div>
          )}

          {copyError && (
            <div className="chat-plan-error">
              <Codicon name="warning" /> {copyError}
            </div>
          )}
        </div>

        <div className="modal-footer chat-plan-dialog-footer">
          <button type="button" className="chat-plan-tool-btn" onClick={() => void copyPlan()}>
            <Codicon name="copy" /> {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            type="button"
            className="chat-plan-tool-btn"
            disabled={busy}
            onClick={() => void onExport(plan.content)}
          >
            <Codicon name="desktop-download" /> Export
          </button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
