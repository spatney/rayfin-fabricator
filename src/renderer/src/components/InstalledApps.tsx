import { useState, type JSX } from 'react'
import type { AppActionResult, InstalledApp } from '@shared/ipc'
import { errorMessage } from '../errorReport'
import { useTranslation } from '../i18n'
import AppIcon from './AppIcon'

interface Props {
  apps: InstalledApp[]
  /** Open the app in its own window. */
  onOpen: (key: string) => void
  /** Remove the app and its data. */
  onRemove: (key: string) => Promise<AppActionResult>
}

/**
 * Home's list of the apps installed from `.rayfin` files: open one in its own
 * window, or remove it with its data, after asking. Nothing shows until there's one.
 */
export default function InstalledApps({ apps, onOpen, onRemove }: Props): JSX.Element | null {
  const { t } = useTranslation('projects')
  const [confirming, setConfirming] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (apps.length === 0) return null

  async function remove(app: InstalledApp): Promise<void> {
    setRemoving(app.key)
    setError(null)
    let result: AppActionResult
    try {
      result = await onRemove(app.key)
    } catch (reason) {
      result = {
        ok: false,
        error: errorMessage(reason, t('installedApps.cantRemove', { name: app.name }))
      }
    }
    setRemoving(null)
    setConfirming(null)
    if (!result.ok) setError(result.error ?? t('installedApps.cantRemove', { name: app.name }))
  }

  return (
    <section className="home-recents" aria-labelledby="installed-apps-title">
      <div className="home-section-heading">
        <h2 id="installed-apps-title">{t('installedApps.title')}</h2>
        <span className="home-project-count">
          {t('installedApps.count', { count: apps.length })}
        </span>
      </div>
      <div className="home-project-list" role="list">
        {apps.map((app) => {
          const busy = removing === app.key
          const about = [
            app.from ? t('parts.from', { from: app.from }) : null,
            app.version ? t('parts.version', { version: app.version }) : null
          ]
            .filter(Boolean)
            .join(' · ')
          return (
            <article
              key={app.key}
              className={`home-project${busy ? ' home-project--removing' : ''}`}
              role="listitem"
              aria-busy={busy || undefined}
            >
              <button
                type="button"
                className="home-project-open"
                aria-label={t('installedApps.openName', { name: app.name })}
                disabled={busy}
                onClick={() => onOpen(app.key)}
              >
                <AppIcon name={app.name} src={app.icon} size={32} />
                <span className="home-project-main">
                  <span className="home-project-name">
                    <span className="home-project-title">{app.name}</span>
                    {app.open && (
                      <span className="home-project-status home-project-status--active">
                        {t('installedApps.isOpen')}
                      </span>
                    )}
                  </span>
                  <span className="home-project-path">{about || t('installedApps.fromFile')}</span>
                </span>
              </button>
              {confirming === app.key ? (
                <span className="home-project-removal-actions">
                  <span className="home-app-confirm">{t('installedApps.confirm')}</span>
                  <button
                    type="button"
                    className="btn btn--sm btn--danger"
                    disabled={busy}
                    onClick={() => void remove(app)}
                  >
                    {busy ? t('installedApps.removing') : t('actions.remove')}
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    disabled={busy}
                    onClick={() => setConfirming(null)}
                  >
                    {t('installedApps.keep')}
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="home-project-manage"
                  aria-label={t('installedApps.removeName', { name: app.name })}
                  title={t('actions.remove')}
                  onClick={() => setConfirming(app.key)}
                >
                  <span className="codicon codicon-trash" aria-hidden="true" />
                </button>
              )}
            </article>
          )
        })}
      </div>
      {error && (
        <p className="project-manage-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
