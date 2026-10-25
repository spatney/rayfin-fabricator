import { useEffect, useId, useRef, useState, type JSX } from 'react'
import type { TeamEnvStatus, TeamGhAccount, TeamProblem, TeamProgressEvent } from '@shared/ipc'
import { openDocs } from '../../docsLinks'
import './team.css'

/** One row of a progress checklist. */
export interface StepRow {
  id: string
  label: string
  state: 'pending' | 'running' | 'done' | 'error' | 'skipped'
  detail?: string
}

/** Build a checklist from step definitions, updated by `team:progress` events. */
export function useStepProgress(
  steps: ReadonlyArray<{ id: string; label: string }>,
  scope: string | null
): [StepRow[], (rows: StepRow[]) => void] {
  const [rows, setRows] = useState<StepRow[]>(() =>
    steps.map((s) => ({ id: s.id, label: s.label, state: 'pending' }))
  )
  useEffect(() => {
    if (!scope) return
    return window.api.team.onProgress((event: TeamProgressEvent) => {
      if (event.scope !== scope) return
      setRows((current) =>
        current.map((row) =>
          row.id === event.step
            ? { ...row, state: event.state, detail: event.detail ?? undefined }
            : row
        )
      )
    })
  }, [scope])
  return [rows, setRows]
}

export function StepList({ rows }: { rows: StepRow[] }): JSX.Element {
  return (
    <ol className="team-steps">
      {rows.map((row) => (
        <li key={row.id} className={`team-step team-step--${row.state}`}>
          <span className="team-step-ico" aria-hidden="true">
            {row.state === 'running' ? (
              <span className="ws-spinner" />
            ) : row.state === 'done' ? (
              '✓'
            ) : row.state === 'error' ? (
              '!'
            ) : row.state === 'skipped' ? (
              '–'
            ) : null}
          </span>
          <span className="team-step-text">
            <span className="team-step-label">{row.label}</span>
            {row.detail && <span className="team-step-detail">{row.detail}</span>}
          </span>
        </li>
      ))}
    </ol>
  )
}

/**
 * A plain-language problem, with instructions to forward to an administrator.
 * When single sign-on blocked the GitHub CLI, it also signs `account` (the
 * CLI's active account when absent) in to GitHub again.
 */
