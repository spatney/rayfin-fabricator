import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react'
import type { TeamMap, TeamMapApp, TeamMapRun, TeamWorkspace } from '@shared/ipc'
import { translator, useTranslation } from '../../i18n'
import { AddIcon, ChevronRightIcon } from '../icons'
import { copyHealth, isActive, publishedHealth, type Health } from './map/model'
import { Avatar, hueOf } from './map/parts'
import { activeDeploys, useTeamActivity } from './useTeamActivity'
import './team.css'

interface Props {
  workspace: TeamWorkspace
  /** The app being opened (`<workspaceId>/<folder>`), if any. */
  opening: string | null
  onOpenApp: (workspaceId: string, folder: string) => void
  /** Open the workspace overview; `manage` opens it on the members and settings. */
  onOpenMap?: (workspaceId: string, manage?: boolean) => void
  onNewApp: (workspaceId: string) => void
  onFinishSetup: (workspace: TeamWorkspace) => void
  /** Delete what an unfinished setup created and forget the workspace. */
  onAbandonSetup: (workspace: TeamWorkspace) => void
}

/** Whether `repo` (`owner/name`) belongs to `login` (so naming the account adds nothing). */
function ownedBy(repo: string, login: string): boolean {
  return repo.split('/')[0]?.toLowerCase() === login.toLowerCase()
}

/** An app's state on Home: deploying anywhere, else its published status. */
export function appStatus(app: TeamMapApp, runs: TeamMapRun[]): { health: Health; label: string } {
  const t = translator('team')
  const deploying =
    (app.published && publishedHealth(app, runs) === 'deploying') ||
    app.copies.some((c) => copyHealth(app, c, runs) === 'deploying')
  if (deploying) return { health: 'deploying', label: t('card.health.deploying') }
  if (!app.published) return { health: 'idle', label: t('card.health.notPublished') }
  const health = publishedHealth(app, runs)
  return {
    health,
    label:
      health === 'live'
        ? t('card.health.live')
        : health === 'failed'
          ? t('card.health.failed')
          : t('card.health.notDeployed')
  }
}

