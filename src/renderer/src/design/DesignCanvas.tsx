import { useCallback, useEffect, useRef, useState } from 'react'
import type { DesignSource } from '@shared/design'
import type { CopilotAuthStatus, StudioProject } from '@shared/ipc'
import type { UIChatMessage } from '../components/ChatPanel'
import PreviewPane, { readFabricatorTheme, type DeployUiState } from '../components/PreviewPane'
import ConfirmModal from '../components/ConfirmModal'
import CopilotSignInNotice from '../components/CopilotSignInNotice'
import PlanQuestionCard from '../components/PlanQuestionCard'
import { Codicon } from '../components/icons'
import { isCopilotAuthError } from '../copilotAuth'
import { canRetryDesignDeployment } from './protocol'
import type { DesignSession, DesignSessionView } from './session'
import './canvas.css'

interface Props {
  project: StudioProject
  session: DesignSession
  view: DesignSessionView
  deploy?: DeployUiState
  localPreviewUrl?: string | null
  localStarting: boolean
  copilotAuth: CopilotAuthStatus
  messages: UIChatMessage[]
  onExit: () => Promise<void>
  onApply: () => Promise<void>
  onRetryDeployment: () => Promise<void>
  onStartLocal: () => Promise<void>
  onCancelApply: () => Promise<void>
  onAuthChanged: () => Promise<void> | void
  onOpenCode: () => void
  onChooseWorkspace: () => void
  onAnswerQuestion: (id: string, answer: string, freeform: boolean) => Promise<void>
}

