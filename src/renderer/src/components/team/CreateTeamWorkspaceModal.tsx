import { useEffect, useId, useMemo, useState, type JSX } from 'react'
import type {
  FabricCapacity,
  TeamActionResult,
  TeamCreateRequest,
  TeamOwner,
  TeamProblem,
  TeamRepoChoice,
  TeamWorkspace
} from '@shared/ipc'
import { useSuppressPreview } from '../../overlay'
import { useModalFocus } from '../../modalFocus'
import {
  FieldLoading,
  FieldProblem,
  GithubAccountField,
  ProblemView,
  StepList,
  TeamPrerequisites,
  teamError,
  useStepProgress
} from './common'
import TeamDiagnosis from './diagnosis/TeamDiagnosis'
import type { DiagnosisInput } from './diagnosis/useTeamDiagnosis'
import RunnerFields, { draftRunner, runnerDraft, runnerDraftReady, type RunnerDraft } from './RunnerFields'

/** Mirrors SETUP_STEPS in src-tauri/src/commands/team/setup.rs. */
export const SETUP_STEPS = [
  { id: 'github', label: 'Create the private GitHub repository' },
  { id: 'fabric', label: 'Create the production and preview Fabric workspaces' },
  { id: 'identity', label: 'Create the deploy identities (service principals)' },
  { id: 'trust', label: "Let the repository's pipeline sign in as those identities" },
  { id: 'access', label: 'Give the deploy identities access to Fabric' },
  { id: 'files', label: 'Add the deploy pipeline to the repository' },
  { id: 'protection', label: 'Protect the main branch' },
  { id: 'clone', label: 'Download the workspace to this computer' },
  { id: 'verify', label: 'Check that the pipeline can reach Fabric' }
] as const

type Phase = 'prereq' | 'details' | 'running' | 'failed' | 'done'

const NO_CAPACITY =
  'You don’t have access to a Fabric capacity. Ask your Fabric administrator for one, then try again.'

/**
 * `owner/name` from a repository name or its GitHub address, or `null` when it
 * isn't one. Mirrors `naming::parse_repo` in src-tauri.
 */
export function parseRepo(input: string): string | null {
  let text = input.trim()
  for (const prefix of ['https://', 'http://', 'git@github.com:', 'www.', 'github.com/']) {
    if (text.toLowerCase().startsWith(prefix)) text = text.slice(prefix.length)
  }
  text = text.replace(/\/+$/, '')
  if (text.endsWith('.git')) text = text.slice(0, -4)
  const match = /^([A-Za-z0-9_][A-Za-z0-9_-]{0,38})\/([A-Za-z0-9._-]{1,100})$/.exec(text)
  if (!match || match[2] === '.' || match[2] === '..') return null
  return `${match[1]}/${match[2]}`
}

interface Props {
  /** Continue this workspace's interrupted setup instead of starting a new one. */
  resume?: TeamWorkspace
  onClose: () => void
  /** Setup finished (or progressed); the parent refreshes its list. */
  onChanged: (workspace?: TeamWorkspace) => void
  /** Give up on a failed setup: delete what it created instead. */
  onAbandon?: (workspace: TeamWorkspace) => void
}