/** A team workspace on Home: its apps, who's working on them, and what's live. */
export default function TeamWorkspaceCard({
  workspace,
  opening,
  onOpenApp,
  onOpenMap,
  onNewApp,
  onFinishSetup,
  onAbandonSetup
}: Props): JSX.Element {
  const { t } = useTranslation('team')
  const pending = Boolean(workspace.setup && !workspace.setup.done)
  const [map, setMap] = useState<TeamMap | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const polled = useTeamActivity(pending ? null : workspace.id)
  const runs = polled.length ? polled : (map?.runs ?? [])
  const activeIds = runs.filter(isActive).map((r) => r.id).join(',')
  const lastActive = useRef(activeIds)

  const load = useRef<() => void>(() => {})
  load.current = () => {
    window.api.team
      .map(workspace.id)
      .then((next) => {
        setMap(next)
        setFailed(next.ok ? null : (next.error ?? t('card.readFailed')))
      })
      .catch(() => setFailed(t('card.readFailed')))
  }

  useEffect(() => {
    if (!pending) load.current()
  }, [workspace.id, pending])

  // A deploy finishing changes what's live: read the workspace again.
  useEffect(() => {
    if (lastActive.current !== activeIds && lastActive.current !== '') load.current()
    lastActive.current = activeIds
  }, [activeIds])

  const deploying = activeDeploys(runs).length

  return (
    <article className="team-card">
      <header className="team-card-head">
        <span
          className="team-card-mark"
          aria-hidden="true"
          style={{ '--hue': hueOf(workspace.repo || workspace.name) } as CSSProperties}
        >
          {(workspace.name.trim()[0] ?? 'T').toUpperCase()}
        </span>
        <span className="team-card-text">
          <span className="team-card-name">{workspace.name}</span>
          <span className="team-card-sub">
            {workspace.repo || t('card.settingUp')} · {workspace.role === 'owner' ? t('card.owner') : t('card.member')}
            {workspace.account && !ownedBy(workspace.repo, workspace.account) && (
              <span title={t('card.accountTitle')}> · {t('card.asAccount', { account: workspace.account })}</span>
            )}
          </span>
        </span>
        {deploying > 0 && (
          <span className="team-live" title={t('card.deployingTitle')}>
            <span className="team-live-dot" aria-hidden="true" />
            {t('card.deploying', { count: deploying })}
          </span>
        )}
        {!pending && onOpenMap && (
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => onOpenMap(workspace.id)}
            title={t('card.overviewTitle')}
          >
            <span className="codicon codicon-type-hierarchy-sub" aria-hidden="true" /> {t('shared.overview')}
          </button>
        )}
        {!pending && onOpenMap && (
          <button
            type="button"
            className="team-card-gear"
            aria-label={t('card.manage', { name: workspace.name })}
            title={t('card.manageTitle')}
            onClick={() => onOpenMap(workspace.id, true)}
          >
            <span className="codicon codicon-gear" aria-hidden="true" />
          </button>
        )}
      </header>

      {pending ? (
        <div className="team-card-setup">
          <span className="team-muted">{t('card.setupUnfinished')}</span>
          <span className="team-card-setup-actions">
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              title={t('card.abandonTitle')}
              onClick={() => onAbandonSetup(workspace)}
            >
              {t('shared.abandonSetup')}
            </button>
            <button type="button" className="btn btn--sm btn--primary" onClick={() => onFinishSetup(workspace)}>
              {t('card.finishSetup')}
            </button>
          </span>
        </div>
      ) : (
        <ul className="team-card-apps">
          {!map && !failed && (
            <li className="team-card-note">
              <span className="ws-spinner" /> {t('card.reading')}
            </li>
          )}
          {failed && !map?.apps.length && <li className="team-card-note">{failed}</li>}
          {map?.apps.map((app) => {
            const status = appStatus(app, runs)
            const people = app.copies.filter((c, i, all) => all.findIndex((x) => x.author === c.author) === i)
            const key = `${workspace.id}/${app.folder}`
            return (
              <li key={app.folder}>
                <button
                  type="button"
                  className={`team-card-app${opening === key ? ' team-card-app--opening' : ''}`}
                  aria-label={t('card.openApp', { name: app.name })}
                  disabled={opening !== null}
                  onClick={() => onOpenApp(workspace.id, app.folder)}
                >
                  <span
                    className="team-card-app-mark"
                    aria-hidden="true"
                    style={{ '--hue': hueOf(app.folder) } as CSSProperties}
                  >
                    {(app.name.trim()[0] ?? '?').toUpperCase()}
                  </span>
                  <span className="team-card-app-name">{app.name}</span>
                  <span className={`team-status team-status--${status.health}`}>
                    <span className="team-status-dot" aria-hidden="true" />
                    {status.label}
                  </span>
                  <span
                    className="team-card-app-people"
                    title={people.map((c) => (c.mine ? t('card.you') : c.author)).join(', ')}
                  >
                    {people.length > 0 && (
                      <>
                        <span className="team-card-avatars">
                          {people.slice(0, 3).map((c) => (
                            <Avatar key={c.author || c.branch} login={c.author || 'you'} url={c.avatarUrl} size={18} />
                          ))}
                        </span>
                        {t('card.inProgress', { count: app.copies.length })}
                      </>
                    )}
                  </span>
                  <span className="team-card-app-go" aria-hidden="true">
                    {opening === key ? <span className="ws-spinner" /> : <ChevronRightIcon />}
                  </span>
                </button>
              </li>
            )
          })}
          <li>
            <button type="button" className="team-card-app team-card-app--new" onClick={() => onNewApp(workspace.id)}>
              <span className="team-card-app-mark team-card-app-mark--new" aria-hidden="true">
                <AddIcon />
              </span>
              <span className="team-card-app-name">{t('card.newApp')}</span>
            </button>
          </li>
        </ul>
      )}
    </article>
  )
}
