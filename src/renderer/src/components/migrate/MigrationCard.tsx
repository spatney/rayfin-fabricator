import type { JSX } from 'react'
import type { MigrationStage, MigrationState } from '@shared/ipc'
import { doneCount, materialReady, nextPage, turnOrder } from '../../migration/turns'
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

const STAGES: ReadonlyArray<[keyof MigrationState['stages'], string]> = [
  ['definition', 'Report definition'],
  ['model', 'Data model'],
  ['export', 'Page export'],
  ['images', 'Page images']
]

function stageWord(stage: MigrationStage): string {
  switch (stage.status) {
    case 'running':
      return stage.progress != null ? `${stage.progress}%` : 'Working…'
    case 'done':
      return 'Done'
    case 'skipped':
      return 'Skipped'
    case 'failed':
      return 'Not available'
    default:
      return 'Waiting'
  }
}

const PAGE_WORDS = { pending: 'Not started', running: 'Migrating', done: 'Migrated', failed: 'Needs another try' }

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
  if (state.dismissed) return null
  const ready = materialReady(state)
  const total = state.pages.length
  const done = doneCount(state)
  const running = state.pages.findIndex((p) => p.status === 'running')
  const next = nextPage(state)
  const finished = total > 0 && done === total
  const failedStages = STAGES.filter(([key]) => state.stages[key].status === 'failed' && state.stages[key].message)

  let note: string
  if (finished) note = 'Every page is migrated. MIGRATION.md lists what’s approximated.'
  else if (running >= 0) {
    note = `Copilot is migrating “${state.pages[running].displayName}”.${chaining ? ' The rest follow, one page at a time.' : ''}`
  } else if (waiting) note = waiting
  else if (next !== null) note = `Next: “${state.pages[next].displayName}”.`
  else note = ''

  return (
    <section className="mig-card" aria-label="Power BI migration">
      <header className="mig-head">
        <Codicon name="graph" className="mig-ico" />
        <span className="mig-title" title={state.source.reportName}>
          Migrating “{state.source.reportName}” from Power BI
        </span>
        <span className="mig-count">
          {ready ? `${done} of ${total} page${total === 1 ? '' : 's'}` : drawing ? 'Drawing pages' : 'Reading the report'}
        </span>
        {finished && (
          <button type="button" className="mig-close" aria-label="Close" title="Close" onClick={onDismiss}>
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
                  <span>{label}</span>
                  <span className="mig-stage-word">{stageWord(stage)}</span>
                </li>
              )
            })}
          </ul>
          {failedStages.map(([key, label]) => (
            <p key={key} className="mig-msg">
              {label}: {state.stages[key].message}
            </p>
          ))}
          {state.stages.export.status === 'running' && (
            <div className="mig-foot">
              <span className="mig-note">Exporting takes about 20 seconds a page.</span>
              <button type="button" className="btn btn--sm" onClick={onSkipImages}>
                Skip page images
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <ol className="mig-pages">
            {turnOrder(state).map((index, position) => {
              const page = state.pages[index]
              return (
                <li
                  key={page.name || index}
                  className={`mig-page mig-page--${page.status}`}
                  aria-label={`${position + 1}. ${page.displayName}: ${PAGE_WORDS[page.status]}`}
                  title={`${page.displayName}: ${PAGE_WORDS[page.status]}`}
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
                      Try again
                    </button>
                  )}
                </li>
              )
            })}
          </ol>
          {failedStages.map(([key, label]) => (
            <p key={key} className="mig-msg">
              {label}: {state.stages[key].message}
            </p>
          ))}
          <div className="mig-foot">
            <span className="mig-note">{note}</span>
            {!finished && chaining && (
              <button type="button" className="btn btn--sm" onClick={onStopRest}>
                Stop after this page
              </button>
            )}
            {!finished && !chaining && running < 0 && next !== null && (
              <>
                <button type="button" className="btn btn--sm btn--primary" disabled={Boolean(waiting)} onClick={onNext}>
                  Migrate next page
                </button>
                <button type="button" className="btn btn--sm" disabled={Boolean(waiting)} onClick={onRest}>
                  Migrate the rest
                </button>
              </>
            )}
          </div>
        </>
      )}
    </section>
  )
}
