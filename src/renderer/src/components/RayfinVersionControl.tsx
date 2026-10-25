import { useEffect, useState, type JSX } from 'react'
import type { RayfinVersionInfo } from '@shared/ipc'
import { useSuppressPreview } from '../overlay'

interface Props {
  /** Local Rayfin version report for the active project (null while loading). */
  info: RayfinVersionInfo | null
  /** Hand the upgrade off to the Copilot agent (parent builds + sends the prompt). */
  onUpdate: (info: RayfinVersionInfo) => void
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
 * when a newer release is on npm — an up-to-date version is nothing to act on.
 * Opening it shows the from → to versions and hands the upgrade to Copilot on
 * click. The app never runs the install itself — the agent edits package.json +
 * runs npm install.
 */
export default function RayfinVersionControl({ info, onUpdate }: Props): JSX.Element | null {
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

  if (!info || !info.upgradeAvailable) return null

  const version = info.version
  const rows = summarize(info)

  return (
    <div className="ver-control" onClick={(e) => e.stopPropagation()}>
      <button
        className="ver-btn"
        title={`Rayfin ${version} — update to ${info.latest} available`}
        onClick={() => setOpen((o) => !o)}
      >
        Rayfin v{version}
        <span className="ver-badge">↑ {info.latest}</span>
      </button>

      {open && (
        <div className="ver-pop" role="dialog">
          <div className="ver-pop-head">
            <span className="ver-pop-title">Update available</span>
            <span className="ver-pop-sub">A newer version of Rayfin is ready.</span>
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
            Update with Copilot
          </button>
          <p className="ver-note">
            Copilot updates the packages and fixes any changes — then redeploy to apply.
          </p>
        </div>
      )}
    </div>
  )
}
