import { useCallback, useEffect, useState, type JSX } from 'react'
import type { LocalSeed, LocalSeedProblem } from '@shared/ipc'
import { reportEvent } from '../../errorReport'
import { Trans, useTranslation } from '../../i18n'
import { toLocalBackendError } from '../../localBackend'
import { plural } from '../blueprint/localData'
import { Codicon } from '../icons'
import { seedFixPrompt, seedPlace } from './seedData'
import './local.css'

const DISMISSED_KEY = 'fabricator.seedOffer.'

function dismissed(projectId: string): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY + projectId) === '1'
  } catch {
    return false
  }
}

function dismiss(projectId: string): void {
  try {
    localStorage.setItem(DISMISSED_KEY + projectId, '1')
  } catch {
    // Without storage it's offered again next time.
  }
}

/** Whether the app's local data holds no rows and no stored files. */
async function localDataEmpty(projectId: string): Promise<boolean> {
  const [entities, folders] = await Promise.all([
    window.api.local.entities(projectId),
    window.api.local.storage(projectId).catch(() => [])
  ])
  return entities.every((e) => e.rows === 0) && folders.every((f) => f.files === 0)
}

interface Props {
  projectId: string
  /** Changes when the backend rebuilds the app or a chat turn ends: look again. */
  stamp: string
  /** The seed data loaded: show the app's page again, with it. */
  onLoaded: () => void
  /** Hand fixing the seed data's problems to the Build chat. */
  onSendToChat?: (display: string, prompt: string) => void
}

/**
 * Offers the app's seed data (`rayfin/seed`) while its local data is empty,
 * as when a project is opened on this computer for the first time: loading it
 * then loses nothing, so it doesn't ask first. Dismissed for good, per project;
 * the Data explorer loads it any time.
 */
export default function SeedOffer({ projectId, stamp, onLoaded, onSendToChat }: Props): JSX.Element | null {
  const { t } = useTranslation('preview')
  const [hidden, setHidden] = useState(() => dismissed(projectId))
  const [offer, setOffer] = useState<LocalSeed | null>(null)
  const [problems, setProblems] = useState<LocalSeedProblem[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setHidden(dismissed(projectId))
    setOffer(null)
    setProblems(null)
    setError(null)
  }, [projectId])

  useEffect(() => {
    if (hidden) return
    let alive = true
    void (async () => {
      try {
        const seed = await window.api.local.seed(projectId)
        const offered = seed.exists && (await localDataEmpty(projectId))
        if (alive) setOffer(offered ? seed : null)
      } catch {
        // An older backend, or one that stopped: nothing to offer.
        if (alive) setOffer(null)
      }
    })()
    return () => {
      alive = false
    }
  }, [projectId, stamp, hidden])

  const close = useCallback((): void => {
    dismiss(projectId)
    setHidden(true)
  }, [projectId])

  const load = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      // Data added meanwhile would be replaced: then the Data explorer asks first.
      if (!(await localDataEmpty(projectId))) {
        setOffer(null)
        return
      }
      const loaded = await window.api.local.loadSeed(projectId)
      if (!loaded.ok) {
        setProblems(loaded.problems)
        return
      }
      setOffer(null)
      onLoaded()
      const rows = loaded.entities.reduce((sum, e) => sum + e.rows, 0)
      const files = loaded.storage.reduce((sum, f) => sum + f.files, 0)
      reportEvent(
        'preview',
        'local.seed_loaded',
        `Loaded the seed data into empty local data: ${plural(rows, 'row')} and ${plural(files, 'file')}.`,
        { projectId }
      )
    } catch (reason) {
      setError(toLocalBackendError(reason).message)
    } finally {
      setBusy(false)
    }
  }

  if (hidden || (!offer && !problems)) return null
  if (problems) {
    const first = problems[0]
    return (
      <section className="local-note" aria-label={t('seed.label')}>
        <Codicon name="warning" className="local-note-icon local-note-icon--warn" />
        <p className="local-note-text">
          <strong>{t('seed.problems', { count: problems.length })}</strong>{' '}
          {first && `${seedPlace(first)}: ${first.message}`}
        </p>
        {onSendToChat && (
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              onSendToChat(t('seed.fixRequest'), seedFixPrompt(problems))
              setProblems(null)
            }}
          >
            {t('seed.fix')}
          </button>
        )}
        <button
          type="button"
          className="local-note-close"
          aria-label={t('actions.dismiss')}
          onClick={close}
        >
          <Codicon name="close" />
        </button>
      </section>
    )
  }
  const seed = offer as LocalSeed
  const rows = seed.entities.reduce((sum, e) => sum + e.rows, 0)
  const files = seed.storage.reduce((sum, f) => sum + f.files, 0)
  const rowsText = rows > 0 ? t('seed.rows', { count: rows }) : null
  const filesText = files > 0 ? t('seed.files', { count: files }) : null
  const amount =
    rowsText && filesText
      ? t('seed.rowsAndFiles', { rows: rowsText, files: filesText })
      : (rowsText ?? filesText)
  return (
    <section className="local-note" aria-label={t('seed.label')}>
      <Codicon name="database" className="local-note-icon" />
      <p className="local-note-text">
        {amount ? (
          <Trans t={t} i18nKey="seed.offer" values={{ amount }} components={{ b: <strong /> }} />
        ) : (
          <Trans t={t} i18nKey="seed.offerEmpty" components={{ b: <strong /> }} />
        )}
        {error && <span className="local-note-error"> {error}</span>}
      </p>
      <button type="button" className="btn btn--sm btn--primary" onClick={() => void load()} disabled={busy}>
        {busy ? t('status.loading') : t('seed.load')}
      </button>
      <button
        type="button"
        className="local-note-close"
        aria-label={t('actions.dismiss')}
        onClick={close}
      >
        <Codicon name="close" />
      </button>
    </section>
  )
}
