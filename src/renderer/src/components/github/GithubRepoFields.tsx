import { useEffect, useId, useRef, useState, type JSX } from 'react'
import type { GithubAccountsResult, ProjectNameCheck, TeamOwner } from '@shared/ipc'
import { useTranslation } from '../../i18n'
import './githubRepo.css'

/** Who creates a project's GitHub repository, who owns it, and who can see it. */
export interface GithubRepoChoice {
  /** The GitHub CLI account that creates it, and that later gets and pushes changes. */
  account: string
  /** The account itself, or one of its organizations. */
  owner: string
  private: boolean
}

/** Where the fields start: no account or owner picked yet, private. */
export const NEW_GITHUB_REPO: GithubRepoChoice = { account: '', owner: '', private: true }

const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/

/** Whether GitHub takes `name` for a repository as it is (the backend checks the same). */
export function validRepoName(name: string): boolean {
  return REPO_NAME.test(name) && name !== '.' && name !== '..' && !/\.git$/i.test(name)
}

/** A folder's name as GitHub takes it for a repository: other characters become hyphens. */
export function githubRepoName(folder: string): string {
  return folder
    .trim()
    .replace(/\.git$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 100)
}

/** How long to keep checking for a sign-in finished in the terminal. */
const SIGN_IN_WAIT_MS = 5 * 60_000
const SIGN_IN_POLL_MS = 3000

const sameLogin = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

const errorText = (reason: unknown, fallback: string): string =>
  reason instanceof Error && reason.message
    ? reason.message
    : typeof reason === 'string' && reason.trim()
      ? reason
      : fallback

interface Props {
  /** The repository's name on GitHub. */
  name: string
  /** Makes the name editable; without it, the name follows something else, such as the project's folder. */
  onNameChange?: (name: string) => void
  value: GithubRepoChoice
  onChange: (next: GithubRepoChoice) => void
  /** Whether the repository can be created as chosen: an account to create it as, an owner, and a name GitHub takes. */
  onReady: (ready: boolean) => void
  disabled?: boolean
  /** Smaller controls, for a popover. */
  compact?: boolean
  /** Open setup, to install the GitHub CLI. */
  onReviewSetup?: () => void
}

/**
 * A new GitHub repository for a project: the GitHub CLI account that creates it
 * (signing in to GitHub when there's none), whether that account or one of its
 * organizations owns it, whether it's private, and its name, checked with GitHub.
 */
