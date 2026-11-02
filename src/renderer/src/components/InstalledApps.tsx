import { useState, type JSX } from 'react'
import type { AppActionResult, InstalledApp } from '@shared/ipc'
import { errorMessage } from '../errorReport'
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
      result = { ok: false, error: errorMessage(reason, `Fabricator couldn’t remove ${app.name}.`) }
    }
    setRemoving(null)
    setConfirming(null)
    if (!result.ok) setError(result.error ?? `Fabricator couldn’t remove ${app.name}.`)
  }

  return (
    <section className="home-recents" aria-labelledby="installed-apps-title">
      <div className="home-section-heading">
        <h2 id="installed-apps-title">Installed apps</h2>
        <span className="home-project-count">
          {apps.length} app{apps.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="home-project-list" role="list">
        {apps.map((app) => {
          const busy = removing === app.key
          const about = [
            app.from ? `From ${app.from}` : null,
            app.version ? `Version ${app.version}` : null
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
                aria-label={`Open ${app.name}`}
                disabled={busy}
                onClick={() => onOpen(app.key)}
              >
                <AppIcon name={app.name} src={app.icon} size={32} />
                <span className="home-project-main">
                  <span className="home-project-name">
                    <span className="home-project-title">{app.name}</span>
                    {app.open && (
                      <span className="home-project-status home-project-status--active">Open</span>
                    )}
                  </span>
                  <span className="home-project-path">
                    {about || 'Installed from a .rayfin file'}
                  </span>
                </span>
              </button>
              {confirming === app.key ? (
                <span className="home-project-removal-actions">
                  <span className="home-app-confirm">Remove it and its data?</span>
                  <button
                    type="button"
                    className="btn btn--sm btn--danger"
                    disabled={busy}
                    onClick={() => void remove(app)}
                  >
                    {busy ? 'Removing…' : 'Remove'}
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    disabled={busy}
                    onClick={() => setConfirming(null)}
                  >
                    Keep
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="home-project-manage"
                  aria-label={`Remove ${app.name}`}
                  title="Remove"
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
