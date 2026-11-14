import { useUpdates } from '../update'
import { formatLocale, useTranslation } from '../i18n'

import type { JSX } from 'react'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  const mb = new Intl.NumberFormat(formatLocale(), {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    useGrouping: false
  }).format(n / (1024 * 1024))
  return `${mb} MB`
}

/**
 * App-wide banner for the in-app updater. Renders only while an update is being
 * downloaded, is ready to install, or is installing — otherwise nothing.
 */
export default function UpdateBanner(): JSX.Element | null {
  const { status, info, progress, blocking, modalOpen, install, dismiss } = useUpdates()
  const { t } = useTranslation('app')

  // The mandatory full-screen ForcedUpdateScreen takes over while blocking, and
  // the optional startup UpdateModal takes over while it's open — avoid showing
  // the banner underneath either.
  if (blocking || modalOpen) return null

  if (status !== 'downloading' && status !== 'ready' && status !== 'installing') {
    return null
  }

  const pct =
    progress && progress.total
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null

  let title: string
  let meta: string | null = null
  if (status === 'downloading') {
    title = info
      ? t('update.downloadingVersion', { version: info.version })
      : t('update.downloading')
    meta =
      pct !== null ? `${pct}%` : progress ? formatBytes(progress.downloaded) : t('update.starting')
  } else if (status === 'ready') {
    title = info?.version ? t('update.readyVersion', { version: info.version }) : t('update.ready')
    meta = t('update.restartToApply')
  } else {
    title = t('update.installing')
  }

  return (
    <div className="update-banner" role="status" aria-live="polite">
      <div className="update-banner__row">
        <span className="update-banner__dot" aria-hidden="true" />
        <div className="update-banner__body">
          <span className="update-banner__title">{title}</span>
          {meta && <span className="update-banner__meta">{meta}</span>}
        </div>
        {status === 'ready' && (
          <div className="update-banner__actions">
            <button className="btn btn--sm btn--ghost" onClick={dismiss}>
              {t('update.later')}
            </button>
            <button className="btn btn--sm btn--primary" onClick={() => void install()}>
              {t('update.restartAndUpdate')}
            </button>
          </div>
        )}
      </div>

      {status === 'downloading' && (
        <div className="update-banner__bar" aria-hidden="true">
          <div
            className={`update-banner__bar-fill${pct === null ? ' update-banner__bar-fill--indet' : ''}`}
            style={pct !== null ? { width: `${pct}%` } : undefined}
          />
        </div>
      )}
    </div>
  )
}
