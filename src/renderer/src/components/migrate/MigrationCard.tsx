import type { JSX } from 'react'
import type { TFunction } from 'i18next'
import type { MigrationStage, MigrationState } from '@shared/ipc'
import { doneCount, materialReady, nextPage, turnOrder } from '../../migration/turns'
import { useTranslation } from '../../i18n'
import { CloseIcon, Codicon } from '../icons'
import './migrate.css'

interface Props {
  state: MigrationState
  /** The exported pages are being drawn. */
  drawing: boolean
  /** "Migrate the rest" is on. */
  chaining: boolean
  /** Why the next turn can't start yet, if it can't. */
  waiting?: string
  onNext: () => void
  onRest: () => void
  onStopRest: () => void
  onRetry: (index: number) => void
  onSkipImages: () => void
  onDismiss: () => void
}

const STAGES = [
  ['definition', 'card.stages.definition'],
  ['model', 'card.stages.model'],
  ['export', 'card.stages.export'],
  ['images', 'card.stages.images']
] as const satisfies ReadonlyArray<readonly [keyof MigrationState['stages'], string]>

function stageWord(stage: MigrationStage, t: TFunction<'migrate'>): string {
  switch (stage.status) {
    case 'running':
      return stage.progress != null ? `${stage.progress}%` : t('status.working')
    case 'done':
      return t('card.stageStatus.done')
    case 'skipped':
      return t('card.stageStatus.skipped')
    case 'failed':
      return t('card.stageStatus.failed')
    default:
      return t('card.stageStatus.waiting')
  }
}

const PAGE_STATUS = {
  pending: 'card.pageStatus.pending',
  running: 'card.pageStatus.running',
  done: 'card.pageStatus.done',
  failed: 'card.pageStatus.failed'
} as const

/**
 * A report migration's progress above the composer: first how far reading the
 * report has come, then each page and its turn, with Migrate next page and
 * Migrate the rest. Flat: status as small dots and words.
 */
export default function MigrationCard({
  state,
  drawing,
  chaining,
  waiting,
  onNext,
  onRest,
  onStopRest,
  onRetry,
  onSkipImages,
  onDismiss
}: Props): JSX.Element | null {
  const { t } = useTranslation('migrate')
  if (state.dismissed) return null
  const ready = materialReady(state)
  const total = state.pages.length
  const done = doneCount(state)
  const running = state.pages.findIndex((p) => p.status === 'running')
  const next = nextPage(state)
  const finished = total > 0 && done === total
  const failedStages = STAGES.filter(([key]) => state.stages[key].status === 'failed' && state.stages[key].message)

  let note: string
  if (finished) note = t('card.finished')
  else if (running >= 0) {
    const name = state.pages[running].displayName
    note = chaining ? t('card.runningRest', { name }) : t('card.running', { name })
  } else if (waiting) note = waiting
  else if (next !== null) note = t('card.next', { name: state.pages[next].displayName })
  else note = ''
  const close = t('actions.close')

  return (
    <section className="mig-card" aria-label={t('card.label')}>
      <header className="mig-head">
        <Codicon name="graph" className="mig-ico" />
        <span className="mig-title" title={state.source.reportName}>
          {t('card.title', { name: state.source.reportName })}
        </span>
        <span className="mig-count">
          {ready ? t('card.progress', { done, count: total }) : drawing ? t('card.drawing') : t('card.reading')}
        </span>
        {finished && (
          <button type="button" className="mig-close" aria-label={close} title={close} onClick={onDismiss}>
            <CloseIcon />
          </button>
        )}
      </header>

      {!ready ? (
        <>
          <ul className="mig-stages">
            {STAGES.map(([key, label]) => {
              const stage = state.stages[key]
              return (
                <li key={key} className={`mig-stage mig-stage--${stage.status}`} title={stage.message}>
                  <span className="mig-dot" aria-hidden="true" />
                  <span>{t(label)}</span>
                  <span className="mig-stage-word">{stageWord(stage, t)}</span>
                </li>
              )
            })}
          </ul>
          {failedStages.map(([key, label]) => (
            <p key={key} className="mig-msg">
              {t('card.stageFailed', { stage: t(label), message: state.stages[key].message })}
            </p>
          ))}
          {state.stages.export.status === 'running' && (
            <div className="mig-foot">
              <span className="mig-note">{t('card.exportTime')}</span>
              <button type="button" className="btn btn--sm" onClick={onSkipImages}>
                {t('card.skipImages')}
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <ol className="mig-pages">
            {turnOrder(state).map((index, position) => {
              const page = state.pages[index]
              const status = t(PAGE_STATUS[page.status])
              return (
                <li
                  key={page.name || index}
                  className={`mig-page mig-page--${page.status}`}
                  aria-label={t('card.page', { n: position + 1, name: page.displayName, status })}
                  title={t('card.pageTitle', { name: page.displayName, status })}
                >
                  {page.thumb ? (
                    <img src={page.thumb} alt="" className="mig-thumb" />
                  ) : (
                    <span className="mig-thumb mig-thumb--none" aria-hidden="true">
                      <Codicon name="graph" />
                    </span>
                  )}
                  <span className="mig-page-text">
                    <span className="mig-dot" aria-hidden="true" />
                    <span className="mig-page-name">
                      {position + 1}. {page.displayName}
                    </span>
                  </span>
                  {page.status === 'failed' && running < 0 && (
                    <button type="button" className="link-btn mig-retry" disabled={Boolean(waiting)} onClick={() => onRetry(index)}>
                      {t('actions.tryAgain')}
                    </button>
                  )}
                </li>
              )
            })}
          </ol>
          {failedStages.map(([key, label]) => (
            <p key={key} className="mig-msg">
              {t('card.stageFailed', { stage: t(label), message: state.stages[key].message })}
            </p>
          ))}
          <div className="mig-foot">
            <span className="mig-note">{note}</span>
            {!finished && chaining && (
              <button type="button" className="btn btn--sm" onClick={onStopRest}>
                {t('card.stopRest')}
              </button>
            )}
            {!finished && !chaining && running < 0 && next !== null && (
              <>
                <button type="button" className="btn btn--sm btn--primary" disabled={Boolean(waiting)} onClick={onNext}>
                  {t('card.migrateNext')}
                </button>
                <button type="button" className="btn btn--sm" disabled={Boolean(waiting)} onClick={onRest}>
                  {t('card.migrateRest')}
                </button>
              </>
            )}
          </div>
        </>
      )}
    </section>
  )
}
