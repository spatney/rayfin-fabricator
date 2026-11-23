import { useEffect, useMemo, useState, type JSX } from 'react'
import type {
  TeamFabricAccess,
  TeamHealth,
  TeamHealthItem,
  TeamMembersResult,
  TeamProblem,
  TeamRunnerInfo,
  TeamWorkspace
} from '@shared/ipc'
import { formatList, useTranslation } from '../../../i18n'
import ConfirmModal from '../../ConfirmModal'
import { Codicon } from '../../icons'
import { GithubAccountField, ProblemView, StepList, teamError, useStepProgress } from '../common'
import TeamDiagnosisModal from '../diagnosis/TeamDiagnosisModal'
import type { DiagnosisInput } from '../diagnosis/useTeamDiagnosis'
import RunnerFields, { draftRunner, runnerDraft, runnerDraftReady, runnerSummary, type RunnerDraft } from '../RunnerFields'
import { Avatar, FabricGlyph, fabricWorkspaceUrl } from './parts'

export type WorkspaceTab = 'members' | 'access' | 'settings'

const VERIFY_STEPS = [{ id: 'verify', label: 'workspace.verifyStep' }] as const

const sameAccount = (a: string, b: string | undefined): boolean => a.toLowerCase() === (b ?? '').toLowerCase()

/** Each health check's dot, in the overview's status colors. */
const HEALTH_DOT: Record<TeamHealthItem['state'], string> = { ok: 'live', warn: 'warn', error: 'failed', unknown: 'idle' }

interface Props {
  workspace: TeamWorkspace
  /** The signed-in GitHub login. */
  viewer?: string
  initialTab?: WorkspaceTab
  onClose: () => void
  /** Members or settings changed. */
  onChanged: () => void
  /** The workspace was left or deleted on this computer. */
  onGone: () => void
}

type Confirm =
  | { kind: 'remove-member'; login: string; invitationId?: number }
  | { kind: 'revoke-fabric'; principalId: string; name: string }
  | { kind: 'leave' }
  | { kind: 'delete' }