export function ProblemView({ problem, account }: { problem: TeamProblem; account?: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  /** A terminal sign-in was opened. */
  const [signingIn, setSigningIn] = useState(false)
  const [signInError, setSignInError] = useState<string | null>(null)
  const sso = problem.kind === 'sso'
  async function copy(): Promise<void> {
    if (!problem.adminNote) return
    try {
      await navigator.clipboard.writeText(problem.adminNote)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard can be unavailable; the text stays selectable */
    }
  }
  async function signInAgain(): Promise<void> {
    setSignInError(null)
    try {
      const result = await window.api.team.githubSignIn(true, false, account || undefined)
      if (result.ok) setSigningIn(true)
      else setSignInError(result.error ?? 'Could not start GitHub sign-in.')
    } catch (reason) {
      setSignInError(teamError(reason, 'Could not start GitHub sign-in.'))
    }
  }
  return (
    <div className="team-problem" role="alert">
      <p className="team-problem-title">{problem.message}</p>
      {problem.guidance && <p>{problem.guidance}</p>}
      {(problem.link || sso) && (
        <div>
          {problem.link && (
            <button
              type="button"
              className="btn btn--sm btn--primary"
              onClick={() => void window.api.openExternal(problem.link!.url)}
            >
              {problem.link.label} <span className="codicon codicon-link-external" aria-hidden="true" />
            </button>
          )}
          {problem.link && sso && ' '}
          {sso && (
            <button type="button" className="btn btn--sm" onClick={() => void signInAgain()}>
              Sign in to GitHub again
            </button>
          )}
        </div>
      )}
      {signingIn && (
        <p className="team-muted">Finish signing in in the terminal window and your browser, then try again.</p>
      )}
      {signInError && <FieldProblem text={signInError} />}
      {problem.adminNote && (
        <>
          <pre className="team-admin-note">{problem.adminNote}</pre>
          <div>
            <button type="button" className="btn btn--sm" onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy instructions for your admin'}
            </button>{' '}
            <button type="button" className="btn btn--sm btn--link" onClick={() => openDocs('teamAdmins')}>
              What administrators need to know
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/** A readable message from a rejected IPC call. */
export function teamError(reason: unknown, fallback: string): string {
  if (typeof reason === 'string' && reason.trim()) return reason
  if (reason instanceof Error && reason.message) return reason.message
  return fallback
}

/** Holds a picker's place, at the picker's size, while its choices load. */
export function FieldLoading({ text }: { text: string }): JSX.Element {
  return (
    <div className="field-input team-field-loading" role="status">
      <span className="ws-spinner" aria-hidden="true" />
      {text}
    </div>
  )
}

/** Why a field can't be used as it is, with a way to ask again (or another action). */
export function FieldProblem({
  text,
  onRetry,
  action = 'Try again'
}: {
  text: string
  onRetry?: () => void
  /** The button's label. */
  action?: string
}): JSX.Element {
  return (
    <div className="team-field-problem" role="alert">
      <span className="codicon codicon-warning" aria-hidden="true" />
      <span className="team-field-problem-text">{text}</span>
      {onRetry && (
        <button type="button" className="link-btn" onClick={onRetry}>
          {action}
        </button>
      )}
    </div>
  )
}

const sameLogin = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** Whether the GitHub CLI's sign-in for `account` can do team workspace work. */
export function accountReady(account: TeamGhAccount | undefined): boolean {
  return Boolean(account?.signedIn && account.missingScopes.length === 0)
}

/** How long to keep checking while a terminal sign-in is open. */
const SIGN_IN_WAIT_MS = 5 * 60_000

/**
 * The GitHub account a team workspace is created or joined as, from the
 * accounts the GitHub CLI is signed in to. Signs in to another account, or fixes
 * the chosen account's sign-in and permissions, in a terminal. Defaults to the
 * CLI's active account.
 */
export function GithubAccountField({
  value,
  onChange,
  onReady,
  hint,
  hideLabel = false
}: {
  /** The chosen login; empty until the accounts load. */
  value: string
  onChange: (login: string) => void
  /** The chosen account can be used: signed in, with the permissions team workspaces need. */
  onReady?: (ready: boolean) => void
  hint?: string
  /** A heading around the field already says what it is. */
  hideLabel?: boolean
}): JSX.Element {
  const fieldId = useId()
  const [status, setStatus] = useState<TeamEnvStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** A terminal sign-in is open: adding an account, or fixing the chosen one. */
  const [waiting, setWaiting] = useState<'add' | 'fix' | null>(null)
  /** The signed-in accounts before an "add" sign-in, to spot the one signed in. */
  const before = useRef<string[]>([])

  async function load(): Promise<TeamEnvStatus | null> {
    try {
      const next = await window.api.team.envStatus()
      setStatus(next)
      setError(next.error ?? null)
      return next
    } catch (reason) {
      setError(teamError(reason, 'Could not check your GitHub accounts.'))
      return null
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const accounts = status?.ghAccounts ?? []
  const chosen = accounts.find((a) => sameLogin(a.login, value))
  const ready = accountReady(chosen)

  // Start with the CLI's active account (or the first that works).
  useEffect(() => {
    if (!status || chosen) return
    const fallback = accounts.find((a) => a.active && a.signedIn) ?? accounts.find((a) => a.signedIn) ?? accounts[0]
    if (fallback) onChange(fallback.login)
  }, [status, chosen])

  useEffect(() => {
    onReady?.(ready)
  }, [ready])

  useEffect(() => {
    if (!waiting) return
    const id = window.setInterval(() => {
      void load().then((next) => {
        if (!next) return
        if (waiting === 'add') {
          const added = next.ghAccounts.find((a) => a.signedIn && !before.current.includes(a.login.toLowerCase()))
          if (added) {
            setWaiting(null)
            onChange(added.login)
          }
        } else if (accountReady(next.ghAccounts.find((a) => sameLogin(a.login, value)))) {
          setWaiting(null)
        }
      })
    }, 3000)
    const stop = window.setTimeout(() => setWaiting(null), SIGN_IN_WAIT_MS)
    return () => {
      window.clearInterval(id)
      window.clearTimeout(stop)
    }
  }, [waiting, value])

  async function signIn(kind: 'add' | 'fix'): Promise<void> {
    setError(null)
    // A new account, or one whose expired sign-in is renewed, counts as added.
    before.current = accounts.filter((a) => a.signedIn).map((a) => a.login.toLowerCase())
    try {
      const result =
        kind === 'add' ? await window.api.team.githubSignIn(false) : await window.api.team.githubSignIn(true, false, value)
      if (!result.ok) {
        setError(result.error ?? 'Could not start GitHub sign-in.')
        return
      }
      setWaiting(kind)
    } catch (reason) {
      setError(teamError(reason, 'Could not start GitHub sign-in.'))
    }
  }

  return (
    <div className="field">
      {!hideLabel && (
        <label className="field-label" htmlFor={fieldId}>
          GitHub account
        </label>
      )}
      {!status ? (
        <FieldLoading text="Checking your GitHub accounts…" />
      ) : accounts.length === 0 ? (
        <div className="team-check">
          <span className="team-check-dot team-check-dot--error" />
          <span className="team-check-text team-muted">
            Sign in to GitHub so Fabricator can work with the team&apos;s repository.
          </span>
          <button type="button" className="btn btn--sm btn--primary" disabled={Boolean(waiting)} onClick={() => void signIn('add')}>
            {waiting ? 'Waiting…' : 'Sign in to GitHub'}
          </button>
        </div>
      ) : (
        <div className="team-account-row">
          <select
            id={fieldId}
            className="field-input"
            aria-label={hideLabel ? 'GitHub account' : undefined}
            value={chosen?.login ?? ''}
            disabled={Boolean(waiting)}
            onChange={(event) => onChange(event.target.value)}
          >
            {accounts.map((a) => (
              <option key={a.login} value={a.login}>
                {a.login}
                {a.signedIn ? '' : ' (sign-in expired)'}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn--sm" disabled={Boolean(waiting)} onClick={() => void signIn('add')}>
            {waiting === 'add' ? 'Waiting…' : 'Add account'}
          </button>
        </div>
      )}
      {hint && accounts.length > 0 && <span className="field-hint">{hint}</span>}
      {chosen && !ready && (
        <div className="team-check">
          <span className={`team-check-dot team-check-dot--${chosen.signedIn ? 'warn' : 'error'}`} />
          <span className="team-check-text team-muted">
            {chosen.signedIn
              ? `Fabricator needs more GitHub permissions for ${chosen.login}: to manage repositories and their pipelines (${chosen.missingScopes.join(', ')}).`
              : `The GitHub CLI's sign-in for ${chosen.login} has expired.`}
          </span>
          <button type="button" className="btn btn--sm btn--primary" disabled={Boolean(waiting)} onClick={() => void signIn('fix')}>
            {waiting === 'fix' ? 'Waiting…' : chosen.signedIn ? 'Grant GitHub access' : 'Sign in again'}
          </button>
        </div>
      )}
      {waiting && (
        <span className="team-muted">
          Finish signing in in the terminal window, then come back. This updates automatically.{' '}
          <button type="button" className="link-btn" onClick={() => setWaiting(null)}>
            Stop waiting
          </button>
        </span>
      )}
      {error && <FieldProblem text={error} onRetry={() => void load()} />}
    </div>
  )
}

/**
 * GitHub and Azure prerequisites for team workspaces, with the actions that fix
 * them. Polls while a sign-in terminal is open. By default any signed-in GitHub
 * account will do (the account chosen next is checked where it's chosen); with
 * `requireAccount`, `account` (the CLI's active account when absent) must be
 * signed in with the permissions team workspaces need, as when resuming setup.
 */
export function TeamPrerequisites({
  onReady,
  account,
  requireAccount = false
}: {
  onReady: (status: TeamEnvStatus) => void
  account?: string
  requireAccount?: boolean
}): JSX.Element {
  const [status, setStatus] = useState<TeamEnvStatus | null>(null)
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function check(): Promise<TeamEnvStatus | null> {
    try {
      const next = await window.api.team.envStatus(account)
      setStatus(next)
      return next
    } catch (reason) {
      setError(teamError(reason, 'Could not check your sign-ins.'))
      return null
    }
  }

  useEffect(() => {
    void check()
  }, [])

  const githubReady = (s: TeamEnvStatus | null): boolean =>
    requireAccount
      ? Boolean(s?.ghSignedIn) && s?.ghMissingScopes.length === 0
      : Boolean(s?.ghAccounts.some((a) => a.signedIn))
  const ready = githubReady(status) && Boolean(status?.azSignedIn)

  useEffect(() => {
    if (ready && status) onReady(status)
  }, [ready, status])

  useEffect(() => {
    if (!waiting) return
    const id = window.setInterval(() => {
      void check().then((next) => {
        if (githubReady(next)) setWaiting(false)
      })
    }, 3000)
    const stop = window.setTimeout(() => setWaiting(false), SIGN_IN_WAIT_MS)
    return () => {
      window.clearInterval(id)
      window.clearTimeout(stop)
    }
  }, [waiting])

  async function signIn(): Promise<void> {
    setError(null)
    const result = requireAccount
      ? await window.api.team.githubSignIn(Boolean(status?.ghSignedIn), false, account)
      : await window.api.team.githubSignIn(false)
    if (!result.ok) {
      setError(result.error ?? 'Could not start GitHub sign-in.')
      return
    }
    setWaiting(true)
  }

  if (!status) {
    return (
      <div className="team-muted">
        <span className="ws-spinner" /> Checking your GitHub and Azure sign-ins…
      </div>
    )
  }

  const signedIn = status.ghAccounts.filter((a) => a.signedIn)
  const ghState: 'ok' | 'warn' | 'error' = !status.ghInstalled
    ? 'error'
    : !requireAccount
      ? signedIn.length
        ? 'ok'
        : 'error'
      : !status.ghSignedIn
        ? 'error'
        : status.ghMissingScopes.length
          ? 'warn'
          : 'ok'
  const others = signedIn.length - 1

  return (
    <div className="team-checks">
      <div className="team-check">
        <span className={`team-check-dot team-check-dot--${ghState}`} />
        <span className="team-check-text">
          <strong>GitHub</strong>
          <div className="team-muted">
            {!status.ghInstalled
              ? 'Install the GitHub CLI (gh) from setup first.'
              : !requireAccount
                ? signedIn.length
                  ? `Signed in as ${signedIn[0].login}${others > 0 ? ` and ${others} more account${others === 1 ? '' : 's'}` : ''}.`
                  : 'Sign in so Fabricator can create and use the team repository.'
                : !status.ghSignedIn
                  ? account
                    ? `Sign in to GitHub as ${account}, the account this workspace uses.`
                    : 'Sign in so Fabricator can create and use the team repository.'
                  : status.ghMissingScopes.length
                    ? `Signed in as ${status.ghUser}. Fabricator also needs permission to manage repositories and their pipelines (${status.ghMissingScopes.join(', ')}).`
                    : `Signed in as ${status.ghUser}.`}
          </div>
        </span>
        {status.ghInstalled && ghState !== 'ok' && (
          <button type="button" className="btn btn--sm btn--primary" onClick={() => void signIn()}>
            {waiting ? 'Waiting…' : requireAccount && status.ghSignedIn ? 'Grant GitHub access' : 'Sign in to GitHub'}
          </button>
        )}
      </div>
      <div className="team-check">
        <span className={`team-check-dot team-check-dot--${status.azSignedIn ? 'ok' : 'error'}`} />
        <span className="team-check-text">
          <strong>Microsoft Entra ID (Azure CLI)</strong>
          <div className="team-muted">
            {status.azSignedIn
              ? `Signed in as ${status.azUser}.`
              : 'Sign in to Azure from setup so Fabricator can create the deploy identity.'}
          </div>
        </span>
      </div>
      {waiting && (
        <p className="team-muted">
          Finish signing in in the terminal window, then come back. This updates automatically.
        </p>
      )}
      {error && <div className="alert alert--error">{error}</div>}
      {!ready && !waiting && (
        <div>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => void check()}>
            Check again
          </button>
        </div>
      )}
    </div>
  )
}
