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
import ConfirmModal from '../../ConfirmModal'
import { Codicon } from '../../icons'
import { GithubAccountField, ProblemView, StepList, teamError, useStepProgress } from '../common'
import TeamDiagnosisModal from '../diagnosis/TeamDiagnosisModal'
import type { DiagnosisInput } from '../diagnosis/useTeamDiagnosis'
import RunnerFields, { draftRunner, runnerDraft, runnerDraftReady, runnerSummary, type RunnerDraft } from '../RunnerFields'
import { Avatar, FabricGlyph, fabricWorkspaceUrl } from './parts'

export type WorkspaceTab = 'members' | 'access' | 'settings'

const VERIFY_STEPS = [{ id: 'verify', label: 'Check that the pipeline can reach Fabric' }] as const

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
  const [repairRows, setRepairRows] = useStepProgress(VERIFY_STEPS, repairScope)
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
      setMembers({ ok: false, error: teamError(reason, 'Could not load members.'), members: [], canManage: false })
    }
  }

  async function loadFabricPeople(): Promise<void> {
    setFabricPeople(null)
    try {
      setFabricPeople(await window.api.team.fabricAccess(ws.id))
    } catch (reason) {
      setFabricPeople({ ok: false, error: teamError(reason, 'Could not check Fabric access.'), people: [] })
    }
  }

  async function loadHealth(): Promise<void> {
    setHealth(null)
    try {
      setHealth(await window.api.team.health(ws.id))
    } catch (reason) {
      setHealth({ ok: false, error: teamError(reason, 'Could not check the workspace.'), items: [] })
    }
  }

  async function loadRunner(): Promise<void> {
    setRunnerInfo(null)
    try {
      setRunnerInfo(await window.api.team.runner(ws.id))
    } catch (reason) {
      setRunnerInfo({ ok: false, error: teamError(reason, 'Could not check where the pipeline runs.') })
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
        else setError(result.error ?? 'That didn’t work.')
        return false
      }
      // Partial success: the main action worked but a follow-up didn't.
      if (result.error) setError(result.error)
      else if (success) setNotice(success)
      await after?.()
      onChanged()
      return true
    } catch (reason) {
      setError(teamError(reason, 'That didn’t work.'))
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
      `Invited ${who}. They can accept from Fabricator's Home or on GitHub.`
    )
    if (ok) {
      setLogin('')
      setEmail('')
      setAsOwner(false)
    }
  }

  async function repair(): Promise<void> {
    setRepairRows(VERIFY_STEPS.map((s) => ({ id: s.id, label: s.label, state: 'pending' })))
    await act('repair', () => window.api.team.repair(ws.id, repairScope), loadHealth, 'The workspace is healthy.')
  }

  async function saveAccount(): Promise<void> {
    const login = newAccount
    const ok = await act(
      'account',
      () => window.api.team.setAccount(ws.id, login),
      loadMembers,
      `Fabricator now works on this workspace as ${login}.`
    )
    if (ok) setChangingAccount(false)
  }

  async function saveRunner(): Promise<void> {
    const ok = await act(
      'runner',
      () => window.api.team.setRunner(ws.id, draftRunner(runnerChoice)),
      loadRunner,
      'Pipeline runs that start from now on use these runners.'
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
        `${current.name} can no longer open the team's apps.`
      )
    } else if (current.kind === 'leave') {
      setBusy('confirm')
      try {
        await window.api.team.leave(ws.id)
        setConfirm(null)
        onGone()
        return
      } catch (reason) {
        setError(teamError(reason, 'Could not leave the workspace.'))
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
  const tabs: { id: WorkspaceTab; label: string }[] = [
    { id: 'members', label: 'Members' },
    ...(canManage ? [{ id: 'access' as const, label: 'App access' }] : []),
    { id: 'settings', label: 'Settings' }
  ]

  return (
    <aside className="tmap-side" aria-label="Workspace">
      <button type="button" className="tmap-icon-btn tmap-inspector-close" onClick={onClose} aria-label="Close" title="Back to deployments">
        <Codicon name="close" />
      </button>
      <header className="tmap-insp-head">
        <span className="tmap-mark tmap-mark--hub">{(ws.name.trim()[0] ?? 'T').toUpperCase()}</span>
        <div className="tmap-titles">
          <span className="tmap-kicker">Team workspace · {ws.role === 'owner' ? 'Owner' : 'Member'}</span>
          <h3>{ws.name}</h3>
          <button type="button" className="tmap-link" onClick={() => void window.api.openExternal(`https://github.com/${ws.repo}`)}>
            {ws.repo} <Codicon name="link-external" />
          </button>
        </div>
      </header>

      <div className="tmap-tabs" role="tablist" aria-label="Workspace">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`tmap-tab${tab === t.id ? ' tmap-tab--active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'members' && (
        <>
          <section className="tmap-insp-section">
            <h4>People</h4>
            {!members ? (
              <p className="tmap-dim">
                <span className="tmap-spinner" /> Loading members…
              </p>
            ) : (
              <ul className="tmap-insp-list">
                {members.members.map((m) => (
                  <li key={`${m.login}-${m.invitationId ?? ''}`} className="tmap-insp-row">
                    <Avatar login={m.login} url={m.avatarUrl} size={24} />
                    <span className="tmap-insp-grow">
                      {m.login}
                      {isMe(m.login) && <span className="tmap-dim"> (you)</span>}
                    </span>
                    {m.pending && <span className="tmap-chip tmap-chip--warn">Invited</span>}
                    <span className="tmap-chip">{m.role === 'owner' ? 'Owner' : 'Member'}</span>
                    {members.canManage && !isMe(m.login) ? (
                      <button
                        type="button"
                        className="tmap-icon-btn"
                        title={m.pending ? 'Cancel the invitation' : 'Remove from the workspace'}
                        aria-label={m.pending ? `Cancel ${m.login}'s invitation` : `Remove ${m.login}`}
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
                {members.members.length === 0 && <li className="tmap-dim">{members.error ?? 'No members found.'}</li>}
              </ul>
            )}
          </section>

          {maintainer && (
            <section className="tmap-insp-section">
              <h4>Invite a teammate</h4>
              <p className="tmap-insp-text">
                GitHub only lets admins of {ws.repo} add or remove people, and you have the Maintain role. Ask one of
                its admins to add your teammates with the Write role.
              </p>
            </section>
          )}

          {isAdmin && (
            <section className="tmap-insp-section">
              <h4>Invite a teammate</h4>
              <form
                className="tmap-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (login.trim() && !busy) void invite()
                }}
              >
                <label className="tmap-field">
                  <span>GitHub username</span>
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
                    Work email <span className="tmap-dim">(optional)</span>
                  </span>
                  <input
                    className="field-input"
                    value={email}
                    placeholder="name@company.com"
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) => setEmail(event.target.value)}
                  />
                  <span className="tmap-hint">Lets them open previews and published apps in Fabric.</span>
                </label>
                <label className="tmap-check">
                  <input type="checkbox" checked={asOwner} onChange={(event) => setAsOwner(event.target.checked)} />
                  <span>
                    Owner
                    <span className="tmap-hint">Can manage members and settings.</span>
                  </span>
                </label>
                <div>
                  <button type="submit" className="btn btn--sm btn--primary" disabled={!login.trim() || Boolean(busy)}>
                    {busy === 'invite' ? 'Inviting…' : 'Send invitation'}
                  </button>
                </div>
              </form>
            </section>
          )}
        </>
      )}

      {tab === 'access' && (
        <section className="tmap-insp-section">
          <h4>Who can open the apps</h4>
          <p className="tmap-insp-text">
            People with access to the workspace&apos;s Fabric workspaces can sign in to its previews and published apps.
            Invite a teammate with their work email to add them.
          </p>
          {!fabricPeople ? (
            <p className="tmap-dim">
              <span className="tmap-spinner" /> Checking Fabric…
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
                    <span className="tmap-dim tmap-block">Can open {person.access.join(' and ')}</span>
                  </span>
                  <button
                    type="button"
                    className="tmap-icon-btn"
                    title="Remove their access to the apps"
                    aria-label={`Remove ${person.name}'s access`}
                    disabled={Boolean(busy)}
                    onClick={() => setConfirm({ kind: 'revoke-fabric', principalId: person.principalId, name: person.name })}
                  >
                    <Codicon name="close" />
                  </button>
                </li>
              ))}
              {fabricPeople.people.length === 0 && <li className="tmap-dim">Nobody yet besides the workspace&apos;s admins.</li>}
            </ul>
          )}
        </section>
      )}

      {tab === 'settings' && (
        <>
          <section className="tmap-insp-section">
            <h4>GitHub account</h4>
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
                    {busy === 'account' ? 'Checking…' : 'Use this account'}
                  </button>
                  <button type="button" className="btn btn--sm btn--ghost" disabled={Boolean(busy)} onClick={() => setChangingAccount(false)}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <ul className="tmap-insp-list">
                <li className="tmap-insp-row">
                  <Codicon name="github" />
                  <span className="tmap-insp-grow">
                    {ws.account ?? 'The GitHub CLI’s active account'}
                    <span className="tmap-dim tmap-block">
                      {ws.account
                        ? 'Fabricator works on this workspace as this account.'
                        : 'Fabricator remembers the account once it reads the workspace.'}
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
                    Change
                  </button>
                </li>
              </ul>
            )}
          </section>

          <section className="tmap-insp-section">
            <h4>Publishing</h4>
            <label className="tmap-toggle">
              <span>
                Require a review
                <span className="tmap-hint">
                  A teammate approves each change before it&apos;s published.
                  {ws.setup?.protection === 'app' || !ws.setup ? ' Where GitHub doesn’t protect main, Fabricator enforces this.' : ''}
                </span>
              </span>
              <span className={`switch${requireReview ? ' switch--on' : ''}`}>
                <input
                  type="checkbox"
                  aria-label="Require a review before publishing"
                  checked={requireReview}
                  disabled={!canManage || Boolean(busy)}
                  onChange={(event) => void act('review', () => window.api.team.setRequireReview(ws.id, event.target.checked))}
                />
                <span className="switch-knob" />
              </span>
            </label>
          </section>

          <section className="tmap-insp-section">
            <h4>Where apps deploy</h4>
            <ul className="tmap-insp-list">
              {[
                { label: 'Published apps', target: fabric?.production },
                { label: 'Previews', target: fabric?.previews }
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
                      title="Open in Fabric"
                      aria-label={`Open ${label} in Fabric`}
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
              <h4>Where the pipeline runs</h4>
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
                      {busy === 'runner' ? 'Saving…' : 'Save'}
                    </button>
                    <button type="button" className="btn btn--sm btn--ghost" disabled={Boolean(busy)} onClick={() => setChangingRunner(false)}>
                      Cancel
                    </button>
                  </div>
                </>
              ) : !runnerInfo ? (
                <p className="tmap-dim">
                  <span className="tmap-spinner" /> Checking where the pipeline runs…
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
                      Change
                    </button>
                  </li>
                </ul>
              )}
            </section>
          )}

          <section className="tmap-insp-section">
            <div className="tmap-section-head">
              <h4>Pipeline health</h4>
              <button type="button" className="tmap-icon-btn" title="Check again" aria-label="Check again" disabled={Boolean(busy)} onClick={() => void loadHealth()}>
                <Codicon name="refresh" />
              </button>
            </div>
            {!health ? (
              <p className="tmap-dim">
                <span className="tmap-spinner" /> Checking the workspace…
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
                    {busy === 'repair' ? 'Repairing…' : needsRepair ? 'Repair' : 'Check the pipeline'}
                  </button>
                )}
                {(healthTrouble || repairFailed) && (
                  <button type="button" className="btn btn--sm" disabled={busy === 'repair'} onClick={diagnoseHealth}>
                    <Codicon name="sparkle" /> Diagnose with Copilot
                  </button>
                )}
              </div>
            )}
            {busy === 'repair' && <StepList rows={repairRows} />}
          </section>

          <section className="tmap-insp-section">
            <h4>Leave or delete</h4>
            <p className="tmap-insp-text">
              Leaving removes the workspace from this computer. Published apps and work saved to GitHub stay.
              {maintainer && ' Deleting the workspace archives its repository, which GitHub only lets its admins do.'}
            </p>
            <div className="tmap-insp-actions">
              <button type="button" className="btn btn--sm" disabled={Boolean(busy)} onClick={() => setConfirm({ kind: 'leave' })}>
                Leave on this computer
              </button>
              {isAdmin && (
                <button type="button" className="btn btn--sm btn--danger" disabled={Boolean(busy)} onClick={() => setConfirm({ kind: 'delete' })}>
                  Delete workspace…
                </button>
              )}
            </div>
          </section>
        </>
      )}

      {problem && <ProblemView problem={problem} />}
      {error && <div className="alert alert--error">{error}</div>}
      {notice && <div className="tmap-notice">{notice}</div>}
      {diagnose && <TeamDiagnosisModal input={diagnose} title="Diagnose the workspace" onClose={() => setDiagnose(null)} />}

      {confirm && (
        <ConfirmModal
          title={
            confirm.kind === 'remove-member'
              ? `Remove ${confirm.login}?`
              : confirm.kind === 'revoke-fabric'
                ? `Remove ${confirm.name}'s access?`
                : confirm.kind === 'leave'
                  ? `Leave ${ws.name}?`
                  : `Delete ${ws.name}?`
          }
          danger={confirm.kind !== 'leave'}
          busy={busy === 'confirm'}
          confirmLabel={confirm.kind === 'leave' ? 'Leave' : confirm.kind === 'delete' ? 'Delete workspace' : 'Remove'}
          message={
            confirm.kind === 'remove-member' ? (
              <p>
                They lose access to the repository, and to the team&apos;s apps in Fabric if you gave it to them from
                this computer. Their unpublished changes stay on GitHub.
              </p>
            ) : confirm.kind === 'revoke-fabric' ? (
              <p>They can no longer open the team&apos;s published apps or previews in Fabric.</p>
            ) : confirm.kind === 'leave' ? (
              <p>The workspace and its apps are removed from this computer. Nothing changes for your teammates.</p>
            ) : (
              <>
                <p>
                  Fabricator deletes the deploy identities it created, archives the GitHub repository (an owner can
                  restore it on GitHub), and removes the workspace from this computer.
                </p>
                <label className="tmap-check">
                  <input type="checkbox" checked={deleteFabric} onChange={(event) => setDeleteFabric(event.target.checked)} />
                  <span>Also delete both Fabric workspaces and every app in them, with their data</span>
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