export default function DesignCanvas({
  project,
  session,
  view,
  deploy,
  localPreviewUrl,
  localStarting,
  copilotAuth,
  messages,
  onExit,
  onApply,
  onRetryDeployment,
  onStartLocal,
  onCancelApply,
  onAuthChanged,
  onOpenCode,
  onChooseWorkspace,
  onAnswerQuestion
}: Props): JSX.Element {
  const [previewOptions, setPreviewOptions] = useState(false)
  const [details, setDetails] = useState(false)
  const [confirm, setConfirm] = useState<'fresh' | 'review' | 'source' | null>(null)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const [questionBusy, setQuestionBusy] = useState(false)
  const [holdingBefore, setHoldingBefore] = useState(false)
  const [authResolvedReceiptId, setAuthResolvedReceiptId] = useState<string | null>(null)
  const held = useRef(false)
  const localRequested = useRef(false)
  const detailsButton = useRef<HTMLButtonElement>(null)
  const draft = view.draft
  const snapshot = view.snapshot
  const count = draft?.cursor ?? 0
  const source = draft?.source ?? (project.lastDeploy?.url ? 'direct' : 'local')
  const disabled = !view.ready || view.busy || view.reviewing
  const needsAuth =
    !copilotAuth.signedIn ||
    (view.receipt?.id !== authResolvedReceiptId && isCopilotAuthError(view.receipt?.error))
  const error = view.saveError ?? view.error
  const conflicts = snapshot?.conflicts ?? []
  const waiting = [...messages]
    .reverse()
    .find(
      (message) =>
        (message.pending ||
          (message.designApplyId === view.receipt?.turnId && view.receipt?.phase === 'editing')) &&
        (message.questions?.some((question) => question.state === 'pending') ||
          message.plan?.questions.some((question) => question.state === 'pending'))
    )
  const questions = (waiting?.questions ?? waiting?.plan?.questions ?? []).filter(
    (question) => question.state === 'pending'
  )
  const attention = Boolean(
    error || conflicts.length || view.sourceChanged || view.reviewing || questions.length
  )

  const run = useCallback(
    async (action: () => Promise<unknown>): Promise<void> => {
      try {
        await action()
      } catch (reason) {
        session.reportError(reason)
      }
    },
    [session]
  )

  useEffect(() => {
    if (source !== 'local' || !draft || localPreviewUrl || localStarting || localRequested.current)
      return
    localRequested.current = true
    void run(onStartLocal)
  }, [source, draft, localPreviewUrl, localStarting, onStartLocal, run])

  useEffect(() => {
    if (!view.ready) return
    let cancelled = false
    let pending = Promise.resolve()
    const update = (): void => {
      const theme = readFabricatorTheme()
      pending = pending
        .then(async () => {
          if (!cancelled) await window.api.preview.design.setTheme(theme)
        })
        .catch(session.reportError)
    }
    update()
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'data-theme']
    })
    return () => {
      cancelled = true
      observer.disconnect()
    }
  }, [session, view.ready, snapshot?.documentId])

  useEffect(() => {
    if (questions.length) setDetails(true)
  }, [questions.length])

  const compare = useCallback(
    (enabled: boolean): void => {
      if (held.current === enabled) return
      held.current = enabled
      setHoldingBefore(enabled)
      void run(() => session.command({ type: 'compare', enabled }))
    },
    [session, run]
  )

  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (disabled || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return
      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest('input,textarea,select'))
      )
        return
      event.preventDefault()
      void run(() => session.command({ type: event.shiftKey ? 'redo' : 'undo' }))
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [disabled, run, session])

  async function chooseSource(next: DesignSource): Promise<void> {
    await run(async () => {
      if (next === 'local') await onStartLocal()
      await session.setSource(next)
    })
  }

  async function confirmAction(): Promise<void> {
    setConfirmBusy(true)
    try {
      if (confirm === 'fresh') await session.startFreshDraft()
      else if (confirm === 'review') await session.confirmReviewedResult()
      else await session.reviewCurrentSource()
      setConfirm(null)
    } catch (reason) {
      session.reportError(reason)
    } finally {
      setConfirmBusy(false)
    }
  }

  const status = view.busy
    ? (view.progress ?? 'Applying your changes')
    : view.saveError
      ? 'Your draft needs attention'
      : view.reviewing
        ? view.receipt?.deployment?.ok
          ? 'Published. Review the result.'
          : 'Apply needs attention'
        : view.loading
          ? 'Opening your canvas'
          : !view.ready
            ? 'Connecting to your app'
            : view.savedRevision !== draft?.revision
              ? 'Saving your draft'
              : count
                ? 'Draft saved on this device'
                : 'Click anything to make it yours'

  return (
    <section className="dc-workspace" aria-label="Visual design">
      <header className="dc-header">
        <div className="dc-identity">
          <button
            className="dc-icon"
            aria-label="Back to Build"
            title="Back to Build - keep this draft"
            disabled={view.busy}
            onClick={() => void run(onExit)}
          >
            <Codicon name="arrow-left" />
          </button>
          <div>
            <strong>Design</strong>
            <span>{project.name}</span>
          </div>
        </div>
        <div className="dc-devices" aria-label="Preview size">
          <button
            aria-pressed={!draft?.viewportWidth}
            title="Fit the canvas"
            disabled={view.busy || view.loading}
            onClick={() => void run(() => session.setViewportWidth(undefined))}
          >
            <Codicon name="device-desktop" />
            <span>Desktop</span>
          </button>
          <button
            aria-pressed={draft?.viewportWidth === 390}
            disabled={view.busy || view.loading}
            onClick={() => void run(() => session.setViewportWidth(390))}
          >
            <Codicon name="device-mobile" />
            <span>Phone</span>
          </button>
          <button
            className="dc-view-settings"
            aria-label="Preview settings"
            title="Preview settings"
            aria-expanded={previewOptions}
            onClick={() => setPreviewOptions((value) => !value)}
          >
            <Codicon name="chevron-down" />
          </button>
        </div>
        <div className="dc-actions">
          <button
            className="dc-icon"
            aria-label="Undo design change"
            title="Undo (Ctrl/Cmd+Z)"
            disabled={disabled || !count || Boolean(snapshot?.compare)}
            onClick={() => void run(() => session.command({ type: 'undo' }))}
          >
            <Codicon name="discard" />
          </button>
          {draft && draft.cursor < draft.history.length && (
            <button
              className="dc-icon"
              aria-label="Redo design change"
              title="Redo (Ctrl/Cmd+Shift+Z)"
              disabled={disabled || Boolean(snapshot?.compare)}
              onClick={() => void run(() => session.command({ type: 'redo' }))}
            >
              <Codicon name="redo" />
            </button>
          )}
          <button
            className={`dc-before${holdingBefore || snapshot?.compare ? ' is-held' : ''}`}
            aria-label="Hold to compare original"
            title="Hold to see the original"
            aria-pressed={holdingBefore}
            disabled={disabled || !count}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId)
              compare(true)
            }}
            onPointerUp={() => compare(false)}
            onPointerCancel={() => compare(false)}
            onBlur={() => compare(false)}
            onKeyDown={(event) => {
              if (event.key === ' ' || event.key === 'Enter') {
                event.preventDefault()
                compare(true)
              }
            }}
            onKeyUp={(event) => {
              if (event.key === ' ' || event.key === 'Enter') {
                event.preventDefault()
                compare(false)
              }
            }}
          >
            Before
          </button>
          <button
            className="dc-apply"
            aria-label="Apply changes to app"
            title="Update source with Copilot and deploy your changes"
            disabled={
              disabled ||
              !count ||
              Boolean(view.saveError) ||
              view.sourceChanged ||
              conflicts.length > 0
            }
            onClick={() => (needsAuth ? setDetails(true) : void run(onApply))}
          >
            {view.busy && <Codicon name="loading" className="dc-spin" />}
            {view.busy ? 'Applying' : 'Apply changes'}
          </button>
        </div>
      </header>

      {previewOptions && (
        <div className="dc-preview-options">
          <label>
            Preview
            <select
              id="dc-source"
              aria-label="Preview source"
              value={source}
              disabled={view.busy}
              onChange={(event) => {
                const value = event.target.value
                if (value === 'local' || value === 'direct' || value === 'fabric')
                  void chooseSource(value)
              }}
            >
              <option value="local">Local app</option>
              <option value="direct" disabled={!project.lastDeploy?.url}>
                Deployed app
              </option>
              <option value="fabric" disabled={!project.lastDeploy?.portalUrl}>
                Inside Fabric
              </option>
            </select>
          </label>
          <label>
            Size
            <select
              aria-label="Canvas size"
              value={draft?.viewportWidth ?? 'fill'}
              disabled={view.busy}
              onChange={(event) =>
                void run(() =>
                  session.setViewportWidth(
                    event.target.value === 'fill' ? undefined : Number(event.target.value)
                  )
                )
              }
            >
              <option value="fill">Fit canvas</option>
              <option value="390">Phone</option>
              <option value="768">Tablet</option>
              {draft?.viewportWidth && ![390, 768].includes(draft.viewportWidth) && (
                <option value={draft.viewportWidth}>{draft.viewportWidth}px</option>
              )}
            </select>
          </label>
          <button
            className="dc-text-button"
            disabled={view.busy}
            onClick={() =>
              void run(async () => {
                await session.flush()
                await window.api.preview.reload()
              })
            }
          >
            Reload app
          </button>
          {snapshot && (
            <span>
              {Math.round(snapshot.viewport.width)} × {Math.round(snapshot.viewport.height)} px
              {draft?.viewportWidth && Math.abs(snapshot.viewport.width - draft.viewportWidth) > 2
                ? ' - limited by available space'
                : ''}
            </span>
          )}
        </div>
      )}

      <div className="dc-canvas-caption">
        <div className="dc-modes" aria-label="Canvas interaction">
          <button
            aria-pressed={snapshot?.tool === 'select'}
            disabled={disabled}
            onClick={() => void run(() => session.command({ type: 'tool', tool: 'select' }))}
          >
            Edit
          </button>
          <button
            aria-pressed={snapshot?.tool === 'interact'}
            disabled={!view.ready || view.busy}
            onClick={() => void run(() => session.command({ type: 'tool', tool: 'interact' }))}
          >
            Use app
          </button>
        </div>
        <span>
          {snapshot?.tool === 'interact'
            ? 'Your app, without the editing layer.'
            : 'Click text to type. Select a card or button to change its look.'}
        </span>
      </div>

      {(attention || view.busy) && (
        <div
          className={`dc-attention${error ? ' dc-attention--error' : ''}`}
          role={error ? 'alert' : 'status'}
        >
          {view.busy && <Codicon name="loading" className="dc-spin" />}
          <span>
            {view.busy
              ? status
              : conflicts.length
                ? 'Some changes belong to another page or need review.'
                : view.sourceChanged
                  ? 'The app source changed. Review it before applying.'
                  : view.reviewing
                    ? status
                    : 'Your draft is safe. Something needs attention.'}
          </span>
          <button className="dc-text-button" onClick={() => setDetails(true)}>
            {questions.length ? 'Answer' : 'Details'}
          </button>
          {view.busy && view.progress?.includes('Copilot') && (
            <button className="dc-text-button" onClick={() => void run(onCancelApply)}>
              Stop
            </button>
          )}
        </div>
      )}

      <div className="dc-canvas">
        <PreviewPane
          project={project}
          deploy={deploy}
          localPreviewUrl={localPreviewUrl}
          focused
          onToggleFocus={() => {}}
          studio={{ source, viewportWidth: draft?.viewportWidth, onReady: session.setTarget }}
        />
        {view.loading && (
          <div className="dc-empty" role="status">
            <Codicon name="loading" className="dc-spin" />
            <strong>Opening your canvas</strong>
          </div>
        )}
        {!view.loading && source === 'local' && !localPreviewUrl && !deploy?.running && (
          <div className="dc-empty">
            <Codicon
              name={localStarting ? 'loading' : 'browser'}
              className={localStarting ? 'dc-spin' : ''}
            />
            <strong>
              {localStarting ? 'Starting your app' : 'Bring your app into the canvas'}
            </strong>
            <p>Start a local preview, or choose a deployed app in Preview settings.</p>
            {!localStarting && (
              <button className="dc-apply" onClick={() => void run(onStartLocal)}>
                Start local preview
              </button>
            )}
          </div>
        )}
      </div>

      <footer className="dc-footer">
        <span className="dc-status" role="status">
          <i className={attention ? 'needs-attention' : ''} />
          {status}
        </span>
        <button
          ref={detailsButton}
          className="dc-text-button"
          aria-expanded={details}
          onClick={() => setDetails((value) => !value)}
        >
          {count ? `${count} ${count === 1 ? 'change' : 'changes'}` : 'Changes'}
        </button>
        <span className="dc-publish-hint">Apply updates code and publishes your app.</span>
      </footer>

      {details && (
        <section className="dc-details" aria-label="Design changes and recovery">
          <header>
            <strong>{questions.length ? 'A quick question' : 'Your changes'}</strong>
            <button
              className="dc-icon"
              aria-label="Close change details"
              onClick={() => {
                setDetails(false)
                detailsButton.current?.focus()
              }}
            >
              <Codicon name="close" />
            </button>
          </header>
          <div className="dc-details-body">
            {error && (
              <p className="dc-error-detail" role="alert">
                {error}
              </p>
            )}
            {!draft && !view.loading && (
              <button className="dc-text-button" onClick={() => setConfirm('fresh')}>
                Start a fresh draft
              </button>
            )}
            {view.saveError && (
              <button
                className="dc-text-button"
                onClick={() => void run(() => session.retrySave())}
              >
                Retry saving
              </button>
            )}
            {!view.ready && (
              <button
                className="dc-text-button"
                onClick={() => void run(() => session.reconnect())}
              >
                Reconnect preview
              </button>
            )}
            {view.sourceChanged && (
              <p>
                The source changed outside this draft.{' '}
                <button className="dc-text-button" onClick={onOpenCode}>
                  Review source
                </button>
                <button className="dc-text-button" onClick={() => setConfirm('source')}>
                  Use current source
                </button>
              </p>
            )}
            {needsAuth && (
              <CopilotSignInNotice
                detail="You can edit without Copilot. Sign in when you're ready to apply."
                host={copilotAuth.host}
                disabled={view.busy}
                onSignedIn={async () => {
                  await onAuthChanged()
                  setAuthResolvedReceiptId(view.receipt?.id ?? null)
                }}
              />
            )}
            {questions.map((question) => (
              <PlanQuestionCard
                key={question.id}
                question={question}
                busy={questionBusy}
                onAnswer={(id, answer, freeform) => {
                  setQuestionBusy(true)
                  void run(() => onAnswerQuestion(id, answer, freeform)).finally(() =>
                    setQuestionBusy(false)
                  )
                }}
              />
            ))}
            {waiting?.questionError && <p role="alert">{waiting.questionError}</p>}
            {view.reviewing && !view.busy && (
              <div className="dc-recovery">
                <p>
                  {view.receipt?.error ??
                    'Review the actual app. Draft overrides are not being applied to this result.'}
                </p>
                {canRetryDesignDeployment(view.receipt) && (
                  <button className="dc-text-button" onClick={() => void run(onRetryDeployment)}>
                    Retry publishing
                  </button>
                )}
                {view.receipt?.deployment?.outcome === 'needs-workspace' && (
                  <button className="dc-text-button" onClick={onChooseWorkspace}>
                    Choose workspace
                  </button>
                )}
                {view.receipt?.phase === 'editing' && (
                  <button className="dc-text-button" onClick={() => void run(onCancelApply)}>
                    Stop pending Apply
                  </button>
                )}
                <button
                  className="dc-text-button"
                  onClick={() => void run(() => session.refreshReceipt())}
                >
                  Refresh status
                </button>
                {view.receipt?.deployment?.ok && (
                  <>
                    <button
                      className="dc-text-button"
                      disabled={!view.ready}
                      onClick={() => void run(() => session.verifyApplied())}
                    >
                      Check refreshed app
                    </button>
                    <button className="dc-text-button" onClick={() => setConfirm('review')}>
                      I've reviewed the result
                    </button>
                  </>
                )}
                <button className="dc-text-button" onClick={onOpenCode}>
                  Review source
                </button>
                <button className="dc-text-button" onClick={() => setConfirm('fresh')}>
                  Start a fresh draft
                </button>
              </div>
            )}
            {count ? (
              <ul className="dc-change-list">
                {draft?.history.slice(0, count).map((transaction) => {
                  const conflict = conflicts.find((item) => item.transactionId === transaction.id)
                  const verification = snapshot?.verification?.find(
                    (item) => item.transactionId === transaction.id
                  )
                  return (
                    <li key={transaction.id}>
                      <div>
                        <strong>{transaction.label}</strong>
                        {conflict && <p>{conflict.message}</p>}
                        {verification && !verification.ok && (
                          <p>
                            {verification.message ?? 'Review this change in the published app.'}
                          </p>
                        )}
                      </div>
                      {!view.reviewing && (
                        <button
                          className="dc-text-button"
                          disabled={disabled}
                          aria-label={`Remove change: ${transaction.label}`}
                          onClick={() =>
                            void run(() =>
                              session.command({ type: 'revert', transactionId: transaction.id })
                            )
                          }
                        >
                          Remove
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p>Nothing to commit to. Try a change on the canvas.</p>
            )}
            <small>
              Draft Undo does not undo published changes. Publishing includes other pending source
              changes in this project.
            </small>
          </div>
        </section>
      )}

      {confirm && (
        <ConfirmModal
          title={
            confirm === 'fresh'
              ? 'Start a fresh draft?'
              : confirm === 'review'
                ? 'Finish reviewing these changes?'
                : 'Use the current source?'
          }
          message={
            confirm === 'fresh'
              ? 'Discard the visual draft, not the source or published app.'
              : confirm === 'review'
                ? 'Confirm you reviewed the published app and its source changes. Nothing else will be published.'
                : 'Use the current project files as this draft’s baseline. Unresolved targets still need review.'
          }
          confirmLabel={
            confirm === 'fresh'
              ? 'Start fresh'
              : confirm === 'review'
                ? 'Finish review'
                : 'Use current source'
          }
          danger={confirm === 'fresh'}
          busy={confirmBusy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void confirmAction()}
        />
      )}
    </section>
  )
}
