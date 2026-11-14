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
 * Full-screen, non-dismissible gate shown when a mandatory startup update is
 * found. It blocks the whole app while the update downloads and installs itself;
 * the app restarts automatically once applied. There is no "Later" — driven by
 * `useUpdates().blocking`.
 */
export default function ForcedUpdateScreen(): JSX.Element {
  const { status, info, progress } = useUpdates()
  const { t } = useTranslation('app')

  const pct =
    progress && progress.total
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null
  const installing = status === 'ready' || status === 'installing'

  const title = installing
    ? info
      ? t('update.installingVersion', { version: info.version })
      : t('update.installing')
    : info
      ? t('update.downloadingVersion', { version: info.version })
      : t('update.downloading')
  const meta = installing
    ? t('update.restartsAutomatically')
    : pct !== null
      ? `${pct}%`
      : progress
        ? formatBytes(progress.downloaded)
        : t('update.starting')

  return (
    <div className="forced-update" role="alertdialog" aria-modal="true" aria-live="polite">
      <div className="forced-update__card">
        <span className="forced-update__dot" aria-hidden="true" />
        <span className="forced-update__title">{title}</span>
        <span className="forced-update__meta">{meta}</span>
        <div className="forced-update__bar" aria-hidden="true">
          <div
            className={`forced-update__bar-fill${
              installing || pct === null ? ' forced-update__bar-fill--indet' : ''
            }`}
            style={!installing && pct !== null ? { width: `${pct}%` } : undefined}
          />
        </div>
        <span className="forced-update__note">{t('update.required')}</span>
      </div>
    </div>
  )
}
