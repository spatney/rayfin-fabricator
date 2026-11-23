import { useEffect, useRef, useState, type JSX } from 'react'
import type { GithubRepo, GithubStatus, InstallResult } from '@shared/ipc'
import { Trans, useTranslation } from '../i18n'
import { useSuppressPreview } from '../overlay'
import { authErrorMessage } from '../authErrors'
import { useMascotInstall } from './mascot/stage'

interface Props {
  /** Abandon the flow (no clone happened). */
  onCancel: () => void
  /** A repo was cloned + opened; the parent refreshes and closes this screen. */
  onCloned: () => void
}

const INITIAL_REPO_RENDER_COUNT = 40
const LOGIN_WAIT_MS = 10 * 60 * 1000

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

type ClonePhase = 'cloning' | 'verifying' | 'installing' | 'opening'

interface ClonePhaseDef {
  id: ClonePhase
  /** Keys in the `home` catalog. */
  label:
    | 'clone.phases.cloning'
    | 'clone.phases.verifying'
    | 'progress.installing'
    | 'clone.phases.opening'
  hint?: 'progress.firstRun'
  /** Loose, lowercase fragments that signal this stage has begun. */
  markers: string[]
}

/**
 * The visible clone stages. Each keys off a marker line the backend `say()`s on
 * the `clone:project` channel: "Cloning …", "Verifying …", "Installing
 * dependencies (npm install) …", and "… Opening …".
 */