/** Sets up a team workspace automatically, step by step. */
export default function CreateTeamWorkspaceModal({ resume, onClose, onChanged, onAbandon }: Props): JSX.Element {
  useSuppressPreview()
  const titleId = useId()
  const ownerFieldId = useId()
  const repoModeId = useId()
  const repoFieldId = useId()
  const repoListId = useId()
  const capacityFieldId = useId()
  const dialogRef = useModalFocus<HTMLDivElement>()
  const scope = useMemo(() => `team-setup-${crypto.randomUUID()}`, [])
  const [phase, setPhase] = useState<Phase>('prereq')
  const [name, setName] = useState(resume?.name ?? '')
  /** The GitHub account the workspace is set up as (empty until the accounts load). */
  const [account, setAccount] = useState('')
  const [accountReady, setAccountReady] = useState(false)
  /** `null` while loading. */
  const [owners, setOwners] = useState<TeamOwner[] | null>(null)
  const [ownersError, setOwnersError] = useState<string | null>(null)
  const [owner, setOwner] = useState('')
  /** `null` while loading. */
  const [capacities, setCapacities] = useState<FabricCapacity[] | null>(null)
  const [capacitiesError, setCapacitiesError] = useState<string | null>(null)
  const [capacityId, setCapacityId] = useState('')
  const [clientId, setClientId] = useState('')
  /** Create a repository, or set the workspace up in one that exists. */
  const [repoMode, setRepoMode] = useState<'new' | 'existing'>('new')
  /** The existing repository (`owner/name` or its address). */
  const [existingRepo, setExistingRepo] = useState('')
  /** Suggestions for it; `null` while loading. */
  const [repoChoices, setRepoChoices] = useState<TeamRepoChoice[] | null>(null)
  const [repoChoicesError, setRepoChoicesError] = useState<string | null>(null)
  /** Where the pipeline runs: GitHub-hosted runners unless the owner picks the organization's own. */
  const [runner, setRunner] = useState<RunnerDraft>(() => runnerDraft(resume?.setup?.request.runner))
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [problem, setProblem] = useState<TeamProblem | null>(null)
  const [workspace, setWorkspace] = useState<TeamWorkspace | undefined>(resume)
  const [rows, setRows] = useStepProgress(SETUP_STEPS, scope)
  const running = phase === 'running'

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !running) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [running, onClose])

  // Owners (GitHub) and capacities (Fabric) load separately, so each picker
  // appears as soon as its own answer arrives. Owners follow the GitHub account.
  async function loadOwners(): Promise<void> {
    setOwners(null)
    setOwnersError(null)
    let list: TeamOwner[] = []
    try {
      const result = await window.api.team.owners(account || undefined)
      list = result.owners
      if (!result.ok || list.length === 0) {
        setOwnersError(result.error ?? 'Fabricator couldn’t find your GitHub account.')
      }
    } catch (reason) {
      setOwnersError(teamError(reason, 'Could not list your GitHub accounts.'))
    }
    setOwners(list)
    setOwner((current) => (list.some((o) => o.login === current) ? current : (list[0]?.login ?? '')))
  }

  useEffect(() => {
    if (phase === 'details' && account && accountReady) void loadOwners()
  }, [phase, account, accountReady])

  // Suggestions for an existing repository; any repository can still be entered.
  async function loadRepoChoices(): Promise<void> {
    setRepoChoices(null)
    setRepoChoicesError(null)
    let list: TeamRepoChoice[] = []
    try {
      const result = await window.api.team.repos(account || undefined)
      list = result.repos
      if (!result.ok) setRepoChoicesError(result.error ?? 'Could not list your repositories.')
    } catch (reason) {
      setRepoChoicesError(teamError(reason, 'Could not list your repositories.'))
    }
    setRepoChoices(list)
  }

  useEffect(() => {
    if (phase === 'details' && repoMode === 'existing' && account && accountReady) void loadRepoChoices()
  }, [phase, repoMode, account, accountReady])

  async function loadCapacities(): Promise<void> {
    setCapacities(null)
    setCapacitiesError(null)
    let list: FabricCapacity[] = []
    try {
      const result = await window.api.team.capacities()
      list = result.capacities ?? []
      if (!result.ok) setCapacitiesError(result.error ?? 'Could not list Fabric capacities.')
    } catch (reason) {
      setCapacitiesError(teamError(reason, 'Could not list Fabric capacities.'))
    }
    setCapacities(list)
    setCapacityId((current) => (list.some((c) => c.id === current) ? current : (list[0]?.id ?? '')))
  }

  function onPrereqsReady(): void {
    if (phase !== 'prereq') return
    if (resume) {
      void run(true)
      return
    }
    setPhase('details')
    void loadCapacities()
  }

  /** Mark steps a previous attempt already finished. */
  function seedCompleted(completed: string[]): void {
    setRows(
      SETUP_STEPS.map((s) => ({
        id: s.id,
        label: s.label,
        state: completed.includes(s.id) ? 'done' : 'pending'
      }))
    )
  }

  /** What the owner entered so far. */
  function currentRequest(): TeamCreateRequest {
    const capacity = capacities?.find((c) => c.id === capacityId)
    // An existing repository decides the owner.
    const owning = repo ? repo.split('/')[0] : owner
    const known = owners?.find((o) => o.login.toLowerCase() === owning.toLowerCase())
    return {
      name: name.trim(),
      owner: owning,
      ownerIsOrg: known ? known.isOrg : Boolean(repo) && owning.toLowerCase() !== account.toLowerCase(),
      capacityId,
      capacityName: capacity?.displayName,
      existingClientId: clientId.trim() || undefined,
      account: account || undefined,
      runner: runner.kind === 'hosted' ? undefined : draftRunner(runner),
      existingRepo: repo ?? undefined
    }
  }

  /** Retry after no runner ran the pipeline: save the runners chosen since, then continue. */
  async function retryWithRunner(): Promise<void> {
    const target = workspace ?? resume
    if (!target) return
    let error: string | undefined
    try {
      const saved = await window.api.team.setRunner(target.id, draftRunner(runner))
      if (!saved.ok) error = saved.error ?? 'Could not save where the pipeline runs.'
      else if (saved.workspace) setWorkspace(saved.workspace)
    } catch (reason) {
      error = teamError(reason, 'Could not save where the pipeline runs.')
    }
    if (error) {
      setProblem({ step: 'verify', kind: 'runner', message: error })
      return
    }
    await run(true)
  }

  async function run(isResume: boolean): Promise<void> {
    setProblem(null)
    setPhase('running')
    const target = workspace ?? resume
    seedCompleted(isResume ? (target?.setup?.completed ?? []) : [])
    let result: TeamActionResult
    try {
      if (isResume && target) {
        result = await window.api.team.resumeSetup(target.id, scope, clientId.trim() || undefined)
      } else {
        result = await window.api.team.create(currentRequest(), scope)
      }
    } catch (reason) {
      result = { ok: false, error: teamError(reason, 'Setup stopped unexpectedly.') }
    }
    if (result.workspace) setWorkspace(result.workspace)
    onChanged(result.workspace)
    if (result.ok) {
      setPhase('done')
      return
    }
    const next = result.problem ?? { step: 'setup', message: result.error ?? 'Setup stopped.' }
    setProblem(next)
    setPhase(result.workspace ? 'failed' : 'details')
  }

  const usingExisting = repoMode === 'existing'
  const repoText = usingExisting ? existingRepo.trim() : ''
  const repo = repoText ? parseRepo(repoText) : null
  const chosenOwner = owners?.find((o) => o.login === owner)
  /** The chosen organization doesn't let you create repositories (so setup can't). */
  const ownerLocked = !usingExisting && chosenOwner?.canCreate === false
  const canCreate =
    phase === 'details' &&
    Boolean(name.trim() && account && accountReady && capacityId) &&
    runnerDraftReady(runner) &&
    (usingExisting ? Boolean(repo) : Boolean(owner) && !ownerLocked)
  const identityProblem = problem && ['identity', 'trust'].includes(problem.step)
  const runnerProblem = problem?.kind === 'runner'
  // A picker that couldn't load is also worth diagnosing (locked-down tenants often stop there).
  const pickerProblem =
    !usingExisting && owners !== null && ownersError
      ? { step: 'github', error: ownersError }
      : capacities !== null && capacitiesError
        ? { step: 'fabric', error: capacitiesError }
        : capacities !== null && capacities.length === 0
          ? { step: 'fabric', error: NO_CAPACITY }
          : null
  const diagnosis: DiagnosisInput | null =
    phase === 'failed' && problem
      ? { kind: 'setup', workspaceId: (workspace ?? resume)?.id, problem }
      : phase === 'details' && problem
        ? { kind: 'setup', problem, request: currentRequest() }
        : phase === 'details' && pickerProblem
          ? { kind: 'setup', step: pickerProblem.step, error: pickerProblem.error, request: currentRequest() }
          : null
  const diagnosisKey = `${phase}|${problem?.step ?? ''}|${problem?.message ?? ''}|${pickerProblem?.error ?? ''}`

  return (
    <div className="modal-backdrop" onClick={running ? undefined : onClose}>
      <div
        className="modal team-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={titleId}>{resume ? `Finish setting up ${resume.name}` : 'Create a team workspace'}</h2>
        </div>
        <div className="modal-body team-form">
          {phase === 'prereq' && (
            <>
              <p className="team-muted">
                A team workspace keeps your team&apos;s apps in a private GitHub repository. Each person
                works on their own copy, and a pipeline publishes the apps to Microsoft Fabric with
                a deploy identity that Fabricator creates for you.
              </p>
              <TeamPrerequisites
                onReady={onPrereqsReady}
                account={resume?.account}
                requireAccount={Boolean(resume)}
              />
            </>
          )}

          {phase === 'details' && (
            <>
              <label className="field">
                <span className="field-label">Workspace name</span>
                <input
                  className="field-input"
                  value={name}
                  autoFocus
                  placeholder="Sales team apps"
                  spellCheck={false}
                  onChange={(event) => setName(event.target.value)}
                />
                <span className="field-hint">
                  Used for the GitHub repository and the Fabric workspaces.
                </span>
              </label>
              <GithubAccountField
                value={account}
                onChange={setAccount}
                onReady={setAccountReady}
                hint="Fabricator always uses this account for the workspace, whichever account the GitHub CLI has active."
              />
              <div className="field">
                <span className="field-label" id={repoModeId}>
                  GitHub repository
                </span>
                <div className="seg team-repo-mode" role="radiogroup" aria-labelledby={repoModeId}>
                  {(['new', 'existing'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      role="radio"
                      aria-checked={repoMode === mode}
                      className={`seg-btn${repoMode === mode ? ' seg-btn--active' : ''}`}
                      onClick={() => setRepoMode(mode)}
                    >
                      {mode === 'new' ? 'New repository' : 'Existing repository'}
                    </button>
                  ))}
                </div>
              </div>
              {usingExisting ? (
                <div className="field">
                  <label className="field-label" htmlFor={repoFieldId}>
                    Repository
                  </label>
                  <input
                    id={repoFieldId}
                    className="field-input"
                    list={repoListId}
                    value={existingRepo}
                    placeholder="owner/repository"
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) => setExistingRepo(event.target.value)}
                  />
                  <datalist id={repoListId}>
                    {(repoChoices ?? []).map((r) => (
                      <option key={r.fullName} value={r.fullName}>
                        {r.description ?? ''}
                      </option>
                    ))}
                  </datalist>
                  {repoText && !repo ? (
                    <FieldProblem text="Enter the repository as owner/name, for example contoso/sales-apps, or paste its GitHub address." />
                  ) : (
                    repoChoicesError && <FieldProblem text={repoChoicesError} onRetry={() => void loadRepoChoices()} />
                  )}
                  <span className="field-hint">
                    {repoChoices && repoChoices.length > 0
                      ? 'Choose one of your repositories, or enter owner/name. '
                      : 'Enter owner/name, or paste the repository’s GitHub address. '}
                    It must be private or internal, and you need the Maintain or Admin role on it. If
                    you can&apos;t create one, an owner of your organization can create it for you.
                  </span>
                </div>
              ) : (
                <div className="field">
                  <label className="field-label" htmlFor={ownerFieldId}>
                    GitHub owner
                  </label>
                  {!accountReady ? (
                    <select id={ownerFieldId} className="field-input" disabled>
                      <option>Choose a GitHub account first</option>
                    </select>
                  ) : owners === null ? (
                    <FieldLoading text={`Finding where ${account} can create repositories…`} />
                  ) : (
                    owners.length > 0 && (
                      <select
                        id={ownerFieldId}
                        className="field-input"
                        value={owner}
                        onChange={(event) => setOwner(event.target.value)}
                      >
                        {owners.map((o) => (
                          <option key={o.login} value={o.login}>
                            {o.login}
                            {!o.isOrg ? ' (you)' : o.canCreate === false ? ' (organization · you can’t create repositories)' : ' (organization)'}
                          </option>
                        ))}
                      </select>
                    )
                  )}
                  {owners !== null && ownersError && (
                    <FieldProblem text={ownersError} onRetry={() => void loadOwners()} />
                  )}
                  {ownerLocked && (
                    <FieldProblem
                      text={`${owner} doesn’t let you create repositories. Ask one of its owners to create an empty private repository for the workspace and give you the Maintain role, then use it as an existing repository.`}
                      action="Use an existing repository"
                      onRetry={() => setRepoMode('existing')}
                    />
                  )}
                  <span className="field-hint">
                    Fabricator creates a private repository. Use an organization if your team already has one.
                  </span>
                </div>
              )}
              <div className="field">
                <label className="field-label" htmlFor={capacityFieldId}>
                  Fabric capacity
                </label>
                {capacities === null ? (
                  <FieldLoading text="Finding the Fabric capacities you can use…" />
                ) : capacities.length > 0 ? (
                  <select
                    id={capacityFieldId}
                    className="field-input"
                    value={capacityId}
                    onChange={(event) => setCapacityId(event.target.value)}
                  >
                    {capacities.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.displayName}
                        {c.sku ? ` · ${c.sku}` : ''}
                        {c.region ? ` · ${c.region}` : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  !capacitiesError && <FieldProblem text={NO_CAPACITY} onRetry={() => void loadCapacities()} />
                )}
                {capacities !== null && capacitiesError && (
                  <FieldProblem text={capacitiesError} onRetry={() => void loadCapacities()} />
                )}
                <span className="field-hint">
                  Fabricator creates two Fabric workspaces on it: one for published apps and one
                  for everyone&apos;s previews.
                </span>
              </div>
              <button
                type="button"
                className="link-btn"
                onClick={() => setShowAdvanced((v) => !v)}
                aria-expanded={showAdvanced}
              >
                {showAdvanced ? 'Hide advanced options' : 'Advanced options'}
              </button>
              {showAdvanced && (
                <>
                  <label className="field">
                    <span className="field-label">Existing app registration (optional)</span>
                    <input
                      className="field-input"
                      value={clientId}
                      placeholder="Application (client) ID"
                      spellCheck={false}
                      onChange={(event) => setClientId(event.target.value)}
                    />
                    <span className="field-hint">
                      Use one an administrator created if your organization doesn&apos;t let you
                      register apps. Fabricator adds the pipeline&apos;s sign-in to it.
                    </span>
                  </label>
                  <RunnerFields value={runner} onChange={setRunner} />
                </>
              )}
              {problem && <ProblemView problem={problem} account={account} />}
            </>
          )}

          {(phase === 'running' || phase === 'failed' || phase === 'done') && (
            <>
              <StepList rows={rows} />
              {phase === 'running' && (
                <p className="team-muted">
                  This takes a few minutes. You can keep this window open while Fabricator works.
                </p>
              )}
              {phase === 'failed' && problem && (
                <ProblemView problem={problem} account={(workspace ?? resume)?.account ?? account} />
              )}
              {phase === 'failed' && identityProblem && (
                <label className="field">
                  <span className="field-label">App registration from your administrator</span>
                  <input
                    className="field-input"
                    value={clientId}
                    placeholder="Application (client) ID"
                    spellCheck={false}
                    onChange={(event) => setClientId(event.target.value)}
                  />
                </label>
              )}
              {phase === 'failed' && runnerProblem && <RunnerFields value={runner} onChange={setRunner} />}
              {phase === 'done' && (
                <div className="team-notice">
                  <span className="team-notice-text">
                    <strong>{workspace?.name ?? name}</strong> is ready. Create an app in it, or
                    invite your teammates from its settings.
                    {workspace?.setup?.protection === 'app' &&
                      " GitHub doesn't protect its main branch, so Fabricator keeps everyone on the publish flow."}
                  </span>
                </div>
              )}
            </>
          )}
          {diagnosis && <TeamDiagnosis input={diagnosis} resetKey={diagnosisKey} />}
        </div>
        <div className="modal-footer">
          {phase === 'failed' && onAbandon && (workspace ?? resume) && (
            <button
              type="button"
              className="btn btn--ghost team-footer-start"
              onClick={() => onAbandon((workspace ?? resume)!)}
            >
              Abandon setup…
            </button>
          )}
          {phase === 'running' ? (
            <button type="button" className="btn btn--ghost" onClick={() => void window.api.team.cancel(scope)}>
              Stop waiting
            </button>
          ) : (
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              {phase === 'done' ? 'Done' : 'Cancel'}
            </button>
          )}
          {phase === 'details' && (
            <button
              type="button"
              className="btn btn--primary"
              disabled={!canCreate}
              onClick={() => void run(false)}
            >
              Create workspace
            </button>
          )}
          {phase === 'failed' && (
            <button
              type="button"
              className="btn btn--primary"
              disabled={runnerProblem && !runnerDraftReady(runner)}
              onClick={() => void (runnerProblem ? retryWithRunner() : run(true))}
            >
              Retry
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
