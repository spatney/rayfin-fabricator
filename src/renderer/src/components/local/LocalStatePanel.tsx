import { useState, type JSX } from 'react'
import { localStateLabel, type LocalBackend } from '../../localBackend'
import { Codicon } from '../icons'
import { describeProblem, startingDetail } from './problems'
import './local.css'

interface Props {
  /** The app's name. */
  name: string
  local: LocalBackend
  onViewOutput: () => void
  /** Open Help and ask why the app didn't start. */
  onDiagnose?: () => void
  /** Open setup, to install or update Node.js. */
  onOpenSetup?: () => void
  /** Open the dialog for a refused schema change. */
  onReviewSchema?: () => void
}

type Action = 'start' | 'install' | 'stop-other'

/**
 * The preview while the app has no page to show on this computer: starting
 * (the state and what it's doing), stopped, or stopped by a problem, with what
 * can be done about it.
 */
export default function LocalStatePanel({
  name,
  local,
  onViewOutput,
  onDiagnose,
  onOpenSetup,
  onReviewSchema
}: Props): JSX.Element {
  const [doing, setDoing] = useState<Action | null>(null)
  const act = (action: Action, run: () => Promise<unknown>): void => {
    setDoing(action)
    void run().finally(() => setDoing(null))
  }
  const disabled = local.busy || doing !== null
  const viewOutput = (
    <button type="button" className="btn btn--sm" onClick={onViewOutput}>
      <Codicon name="output" />
      View output
    </button>
  )

  if (
    local.state === 'starting' ||
    local.state === 'restarting' ||
    (local.state === 'stopped' && (!local.status || local.busy))
  ) {
    return (
      <div className="local-state" role="status">
        <span className="local-spinner" aria-hidden="true" />
        <p className="local-state-label">
          {localStateLabel(local.status, !local.status || local.busy)}
        </p>
        <p className="local-state-detail">{startingDetail(local.status)}</p>
        <button type="button" className="btn btn--sm btn--link" onClick={onViewOutput}>
          View output
        </button>
      </div>
    )
  }

  if (local.state === 'running') {
    return (
      <div className="local-state" role="status">
        <p className="local-state-label">{localStateLabel(local.status)}</p>
        <p className="local-state-detail">
          {name} has no pages to show. Its backend runs at {local.ready?.apiUrl}.
        </p>
        {viewOutput}
      </div>
    )
  }

  if (local.state === 'stopped') {
    return (
      <div className="local-state" role="status">
        <p className="local-state-label">{localStateLabel(local.status)}</p>
        <p className="local-state-detail">{name} isn’t running on this computer.</p>
        {local.actionError && <p className="local-state-failed">{local.actionError.message}</p>}
        <div className="local-state-actions">
          <button
            type="button"
            className="btn btn--sm btn--primary"
            disabled={disabled}
            onClick={() => act('start', local.start)}
          >
            {doing === 'start' ? 'Starting…' : 'Start'}
          </button>
          {viewOutput}
        </div>
      </div>
    )
  }

  const problem = local.error
  const text = describeProblem(problem)
  const code = problem?.code
  const docs = typeof problem?.details?.docs === 'string' ? problem.details.docs : null
  let primary: JSX.Element | null = null
  if (code === 'packages-missing') {
    primary = (
      <button
        type="button"
        className="btn btn--sm btn--primary"
        disabled={disabled}
        onClick={() => act('install', local.installPackages)}
      >
        {doing === 'install' ? 'Installing…' : 'Install dependencies'}
      </button>
    )
  } else if (code === 'already-serving') {
    primary = (
      <button
        type="button"
        className="btn btn--sm btn--primary"
        disabled={disabled}
        onClick={() => act('stop-other', local.stopOtherServe)}
      >
        {doing === 'stop-other' ? 'Stopping…' : 'Stop the other one'}
      </button>
    )
  } else if (code === 'schema-refused' && onReviewSchema) {
    primary = (
      <button type="button" className="btn btn--sm btn--primary" onClick={onReviewSchema}>
        Review the change
      </button>
    )
  } else if ((code === 'node-missing' || code === 'node-too-old') && onOpenSetup) {
    primary = (
      <button type="button" className="btn btn--sm btn--primary" onClick={onOpenSetup}>
        Set up Node.js
      </button>
    )
  } else if (docs) {
    primary = (
      <button
        type="button"
        className="btn btn--sm btn--primary"
        onClick={() => void window.api.openExternal(docs)}
      >
        Learn how to allow it
      </button>
    )
  }

  return (
    <div className="local-state">
      <section className="local-state-card" role="alert" aria-label={text.title}>
        <h3 className="local-state-title">
          <Codicon name="error" />
          {text.title}
        </h3>
        <p className="local-state-message">{text.message}</p>
        {text.hint && <p className="local-state-hint">{text.hint}</p>}
        {local.actionError && <p className="local-state-failed">{local.actionError.message}</p>}
        <div className="local-state-actions">
          {primary}
          <button
            type="button"
            className={`btn btn--sm${primary ? '' : ' btn--primary'}`}
            disabled={disabled}
            onClick={() => act('start', () => local.restart())}
          >
            {doing === 'start' ? 'Starting…' : 'Try again'}
          </button>
          {viewOutput}
          {onDiagnose && (
            <button
              type="button"
              className="btn btn--sm"
              onClick={onDiagnose}
              title="Open Help, which reads what happened and explains it"
            >
              <Codicon name="comment-discussion" />
              Find out why
            </button>
          )}
        </div>
      </section>
    </div>
  )
}
