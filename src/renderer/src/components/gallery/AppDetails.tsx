import { useEffect, useRef, useState, type JSX } from 'react'
import type { GalleryApp, GalleryStatus } from '@shared/ipc'
import { CheckIcon, CloseIcon, Codicon, CopyIcon } from '../icons'
import { AppCover, AppTags } from './AppCard'
import { ago, fullDate, hostOf } from './model'

interface Props {
  app: GalleryApp
  /** What Fabric said about its latest publish; undefined while it's asked. */
  status?: GalleryStatus
  pinned: boolean
  onClose: () => void
  onOpenProject: (projectId: string) => void
  onPin: (app: GalleryApp) => void
  openUrl: (url: string) => void
}

/** A copy button that says so for a moment. */
function CopyLink({ url }: { url: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current)
    },
    []
  )
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      if (timer.current != null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 1400)
    } catch {
      /* clipboard unavailable */
    }
  }
  return (
    <button type="button" className="btn btn--sm" onClick={() => void copy()}>
      {copied ? <CheckIcon /> : <CopyIcon />}
      {copied ? 'Copied' : 'Copy link'}
    </button>
  )
}

/** The selected app: what Fabric knows about it, and where to open it. */
export default function AppDetails({
  app,
  status,
  pinned,
  onClose,
  onOpenProject,
  onPin,
  openUrl
}: Props): JSX.Element {
  const address = status?.hostingUrl ?? app.hostingUrl
  const local = app.local
  const when = ago(status?.publishedAt)
  let published: JSX.Element | string = '…'
  if (status?.unknown) published = 'Unknown'
  else if (when)
    published = (
      <span title={fullDate(status?.publishedAt)}>{when[0].toUpperCase() + when.slice(1)}</span>
    )
  else if (status) published = 'Not yet'
  let note = 'Looking up the app’s address…'
  if (status?.unknown) note = 'Fabric didn’t share this app’s address. Open it in Fabric instead.'
  else if (status) note = 'This app hasn’t published its pages yet.'

  return (
    <aside className="gdetail" aria-label={`About ${app.name}`}>
      <div className="gdetail-cover">
        <AppCover name={app.name} className="gcover--large" />
        <button
          type="button"
          className="icon-btn gdetail-close"
          aria-label="Close details"
          title="Close (Esc)"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </div>
      <div className="gdetail-main">
        <div className="gdetail-titles">
          <h2 className="gdetail-name">{app.name}</h2>
          <p className="gdetail-ws">
            <Codicon name={app.workspaceName === 'My workspace' ? 'account' : 'folder'} />
            {app.workspaceName}
          </p>
          {(app.local || app.team) && (
            <p className="gdetail-tags">
              <AppTags app={app} />
            </p>
          )}
        </div>
        {app.description && <p className="gdetail-desc">{app.description}</p>}

        <div className="gdetail-actions">
          {address ? (
            <button type="button" className="btn btn--primary" onClick={() => openUrl(address)}>
              <Codicon name="link-external" />
              Open app
            </button>
          ) : (
            <p className="gdetail-note" role="status">
              {note}
            </p>
          )}
          <button type="button" className="btn" onClick={() => openUrl(app.portalUrl)}>
            <Codicon name="globe" />
            Open in Fabric
          </button>
          {local && (
            <button type="button" className="btn" onClick={() => onOpenProject(local.projectId)}>
              <Codicon name="go-to-file" />
              Open in Fabricator
            </button>
          )}
          <div className="gdetail-more">
            <CopyLink url={address ?? app.portalUrl} />
            <button type="button" className="btn btn--sm" onClick={() => onPin(app)}>
              <Codicon name={pinned ? 'pinned' : 'pin'} />
              {pinned ? 'Unpin' : 'Pin to the top'}
            </button>
          </div>
        </div>

        <dl className="gdetail-facts">
          <dt>Published</dt>
          <dd>{published}</dd>
          {address && (
            <>
              <dt>Address</dt>
              <dd className="gdetail-mono" title={address}>
                {hostOf(address)}
              </dd>
            </>
          )}
          <dt>Workspace</dt>
          <dd>{app.workspaceName}</dd>
          {local && (
            <>
              <dt>Project</dt>
              <dd>{local.projectName}</dd>
            </>
          )}
          {app.team && (
            <>
              <dt>Team</dt>
              <dd>
                {app.team.name}
                {app.team.preview ? ' · a teammate’s preview' : ''}
              </dd>
            </>
          )}
        </dl>
      </div>
    </aside>
  )
}