export default function GithubRepoFields({
  name,
  onNameChange,
  value,
  onChange,
  onReady,
  disabled = false,
  compact = false,
  onReviewSetup
}: Props): JSX.Element {
  const { t } = useTranslation('accounts')
  const accountId = useId()
  const ownerId = useId()
  const nameId = useId()
  const visibilityId = useId()
  const [accounts, setAccounts] = useState<GithubAccountsResult | null>(null)
  const [owners, setOwners] = useState<{
    account: string
    list: TeamOwner[]
    error?: string
  } | null>(null)
  /** Bumped to list the owners again. */
  const [ownersTry, setOwnersTry] = useState(0)
  const [check, setCheck] = useState<(ProjectNameCheck & { key: string }) | null>(null)
  /** A terminal sign-in is open: the accounts that were signed in before it. */
  const [waiting, setWaiting] = useState<string[] | null>(null)
  const [signInError, setSignInError] = useState<string | null>(null)
  const valueRef = useRef(value)
  valueRef.current = value

  const signedIn = (accounts?.accounts ?? []).filter((a) => a.signedIn)

  async function loadAccounts(): Promise<void> {
    try {
      setAccounts(await window.api.github.accounts())
    } catch (reason) {
      setAccounts({
        ghInstalled: true,
        accounts: [],
        error: errorText(reason, t('githubRepo.errors.listAccounts'))
      })
    }
  }

  useEffect(() => {
    void loadAccounts()
  }, [])

  // Create as the GitHub CLI's active account, or the first one signed in.
  useEffect(() => {
    if (!accounts || signedIn.some((a) => sameLogin(a.login, valueRef.current.account))) return
    const pick = signedIn.find((a) => a.active) ?? signedIn[0]
    if (pick) onChange({ ...valueRef.current, account: pick.login, owner: '' })
  }, [accounts])

  // The owners follow the account, the account itself first.
  useEffect(() => {
    const account = value.account
    if (!account) return
    let stale = false
    setOwners(null)
    window.api.github.owners(account).then(
      (result) => {
        if (stale) return
        setOwners({
          account,
          list: result.owners,
          error: result.ok ? undefined : (result.error ?? t('githubRepo.errors.listOwners'))
        })
        const current = valueRef.current
        const first = result.owners[0]?.login
        if (first && !result.owners.some((o) => sameLogin(o.login, current.owner))) {
          onChange({ ...current, owner: first })
        }
      },
      (reason) => {
        if (!stale) {
          setOwners({
            account,
            list: [],
            error: errorText(reason, t('githubRepo.errors.listOwners'))
          })
        }
      }
    )
    return () => {
      stale = true
    }
  }, [value.account, ownersTry])

  // Whether GitHub has the name already, shortly after it stops changing.
  const nameValid = validRepoName(name)
  const key = `${value.account}\u0000${value.owner}\u0000${name}`
  useEffect(() => {
    if (!value.account || !value.owner || !nameValid) return
    let stale = false
    const timer = window.setTimeout(() => {
      window.api.github.checkRepo(value.account, value.owner, name).then(
        (result) => {
          if (!stale) setCheck({ ...result, key })
        },
        // A check that couldn't run doesn't stop creating, which says what's wrong.
        () => {
          if (!stale) setCheck({ ok: true, key })
        }
      )
    }, 400)
    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [key, nameValid])
  const checked = check?.key === key ? check : null

  const owner =
    owners?.account === value.account
      ? owners.list.find((o) => sameLogin(o.login, value.owner))
      : undefined
  const privateBlocked = Boolean(owner?.isOrg && value.private && owner.canCreate === false)
  const ready = Boolean(owner) && nameValid && !(checked && !checked.ok) && !privateBlocked
  useEffect(() => {
    onReady(ready)
  }, [ready])

  async function signIn(): Promise<void> {
    setSignInError(null)
    const before = signedIn.map((a) => a.login.toLowerCase())
    try {
      const result = await window.api.github.addAccount()
      if (!result.ok) {
        setSignInError(result.error ?? t('githubRepo.errors.signIn'))
        return
      }
      setWaiting(before)
    } catch (reason) {
      setSignInError(errorText(reason, t('githubRepo.errors.signIn')))
    }
  }

  // While the terminal is open, look for the account it signs in, and use it.
  useEffect(() => {
    if (!waiting) return
    const before = waiting
    const started = Date.now()
    let inFlight = false
    const id = window.setInterval(() => {
      if (Date.now() - started > SIGN_IN_WAIT_MS) {
        setWaiting(null)
        return
      }
      if (inFlight) return
      inFlight = true
      window.api.github
        .accounts()
        .then(
          (next) => {
            setAccounts(next)
            const added = next.accounts.find(
              (a) => a.signedIn && !before.includes(a.login.toLowerCase())
            )
            if (added) {
              setWaiting(null)
              onChange({ ...valueRef.current, account: added.login, owner: '' })
            }
          },
          () => {}
        )
        .finally(() => {
          inFlight = false
        })
    }, SIGN_IN_POLL_MS)
    return () => window.clearInterval(id)
  }, [waiting])

  const className = `gh-repo${compact ? ' gh-repo--compact' : ''}`
  const waitingNote = waiting && (
    <p className="gh-repo-note">
      {t('githubRepo.finishInTerminal')}{' '}
      <button type="button" className="link-btn" onClick={() => setWaiting(null)}>
        {t('stopWaiting')}
      </button>
    </p>
  )
  const problem = (text?: string | null, retry?: () => void): JSX.Element | null =>
    text ? (
      <span className="field-hint field-hint--warn gh-repo-problem" role="alert">
        {text}
        {retry && (
          <button type="button" className="link-btn" disabled={disabled} onClick={retry}>
            {t('actions.tryAgain')}
          </button>
        )}
      </span>
    ) : null

  if (!accounts) {
    return (
      <div className={className}>
        <span className="gh-repo-status" role="status">
          <span className="ws-spinner" aria-hidden="true" />
          {t('githubRepo.checking')}
        </span>
      </div>
    )
  }

  if (!accounts.ghInstalled) {
    return (
      <div className={className}>
        <p className="gh-repo-note">
          {t('githubRepo.noCli')}{' '}
          {onReviewSetup && (
            <button type="button" className="link-btn" disabled={disabled} onClick={onReviewSetup}>
              {t('installFromSetup')}
            </button>
          )}
        </p>
      </div>
    )
  }

  if (signedIn.length === 0) {
    return (
      <div className={className}>
        <div className="gh-repo-signin">
          <span className="gh-repo-note">{t('githubRepo.signInFirst')}</span>
          <button
            type="button"
            className="btn btn--sm"
            disabled={disabled || Boolean(waiting)}
            onClick={() => void signIn()}
          >
            {waiting ? t('githubRepo.waiting') : t('githubSignIn')}
          </button>
        </div>
        {waitingNote}
        {problem(
          signInError ?? accounts.error,
          signInError ? undefined : () => void loadAccounts()
        )}
      </div>
    )
  }

  return (
    <div className={className}>
      <div className="gh-repo-field">
        <label className="gh-repo-label" htmlFor={accountId}>
          {t('githubRepo.account')}
        </label>
        <div className="gh-repo-account">
          <select
            id={accountId}
            className="field-input"
            value={signedIn.find((a) => sameLogin(a.login, value.account))?.login ?? ''}
            disabled={disabled || Boolean(waiting)}
            onChange={(e) => onChange({ ...value, account: e.target.value, owner: '' })}
          >
            {signedIn.map((a) => (
              <option key={a.login} value={a.login}>
                {a.login}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="link-btn"
            disabled={disabled || Boolean(waiting)}
            onClick={() => void signIn()}
          >
            {waiting ? t('githubRepo.waiting') : t('addAccount')}
          </button>
        </div>
      </div>
      {waitingNote}
      {problem(signInError)}

      <div className="gh-repo-row">
        <div className="gh-repo-field gh-repo-field--grow">
          <label className="gh-repo-label" htmlFor={ownerId}>
            {t('githubRepo.owner')}
          </label>
          {owners?.account === value.account ? (
            <select
              id={ownerId}
              className="field-input"
              value={owner?.login ?? ''}
              disabled={disabled || owners.list.length === 0}
              onChange={(e) => onChange({ ...value, owner: e.target.value })}
            >
              {owners.list.map((o) => (
                <option key={o.login} value={o.login}>
                  {o.isOrg ? o.login : t('githubRepo.you', { login: o.login })}
                </option>
              ))}
            </select>
          ) : (
            <select id={ownerId} className="field-input" disabled>
              <option>{t('status.loading')}</option>
            </select>
          )}
        </div>
        <div className="gh-repo-field">
          <span className="gh-repo-label" id={visibilityId}>
            {t('githubRepo.visibility')}
          </span>
          <div className="seg" role="radiogroup" aria-labelledby={visibilityId}>
            {[true, false].map((isPrivate) => (
              <button
                key={String(isPrivate)}
                type="button"
                role="radio"
                aria-checked={value.private === isPrivate}
                className={`seg-btn${value.private === isPrivate ? ' seg-btn--active' : ''}`}
                disabled={disabled}
                onClick={() => onChange({ ...value, private: isPrivate })}
              >
                {isPrivate ? t('githubRepo.private') : t('githubRepo.public')}
              </button>
            ))}
          </div>
        </div>
      </div>
      {owners?.account === value.account && problem(owners.error, () => setOwnersTry((n) => n + 1))}
      {privateBlocked && problem(t('githubRepo.privateBlocked', { owner: value.owner }))}

      {onNameChange && (
        <div className="gh-repo-field">
          <label className="gh-repo-label" htmlFor={nameId}>
            {t('githubRepo.name')}
          </label>
          <input
            id={nameId}
            className="field-input"
            value={name}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            disabled={disabled}
            aria-invalid={!nameValid || (checked && !checked.ok) ? true : undefined}
            onChange={(e) => onNameChange(e.target.value)}
          />
        </div>
      )}
      <span className="gh-repo-where">
        github.com/{value.owner || '…'}/{name || '…'}
      </span>
      {!nameValid
        ? (name.trim() || onNameChange) &&
          problem(name.trim() ? t('githubRepo.invalidName') : t('githubRepo.noName'))
        : checked && !checked.ok
          ? problem(checked.message ?? t('githubRepo.taken'))
          : checked?.message && <span className="field-hint">{checked.message}</span>}
    </div>
  )
}