/** Managing a team workspace, in the overview's sidebar: members, access to the apps, settings. */
export default function WorkspacePanel({
  workspace,
  viewer,
  initialTab = 'members',
  onClose,
  onChanged,
  onGone
}: Props): JSX.Element {
  const { t } = useTranslation('teamMap')
  const [tab, setTab] = useState<WorkspaceTab>(initialTab)
  const [members, setMembers] = useState<TeamMembersResult | null>(null)
  const [fabricPeople, setFabricPeople] = useState<TeamFabricAccess | null>(null)
  const [health, setHealth] = useState<TeamHealth | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [problem, setProblem] = useState<TeamProblem | null>(null)
  const [login, setLogin] = useState('')
  const [email, setEmail] = useState('')
  const [asOwner, setAsOwner] = useState(false)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [deleteFabric, setDeleteFabric] = useState(false)
  /** Choosing another GitHub account for the workspace. */
  const [changingAccount, setChangingAccount] = useState(false)
  const [newAccount, setNewAccount] = useState('')
  const [newAccountReady, setNewAccountReady] = useState(false)
  /** Where the pipeline runs (owners); `null` until loaded. */
  const [runnerInfo, setRunnerInfo] = useState<TeamRunnerInfo | null>(null)
  const [changingRunner, setChangingRunner] = useState(false)
  const [runnerChoice, setRunnerChoice] = useState<RunnerDraft>(() => runnerDraft())
  const [diagnose, setDiagnose] = useState<DiagnosisInput | null>(null)
  /** The last action was Repair (so `problem`/`error` are its outcome). */
  const [repairTried, setRepairTried] = useState(false)
  const repairScope = useMemo(() => `team-repair-${crypto.randomUUID()}`, [])
  const [repairRows, setRepairRows] = useStepProgress(
    VERIFY_STEPS.map((s) => ({ id: s.id, label: t(s.label) })),
    repairScope
  )
  const ws = workspace
  /** Owners (the Maintain or Admin role on the repository) manage settings, runners, Repair and app access. */
  const canManage = Boolean(members?.canManage) || ws.role === 'owner'
  /** GitHub only lets the repository's admins add and remove people, and archive it. */
  const isAdmin = Boolean(members?.canManage)
  /** An owner with the Maintain role, once members say so. */
  const maintainer = canManage && Boolean(members?.ok) && !isAdmin
  const requireReview = Boolean(ws.manifest?.settings.requireReview)
  const fabric = ws.manifest?.fabric

  async function loadMembers(): Promise<void> {
    try {
      setMembers(await window.api.team.members(ws.id))
    } catch (reason) {
      setMembers({ ok: false, error: teamError(reason, t('workspace.members.loadFailed')), members: [], canManage: false })
    }
  }

  async function loadFabricPeople(): Promise<void> {
    setFabricPeople(null)
    try {
      setFabricPeople(await window.api.team.fabricAccess(ws.id))
    } catch (reason) {
      setFabricPeople({ ok: false, error: teamError(reason, t('workspace.access.loadFailed')), people: [] })
    }
  }

  async function loadHealth(): Promise<void> {
    setHealth(null)
    try {
      setHealth(await window.api.team.health(ws.id))
    } catch (reason) {
      setHealth({ ok: false, error: teamError(reason, t('workspace.settings.healthFailed')), items: [] })
    }
  }

  async function loadRunner(): Promise<void> {
    setRunnerInfo(null)
    try {
      setRunnerInfo(await window.api.team.runner(ws.id))
    } catch (reason) {
      setRunnerInfo({ ok: false, error: teamError(reason, t('workspace.settings.runnerFailed')) })
    }
  }

  useEffect(() => {
    void loadMembers()
  }, [ws.id])

  useEffect(() => {
    if (tab === 'settings' && !health) void loadHealth()
    if (tab === 'access' && !fabricPeople) void loadFabricPeople()
  }, [tab])

  // Only owners can read the pipeline's variables.
  useEffect(() => {
    if (tab === 'settings' && canManage && !runnerInfo) void loadRunner()
  }, [tab, canManage])

  async function act(
    key: string,
    action: () => Promise<{ ok: boolean; error?: string; problem?: TeamProblem }>,
    after?: () => Promise<void> | void,
    success?: string
  ): Promise<boolean> {
    setBusy(key)
    setError(null)
    setNotice(null)
    setProblem(null)
    setRepairTried(key === 'repair')
    try {
      const result = await action()
      if (!result.ok) {
        if (result.problem) setProblem(result.problem)
        else setError(result.error ?? t('workspace.failed'))
        return false
      }
      // Partial success: the main action worked but a follow-up didn't.
      if (result.error) setError(result.error)
      else if (success) setNotice(success)
      await after?.()
      onChanged()
      return true
    } catch (reason) {
      setError(teamError(reason, t('workspace.failed')))
      return false
    } finally {
      setBusy(null)
    }
  }

  async function invite(): Promise<void> {
    const who = login.trim()
    const ok = await act(
      'invite',
      () => window.api.team.invite(ws.id, who, asOwner, email.trim() || undefined),
      async () => {
        await loadMembers()
        if (fabricPeople) await loadFabricPeople()
      },
      t('workspace.members.invitedNotice', { name: who })
    )
    if (ok) {
      setLogin('')
      setEmail('')
      setAsOwner(false)
    }
  }

  async function repair(): Promise<void> {
    setRepairRows(VERIFY_STEPS.map((s) => ({ id: s.id, label: t(s.label), state: 'pending' })))
    await act('repair', () => window.api.team.repair(ws.id, repairScope), loadHealth, t('workspace.settings.healthy'))
  }

  async function saveAccount(): Promise<void> {
    const login = newAccount
    const ok = await act(
      'account',
      () => window.api.team.setAccount(ws.id, login),
      loadMembers,
      t('workspace.settings.accountSaved', { login })
    )
    if (ok) setChangingAccount(false)
  }

  async function saveRunner(): Promise<void> {
    const ok = await act(
      'runner',
      () => window.api.team.setRunner(ws.id, draftRunner(runnerChoice)),
      loadRunner,
      t('workspace.settings.runnerSaved')
    )
    if (ok) setChangingRunner(false)
  }

  async function runConfirmed(): Promise<void> {
    const current = confirm
    if (!current) return
    if (current.kind === 'remove-member') {
      await act('confirm', () => window.api.team.removeMember(ws.id, current.login, current.invitationId), loadMembers)
    } else if (current.kind === 'revoke-fabric') {
      await act(
        'confirm',
        () => window.api.team.revokeFabricAccess(ws.id, current.principalId),
        loadFabricPeople,
        t('workspace.access.revoked', { name: current.name })
      )
    } else if (current.kind === 'leave') {
      setBusy('confirm')
      try {
        await window.api.team.leave(ws.id)
        setConfirm(null)
        onGone()
        return
      } catch (reason) {
        setError(teamError(reason, t('workspace.settings.leaveFailed')))
      } finally {
        setBusy(null)
      }
    } else if (current.kind === 'delete') {
      const ok = await act('confirm', () => window.api.team.delete(ws.id, deleteFabric))
      if (ok) {
        setConfirm(null)
        onGone()
        return
      }
    }
    setConfirm(null)
    setDeleteFabric(false)
  }

  const needsRepair = health?.items.some((i) => i.repairable) ?? false
  const runnerNow = runnerInfo?.ok ? runnerSummary(runnerInfo) : null
  const healthTrouble = Boolean(health?.error) || (health?.items.some((i) => i.state === 'error' || i.state === 'unknown') ?? false)
  const repairFailed = repairTried && busy !== 'repair' && Boolean(problem || error)
  function diagnoseHealth(): void {
    setDiagnose({
      kind: 'health',
      workspaceId: ws.id,
      health: health?.items ?? [],
      problem: repairFailed ? (problem ?? undefined) : undefined,
      error: repairFailed ? (error ?? undefined) : health?.error
    })
  }
  const isMe = (who: string): boolean => Boolean(viewer && viewer.toLowerCase() === who.toLowerCase())
  /** The core names what each person can open in English: say it in the interface's language. */
  const accessName = (kind: string): string =>
    kind === 'published apps'
      ? t('workspace.access.published')
      : kind === 'previews'
        ? t('workspace.access.previews')
        : kind
  const tabs: { id: WorkspaceTab; label: string }[] = [
    { id: 'members', label: t('workspace.tabs.members') },
    ...(canManage ? [{ id: 'access' as const, label: t('workspace.tabs.access') }] : []),
    { id: 'settings', label: t('workspace.tabs.settings') }
  ]

  return (
    <aside className="tmap-side" aria-label={t('workspace.label')}>
      <button
        type="button"
        className="tmap-icon-btn tmap-inspector-close"
        onClick={onClose}
        aria-label={t('actions.close')}
        title={t('shared.backToDeployments')}
      >
        <Codicon name="close" />
      </button>
      <header className="tmap-insp-head">
        <span className="tmap-mark tmap-mark--hub">{(ws.name.trim()[0] ?? 'T').toUpperCase()}</span>
        <div className="tmap-titles">
          <span className="tmap-kicker">
            {t('workspace.kicker', { role: ws.role === 'owner' ? t('shared.owner') : t('shared.member') })}
          </span>
          <h3>{ws.name}</h3>
          <button type="button" className="tmap-link" onClick={() => void window.api.openExternal(`https://github.com/${ws.repo}`)}>
            {ws.repo} <Codicon name="link-external" />
          </button>
        </div>
      </header>

      <div className="tmap-tabs" role="tablist" aria-label={t('workspace.label')}>
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`tmap-tab${tab === item.id ? ' tmap-tab--active' : ''}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'members' && (
        <>
          <section className="tmap-insp-section">
            <h4>{t('workspace.members.title')}</h4>
            {!members ? (
              <p className="tmap-dim">
                <span className="tmap-spinner" /> {t('workspace.members.loading')}
              </p>
            ) : (
              <ul className="tmap-insp-list">
                {members.members.map((m) => (
                  <li key={`${m.login}-${m.invitationId ?? ''}`} className="tmap-insp-row">
                    <Avatar login={m.login} url={m.avatarUrl} size={24} />
                    <span className="tmap-insp-grow">
                      {m.login}
                      {isMe(m.login) && <span className="tmap-dim"> {t('workspace.members.you')}</span>}
                    </span>
                    {m.pending && <span className="tmap-chip tmap-chip--warn">{t('workspace.members.invited')}</span>}
                    <span className="tmap-chip">{m.role === 'owner' ? t('shared.owner') : t('shared.member')}</span>
                    {members.canManage && !isMe(m.login) ? (
                      <button
                        type="button"
                        className="tmap-icon-btn"
                        title={m.pending ? t('workspace.members.cancelInvite') : t('workspace.members.remove')}
                        aria-label={
                          m.pending
                            ? t('workspace.members.cancelInviteFor', { login: m.login })
                            : t('workspace.members.removeLogin', { login: m.login })
                        }
                        disabled={Boolean(busy)}
                        onClick={() => setConfirm({ kind: 'remove-member', login: m.login, invitationId: m.invitationId })}
                      >
                        <Codicon name="close" />
                      </button>
                    ) : (
                      members.canManage && <span className="tmap-icon-spacer" aria-hidden="true" />
                    )}
                  </li>
                ))}
                {members.members.length === 0 && <li className="tmap-dim">{members.error ?? t('workspace.members.none')}</li>}
              </ul>
            )}
          </section>

          {maintainer && (
            <section className="tmap-insp-section">
              <h4>{t('workspace.invite.title')}</h4>
              <p className="tmap-insp-text">{t('workspace.invite.maintainer', { repo: ws.repo })}</p>
            </section>
          )}

          {isAdmin && (
            <section className="tmap-insp-section">
              <h4>{t('workspace.invite.title')}</h4>
              <form
                className="tmap-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (login.trim() && !busy) void invite()
                }}
              >
                <label className="tmap-field">
                  <span>{t('workspace.invite.username')}</span>
                  <input
                    className="field-input"
                    value={login}
                    placeholder="octocat"
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) => setLogin(event.target.value)}
                  />
                </label>
                <label className="tmap-field">
                  <span>
                    {t('workspace.invite.email')} <span className="tmap-dim">{t('workspace.invite.optional')}</span>
                  </span>
                  <input
                    className="field-input"
                    value={email}
                    placeholder={t('workspace.invite.emailPlaceholder')}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) => setEmail(event.target.value)}
                  />
                  <span className="tmap-hint">{t('workspace.invite.emailHint')}</span>
                </label>
                <label className="tmap-check">
                  <input type="checkbox" checked={asOwner} onChange={(event) => setAsOwner(event.target.checked)} />
                  <span>
                    {t('shared.owner')}
                    <span className="tmap-hint">{t('workspace.invite.ownerHint')}</span>
                  </span>
                </label>
                <div>
                  <button type="submit" className="btn btn--sm btn--primary" disabled={!login.trim() || Boolean(busy)}>
                    {busy === 'invite' ? t('workspace.invite.sending') : t('workspace.invite.send')}
                  </button>
                </div>
              </form>
            </section>
          )}
        </>
      )}

      {tab === 'access' && (
        <section className="tmap-insp-section">
          <h4>{t('workspace.access.title')}</h4>
          <p className="tmap-insp-text">{t('workspace.access.intro')}</p>
          {!fabricPeople ? (
            <p className="tmap-dim">
              <span className="tmap-spinner" /> {t('workspace.access.checking')}
            </p>
          ) : fabricPeople.error ? (
            <p className="tmap-dim">{fabricPeople.error}</p>
          ) : (
            <ul className="tmap-insp-list">
              {fabricPeople.people.map((person) => (
                <li key={person.principalId} className="tmap-insp-row">
                  <Avatar login={person.name} size={24} />
                  <span className="tmap-insp-grow">
                    {person.name}
                    {person.email && person.email !== person.name && (
                      <span className="tmap-dim tmap-block tmap-ellipsis">{person.email}</span>
                    )}
                    <span className="tmap-dim tmap-block">
                      {t('workspace.access.canOpen', { targets: formatList(person.access.map(accessName)) })}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="tmap-icon-btn"
                    title={t('workspace.access.remove')}
                    aria-label={t('workspace.access.removeFor', { name: person.name })}
                    disabled={Boolean(busy)}
                    onClick={() => setConfirm({ kind: 'revoke-fabric', principalId: person.principalId, name: person.name })}
                  >
                    <Codicon name="close" />
                  </button>
                </li>
              ))}
              {fabricPeople.people.length === 0 && <li className="tmap-dim">{t('workspace.access.none')}</li>}
            </ul>
          )}
        </section>
      )}

      {tab === 'settings' && (
        <>
          <section className="tmap-insp-section">
            <h4>{t('workspace.settings.account')}</h4>
            {changingAccount ? (
              <>
                <GithubAccountField hideLabel value={newAccount} onChange={setNewAccount} onReady={setNewAccountReady} />
                <div className="tmap-insp-actions">
                  <button
                    type="button"
                    className="btn btn--sm btn--primary"
                    disabled={!newAccountReady || Boolean(busy) || sameAccount(newAccount, ws.account)}
                    onClick={() => void saveAccount()}
                  >
                    {busy === 'account' ? t('status.checking') : t('workspace.settings.useAccount')}
                  </button>
                  <button type="button" className="btn btn--sm btn--ghost" disabled={Boolean(busy)} onClick={() => setChangingAccount(false)}>
                    {t('actions.cancel')}
                  </button>
                </div>
              </>
            ) : (
              <ul className="tmap-insp-list">
                <li className="tmap-insp-row">
                  <Codicon name="github" />
                  <span className="tmap-insp-grow">
                    {ws.account ?? t('workspace.settings.cliAccount')}
                    <span className="tmap-dim tmap-block">
                      {ws.account ? t('workspace.settings.accountInUse') : t('workspace.settings.accountLater')}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={Boolean(busy)}
                    onClick={() => {
                      setNewAccount(ws.account ?? '')
                      setChangingAccount(true)
                    }}
                  >
                    {t('shared.change')}
                  </button>
                </li>
              </ul>
            )}
          </section>

          <section className="tmap-insp-section">
            <h4>{t('workspace.settings.publishing')}</h4>
            <label className="tmap-toggle">
              <span>
                {t('workspace.settings.requireReview')}
                <span className="tmap-hint">
                  {ws.setup?.protection === 'app' || !ws.setup
                    ? t('workspace.settings.reviewHintEnforced')
                    : t('workspace.settings.reviewHint')}
                </span>
              </span>
              <span className={`switch${requireReview ? ' switch--on' : ''}`}>
                <input
                  type="checkbox"
                  aria-label={t('workspace.settings.requireReviewLabel')}
                  checked={requireReview}
                  disabled={!canManage || Boolean(busy)}
                  onChange={(event) => void act('review', () => window.api.team.setRequireReview(ws.id, event.target.checked))}
                />
                <span className="switch-knob" />
              </span>
            </label>
          </section>

          <section className="tmap-insp-section">
            <h4>{t('workspace.settings.deploys')}</h4>
            <ul className="tmap-insp-list">
              {[
                { label: t('shared.publishedApps'), target: fabric?.production },
                { label: t('shared.previews'), target: fabric?.previews }
              ].map(({ label, target }) =>
                target?.id ? (
                  <li key={label} className="tmap-insp-row">
                    <FabricGlyph />
                    <span className="tmap-insp-grow">
                      {label}
                      <span className="tmap-dim tmap-block tmap-ellipsis">{target.name}</span>
                    </span>
                    <button
                      type="button"
                      className="tmap-icon-btn"
                      title={t('shared.openInFabric')}
                      aria-label={t('workspace.settings.openTarget', { label })}
                      onClick={() => void window.api.openExternal(fabricWorkspaceUrl(target.id))}
                    >
                      <Codicon name="link-external" />
                    </button>
                  </li>
                ) : null
              )}
            </ul>
          </section>

          {canManage && (
            <section className="tmap-insp-section">
              <h4>{t('workspace.settings.runs')}</h4>
              {changingRunner ? (
                <>
                  <RunnerFields
                    hideLabel
                    value={runnerChoice}
                    onChange={setRunnerChoice}
                    organization={runnerInfo?.organization?.runner}
                    disabled={Boolean(busy)}
                  />
                  <div className="tmap-insp-actions">
                    <button
                      type="button"
                      className="btn btn--sm btn--primary"
                      disabled={!runnerDraftReady(runnerChoice) || Boolean(busy)}
                      onClick={() => void saveRunner()}
                    >
                      {busy === 'runner' ? t('status.saving') : t('actions.save')}
                    </button>
                    <button type="button" className="btn btn--sm btn--ghost" disabled={Boolean(busy)} onClick={() => setChangingRunner(false)}>
                      {t('actions.cancel')}
                    </button>
                  </div>
                </>
              ) : !runnerInfo ? (
                <p className="tmap-dim">
                  <span className="tmap-spinner" /> {t('workspace.settings.checkingRunner')}
                </p>
              ) : !runnerNow ? (
                <p className="tmap-dim tmap-wrap">{runnerInfo.error}</p>
              ) : (
                <ul className="tmap-insp-list">
                  <li className="tmap-insp-row">
                    {runnerNow.invalid ? (
                      <span className="tmap-health tmap-health--failed">
                        <span className="tmap-health-dot" aria-hidden="true" />
                      </span>
                    ) : (
                      <Codicon name="server" />
                    )}
                    <span className="tmap-insp-grow tmap-wrap">
                      {runnerNow.title}
                      <span className="tmap-dim tmap-block">{runnerNow.detail}</span>
                    </span>
                    <button
                      type="button"
                      className="btn btn--sm"
                      disabled={Boolean(busy)}
                      onClick={() => {
                        setRunnerChoice(runnerDraft(runnerInfo.repository?.runner))
                        setChangingRunner(true)
                      }}
                    >
                      {t('shared.change')}
                    </button>
                  </li>
                </ul>
              )}
            </section>
          )}

          <section className="tmap-insp-section">
            <div className="tmap-section-head">
              <h4>{t('workspace.settings.health')}</h4>
              <button
                type="button"
                className="tmap-icon-btn"
                title={t('workspace.settings.checkAgain')}
                aria-label={t('workspace.settings.checkAgain')}
                disabled={Boolean(busy)}
                onClick={() => void loadHealth()}
              >
                <Codicon name="refresh" />
              </button>
            </div>
            {!health ? (
              <p className="tmap-dim">
                <span className="tmap-spinner" /> {t('workspace.settings.checkingHealth')}
              </p>
            ) : (
              <ul className="tmap-insp-list">
                {health.items.map((item) => (
                  <li key={item.id} className="tmap-insp-row tmap-insp-row--top">
                    <span className={`tmap-health tmap-health--${HEALTH_DOT[item.state]}`}>
                      <span className="tmap-health-dot" aria-hidden="true" />
                    </span>
                    <span className="tmap-insp-grow tmap-wrap">
                      {item.label}
                      {item.detail && <span className="tmap-dim tmap-block">{item.detail}</span>}
                    </span>
                  </li>
                ))}
                {health.error && <li className="tmap-dim">{health.error}</li>}
              </ul>
            )}
            {(canManage || healthTrouble || repairFailed) && (
              <div className="tmap-insp-actions">
                {canManage && (
                  <button type="button" className={`btn btn--sm${needsRepair ? ' btn--primary' : ''}`} disabled={Boolean(busy)} onClick={() => void repair()}>
                    {busy === 'repair'
                      ? t('workspace.settings.repairing')
                      : needsRepair
                        ? t('workspace.settings.repair')
                        : t('workspace.settings.checkPipeline')}
                  </button>
                )}
                {(healthTrouble || repairFailed) && (
                  <button type="button" className="btn btn--sm" disabled={busy === 'repair'} onClick={diagnoseHealth}>
                    <Codicon name="sparkle" /> {t('shared.diagnose')}
                  </button>
                )}
              </div>
            )}
            {busy === 'repair' && <StepList rows={repairRows} />}
          </section>

          <section className="tmap-insp-section">
            <h4>{t('workspace.settings.leaveTitle')}</h4>
            <p className="tmap-insp-text">
              {maintainer ? t('workspace.settings.leaveTextMaintainer') : t('workspace.settings.leaveText')}
            </p>
            <div className="tmap-insp-actions">
              <button type="button" className="btn btn--sm" disabled={Boolean(busy)} onClick={() => setConfirm({ kind: 'leave' })}>
                {t('workspace.settings.leave')}
              </button>
              {isAdmin && (
                <button type="button" className="btn btn--sm btn--danger" disabled={Boolean(busy)} onClick={() => setConfirm({ kind: 'delete' })}>
                  {t('workspace.settings.delete')}
                </button>
              )}
            </div>
          </section>
        </>
      )}

      {problem && <ProblemView problem={problem} />}
      {error && <div className="alert alert--error">{error}</div>}
      {notice && <div className="tmap-notice">{notice}</div>}
      {diagnose && <TeamDiagnosisModal input={diagnose} title={t('workspace.diagnose')} onClose={() => setDiagnose(null)} />}

      {confirm && (
        <ConfirmModal
          title={
            confirm.kind === 'remove-member'
              ? t('workspace.confirm.removeMember', { login: confirm.login })
              : confirm.kind === 'revoke-fabric'
                ? t('workspace.confirm.revoke', { name: confirm.name })
                : confirm.kind === 'leave'
                  ? t('workspace.confirm.leave', { name: ws.name })
                  : t('workspace.confirm.delete', { name: ws.name })
          }
          danger={confirm.kind !== 'leave'}
          busy={busy === 'confirm'}
          confirmLabel={
            confirm.kind === 'leave'
              ? t('workspace.confirm.leaveLabel')
              : confirm.kind === 'delete'
                ? t('workspace.confirm.deleteLabel')
                : t('actions.remove')
          }
          message={
            confirm.kind === 'remove-member' ? (
              <p>{t('workspace.confirm.removeMemberText')}</p>
            ) : confirm.kind === 'revoke-fabric' ? (
              <p>{t('workspace.confirm.revokeText')}</p>
            ) : confirm.kind === 'leave' ? (
              <p>{t('workspace.confirm.leaveText')}</p>
            ) : (
              <>
                <p>{t('workspace.confirm.deleteText')}</p>
                <label className="tmap-check">
                  <input type="checkbox" checked={deleteFabric} onChange={(event) => setDeleteFabric(event.target.checked)} />
                  <span>{t('workspace.confirm.deleteFabric')}</span>
                </label>
              </>
            )
          }
          onConfirm={() => void runConfirmed()}
          onCancel={() => {
            setConfirm(null)
            setDeleteFabric(false)
          }}
        />
      )}
    </aside>
  )
}
