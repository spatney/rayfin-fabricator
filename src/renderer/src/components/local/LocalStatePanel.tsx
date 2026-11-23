import { useState, type JSX } from 'react'
import { useTranslation } from '../../i18n'
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
  const { t } = useTranslation('preview')
  const [doing, setDoing] = useState<Action | null>(null)
  const act = (action: Action, run: () => Promise<unknown>): void => {
    setDoing(action)
    void run().finally(() => setDoing(null))
  }
  const disabled = local.busy || doing !== null
  const viewOutput = (
    <button type="button" className="btn btn--sm" onClick={onViewOutput}>
      <Codicon name="output" />
      {t('statePanel.viewOutput')}
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
          {t('statePanel.viewOutput')}
        </button>
      </div>
    )
  }

  if (local.state === 'running') {
    return (
      <div className="local-state" role="status">
        <p className="local-state-label">{localStateLabel(local.status)}</p>
        <p className="local-state-detail">
          {t('statePanel.noPages', { name, url: local.ready?.apiUrl ?? '' })}
        </p>
        {viewOutput}
      </div>
    )
  }

  if (local.state === 'stopped') {
    return (
      <div className="local-state" role="status">
        <p className="local-state-label">{localStateLabel(local.status)}</p>
        <p className="local-state-detail">{t('statePanel.notRunning', { name })}</p>
        {local.actionError && <p className="local-state-failed">{local.actionError.message}</p>}
        <div className="local-state-actions">
          <button
            type="button"
            className="btn btn--sm btn--primary"
            disabled={disabled}
            onClick={() => act('start', local.start)}
          >
            {doing === 'start' ? t('statePanel.starting') : t('statePanel.start')}
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
        {doing === 'install' ? t('statePanel.installing') : t('statePanel.install')}
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
        {doing === 'stop-other' ? t('statePanel.stopping') : t('statePanel.stopOther')}
      </button>
    )
  } else if (code === 'schema-refused' && onReviewSchema) {
    primary = (
      <button type="button" className="btn btn--sm btn--primary" onClick={onReviewSchema}>
        {t('schema.review')}
      </button>
    )
  } else if ((code === 'node-missing' || code === 'node-too-old') && onOpenSetup) {
    primary = (
      <button type="button" className="btn btn--sm btn--primary" onClick={onOpenSetup}>
        {t('statePanel.setUpNode')}
      </button>
    )
  } else if (docs) {
    primary = (
      <button
        type="button"
        className="btn btn--sm btn--primary"
        onClick={() => void window.api.openExternal(docs)}
      >
        {t('statePanel.allowHelp')}
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
            {doing === 'start' ? t('statePanel.starting') : t('actions.tryAgain')}
          </button>
          {viewOutput}
          {onDiagnose && (
            <button
              type="button"
              className="btn btn--sm"
              onClick={onDiagnose}
              title={t('statePanel.whyTitle')}
            >
              <Codicon name="comment-discussion" />
              {t('statePanel.why')}
            </button>
          )}
        </div>
      </section>
    </div>
  )
}
