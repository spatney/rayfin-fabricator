import { useEffect, useRef, useState } from 'react'
import type { GithubRepo, GithubStatus, InstallResult } from '@shared/ipc'
import { useSuppressPreview } from '../overlay'
import { Codicon } from './icons'

interface Props {
  /** Abandon the flow (no clone happened). */
  onCancel: () => void
  /** A repo was cloned + opened; the parent refreshes and closes this screen. */
  onCloned: () => void
}

const INITIAL_REPO_RENDER_COUNT = 40

/** Case-insensitive match of a repo against the filter box (name / desc / language). */
function matches(repo: GithubRepo, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    repo.nameWithOwner.toLowerCase().includes(q) ||
    (repo.description ?? '').toLowerCase().includes(q) ||
    (repo.primaryLanguage ?? '').toLowerCase().includes(q)
  )
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback
}

type ClonePhase = 'cloning' | 'verifying' | 'installing' | 'opening'

interface ClonePhaseDef {
  id: ClonePhase
  label: string
  hint?: string
  /** Loose, lowercase fragments that signal this stage has begun. */
  markers: string[]
}

/**
 * The visible clone stages. Each keys off a marker line the backend `say()`s on
 * the `clone:project` channel: "Cloning …", "Verifying …", "Installing
 * dependencies (npm install) …", and "… Opening …".
 */
const CLONE_PHASES: ClonePhaseDef[] = [
  { id: 'cloning', label: 'Cloning repository', markers: ['cloning'] },
  { id: 'verifying', label: 'Verifying project', markers: ['verifying'] },
  {
    id: 'installing',
    label: 'Installing dependencies',
    hint: 'First run can take a minute or two.',
    markers: ['install']
  },
  { id: 'opening', label: 'Opening project', markers: ['opening'] }
]

const clonePhaseRank = (phase: ClonePhase): number => CLONE_PHASES.findIndex((p) => p.id === phase)

/**
 * Best-effort, purely cosmetic mapping of the cumulative clone log to the
 * furthest stage reached. Markers are loose substrings; a miss only softens the
 * indicator (the spinner + elapsed timer + {@link fallbackPhase} still convey
 * motion) and it never drives completion — that is the backend result alone.
 */
function markerPhase(log: string): ClonePhase {
  try {
    const l = log.toLowerCase()
    let reached: ClonePhase = 'cloning'
    for (const def of CLONE_PHASES) {
      if (def.markers.some((m) => l.includes(m))) reached = def.id
    }
    return reached
  } catch {
    return 'cloning'
  }
}

/**
 * Time-based floor so the indicator keeps advancing even if the backend output
 * wording changes. Capped at `installing` (the dominant time sink) — it never
 * fabricates `opening`, which requires a real signal.
 */
function fallbackPhase(elapsedSec: number, running: boolean): ClonePhase {
  if (!running) return 'cloning'
  if (elapsedSec >= 6) return 'installing'
  if (elapsedSec >= 2) return 'verifying'
  return 'cloning'
}

/** Keeps the repository pane spatially stable while `gh` performs its network query. */
function RepositorySkeleton({ label }: { label: string }): JSX.Element {
  return (
    <div className="clone-repo-skeleton" aria-busy="true">
      <p className="clone-loading-status" role="status">
        <span className="ws-spinner" aria-hidden="true" /> {label}
      </p>
      <div className="clone-skeleton-row">
        <span className="clone-skeleton-mark" />
        <span className="clone-skeleton-copy">
          <span className="clone-skeleton-line clone-skeleton-line--title" />
          <span className="clone-skeleton-line clone-skeleton-line--body" />
        </span>
      </div>
      <div className="clone-skeleton-row">
        <span className="clone-skeleton-mark" />
        <span className="clone-skeleton-copy">
          <span className="clone-skeleton-line clone-skeleton-line--title" />
          <span className="clone-skeleton-line clone-skeleton-line--body" />
        </span>
      </div>
      <div className="clone-skeleton-row">
        <span className="clone-skeleton-mark" />
        <span className="clone-skeleton-copy">
          <span className="clone-skeleton-line clone-skeleton-line--title" />
          <span className="clone-skeleton-line clone-skeleton-line--body" />
        </span>
      </div>
    </div>
  )
}

