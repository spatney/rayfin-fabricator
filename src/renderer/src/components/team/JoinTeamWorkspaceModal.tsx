import { useEffect, useId, useState, type JSX } from 'react'
import type { TeamJoinOptions, TeamProblem, TeamWorkspace } from '@shared/ipc'
import { useTranslation } from '../../i18n'
import { useSuppressPreview } from '../../overlay'
import { useModalFocus } from '../../modalFocus'
import { GithubAccountField, ProblemView, teamError } from './common'
import TeamDiagnosis from './diagnosis/TeamDiagnosis'
import './team.css'

interface Props {
  /** Start with this GitHub account (an invitation's). */
  initialAccount?: string
  onClose: () => void
  onJoined: (workspace: TeamWorkspace) => void
}

/** Join a team workspace as one of your GitHub accounts: accept an invitation, or pick one it can access. */
export default function JoinTeamWorkspaceModal({ initialAccount, onClose, onJoined }: Props): JSX.Element {
  useSuppressPreview()
  const { t } = useTranslation('team')
  const titleId = useId()
  const dialogRef = useModalFocus<HTMLDivElement>()
  const [account, setAccount] = useState(initialAccount ?? '')
  const [accountReady, setAccountReady] = useState(false)
  const [options, setOptions] = useState<TeamJoinOptions | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [repo, setRepo] = useState('')
  const [error, setError] = useState<string | null>(null)
  /** The failed join's problem, when it has more to show (a link or a sign-in that fixes it). */
  const [problem, setProblem] = useState<TeamProblem | null>(null)
  /** The repository the failed join was for. */
  const [failedRepo, setFailedRepo] = useState<string | null>(null)

  useEffect(() => {
    if (!account || !accountReady) return
    let current = true
    setOptions(null)
    setError(null)
    window.api.team
      .joinOptions(account)
      .then((next) => {
        if (current) setOptions(next)
      })
      .catch((reason) => {
        if (current) {
          setOptions({ ok: false, error: teamError(reason, t('join.loadFailed')), invitations: [], discovered: [] })
        }
      })
    return () => {
      current = false
    }
  }, [account, accountReady])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  async function join(
    key: string,
    target: string,
    action: () => Promise<{ ok: boolean; error?: string; problem?: TeamProblem; workspace?: TeamWorkspace }>
  ): Promise<void> {
    setBusy(key)
    setError(null)
    setProblem(null)
    setFailedRepo(target)
    try {
      const result = await action()
      if (result.ok && result.workspace) {
        onJoined(result.workspace)
        return
      }
      setError(result.error ?? t('join.failed'))
      if (result.problem?.link || result.problem?.kind === 'sso') setProblem(result.problem)
    } catch (reason) {
      setError(teamError(reason, t('join.failed')))
    } finally {
      setBusy(null)
    }
  }

  const manualValid = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/.test(repo.trim())

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div
        className="modal team-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={titleId}>{t('join.title')}</h2>
        </div>
        <div className="modal-body team-form">
          <GithubAccountField
            value={account}
            onChange={setAccount}
            onReady={setAccountReady}
            hint={t('join.accountHint')}
          />
          {!accountReady ? null : !options ? (
            <span className="team-muted">
              <span className="ws-spinner" /> {t('join.looking', { account })}
            </span>
          ) : (
            <>
              {options.error && <div className="alert alert--error">{options.error}</div>}
              <section className="team-menu-section">
                <span className="team-menu-title">{t('join.invitations')}</span>
                {options.invitations.length === 0 ? (
                  <span className="team-muted">{t('join.noInvitations', { account })}</span>
                ) : (
                  options.invitations.map((invite) => (
                    <div key={invite.id} className="team-app">
                      <span className="team-app-name" title={invite.description}>
                        <strong>{invite.repo}</strong>
                        {invite.inviter && (
                          <span className="team-muted"> {t('join.from', { inviter: invite.inviter })}</span>
                        )}
                      </span>
                      <button
                        type="button"
                        className="btn btn--sm btn--primary"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          void join(`i${invite.id}`, invite.repo, () =>
                            window.api.team.acceptInvitation(invite.id, invite.repo, account)
                          )
                        }
                      >
                        {busy === `i${invite.id}` ? t('join.joining') : t('join.accept')}
                      </button>
                    </div>
                  ))
                )}
              </section>
              {options.discovered.length > 0 && (
                <section className="team-menu-section">
                  <span className="team-menu-title">{t('join.discovered')}</span>
                  {options.discovered.map((d) => (
                    <div key={d.repo} className="team-app">
                      <span className="team-app-name" title={d.description}>
                        <strong>{d.repo}</strong>
                      </span>
                      <button
                        type="button"
                        className="btn btn--sm"
                        disabled={Boolean(busy)}
                        onClick={() => void join(d.repo, d.repo, () => window.api.team.join(d.repo, account))}
                      >
                        {busy === d.repo ? t('join.joining') : t('shared.join')}
                      </button>
                    </div>
                  ))}
                </section>
              )}
              <section className="team-menu-section">
                <span className="team-menu-title">{t('join.manual')}</span>
                <div className="team-row">
                  <input
                    className="field-input"
                    value={repo}
                    placeholder={t('shared.repoPlaceholder')}
                    spellCheck={false}
                    onChange={(event) => setRepo(event.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={!manualValid || Boolean(busy)}
                    onClick={() => void join('manual', repo.trim(), () => window.api.team.join(repo.trim(), account))}
                  >
                    {busy === 'manual' ? t('join.joining') : t('shared.join')}
                  </button>
                </div>
              </section>
            </>
          )}
          {problem ? (
            <ProblemView problem={problem} account={account || undefined} />
          ) : (
            error && <div className="alert alert--error">{error}</div>
          )}
          {error ? (
            <TeamDiagnosis
              input={{ kind: 'join', repo: failedRepo ?? undefined, error, account: account || undefined }}
              resetKey={`${failedRepo ?? ''}|${error}`}
            />
          ) : (
            options?.error && (
              <TeamDiagnosis
                input={{ kind: 'join', error: options.error, account: account || undefined }}
                resetKey={options.error}
              />
            )
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn--ghost" disabled={Boolean(busy)} onClick={onClose}>
            {t('actions.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
