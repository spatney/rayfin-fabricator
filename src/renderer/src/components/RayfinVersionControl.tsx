import { useEffect, useState, type JSX } from 'react'
import type { RayfinNewerRelease, RayfinVersionInfo } from '@shared/ipc'
import { newerRayfinWarnings } from '../localDevelopment'
import { useSuppressPreview } from '../overlay'
import { useTranslation } from '../i18n'

interface Props {
  /**
   * Local Rayfin version report for the active project (null while loading),
   * with its updates going to the release Fabricator recommends (the
   * workbench sets them, see `recommendedUpdates`).
   */
  info: RayfinVersionInfo | null
  /**
   * A release newer than the recommended one, such as a preview, offered too,
   * with a warning (see `newerRayfin`).
   */
  newer?: RayfinNewerRelease | null
  /**
   * Hand the upgrade off to the Copilot agent (parent builds + sends the
   * prompt): to the recommended release, or to `newer`.
   */
  onUpdate: (info: RayfinVersionInfo, newer?: RayfinNewerRelease) => void
  /** Chat turns publish the app as they finish, so the update reaches Fabric with its turn. */
  publishes?: boolean
}

interface SummaryRow {
  label: string
  from: string | null
  to: string | null
  upgradable: boolean
}

/** Collapse the per-package detail into two friendly rows: CLI and SDK. */
function summarize(info: RayfinVersionInfo): SummaryRow[] {
  const rows: SummaryRow[] = []
  const cli = info.packages.find((p) => p.kind === 'cli')
  if (cli) {
    rows.push({ label: 'Rayfin CLI', from: cli.installed, to: cli.latest, upgradable: cli.upgradable })
  }
  const sdk = info.packages.filter((p) => p.kind === 'sdk')
  if (sdk.length) {
    const rep = sdk.find((p) => p.upgradable) ?? sdk[0]
    rows.push({
      label: 'Rayfin SDK',
      from: rep.installed,
      to: rep.latest,
      upgradable: sdk.some((p) => p.upgradable)
    })
  }
  return rows
}

/**
 * Status-bar item for the project's local Rayfin (CLI + SDK) version, shown only
 * when there's a newer release to update to — an up-to-date version is nothing
 * to act on. Opening it shows the from → to versions and hands the upgrade to
 * Copilot on click. A release newer than the one Fabricator recommends, such
 * as a preview, is offered below it (or alone), with why it needs care. The app
 * never runs the install itself — the agent edits package.json + runs npm install.
 */
export default function RayfinVersionControl({
  info,
  newer = null,
  onUpdate,
  publishes = false
}: Props): JSX.Element | null {
  const { t } = useTranslation('publish')
  const [open, setOpen] = useState(false)

  // The popover is plain HTML, but the live preview is a native webview that paints
  // above all HTML — hide it while the popover is open so it isn't clipped behind it.
  useSuppressPreview(open)

  useEffect(() => {
    if (!open) return
    const close = (): void => setOpen(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [open])

  if (!info || (!info.upgradeAvailable && !newer)) return null

  const version = info.version
  const update = info.upgradeAvailable
  const rows = summarize(info)

  return (
    <div className="ver-control" onClick={(e) => e.stopPropagation()}>
      <button
        className="ver-btn"
        title={
          update
            ? t('rayfinVersion.updateTitle', { version, latest: info.latest })
            : t('rayfinVersion.newerTitle', { version, newer: newer?.version })
        }
        onClick={() => setOpen((o) => !o)}
      >
        Rayfin v{version}
        {update && <span className="ver-badge">↑ {info.latest}</span>}
      </button>

      {open && (
        <div className="ver-pop" role="dialog">
          {update && (
            <>
              <div className="ver-pop-head">
                <span className="ver-pop-title">{t('rayfinVersion.updateAvailable')}</span>
                <span className="ver-pop-sub">{t('rayfinVersion.newerReady')}</span>
              </div>
              <ul className="ver-rows">
                {rows.map((r) => (
                  <li key={r.label} className="ver-row">
                    <span className="ver-row-label">{r.label}</span>
                    <span className="ver-row-vers">
                      <span className="ver-from">{r.from ?? '—'}</span>
                      <span className="ver-arrow">→</span>
                      <span className={`ver-to${r.upgradable ? ' ver-to--new' : ''}`}>
                        {r.to ?? '—'}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
              <button
                className="btn btn--sm btn--primary ver-update"
                onClick={() => {
                  onUpdate(info)
                  setOpen(false)
                }}
              >
                {t('rayfinVersion.updateWithCopilot')}
              </button>
            </>
          )}
          {newer && (
            <div className={`ver-newer${update ? ' ver-newer--below' : ''}`}>
              <div className="ver-pop-head">
                <span className="ver-pop-title">
                  {update
                    ? t('rayfinVersion.newerAvailableToo', { version: newer.version })
                    : t('rayfinVersion.newerAvailable', { version: newer.version })}
                </span>
                {!update && (
                  <span className="ver-pop-sub">{t('rayfinVersion.current', { version })}</span>
                )}
              </div>
              <ul className="ver-warnings">
                {newerRayfinWarnings(newer).map((warning) => (
                  <li key={warning} className="ver-warning">
                    {warning}
                  </li>
                ))}
              </ul>
              <button
                className="btn btn--sm ver-update"
                onClick={() => {
                  onUpdate(info, newer)
                  setOpen(false)
                }}
              >
                {t('rayfinVersion.updateToNewer', { version: newer.version })}
              </button>
            </div>
          )}
          <p className="ver-note">
            {publishes ? t('rayfinVersion.notePublishes') : t('rayfinVersion.note')}
          </p>
        </div>
      )}
    </div>
  )
}