/**
 * "Open existing -> Clone from GitHub" full-screen flow. Gated on the optional
 * `gh` CLI: install -> sign in -> browse repositories (or paste a URL) -> clone.
 */
export default function CloneFromGitHubScreen({ onCancel, onCloned }: Props): JSX.Element {
  // The native preview webview floats above HTML; suppress it while this covers the body.
  useSuppressPreview()

  const [status, setStatus] = useState<GithubStatus | null>(null)
  const [checking, setChecking] = useState(true)
  const [statusError, setStatusError] = useState<string | null>(null)

  // gh install
  const [installing, setInstalling] = useState(false)
  const [installLog, setInstallLog] = useState('')
  const [installResult, setInstallResult] = useState<InstallResult | null>(null)

  // sign-in
  const [waitingLogin, setWaitingLogin] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)

  // repos
  const [repos, setRepos] = useState<GithubRepo[] | null>(null)
  const [loadingRepos, setLoadingRepos] = useState(false)
  const [reposError, setReposError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [manual, setManual] = useState('')
  const [visibleRepoCount, setVisibleRepoCount] = useState(INITIAL_REPO_RENDER_COUNT)

  // clone
  const [cloning, setCloning] = useState(false)
  const [cloneLog, setCloneLog] = useState('')
  const [cloneError, setCloneError] = useState<string | null>(null)
  const [showCloneLog, setShowCloneLog] = useState(false)
  const cloneLogRef = useRef<HTMLPreElement>(null)
  // Elapsed-time clock backing the phase checklist (see the tick effect below).
  const [cloneStartedAt, setCloneStartedAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const busy = checking || installing || cloning

  async function recheck(): Promise<void> {
    setChecking(true)
    setStatusError(null)
    try {
      const next = await window.api.github.status()
      setStatus(next)
      if (!next.signedIn) {
        setRepos(null)
        setReposError(null)
        setSelected(null)
      }
    } catch (reason) {
      setStatus(null)
      setStatusError(errorMessage(reason, 'Could not check the GitHub CLI. Please try again.'))
    } finally {
      setChecking(false)
    }
  }

  // Initial gh + auth probe.
  useEffect(() => {
    void recheck()
  }, [])

  // Esc abandons the flow when nothing is in flight.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  // Stream gh install + clone output.
  useEffect(() => {
    return window.api.onProcLog((event) => {
      if (event.channel === 'clone:project') setCloneLog((prev) => prev + event.data)
      else if (event.channel === 'install:gh') setInstallLog((prev) => prev + event.data)
    })
  }, [])

  // Poll for sign-in completion after the terminal is launched.
  useEffect(() => {
    if (!waitingLogin) return
    let cancelled = false
    const tick = async (): Promise<void> => {
      const next = await window.api.github.status().catch(() => null)
      if (cancelled || !next) return
      setStatus(next)
      if (next.signedIn) setWaitingLogin(false)
    }
    const id = window.setInterval(() => void tick(), 2000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [waitingLogin])

  async function loadRepos(): Promise<void> {
    setLoadingRepos(true)
    setReposError(null)
    try {
      const res = await window.api.github.listRepos()
      if (res.ok) {
        setRepos(res.repos)
      } else {
        setRepos([])
        setReposError(res.error ?? 'Could not load your repositories.')
      }
    } catch (reason) {
      setRepos([])
      setReposError(errorMessage(reason, 'Could not load your repositories.'))
    } finally {
      setLoadingRepos(false)
    }
  }

  // Load the user's repos once signed in. A null list is always a loading state,
  // never an empty search result, so the picker cannot flash a false empty message.
  useEffect(() => {
    if (!status?.signedIn || repos !== null || loadingRepos || reposError) return
    void loadRepos()
  }, [status?.signedIn, repos, loadingRepos, reposError])

  useEffect(() => {
    if (cloneLogRef.current) cloneLogRef.current.scrollTop = cloneLogRef.current.scrollHeight
  }, [cloneLog, showCloneLog])

  // Tick a 1s elapsed clock while a clone is in flight — the strongest "still
  // working" cue during the output-silent npm install, independent of log wording.
  useEffect(() => {
    if (!cloning || cloneStartedAt == null) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [cloning, cloneStartedAt])

  async function installGh(): Promise<void> {
    setInstalling(true)
    setInstallLog('')
    setInstallResult(null)
    try {
      const res = await window.api.doctor.install('gh')
      setInstallResult(res)
      // An in-process install that needs no relaunch (rare) — re-probe immediately.
      if (res.ok && !res.requiresRelaunch) await recheck()
    } finally {
      setInstalling(false)
    }
  }

  async function beginLogin(): Promise<void> {
    setLoginError(null)
    try {
      const res = await window.api.github.login()
      if (!res.ok) {
        setLoginError(
          'Could not open a terminal automatically. Run "gh auth login" in your terminal, then click Re-check.'
        )
        return
      }
      setWaitingLogin(true)
    } catch (reason) {
      setLoginError(errorMessage(reason, 'Could not start GitHub sign-in. Please try again.'))
    }
  }

  const cloneTarget = (manual.trim() || selected || '').trim()

  async function clone(): Promise<void> {
    if (!cloneTarget) return
    setCloning(true)
    setCloneError(null)
    setCloneLog('')
    setShowCloneLog(false)
    setCloneStartedAt(Date.now())
    setNow(Date.now())
    try {
      const res = await window.api.github.clone(cloneTarget)
      if (res.ok) {
        onCloned()
      } else {
        setCloneError(res.error ?? 'Clone failed.')
        setShowCloneLog(true)
      }
    } catch (reason) {
      setCloneError(errorMessage(reason, 'Clone failed. Please try again.'))
      setShowCloneLog(true)
    } finally {
      setCloning(false)
    }
  }

  const filtered = (repos ?? []).filter((repo) => matches(repo, filter))
  const ghInstalled = status?.ghInstalled ?? false
  const signedIn = status?.signedIn ?? false
  const initialChecking = checking && status === null
  const reposPending = signedIn && repos === null && !reposError
  const visibleRepos = filtered.slice(0, visibleRepoCount)
  const remainingRepoCount = filtered.length - visibleRepos.length

  // ----- Clone progress (cosmetic; completion is driven by the backend result) -----
  const cloneElapsedSec = cloneStartedAt
    ? Math.max(0, Math.floor((now - cloneStartedAt) / 1000))
    : 0
  const cloneElapsedLabel = `${Math.floor(cloneElapsedSec / 60)}:${String(
    cloneElapsedSec % 60
  ).padStart(2, '0')}`
  const cloneFailed = !cloning && Boolean(cloneError)
  const cloneDone = !cloning && !cloneError && Boolean(cloneLog)
  const detectedClonePhase = markerPhase(cloneLog)
  const cloneFallback = fallbackPhase(cloneElapsedSec, cloning)
  // Never regress: take the furthest of the parsed marker and the time floor.
  const clonePhase: ClonePhase =
    clonePhaseRank(detectedClonePhase) >= clonePhaseRank(cloneFallback)
      ? detectedClonePhase
      : cloneFallback
  const cloneActiveIdx = cloneDone
    ? CLONE_PHASES.length
    : CLONE_PHASES.findIndex((p) => p.id === clonePhase)
  const cloneActivePhaseLabel = cloneDone
    ? 'Project ready'
    : (CLONE_PHASES[cloneActiveIdx]?.label ?? 'Cloning repository')

  let sub = 'Sign in to GitHub to clone one of your repositories into your workspace.'
  if (signedIn) sub = 'Pick a repository to clone into your workspace, or paste a URL.'
  else if (status && !ghInstalled)
    sub = 'The GitHub CLI (gh) is needed to sign in and clone repositories.'
  else if (statusError) sub = 'Check your GitHub CLI connection, then try again.'

  const connection = checking
    ? 'Checking GitHub'
    : statusError
      ? 'Connection unavailable'
      : signedIn
        ? `Connected${status?.user ? ` as ${status.user}` : ''}`
        : ghInstalled
          ? 'Sign in required'
          : 'GitHub CLI needed'

  return (
    <div className="create-screen clone-screen">
      <div className="create-shell clone-shell">
        <header className="create-head clone-head">
          <span className="clone-head-icon" aria-hidden="true">
            <Codicon name="repo-clone" />
          </span>
          <div className="create-head-text">
            <p className="clone-eyebrow">GitHub</p>
            <h1 className="create-title">Clone from GitHub</h1>
            <p className="create-sub">{sub}</p>
          </div>
          <span
            className={`clone-connection${
              signedIn ? ' clone-connection--ready' : statusError ? ' clone-connection--error' : ''
            }`}
            role="status"
          >
            {checking && <span className="ws-spinner" aria-hidden="true" />}
            {connection}
          </span>
        </header>

        <div className={`create-body clone-body${cloning ? ' clone-body--progress' : ''}`}>
          {initialChecking && (
            <section className="clone-loading-card" aria-label="Checking GitHub connection">
              <div className="clone-loading-copy">
                <strong>Preparing your GitHub repositories</strong>
                <span>Checking the GitHub CLI and your sign-in before loading the picker.</span>
              </div>
              <span className="clone-skeleton-input" aria-hidden="true" />
              <RepositorySkeleton label="Loading repository picker..." />
            </section>
          )}

          {statusError && !initialChecking && (
            <section className="clone-state-card clone-state-card--error" role="alert">
              <span className="clone-state-icon" aria-hidden="true">
                <Codicon name="warning" />
              </span>
              <div className="clone-state-copy">
                <h2>Could not check GitHub</h2>
                <p>{statusError}</p>
              </div>
              <button type="button" className="btn btn--sm" onClick={() => void recheck()}>
                Try again
              </button>
            </section>
          )}

          {!initialChecking && !statusError && status && !ghInstalled && (
            <section className="clone-state-card">
              <span className="clone-state-icon" aria-hidden="true">
                <Codicon name="terminal" />
              </span>
              <div className="clone-state-copy">
                <h2>Install the GitHub CLI</h2>
                <p>
                  Fabricator uses <code>gh</code> to sign in and clone repositories from GitHub.
                </p>
                <div className="clone-state-actions">
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    disabled={installing}
                    onClick={() => void installGh()}
                  >
                    {installing ? 'Installing...' : 'Install GitHub CLI'}
                  </button>
                  {installResult?.requiresRelaunch ? (
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => void window.api.relaunch()}
                    >
                      Restart to finish
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn--sm"
                      disabled={installing}
                      onClick={() => void recheck()}
                    >
                      Re-check
                    </button>
                  )}
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => void window.api.openExternal('https://cli.github.com')}
                  >
                    Install manually
                  </button>
                </div>
                {installResult?.manual && (
                  <p className="field-hint">
                    The installer was opened in your browser. After installing, click Restart.
                  </p>
                )}
                {(installing || installLog) && (
                  <pre className="log-console log-console--sm clone-install-log">
                    {installLog || 'Starting...'}
                  </pre>
                )}
              </div>
            </section>
          )}

          {!initialChecking && !statusError && ghInstalled && !signedIn && (
            <section className="clone-state-card">
              <span className="clone-state-icon" aria-hidden="true">
                <Codicon name="account" />
              </span>
              <div className="clone-state-copy">
                {waitingLogin ? (
                  <>
                    <h2>Waiting for GitHub sign-in</h2>
                    <p>
                      A terminal window opened. Complete the browser prompts, then return here and
                      Fabricator will detect your sign-in.
                    </p>
                    <div className="clone-state-actions">
                      <button type="button" className="btn btn--sm" onClick={() => void recheck()}>
                        Re-check now
                      </button>
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() => setWaitingLogin(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <h2>Sign in to GitHub</h2>
                    <p>
                      A terminal will run <code>gh auth login --web</code>. Complete the sign-in in
                      your browser, then return here.
                    </p>
                    <div className="clone-state-actions">
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        onClick={() => void beginLogin()}
                      >
                        Sign in with GitHub
                      </button>
                      <button type="button" className="btn btn--sm" onClick={() => void recheck()}>
                        Re-check
                      </button>
                    </div>
                  </>
                )}
                {loginError && <div className="alert alert--error">{loginError}</div>}
              </div>
            </section>
          )}

          {!statusError && (initialChecking || signedIn) && !cloning && (
            <section className="clone-manual" aria-labelledby="clone-manual-title">
              <div className="clone-section-head">
                <div>
                  <p className="clone-section-eyebrow">
                    {initialChecking ? 'Direct link' : 'Another repository'}
                  </p>
                  <h2 id="clone-manual-title">
                    {initialChecking ? 'Paste a repository link' : 'Or paste a repository link'}
                  </h2>
                </div>
              </div>
              <input
                className="field-input"
                type="text"
                value={manual}
                placeholder="owner/name or https://github.com/owner/name"
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
                disabled={cloning}
                onChange={(event) => {
                  setManual(event.target.value)
                  if (event.target.value.trim()) setSelected(null)
                }}
              />
              <span className="field-hint">
                {initialChecking ? (
                  'You can paste a link now. Cloning unlocks once GitHub connection checking finishes.'
                ) : (
                  <>
                    The repository is cloned into your workspace and must contain{' '}
                    <code>rayfin/rayfin.yml</code>.
                  </>
                )}
              </span>
            </section>
          )}

          {!initialChecking && !statusError && signedIn && (
            <>
              {!cloning && (
                <section className="clone-repo-panel" aria-labelledby="clone-repositories-title">
                  <div className="clone-section-head">
                    <div>
                      <p className="clone-section-eyebrow">Your repositories</p>
                      <h2 id="clone-repositories-title">Choose a repository</h2>
                    </div>
                    <span className="clone-account">
                      <Codicon name="account" />
                      {status?.user ?? 'GitHub account'}
                    </span>
                  </div>
                  <label className="clone-search">
                    <span className="sr-only">Filter repositories</span>
                    <Codicon name="search" className="clone-search-icon" />
                    <input
                      className="field-input clone-search-input"
                      type="text"
                      value={filter}
                      placeholder="Filter repositories"
                      autoCapitalize="off"
                      autoCorrect="off"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={cloning || reposPending}
                      onChange={(event) => {
                        setFilter(event.target.value)
                        setVisibleRepoCount(INITIAL_REPO_RENDER_COUNT)
                      }}
                    />
                  </label>

                  {reposPending ? (
                    <RepositorySkeleton label="Loading your repositories..." />
                  ) : reposError ? (
                    <div className="clone-list-state" role="alert">
                      <p>{reposError}</p>
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() => {
                          setRepos(null)
                          setReposError(null)
                        }}
                      >
                        Try again
                      </button>
                    </div>
                  ) : filtered.length === 0 ? (
                    <div className="clone-list-state">
                      <p>
                        {repos && repos.length === 0
                          ? 'No repositories found for this account.'
                          : 'No repositories match your filter.'}
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className="clone-repo-scroll" role="list">
                        {visibleRepos.map((repo) => (
                          <button
                            key={repo.nameWithOwner}
                            type="button"
                            className={`clone-repo${
                              selected === repo.nameWithOwner ? ' clone-repo--active' : ''
                            }`}
                            disabled={cloning}
                            onClick={() => {
                              setSelected(repo.nameWithOwner)
                              setManual('')
                            }}
                          >
                            <span className="clone-repo-mark" aria-hidden="true">
                              {repo.name.trim()[0]?.toUpperCase() ?? '?'}
                            </span>
                            <span className="clone-repo-main">
                              <span className="clone-repo-name">
                                {repo.nameWithOwner}
                                {repo.isPrivate && <span className="clone-repo-tag">Private</span>}
                                {repo.primaryLanguage && (
                                  <span className="clone-repo-tag clone-repo-tag--language">
                                    {repo.primaryLanguage}
                                  </span>
                                )}
                              </span>
                              <span className="clone-repo-path" title={repo.description ?? ''}>
                                {repo.description || repo.url || 'No description'}
                              </span>
                            </span>
                            {selected === repo.nameWithOwner && (
                              <span className="clone-repo-selected" aria-hidden="true">
                                <Codicon name="check" />
                              </span>
                            )}
                          </button>
                        ))}
                      </div>
                      {remainingRepoCount > 0 && (
                        <div className="clone-repo-more">
                          <span>
                            Showing {visibleRepos.length} of {filtered.length} repositories
                          </span>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            disabled={cloning}
                            onClick={() =>
                              setVisibleRepoCount((count) => count + INITIAL_REPO_RENDER_COUNT)
                            }
                          >
                            Show {Math.min(INITIAL_REPO_RENDER_COUNT, remainingRepoCount)} more
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </section>
              )}

              {(cloning || cloneLog) && (
                <div className="create-progress clone-progress" aria-busy={cloning}>
                  <div className="clone-progress-head">
                    <span className="clone-progress-ico" aria-hidden="true">
                      <Codicon name="repo-clone" />
                    </span>
                    <span className="clone-progress-heading">
                      <span className="clone-progress-title">
                        {cloneFailed
                          ? 'Could not clone repository'
                          : cloneDone
                            ? 'Repository ready'
                            : 'Setting up your project'}
                      </span>
                      {cloneTarget && <code className="clone-progress-target">{cloneTarget}</code>}
                    </span>
                  </div>
                  <span className="sr-only" role="status" aria-live="polite">
                    {cloning
                      ? cloneActivePhaseLabel
                      : cloneFailed
                        ? 'Clone failed'
                        : 'Project ready'}
                  </span>
                  <ol className="create-phases">
                    {CLONE_PHASES.map((phaseDef, i) => {
                      const state =
                        i < cloneActiveIdx ? 'done' : i === cloneActiveIdx ? 'active' : 'pending'
                      return (
                        <li
                          key={phaseDef.id}
                          className={`create-phase create-phase--${state}${
                            cloneFailed && state === 'active' ? ' create-phase--failed' : ''
                          }`}
                        >
                          <span className="create-phase-ico" aria-hidden="true">
                            {state === 'active' ? (
                              cloning ? (
                                <span className="ws-spinner" />
                              ) : cloneFailed ? (
                                '✕'
                              ) : null
                            ) : state === 'done' ? (
                              '✓'
                            ) : null}
                          </span>
                          <span className="create-phase-text">
                            <span className="create-phase-label">{phaseDef.label}</span>
                            {phaseDef.id === 'installing' && state === 'active' && (
                              <span className="create-phase-hint">
                                {cloneElapsedSec > 75
                                  ? 'Still working — large dependency trees take a little longer.'
                                  : phaseDef.hint}
                              </span>
                            )}
                          </span>
                        </li>
                      )
                    })}
                  </ol>

                  <div className="create-progress-meta">
                    <span className="create-elapsed" aria-hidden="true">
                      {cloning ? `${cloneElapsedLabel} elapsed` : cloneFailed ? '' : 'Done'}
                    </span>
                    <button
                      type="button"
                      className="link-btn create-progress-toggle"
                      onClick={() => setShowCloneLog((value) => !value)}
                    >
                      {showCloneLog ? 'Hide details' : 'Show details'}
                    </button>
                  </div>
                  {showCloneLog && (
                    <pre className="log-console log-console--sm" ref={cloneLogRef}>
                      {cloneLog || 'Starting...'}
                    </pre>
                  )}
                </div>
              )}

              {cloneError && <div className="alert alert--error">{cloneError}</div>}
            </>
          )}
        </div>

        <footer className="create-foot clone-foot">
          <button className="btn btn--ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          {signedIn && (
            <button
              className="btn btn--primary"
              onClick={() => void clone()}
              disabled={cloning || !cloneTarget}
            >
              {cloning ? 'Cloning...' : 'Clone and open'}
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}
