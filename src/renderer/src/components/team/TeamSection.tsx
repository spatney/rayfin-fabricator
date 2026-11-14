import { useEffect, useState, type JSX } from 'react'
import type { StudioProject, TeamInvitation, TeamReviewRequest, TeamWorkspace } from '@shared/ipc'
import { Trans, useTranslation } from '../../i18n'
import AbandonSetupModal from './AbandonSetupModal'
import CreateTeamWorkspaceModal from './CreateTeamWorkspaceModal'
import JoinTeamWorkspaceModal from './JoinTeamWorkspaceModal'
import TeamWorkspaceCard from './TeamWorkspaceCard'
import { teamError } from './common'
import './team.css'

/** What a team workspace gives you, on Home before you have one. */
const EMPTY_POINTS = [
  { icon: 'github', title: 'section.points.shared.title', text: 'section.points.shared.text' },
  { icon: 'git-branch', title: 'section.points.copy.title', text: 'section.points.copy.text' },
  { icon: 'rocket', title: 'section.points.published.title', text: 'section.points.published.text' }
] as const

interface Props {
  workspaces: TeamWorkspace[]
  /** A team app was opened (registered and made active). */
  onOpened: (project: StudioProject) => void
  /** Start the New project flow with this workspace as the destination. */
  onNewApp: (workspaceId: string) => void
  /** Open the workspace overview; `manage` opens it on the members and settings. */
  onOpenMap?: (workspaceId: string, manage?: boolean) => void
  /** Workspaces or members changed: refresh the projects state. */
  onChanged: () => void
}