const CLONE_PHASES: ClonePhaseDef[] = [
  { id: 'cloning', label: 'clone.phases.cloning', markers: ['cloning'] },
  { id: 'verifying', label: 'clone.phases.verifying', markers: ['verifying'] },
  {
    id: 'installing',
    label: 'progress.installing',
    hint: 'progress.firstRun',
    markers: ['install']
  },
  { id: 'opening', label: 'clone.phases.opening', markers: ['opening'] }
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
  const { t } = useTranslation('home')

  const [status, setStatus] = useState<GithubStatus | null>(null)
  const [checking, setChecking] = useState(true)
  const [statusError, setStatusError] = useState<string | null>(null)

  // gh install
  const [installing, setInstalling] = useState(false)
  const [installLog, setInstallLog] = useState('')
  const [installResult, setInstallResult] = useState<InstallResult | null>(null)

  // sign-in
  const [waitingLogin, setWaitingLogin] = useState(false)
  const [startingLogin, setStartingLogin] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)
  const loginBusyRef = useRef(false)
  const loginSeqRef = useRef(0)
  const statusSeqRef = useRef(0)
  const reposSeqRef = useRef(0)
  const statusRef = useRef<GithubStatus | null>(null)

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

  const busy = checking || installing || cloning || startingLogin

  // Ray keeps the user company while the repository clones and installs.
  const screenRef = useRef<HTMLDivElement>(null)
  const mascot = useMascotInstall(
    'clone',
    cloning ? 'running' : cloneError ? 'error' : 'idle',
    screenRef
  )

  function clearRepos(): void {
    ++reposSeqRef.current
    setRepos(null)
    setReposError(null)
    setSelected(null)
    setLoadingRepos(false)
  }

  async function recheck(): Promise<GithubStatus | null> {
    const seq = ++statusSeqRef.current
    setChecking(true)
    setStatusError(null)
    try {
      const next = await window.api.github.status()
      if (seq !== statusSeqRef.current) return null
      if (!next.signedIn || next.user !== statusRef.current?.user) {
        clearRepos()
      }
      statusRef.current = next
      setStatus(next)
      if (next.signedIn || !next.ghInstalled) setWaitingLogin(false)
      return next
    } catch (reason) {
      if (seq !== statusSeqRef.current) return null
      statusRef.current = null
      setStatus(null)
      clearRepos()
      setWaitingLogin(false)
      setStatusError(authErrorMessage(reason, t('clone.errors.check')))
      return null
    } finally {
      if (seq === statusSeqRef.current) setChecking(false)
    }
  }

  // Initial gh + auth probe.
  useEffect(() => {
    void recheck()
    return () => {
      ++statusSeqRef.current
      ++reposSeqRef.current
      ++loginSeqRef.current
    }
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
    let id: ReturnType<typeof setTimeout>
    const deadline = Date.now() + LOGIN_WAIT_MS
    const tick = async (): Promise<void> => {
      if (cancelled) return
      if (Date.now() >= deadline) {
        setWaitingLogin(false)
        setLoginError(t('clone.errors.notDetected'))
        return
      }
      await recheck()
      if (!cancelled) id = setTimeout(() => void tick(), 2000)
    }
    id = setTimeout(() => void tick(), 2000)
    return () => {
      cancelled = true
      clearTimeout(id)
      ++statusSeqRef.current
    }
  }, [waitingLogin])

  async function loadRepos(): Promise<void> {
    const seq = ++reposSeqRef.current
    setLoadingRepos(true)
    setReposError(null)
    try {
      const res = await window.api.github.listRepos()
      if (seq !== reposSeqRef.current) return
      if (res.ok) {
        setRepos(res.repos)
      } else {
        setRepos([])
        setSelected(null)
        setReposError(res.error ?? t('clone.errors.repos'))
        await recheck()
      }
    } catch (reason) {
      if (seq !== reposSeqRef.current) return
      setRepos([])
      setSelected(null)
      setReposError(authErrorMessage(reason, t('clone.errors.repos')))
      await recheck()
    } finally {
      if (seq === reposSeqRef.current) setLoadingRepos(false)
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
    } catch (reason) {
      setInstallResult({
        ok: false,
        exitCode: null,
        error: authErrorMessage(reason, t('clone.errors.install'))
      })
    } finally {
      setInstalling(false)
    }
  }

  async function beginLogin(): Promise<void> {
    if (loginBusyRef.current || busy || waitingLogin) return
    loginBusyRef.current = true
    const seq = ++loginSeqRef.current
    setStartingLogin(true)
    setLoginError(null)
    try {
      const res = await window.api.github.login()
      if (seq !== loginSeqRef.current) return
      if (!res.ok) {
        setLoginError(authErrorMessage(res.error, t('clone.errors.terminal')))
        return
      }
      setWaitingLogin(true)
    } catch (reason) {
      if (seq === loginSeqRef.current) {
        setLoginError(authErrorMessage(reason, t('clone.errors.signIn')))
      }
    } finally {
      if (seq === loginSeqRef.current) {
        loginBusyRef.current = false
        setStartingLogin(false)
      }
    }
  }

  const cloneTarget = (manual.trim() || selected || '').trim()

  async function clone(): Promise<void> {
    if (!cloneTarget || busy || waitingLogin || !statusRef.current?.signedIn) return
    const user = statusRef.current.user
    setCloning(true)
    setCloneError(null)
    setCloneLog('')
    setShowCloneLog(false)
    setCloneStartedAt(Date.now())
    setNow(Date.now())
    try {
      const verified = await recheck()
      if (!verified?.signedIn) return
      if (!manual.trim() && verified.user !== user) {
        setCloneError(t('clone.errors.accountChanged'))
        return
      }
      const res = await window.api.github.clone(cloneTarget)
      if (res.ok) {
        // The screen closes in the same moment, so tell Ray directly.
        mascot.succeed()
        onCloned()
      } else {
        setCloneError(res.error ?? t('clone.errors.failed'))
        setShowCloneLog(true)
        await recheck()
      }
    } catch (reason) {
      setCloneError(authErrorMessage(reason, t('clone.errors.failedRetry')))
      setShowCloneLog(true)
      await recheck()
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
  const cloneActivePhaseLabel = t(
    cloneDone ? 'progress.ready' : (CLONE_PHASES[cloneActiveIdx]?.label ?? 'clone.phases.cloning')
  )

  let sub = t('clone.sub.signIn')
  if (signedIn) sub = t('clone.sub.pick')
  else if (status && !ghInstalled) sub = t('clone.sub.needCli')
  else if (statusError) sub = t('clone.sub.checkFailed')

  const connection = checking
    ? t('clone.connection.checking')
    : statusError
      ? t('clone.connection.unavailable')
      : signedIn
        ? status?.user
          ? t('clone.connection.connectedAs', { user: status.user })
          : t('clone.connection.connected')
        : ghInstalled
          ? t('clone.connection.signInRequired')
          : t('clone.connection.cliNeeded')

  return (
    <div className="create-screen clone-screen" ref={screenRef}>
      <div className="create-shell clone-shell">
        <header className="create-head clone-head" data-mascot-avoid="">
          <span className="clone-head-icon" aria-hidden="true">
            <span className="codicon codicon-repo-clone" />
          </span>
          <div className="create-head-text">
            <p className="clone-eyebrow">GitHub</p>
            <h1 className="create-title">{t('clone.title')}</h1>
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

        <div
          className={`create-body clone-body${cloning ? ' clone-body--progress' : ''}`}
          data-mascot-avoid=""
        >
          {initialChecking && (
            <section className="clone-loading-card" aria-label={t('clone.checking.label')}>
              <div className="clone-loading-copy">
                <strong>{t('clone.checking.title')}</strong>
                <span>{t('clone.checking.desc')}</span>
              </div>
              <span className="clone-skeleton-input" aria-hidden="true" />
              <RepositorySkeleton label={t('clone.checking.loading')} />
            </section>
          )}

          {statusError && !initialChecking && (
            <section className="clone-state-card clone-state-card--error" role="alert">
              <span className="clone-state-icon codicon codicon-warning" aria-hidden="true" />
              <div className="clone-state-copy">
                <h2>{t('clone.checkFailed')}</h2>
                <p>{statusError}</p>
              </div>
              <button
                type="button"
                className="btn btn--sm"
                disabled={checking || startingLogin}
                onClick={() => void recheck()}
              >
                {t('actions.tryAgain')}
              </button>
            </section>
          )}

          {!initialChecking && !statusError && status && !ghInstalled && (
            <section className="clone-state-card">
              <span className="clone-state-icon codicon codicon-terminal" aria-hidden="true" />
              <div className="clone-state-copy">
                <h2>{t('clone.install.title')}</h2>
                <p>
                  <Trans t={t} i18nKey="clone.install.desc" components={{ code: <code /> }} />
                </p>
                <div className="clone-state-actions">
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    disabled={installing || checking}
                    onClick={() => void installGh()}
                  >
                    {installing ? t('clone.install.installing') : t('clone.install.install')}
                  </button>
                  {installResult?.requiresRelaunch ? (
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => void window.api.relaunch()}
                    >
                      {t('clone.install.restart')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn--sm"
                      disabled={installing || checking}
                      onClick={() => void recheck()}
                    >
                      {t('clone.recheck')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => void window.api.openExternal('https://cli.github.com')}
                  >
                    {t('clone.install.manually')}
                  </button>
                </div>
                {installResult?.manual && (
                  <p className="field-hint">{t('clone.install.manualHint')}</p>
                )}
                {installResult && !installResult.ok && (
                  <div className="alert alert--error" role="alert">
                    {installResult.error || t('clone.errors.install')}
                  </div>
                )}
                {(installing || installLog) && (
                  <pre className="log-console log-console--sm clone-install-log">
                    {installLog || t('clone.starting')}
                  </pre>
                )}
              </div>
            </section>
          )}

          {!initialChecking && !statusError && ghInstalled && !signedIn && (
            <section className="clone-state-card">
              <span className="clone-state-icon codicon codicon-account" aria-hidden="true" />
              <div className="clone-state-copy">
                {waitingLogin ? (
                  <>
                    <h2>{t('clone.signIn.waiting')}</h2>
                    <p>{t('clone.signIn.waitingDesc')}</p>
                    <div className="clone-state-actions">
                      <button
                        type="button"
                        className="btn btn--sm"
                        disabled={checking}
                        onClick={() => void recheck()}
                      >
                        {t('clone.signIn.recheckNow')}
                      </button>
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() => {
                          ++statusSeqRef.current
                          setChecking(false)
                          setWaitingLogin(false)
                        }}
                      >
                        {t('actions.cancel')}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <h2>{t('clone.signIn.title')}</h2>
                    <p>
                      <Trans t={t} i18nKey="clone.signIn.desc" components={{ code: <code /> }} />
                    </p>
                    <div className="clone-state-actions">
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        disabled={startingLogin || checking}
                        onClick={() => void beginLogin()}
                      >
                        {startingLogin ? t('clone.signIn.opening') : t('clone.signIn.button')}
                      </button>
                      <button
                        type="button"
                        className="btn btn--sm"
                        disabled={checking || startingLogin}
                        onClick={() => void recheck()}
                      >
                        {t('clone.recheck')}
                      </button>
                    </div>
                  </>
                )}
                {loginError && <div className="alert alert--error" role="alert">{loginError}</div>}
              </div>
            </section>
          )}

          {!statusError && (initialChecking || signedIn) && !cloning && (
            <section className="clone-manual" aria-labelledby="clone-manual-title">
              <div className="clone-section-head">
                <div>
                  <p className="clone-section-eyebrow">
                    {initialChecking ? t('clone.manual.direct') : t('clone.manual.another')}
                  </p>
                  <h2 id="clone-manual-title">
                    {initialChecking ? t('clone.manual.title') : t('clone.manual.titleOr')}
                  </h2>
                </div>
              </div>
              <input
                className="field-input"
                type="text"
                value={manual}
                placeholder={t('clone.manual.placeholder')}
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
                  t('clone.manual.checkingHint')
                ) : (
                  <Trans t={t} i18nKey="clone.manual.hint" components={{ code: <code /> }} />
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
                      <p className="clone-section-eyebrow">{t('clone.repos.eyebrow')}</p>
                      <h2 id="clone-repositories-title">{t('clone.repos.title')}</h2>
                    </div>
                    <span className="clone-account">
                      <span className="codicon codicon-account" aria-hidden="true" />
                      {status?.user ?? t('clone.repos.account')}
                    </span>
                  </div>
                  <label className="clone-search">
                    <span className="sr-only">{t('clone.repos.filter')}</span>
                    <span className="clone-search-icon codicon codicon-search" aria-hidden="true" />
                    <input
                      className="field-input clone-search-input"
                      type="text"
                      value={filter}
                      placeholder={t('clone.repos.filter')}
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
                    <RepositorySkeleton label={t('clone.repos.loading')} />
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
                        {t('actions.tryAgain')}
                      </button>
                    </div>
                  ) : filtered.length === 0 ? (
                    <div className="clone-list-state">
                      <p>
                        {repos && repos.length === 0
                          ? t('clone.repos.none')
                          : t('clone.repos.noMatch')}
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
                                {repo.isPrivate && (
                                  <span className="clone-repo-tag">{t('clone.repos.private')}</span>
                                )}
                                {repo.primaryLanguage && (
                                  <span className="clone-repo-tag clone-repo-tag--language">
                                    {repo.primaryLanguage}
                                  </span>
                                )}
                              </span>
                              <span className="clone-repo-path" title={repo.description ?? ''}>
                                {repo.description || repo.url || t('clone.repos.noDescription')}
                              </span>
                            </span>
                            {selected === repo.nameWithOwner && (
                              <span
                                className="clone-repo-selected codicon codicon-check"
                                aria-hidden="true"
                              />
                            )}
                          </button>
                        ))}
                      </div>
                      {remainingRepoCount > 0 && (
                        <div className="clone-repo-more">
                          <span>
                            {t('clone.repos.showing', {
                              shown: visibleRepos.length,
                              count: filtered.length
                            })}
                          </span>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            disabled={cloning}
                            onClick={() =>
                              setVisibleRepoCount((count) => count + INITIAL_REPO_RENDER_COUNT)
                            }
                          >
                            {t('clone.repos.showMore', {
                              count: Math.min(INITIAL_REPO_RENDER_COUNT, remainingRepoCount)
                            })}
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
                      <span className="codicon codicon-repo-clone" />
                    </span>
                    <span className="clone-progress-heading">
                      <span className="clone-progress-title">
                        {cloneFailed
                          ? t('clone.progress.failed')
                          : cloneDone
                            ? t('clone.progress.ready')
                            : t('clone.progress.settingUp')}
                      </span>
                      {cloneTarget && <code className="clone-progress-target">{cloneTarget}</code>}
                    </span>
                  </div>
                  <span className="sr-only" role="status" aria-live="polite">
                    {cloning
                      ? cloneActivePhaseLabel
                      : cloneFailed
                        ? t('clone.progress.cloneFailed')
                        : t('progress.ready')}
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
                            <span className="create-phase-label">{t(phaseDef.label)}</span>
                            {phaseDef.id === 'installing' && state === 'active' && (
                              <span className="create-phase-hint">
                                {cloneElapsedSec > 75
                                  ? t('progress.stillWorking')
                                  : phaseDef.hint && t(phaseDef.hint)}
                              </span>
                            )}
                          </span>
                        </li>
                      )
                    })}
                  </ol>

                  <div className="create-progress-meta">
                    <span className="create-elapsed" aria-hidden="true">
                      {cloning
                        ? t('progress.elapsed', { time: cloneElapsedLabel })
                        : cloneFailed
                          ? ''
                          : t('actions.done')}
                    </span>
                    <button
                      type="button"
                      className="link-btn create-progress-toggle"
                      onClick={() => setShowCloneLog((value) => !value)}
                    >
                      {showCloneLog ? t('progress.hideDetails') : t('progress.showDetails')}
                    </button>
                  </div>
                  {showCloneLog && (
                    <pre className="log-console log-console--sm" ref={cloneLogRef}>
                      {cloneLog || t('clone.starting')}
                    </pre>
                  )}
                </div>
              )}

            </>
          )}
          {cloneError && <div className="alert alert--error" role="alert">{cloneError}</div>}
        </div>

        <footer className="create-foot clone-foot" data-mascot-avoid="">
          <button className="btn btn--ghost" onClick={onCancel} disabled={busy}>
            {t('actions.cancel')}
          </button>
          {signedIn && (
            <button
              className="btn btn--primary"
              onClick={() => void clone()}
              disabled={busy || waitingLogin || !cloneTarget}
            >
              {cloning ? t('clone.cloning') : t('clone.cloneAndOpen')}
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}
