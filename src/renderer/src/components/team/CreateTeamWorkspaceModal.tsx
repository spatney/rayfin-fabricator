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
import { Trans, useTranslation } from '../../i18n'
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
  { id: 'github', labelKey: 'create.step.github' },
  { id: 'fabric', labelKey: 'create.step.fabric' },
  { id: 'identity', labelKey: 'create.step.identity' },
  { id: 'trust', labelKey: 'create.step.trust' },
  { id: 'access', labelKey: 'create.step.access' },
  { id: 'files', labelKey: 'create.step.files' },
  { id: 'protection', labelKey: 'create.step.protection' },
  { id: 'clone', labelKey: 'create.step.clone' },
  { id: 'verify', labelKey: 'create.step.verify' }
] as const

type Phase = 'prereq' | 'details' | 'running' | 'failed' | 'done'

// Copilot's diagnosis reads this in English; the field shows create.noCapacity.
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
  const { t } = useTranslation('team')
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
  const setupSteps = useMemo(() => SETUP_STEPS.map((s) => ({ id: s.id, label: t(s.labelKey) })), [t])
  const [rows, setRows] = useStepProgress(setupSteps, scope)
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
        setOwnersError(result.error ?? t('create.noAccount'))
      }
    } catch (reason) {
      setOwnersError(teamError(reason, t('create.ownersFailed')))
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
      if (!result.ok) setRepoChoicesError(result.error ?? t('create.reposFailed'))
    } catch (reason) {
      setRepoChoicesError(teamError(reason, t('create.reposFailed')))
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
      if (!result.ok) setCapacitiesError(result.error ?? t('create.capacitiesFailed'))
    } catch (reason) {
      setCapacitiesError(teamError(reason, t('create.capacitiesFailed')))
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
        label: t(s.labelKey),
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
      if (!saved.ok) error = saved.error ?? t('create.runnerFailed')
      else if (saved.workspace) setWorkspace(saved.workspace)
    } catch (reason) {
      error = teamError(reason, t('create.runnerFailed'))
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
      result = { ok: false, error: teamError(reason, t('create.stoppedUnexpectedly')) }
    }
    if (result.workspace) setWorkspace(result.workspace)
    onChanged(result.workspace)
    if (result.ok) {
      setPhase('done')
      return
    }
    const next = result.problem ?? { step: 'setup', message: result.error ?? t('create.stopped') }
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
          <h2 id={titleId}>
            {resume ? t('create.titleResume', { name: resume.name }) : t('shared.createTeamWorkspace')}
          </h2>
        </div>
        <div className="modal-body team-form">
          {phase === 'prereq' && (
            <>
              <p className="team-muted">{t('create.intro')}</p>
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
                <span className="field-label">{t('create.name')}</span>
                <input
                  className="field-input"
                  value={name}
                  autoFocus
                  placeholder={t('create.namePlaceholder')}
                  spellCheck={false}
                  onChange={(event) => setName(event.target.value)}
                />
                <span className="field-hint">{t('create.nameHint')}</span>
              </label>
              <GithubAccountField
                value={account}
                onChange={setAccount}
                onReady={setAccountReady}
                hint={t('create.accountHint')}
              />
              <div className="field">
                <span className="field-label" id={repoModeId}>
                  {t('create.repo')}
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
                      {mode === 'new' ? t('create.newRepo') : t('create.existingRepo')}
                    </button>
                  ))}
                </div>
              </div>
              {usingExisting ? (
                <div className="field">
                  <label className="field-label" htmlFor={repoFieldId}>
                    {t('create.repoLabel')}
                  </label>
                  <input
                    id={repoFieldId}
                    className="field-input"
                    list={repoListId}
                    value={existingRepo}
                    placeholder={t('shared.repoPlaceholder')}
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
                    <FieldProblem text={t('create.repoInvalid')} />
                  ) : (
                    repoChoicesError && <FieldProblem text={repoChoicesError} onRetry={() => void loadRepoChoices()} />
                  )}
                  <span className="field-hint">
                    {repoChoices && repoChoices.length > 0 ? t('create.repoHintChoose') : t('create.repoHintEnter')}
                  </span>
                </div>
              ) : (
                <div className="field">
                  <label className="field-label" htmlFor={ownerFieldId}>
                    {t('create.owner')}
                  </label>
                  {!accountReady ? (
                    <select id={ownerFieldId} className="field-input" disabled>
                      <option>{t('create.chooseAccountFirst')}</option>
                    </select>
                  ) : owners === null ? (
                    <FieldLoading text={t('create.findingOwners', { account })} />
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
                            {!o.isOrg
                              ? t('create.ownerYou', { login: o.login })
                              : o.canCreate === false
                                ? t('create.ownerOrgLocked', { login: o.login })
                                : t('create.ownerOrg', { login: o.login })}
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
                      text={t('create.ownerLocked', { owner })}
                      action={t('create.useExisting')}
                      onRetry={() => setRepoMode('existing')}
                    />
                  )}
                  <span className="field-hint">{t('create.ownerHint')}</span>
                </div>
              )}
              <div className="field">
                <label className="field-label" htmlFor={capacityFieldId}>
                  {t('create.capacity')}
                </label>
                {capacities === null ? (
                  <FieldLoading text={t('create.findingCapacities')} />
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
                  !capacitiesError && (
                    <FieldProblem text={t('create.noCapacity')} onRetry={() => void loadCapacities()} />
                  )
                )}
                {capacities !== null && capacitiesError && (
                  <FieldProblem text={capacitiesError} onRetry={() => void loadCapacities()} />
                )}
                <span className="field-hint">{t('create.capacityHint')}</span>
              </div>
              <button
                type="button"
                className="link-btn"
                onClick={() => setShowAdvanced((v) => !v)}
                aria-expanded={showAdvanced}
              >
                {showAdvanced ? t('create.hideAdvanced') : t('create.advanced')}
              </button>
              {showAdvanced && (
                <>
                  <label className="field">
                    <span className="field-label">{t('create.existingApp')}</span>
                    <input
                      className="field-input"
                      value={clientId}
                      placeholder={t('shared.clientIdPlaceholder')}
                      spellCheck={false}
                      onChange={(event) => setClientId(event.target.value)}
                    />
                    <span className="field-hint">{t('create.existingAppHint')}</span>
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
              {phase === 'running' && <p className="team-muted">{t('create.takesMinutes')}</p>}
              {phase === 'failed' && problem && (
                <ProblemView problem={problem} account={(workspace ?? resume)?.account ?? account} />
              )}
              {phase === 'failed' && identityProblem && (
                <label className="field">
                  <span className="field-label">{t('create.adminApp')}</span>
                  <input
                    className="field-input"
                    value={clientId}
                    placeholder={t('shared.clientIdPlaceholder')}
                    spellCheck={false}
                    onChange={(event) => setClientId(event.target.value)}
                  />
                </label>
              )}
              {phase === 'failed' && runnerProblem && <RunnerFields value={runner} onChange={setRunner} />}
              {phase === 'done' && (
                <div className="team-notice">
                  <span className="team-notice-text">
                    <Trans
                      t={t}
                      i18nKey={workspace?.setup?.protection === 'app' ? 'create.readyUnprotected' : 'create.ready'}
                      values={{ name: workspace?.name ?? name }}
                      components={{ b: <strong /> }}
                    />
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
              {t('shared.abandonSetup')}
            </button>
          )}
          {phase === 'running' ? (
            <button type="button" className="btn btn--ghost" onClick={() => void window.api.team.cancel(scope)}>
              {t('shared.stopWaiting')}
            </button>
          ) : (
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              {phase === 'done' ? t('actions.done') : t('actions.cancel')}
            </button>
          )}
          {phase === 'details' && (
            <button
              type="button"
              className="btn btn--primary"
              disabled={!canCreate}
              onClick={() => void run(false)}
            >
              {t('create.create')}
            </button>
          )}
          {phase === 'failed' && (
            <button
              type="button"
              className="btn btn--primary"
              disabled={runnerProblem && !runnerDraftReady(runner)}
              onClick={() => void (runnerProblem ? retryWithRunner() : run(true))}
            >
              {t('actions.retry')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