/** Home's Team workspaces section (behind the team workspaces experiment). */
export default function TeamSection({ workspaces, onOpened, onNewApp, onOpenMap, onChanged }: Props): JSX.Element {
  const { t } = useTranslation('team')
  const [opening, setOpening] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [invitations, setInvitations] = useState<TeamInvitation[]>([])
  const [reviews, setReviews] = useState<TeamReviewRequest[]>([])
  const [approving, setApproving] = useState<number | null>(null)
  const [creating, setCreating] = useState<TeamWorkspace | 'new' | null>(null)
  const [abandoning, setAbandoning] = useState<TeamWorkspace | null>(null)
  /** Join is open, starting with this GitHub account (an invitation's). */
  const [joining, setJoining] = useState<{ account?: string } | null>(null)

  async function loadInbox(): Promise<void> {
    const [joinOptions, requests] = await Promise.all([
      window.api.team.joinOptions().catch(() => null),
      window.api.team.reviewRequests().catch(() => [])
    ])
    setInvitations(joinOptions?.invitations ?? [])
    setReviews(requests)
  }

  useEffect(() => {
    void loadInbox()
  }, [])

  async function open(workspaceId: string, folder: string): Promise<void> {
    setOpening(`${workspaceId}/${folder}`)
    setError(null)
    try {
      const result = await window.api.team.openProject(workspaceId, folder)
      if (result.ok && result.project) {
        onOpened(result.project)
      } else {
        setError(result.error ?? t('section.openFailed'))
      }
    } catch (reason) {
      setError(teamError(reason, t('section.openFailed')))
    } finally {
      setOpening(null)
    }
  }

  async function approve(review: TeamReviewRequest): Promise<void> {
    setApproving(review.pr.number)
    setError(null)
    try {
      const result = await window.api.team.approve(review.workspaceId, review.pr.number)
      if (!result.ok) setError(result.error ?? t('section.approveFailed'))
      await loadInbox()
    } finally {
      setApproving(null)
    }
  }

  return (
    <section className="home-recents team-section" aria-labelledby="team-workspaces-title">
      <div className="home-section-heading">
        <h2 id="team-workspaces-title">{t('section.title')}</h2>
        {workspaces.length > 0 && (
          <div className="team-section-actions">
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setJoining({ account: invitations[0]?.account })}>
              {t('shared.join')}
              {invitations.length > 0 && <span className="team-count">{invitations.length}</span>}
            </button>
            <button type="button" className="btn btn--sm" onClick={() => setCreating('new')}>
              <span className="codicon codicon-add" aria-hidden="true" /> {t('section.newWorkspace')}
            </button>
          </div>
        )}
      </div>

      {(invitations.length > 0 || reviews.length > 0) && (
        <div className="team-inbox" aria-label={t('section.inbox')}>
          {invitations.length > 0 && (
            <div className="team-notice">
              <span className="team-notice-icon codicon codicon-mail" aria-hidden="true" />
              <span className="team-notice-text">
                {invitations.length === 1 ? (
                  <Trans
                    t={t}
                    i18nKey="section.invited"
                    values={{ repo: invitations[0].repo }}
                    components={{ b: <strong /> }}
                  />
                ) : (
                  <Trans
                    t={t}
                    i18nKey="section.invitedMany"
                    values={{ count: invitations.length }}
                    components={{ b: <strong /> }}
                  />
                )}
              </span>
              <button
                type="button"
                className="btn btn--sm btn--primary"
                onClick={() => setJoining({ account: invitations[0]?.account })}
              >
                {t('section.reviewInvitations')}
              </button>
            </div>
          )}
          {reviews.map((review) => (
            <div key={`${review.repo}#${review.pr.number}`} className="team-notice">
              <span className="team-notice-icon codicon codicon-git-pull-request" aria-hidden="true" />
              <span className="team-notice-text">
                <Trans
                  t={t}
                  i18nKey="section.wantsToPublish"
                  values={{ author: review.pr.author, title: review.pr.title }}
                  components={{ b: <strong /> }}
                />
              </span>
              <button type="button" className="btn btn--sm" onClick={() => void window.api.openExternal(review.pr.url)}>
                {t('section.viewChanges')}
              </button>
              <button
                type="button"
                className="btn btn--sm btn--primary"
                disabled={approving === review.pr.number}
                onClick={() => void approve(review)}
              >
                {approving === review.pr.number ? t('section.approving') : t('section.approve')}
              </button>
            </div>
          ))}
        </div>
      )}

      {workspaces.length === 0 ? (
        <div className="team-empty">
          <div className="team-empty-head">
            <span className="team-empty-icon" aria-hidden="true">
              <span className="codicon codicon-organization" />
            </span>
            <div className="team-empty-text">
              <p className="team-empty-title">{t('section.emptyTitle')}</p>
              <p className="team-muted">{t('section.emptyText')}</p>
            </div>
            <div className="team-empty-actions">
              <button type="button" className="btn btn--sm" onClick={() => setJoining({ account: invitations[0]?.account })}>
                {t('shared.join')}
                {invitations.length > 0 && <span className="team-count">{invitations.length}</span>}
              </button>
              <button type="button" className="btn btn--sm btn--primary" onClick={() => setCreating('new')}>
                {t('shared.createTeamWorkspace')}
              </button>
            </div>
          </div>
          <ul className="team-empty-points">
            {EMPTY_POINTS.map((point) => (
              <li key={point.icon} className="team-empty-point">
                <span className={`codicon codicon-${point.icon}`} aria-hidden="true" />
                <span className="team-empty-point-text">
                  <span className="team-empty-point-title">{t(point.title)}</span>
                  <span className="team-muted">{t(point.text)}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="team-grid">
          {workspaces.map((ws) => (
            <TeamWorkspaceCard
              key={ws.id}
              workspace={ws}
              opening={opening}
              onOpenApp={(workspaceId, folder) => void open(workspaceId, folder)}
              onOpenMap={onOpenMap}
              onNewApp={onNewApp}
              onFinishSetup={setCreating}
              onAbandonSetup={setAbandoning}
            />
          ))}
        </div>
      )}

      {error && <div className="alert alert--error">{error}</div>}

      {creating && (
        <CreateTeamWorkspaceModal
          resume={creating === 'new' ? undefined : creating}
          onClose={() => setCreating(null)}
          onChanged={() => onChanged()}
          onAbandon={(workspace) => {
            setCreating(null)
            setAbandoning(workspace)
          }}
        />
      )}
      {abandoning && (
        <AbandonSetupModal
          workspace={abandoning}
          onClose={() => setAbandoning(null)}
          onGone={() => {
            setAbandoning(null)
            onChanged()
          }}
          onChanged={() => onChanged()}
        />
      )}
      {joining && (
        <JoinTeamWorkspaceModal
          initialAccount={joining.account}
          onClose={() => setJoining(null)}
          onJoined={() => {
            setJoining(null)
            onChanged()
            void loadInbox()
          }}
        />
      )}
    </section>
  )
}
