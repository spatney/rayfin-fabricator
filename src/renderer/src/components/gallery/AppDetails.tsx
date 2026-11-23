import { useEffect, useRef, useState, type JSX } from 'react'
import type { GalleryApp, GalleryDescribeResult, GalleryStatus } from '@shared/ipc'
import { errorMessage } from '../../errorReport'
import { useTranslation } from '../../i18n'
import { CheckIcon, CloseIcon, Codicon, CopyIcon } from '../icons'
import { AppCover, AppTags, HealthTag } from './AppCard'
import { ago, fullDate, hostOf, type HealthIssue } from './model'

interface Props {
  app: GalleryApp
  /** What Fabric said about its latest publish; undefined while it's asked. */
  status?: GalleryStatus
  pinned: boolean
  /** The app's thumbnail from this computer. */
  picture?: string
  /** Where its published thumbnail would be. */
  hosted?: string
  /** What its maker may want to look at, most pressing first. */
  issues?: readonly HealthIssue[]
  /** The Rayfin version its project could update to. */
  update?: string | null
  onClose: () => void
  onOpenProject: (projectId: string) => void
  onPin: (app: GalleryApp) => void
  openUrl: (url: string) => void
  /** The app was opened, for the Recently opened order. */
  onOpened?: (app: GalleryApp) => void
  /** Look at the live app over the gallery. */
  onQuickLook?: (app: GalleryApp) => void
  /** Have Copilot write the app's description and save it in Fabric. */
  onDescribe?: (app: GalleryApp) => Promise<GalleryDescribeResult>
}

/** A copy button that says so for a moment. */
function CopyLink({ url }: { url: string }): JSX.Element {
  const { t } = useTranslation('gallery')
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
      {copied ? t('actions.copied') : t('details.copyLink')}
    </button>
  )
}

/**
 * An app without a description, published from this computer by someone who
 * can change it: Copilot can write one, which Fabric then shows everyone.
 */
function Describe({
  app,
  onDescribe
}: {
  app: GalleryApp
  onDescribe: (app: GalleryApp) => Promise<GalleryDescribeResult>
}): JSX.Element {
  const { t } = useTranslation('gallery')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function describe(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const result = await onDescribe(app)
      if (!result.ok) setError(result.error ?? t('describe.failed'))
    } catch (reason) {
      setError(errorMessage(reason, t('describe.failed')))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="gdetail-describe">
      <p className="gdetail-describe-text">{t('describe.text')}</p>
      <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void describe()}>
        <Codicon name={busy ? 'loading' : 'sparkle'} className={busy ? 'icon-spin' : undefined} />
        {busy ? t('describe.writing') : t('describe.write')}
      </button>
      {error && (
        <p className="gdetail-describe-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

/** The selected app: what Fabric knows about it, and where to open it. */
export default function AppDetails({
  app,
  status,
  pinned,
  picture,
  hosted,
  issues = [],
  update,
  onClose,
  onOpenProject,
  onPin,
  openUrl,
  onOpened,
  onQuickLook,
  onDescribe
}: Props): JSX.Element {
  const { t } = useTranslation('gallery')
  const address = status?.hostingUrl ?? app.hostingUrl
  const local = app.local
  const when = ago(status?.publishedAt)
  let published: JSX.Element | string = '…'
  if (status?.unknown) published = t('status.unknown')
  else if (when)
    published = (
      <span title={fullDate(status?.publishedAt)}>{when[0].toUpperCase() + when.slice(1)}</span>
    )
  else if (status) published = t('published.notYet')
  let note = t('details.lookingUp')
  if (status?.unknown) note = t('details.noAddress')
  else if (status) note = t('details.notPublished')
  // "Not published yet" is already the Published line.
  const shown = issues.filter((issue) => issue !== 'unpublished')
  const describable =
    Boolean(onDescribe) && !app.description && Boolean(local) && !app.team && app.canEdit !== false
  const open = (url: string): void => {
    onOpened?.(app)
    openUrl(url)
  }

  return (
    <aside className="gdetail" aria-label={t('details.label', { name: app.name })}>
      <div className="gdetail-cover">
        <AppCover name={app.name} className="gcover--large" picture={picture} hosted={hosted} />
        <button
          type="button"
          className="icon-btn gdetail-close"
          aria-label={t('details.close')}
          title={t('details.closeTitle')}
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
          {shown.length > 0 && (
            <p className="gdetail-tags gdetail-health">
              {shown.map((issue) => (
                <HealthTag key={issue} issue={issue} update={update} />
              ))}
            </p>
          )}
        </div>
        {app.description && <p className="gdetail-desc">{app.description}</p>}
        {describable && onDescribe && <Describe app={app} onDescribe={onDescribe} />}

        <div className="gdetail-actions">
          {address ? (
            <button type="button" className="btn btn--primary" onClick={() => open(address)}>
              <Codicon name="link-external" />
              {t('app.openApp')}
            </button>
          ) : (
            <p className="gdetail-note" role="status">
              {note}
            </p>
          )}
          {address && onQuickLook && (
            <button
              type="button"
              className="btn"
              aria-keyshortcuts="Space"
              title={t('details.quickLookTitle')}
              onClick={() => onQuickLook(app)}
            >
              <Codicon name="eye" />
              {t('details.quickLook')}
            </button>
          )}
          <button type="button" className="btn" onClick={() => open(app.portalUrl)}>
            <Codicon name="globe" />
            {t('app.openInFabric')}
          </button>
          {local && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                onOpened?.(app)
                onOpenProject(local.projectId)
              }}
            >
              <Codicon name="go-to-file" />
              {t('app.openInFabricator')}
            </button>
          )}
          <div className="gdetail-more">
            <CopyLink url={address ?? app.portalUrl} />
            <button type="button" className="btn btn--sm" onClick={() => onPin(app)}>
              <Codicon name={pinned ? 'pinned' : 'pin'} />
              {pinned ? t('app.unpin') : t('app.pinToTop')}
            </button>
          </div>
        </div>

        <dl className="gdetail-facts">
          <dt>{t('details.facts.published')}</dt>
          <dd>{published}</dd>
          {address && (
            <>
              <dt>{t('details.facts.address')}</dt>
              <dd className="gdetail-mono" title={address}>
                {hostOf(address)}
              </dd>
            </>
          )}
          <dt>{t('details.facts.workspace')}</dt>
          <dd>{app.workspaceName}</dd>
          {app.canEdit !== undefined && (
            <>
              <dt>{t('details.facts.access')}</dt>
              <dd>{app.canEdit ? t('details.canChange') : t('details.canOpen')}</dd>
            </>
          )}
          {local && (
            <>
              <dt>{t('details.facts.project')}</dt>
              <dd>{local.projectName}</dd>
            </>
          )}
          {app.team && (
            <>
              <dt>{t('details.facts.team')}</dt>
              <dd>
                {app.team.preview
                  ? t('details.teammatePreview', { name: app.team.name })
                  : app.team.name}
              </dd>
            </>
          )}
        </dl>
      </div>
    </aside>
  )
}
