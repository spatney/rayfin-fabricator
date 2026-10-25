import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type JSX,
} from 'react'
import type {
  AuthStatus,
  AzureAccountsResult,
  FabricAccountsResult,
  GithubAccountsResult,
  ProcLogEvent,
  ProcResult
} from '@shared/ipc'
import { useSuppressPreview } from '../overlay'
import { useModalFocus } from '../modalFocus'
import { getCopilotHost, signInToCopilot, signOutOfCopilot } from '../copilotAuth'
import { authErrorMessage } from '../authErrors'
import { deviceCode, tenantLabel, tenantName, tenantsDiffer } from '../accounts'
import { openDocs } from '../docsLinks'
import CopilotHostInput from './CopilotHostInput'
import { CopilotLogo } from './brand-icons'
import { Codicon } from './icons'
import { CopyButton } from './chat/CopyButton'
import { AccountCard, Foot, Row, errorLine, type CardState } from './accounts/AccountParts'
import { ModelProviders } from './accounts/ModelProviders'
import azureSvg from '../assets/brands/azure.svg'
import fabricSvg from '../assets/brands/fabric.svg'

/** The Fabric actions the workbench owns, so they wait for deploys. */
export interface FabricAccountActions {
  /** A Fabric sign-in, sign-out, credential refresh, or deploy is running. */
  busy: boolean
  signingIn: boolean
  signingOut: boolean
  /** Refreshing credentials needs an open project's Rayfin CLI. */
  canRefresh: boolean
  /** The open project, whose Rayfin CLI runs account changes. */
  projectId?: string
  onSignIn: () => void
  onSignOut: () => void
  onRefresh: () => void
}

interface Props {
  auth: AuthStatus
  /** Re-verify every account; rejects when verification fails. */
  onAuthChanged: () => Promise<void> | void
  fabric: FabricAccountActions
  /** Show Model providers (your own API keys), scrolled to when `focus`. */
  modelProviders?: { focus: boolean }
  /** Open setup, e.g. to install the GitHub CLI. */
  onReviewSetup: () => void
  onClose: () => void
}

type Card = 'copilot' | 'fabric' | 'az' | 'github' | 'general'

/** How long to wait for a GitHub sign-in finished in the terminal. */
const GITHUB_WAIT_MS = 5 * 60_000
const GITHUB_POLL_MS = 3000

function stateOf(status: { signedIn: boolean; checking?: boolean; error?: string }): CardState {
  if (status.checking) return 'checking'
  if (status.signedIn) return 'ok'
  return status.error ? 'error' : 'off'
}

/** Fail with the action's error. */
function expectOk(result: ProcResult, fallback: string): void {
  if (!result.ok) throw new Error(result.error || fallback)
}

/**
 * Every account Fabricator uses, in one place: who you're signed in as (and to
 * which organization), and signing in to, switching between, and signing out of
 * GitHub Copilot, Microsoft Fabric, Azure CLI and GitHub accounts without
 * leaving the app.
 */
export default function AccountsModal({
  auth,
  onAuthChanged,
  fabric,
  modelProviders,
  onReviewSetup,
  onClose
}: Props): JSX.Element {
  useSuppressPreview()
  const titleId = useId()
  const dialogRef = useModalFocus<HTMLDivElement>()
  const mountedRef = useRef(true)
  /** The running action, e.g. `copilot:in` or `azure:use:alice@contoso.com`. One at a time. */
  const [action, setAction] = useState<string | null>(null)
  const [errors, setErrors] = useState<Partial<Record<Card, string>>>({})
  const [log, setLog] = useState('')
  const logChannel = useRef<string | null>(null)
  const [host, setHost] = useState(
    () => auth.copilot.host?.replace(/^https:\/\//, '') ?? getCopilotHost()
  )
  const [fabricAccounts, setFabricAccounts] = useState<FabricAccountsResult | null>(null)
  const [azureAccounts, setAzureAccounts] = useState<AzureAccountsResult | null>(null)
  const [github, setGithub] = useState<GithubAccountsResult | null>(null)
  const [waitingForGithub, setWaitingForGithub] = useState(false)
  /** The account row asking to confirm its sign-out, e.g. `github:octo`. */
  const [confirming, setConfirming] = useState<string | null>(null)
  /** The service whose Add account form is open, and an organization to fill in. */
  const [adding, setAdding] = useState<{ service: 'fabric' | 'az'; tenant?: string } | null>(null)
  const pollRef = useRef<number | null>(null)

  const busy = action !== null

  const stopWaiting = useCallback((): void => {
    if (pollRef.current !== null) window.clearInterval(pollRef.current)
    pollRef.current = null
    setWaitingForGithub(false)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (pollRef.current !== null) window.clearInterval(pollRef.current)
    }
  }, [])

  useEffect(
    () =>
      window.api.onProcLog((event: ProcLogEvent) => {
        if (event.channel === logChannel.current)
          setLog((previous) => (previous + event.data).slice(-8000))
      }),
    []
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const loadFabric = useCallback(async (): Promise<void> => {
    try {
      const next = await window.api.accounts.fabric()
      if (mountedRef.current) setFabricAccounts(next)
    } catch (reason) {
      if (mountedRef.current) {
        setErrors((all) => ({
          ...all,
          fabric: authErrorMessage(reason, 'Could not list your Fabric accounts.')
        }))
      }
    }
  }, [])

  const loadAzure = useCallback(async (): Promise<void> => {
    try {
      const next = await window.api.accounts.azure()
      if (mountedRef.current) setAzureAccounts(next)
    } catch (reason) {
      if (mountedRef.current) {
        setAzureAccounts({
          azInstalled: true,
          accounts: [],
          error: authErrorMessage(reason, 'Could not list your Azure accounts. Please retry.')
        })
      }
    }
  }, [])

  const loadGithub = useCallback(async (): Promise<void> => {
    try {
      const next = await window.api.github.accounts()
      if (mountedRef.current) setGithub(next)
    } catch (reason) {
      if (mountedRef.current) {
        setGithub({
          ghInstalled: true,
          accounts: [],
          error: authErrorMessage(reason, 'Could not list your GitHub accounts. Please retry.')
        })
      }
    }
  }, [])

  useEffect(() => {
    void loadGithub()
  }, [loadGithub])

  // The lists follow the verified accounts, e.g. after a sign-out elsewhere.
  const { copilot, rayfin, az } = auth
  useEffect(() => {
    void loadFabric()
  }, [loadFabric, rayfin.signedIn, rayfin.user, rayfin.tenant])
  useEffect(() => {
    void loadAzure()
  }, [loadAzure, az.signedIn, az.user, az.tenant])

  /** Run one account action, showing its failure on `card`. Resolves whether it worked. */
  async function run(
    name: string,
    card: Card,
    work: () => Promise<void>,
    channel?: string
  ): Promise<boolean> {
    if (action) return false
    setAction(name)
    setConfirming(null)
    setErrors((all) => ({ ...all, [card]: undefined, general: undefined }))
    logChannel.current = channel ?? null
    setLog('')
    try {
      await work()
      return true
    } catch (reason) {
      if (mountedRef.current) {
        setErrors((all) => ({
          ...all,
          [card]: authErrorMessage(reason, 'That didn’t work. Please try again.')
        }))
      }
      return false
    } finally {
      logChannel.current = null
      if (mountedRef.current) setAction(null)
    }
  }

  const copilotIn = (): Promise<boolean> =>
    run(
      'copilot:in',
      'copilot',
      async () => {
        expectOk(await signInToCopilot(host), 'Copilot sign-in did not complete. Please try again.')
        await onAuthChanged()
      },
      'login:copilot'
    )
  const copilotOut = (): Promise<boolean> =>
    run('copilot:out', 'copilot', async () => {
      expectOk(await signOutOfCopilot(), 'Copilot sign-out did not complete. Please try again.')
      await onAuthChanged()
    })

  const fabricAdd = (tenant?: string): Promise<boolean> =>
    run(
      'fabric:add',
      'fabric',
      async () => {
        expectOk(
          await window.api.accounts.addFabric(tenant, fabric.projectId),
          'Fabric sign-in did not complete. Please try again.'
        )
        await Promise.all([Promise.resolve(onAuthChanged()), loadFabric()])
      },
      'login:rayfin'
    )
  const fabricUse = (id: string): Promise<boolean> =>
    run(`fabric:use:${id}`, 'fabric', async () => {
      expectOk(await window.api.accounts.useFabric(id), 'Could not switch Fabric accounts.')
      await Promise.all([Promise.resolve(onAuthChanged()), loadFabric()])
    })
  const fabricSignOut = (id: string): Promise<boolean> =>
    run(`fabric:out:${id}`, 'fabric', async () => {
      expectOk(
        await window.api.accounts.signOutFabric(id, fabric.projectId),
        'Fabric sign-out did not complete. Please try again.'
      )
      await Promise.all([Promise.resolve(onAuthChanged()), loadFabric()])
    })

  const azureAdd = (tenant?: string): Promise<boolean> =>
    run(
      'az:in',
      'az',
      async () => {
        expectOk(
          await window.api.auth.loginAz(tenant),
          'Azure sign-in did not complete. Please try again.'
        )
        await Promise.all([Promise.resolve(onAuthChanged()), loadAzure()])
      },
      'login:az'
    )
  const azureUse = (user: string, subscription: string): Promise<boolean> =>
    run(`az:use:${user}`, 'az', async () => {
      expectOk(
        await window.api.accounts.useAzure(user, subscription),
        'Could not switch Azure accounts.'
      )
      await Promise.all([Promise.resolve(onAuthChanged()), loadAzure()])
    })
  const azureSignOut = (user?: string): Promise<boolean> =>
    run(`az:out:${user ?? ''}`, 'az', async () => {
      expectOk(
        user ? await window.api.accounts.signOutAzure(user) : await window.api.auth.logoutAz(),
        'Azure sign-out did not complete. Please try again.'
      )
      await Promise.all([Promise.resolve(onAuthChanged()), loadAzure()])
    })

  const githubSwitch = (login: string): Promise<boolean> =>
    run(`github:use:${login}`, 'github', async () => {
      expectOk(await window.api.github.switchAccount(login), `Could not switch to ${login}.`)
      await loadGithub()
    })
  const githubSignOut = (login: string): Promise<boolean> =>
    run(`github:out:${login}`, 'github', async () => {
      expectOk(await window.api.github.signOutAccount(login), `Could not sign out of ${login}.`)
      await loadGithub()
    })
  const githubAdd = (): Promise<boolean> =>
    run('github:add', 'github', async () => {
      stopWaiting()
      const known = new Set(
        (github?.accounts ?? []).filter((a) => a.signedIn).map((a) => a.login.toLowerCase())
      )
      expectOk(await window.api.github.addAccount(), 'Could not start GitHub sign-in.')
      if (!mountedRef.current) return
      setWaitingForGithub(true)
      const started = Date.now()
      let inFlight = false
      pollRef.current = window.setInterval(() => {
        if (inFlight) return
        inFlight = true
        void window.api.github
          .accounts()
          .then(
            (next) => {
              if (!mountedRef.current) return
              setGithub(next)
              const arrived = next.accounts.some(
                (a) => a.signedIn && !known.has(a.login.toLowerCase())
              )
              if (arrived || Date.now() - started > GITHUB_WAIT_MS) stopWaiting()
            },
            () => {}
          )
          .finally(() => {
            inFlight = false
          })
      }, GITHUB_POLL_MS)
    })

  const recheck = (): Promise<boolean> =>
    run('recheck', 'general', async () => {
      await Promise.all([Promise.resolve(onAuthChanged()), loadFabric(), loadAzure(), loadGithub()])
    })

  const copilotState = stateOf(copilot)
  const fabricState = stateOf(rayfin)
  const azureState = stateOf(az)
  const githubState: CardState = !github
    ? 'checking'
    : !github.ghInstalled
      ? 'off'
      : github.error
        ? 'error'
        : github.accounts.some((a) => a.signedIn)
          ? 'ok'
          : 'off'
  const otherFabric = (fabricAccounts?.accounts ?? []).filter((a) => !a.active)
  const otherAzure = (azureAccounts?.accounts ?? []).filter((a) => !a.active)
  // Any Azure CLI account in a tenant knows its name, so Fabric's tenant can be
  // named even when the Azure CLI is using another one.
  const known = [az, ...(azureAccounts?.accounts ?? [])]
  const fabricTenant = tenantLabel(rayfin.tenant, ...known)
  const azureTenant = az.tenantName ?? tenantLabel(az.tenant, ...known)
  const mismatch = tenantsDiffer(auth)
  const fabricTenantId = rayfin.tenant?.trim().toLowerCase()
  /** An Azure CLI account in Fabric's organization, to switch to in one click. */
  const matchingAzure = mismatch
    ? otherAzure.find((a) => a.tenant.trim().toLowerCase() === fabricTenantId)
    : undefined
  const fabricOrg = tenantName(rayfin.tenant, ...known)
  const fabricBusy = busy || fabric.busy
  const azMissing = Boolean(azureAccounts && !azureAccounts.azInstalled)
  const ghMissing = Boolean(github && !github.ghInstalled)
  const fabricNote = [
    fabric.signingIn ? 'Finish signing in in the browser window that opened.' : '',
    fabricAccounts?.sharedTokenStore &&
    (fabricAccounts.accounts.length > 1 || otherFabric.length > 0)
      ? 'On this Mac, signing out of one Fabric account signs all of them out until you sign in again.'
      : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal accounts-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={titleId}>Accounts</h2>
          <button className="btn btn--sm btn--ghost" onClick={onClose} aria-label="Close accounts">
            ✕
          </button>
        </div>

        <div className="modal-body accounts-body">
          <p className="modal-sub accounts-lead">
            The accounts Fabricator uses on this computer. Changes apply to all your projects.
          </p>

          {errors.general && (
            <div className="alert alert--error" role="alert">
              {errors.general}
            </div>
          )}

          {mismatch && (
            <div className="acct-warn" role="note">
              <Codicon name="warning" className="acct-warn-ico" />
              <div className="acct-warn-text">
                <p className="acct-warn-title">
                  Fabric and the Azure CLI are in different organizations
                </p>
                <p>
                  Fabric uses <strong>{fabricTenant}</strong> and the Azure CLI uses{' '}
                  <strong>{azureTenant}</strong>. Sharing an app and connecting data look people
                  up through the Azure CLI, so use one organization for both.
                </p>
                {matchingAzure ? (
                  <button
                    className="btn btn--sm"
                    disabled={busy}
                    onClick={() => void azureUse(matchingAzure.user, matchingAzure.subscription)}
                  >
                    {action === `az:use:${matchingAzure.user}`
                      ? 'Switching…'
                      : `Use ${matchingAzure.user} in the Azure CLI`}
                  </button>
                ) : (
                  !azMissing && (
                    <button
                      className="btn btn--sm"
                      disabled={busy}
                      onClick={() => setAdding({ service: 'az', tenant: rayfin.tenant })}
                    >
                      Sign in to {fabricOrg ?? 'Fabric’s organization'} in the Azure CLI
                    </button>
                  )
                )}
              </div>
            </div>
          )}

          <AccountCard
            icon={<CopilotLogo />}
            title="GitHub Copilot"
            purpose="Writes and edits your app’s code."
            state={copilotState}
            action={
              !copilot.signedIn &&
              copilotState !== 'checking' && (
                <button
                  className="btn btn--sm btn--primary"
                  disabled={busy}
                  aria-label="Sign in to GitHub Copilot"
                  onClick={() => void copilotIn()}
                >
                  {action === 'copilot:in' ? 'Waiting for GitHub…' : 'Sign in'}
                </button>
              )
            }
          >
            {copilot.signedIn && (
              <Row name={copilot.user ?? 'Signed in'} meta={copilot.host?.replace(/^https:\/\//, '')}>
                <button
                  className="btn btn--xs btn--ghost acct-quiet"
                  disabled={busy}
                  aria-label="Sign out of GitHub Copilot"
                  title="To use a different GitHub account, sign out, then sign in with that account."
                  onClick={() => void copilotOut()}
                >
                  {action === 'copilot:out' ? 'Signing out…' : 'Sign out'}
                </button>
              </Row>
            )}
            <Foot>
              {!copilot.signedIn && copilotState !== 'checking' && (
                <CopilotHostInput value={host} disabled={busy} onChange={setHost} />
              )}
              {action === 'copilot:in' && <SignInProgress log={log} service="GitHub" />}
              {errorLine(errors.copilot ?? (copilot.signedIn ? undefined : copilot.error))}
            </Foot>
          </AccountCard>

          <AccountCard
            icon={<img className="brand-glyph" src={fabricSvg} alt="" />}
            title="Microsoft Fabric"
            purpose="Deploys, hosts, and shares your apps."
            state={fabricState}
            action={
              rayfin.signedIn
                ? adding?.service !== 'fabric' && (
                    <AddButton disabled={fabricBusy} onClick={() => setAdding({ service: 'fabric' })} />
                  )
                : fabricState !== 'checking' && (
                    <button
                      className="btn btn--sm btn--primary"
                      disabled={fabricBusy}
                      aria-label="Sign in to Microsoft Fabric"
                      onClick={fabric.onSignIn}
                    >
                      {fabric.signingIn ? 'Signing in…' : 'Sign in'}
                    </button>
                  )
            }
          >
            {rayfin.signedIn && (
              <Row
                name={rayfin.user ?? 'Signed in'}
                meta={fabricTenant}
                title={rayfin.tenant}
                badge="In use"
                badgeTitle="Deploying, workspace lists, sharing, and secrets use this account."
              >
                {fabric.canRefresh && (
                  <button
                    className="btn btn--xs btn--ghost"
                    disabled={fabricBusy}
                    onClick={fabric.onRefresh}
                  >
                    Refresh sign-in
                  </button>
                )}
                <button
                  className="btn btn--xs btn--ghost acct-quiet"
                  disabled={fabricBusy}
                  aria-label="Sign out of Microsoft Fabric"
                  onClick={fabric.onSignOut}
                >
                  {fabric.signingOut ? 'Signing out…' : 'Sign out'}
                </button>
              </Row>
            )}
            {otherFabric.length > 0 && (
              <ul className="acct-list" aria-label="Other Fabric accounts">
                {otherFabric.map((account) => (
                  <AccountRow
                    key={account.id}
                    name={account.user}
                    meta={tenantLabel(account.tenant, ...known)}
                    title={account.tenant}
                    busy={fabricBusy}
                    using={action === `fabric:use:${account.id}`}
                    signingOut={action === `fabric:out:${account.id}`}
                    confirming={confirming === `fabric:${account.id}`}
                    onUse={() => void fabricUse(account.id)}
                    onAskSignOut={() => setConfirming(`fabric:${account.id}`)}
                    onCancelSignOut={() => setConfirming(null)}
                    onSignOut={() => void fabricSignOut(account.id)}
                  />
                ))}
              </ul>
            )}
            <Foot>
              {errorLine(errors.fabric ?? (rayfin.signedIn ? undefined : rayfin.error))}
              {action === 'fabric:add' && <SignInProgress log={log} service="Microsoft" />}
              {adding?.service === 'fabric' && (
                <AddAccountForm
                  label="Add a Fabric account"
                  busy={fabricBusy}
                  running={action === 'fabric:add'}
                  onSubmit={async (tenant) => {
                    if (await fabricAdd(tenant)) setAdding(null)
                  }}
                  onCancel={() => setAdding(null)}
                />
              )}
              {fabricNote ? <p className="acct-note">{fabricNote}</p> : null}
            </Foot>
          </AccountCard>

          <AccountCard
            icon={<img className="brand-glyph" src={azureSvg} alt="" />}
            title="Azure CLI"
            purpose="Finds people when you share an app, connects Fabric data, and sets up team workspaces. Shared with your terminal."
            state={azureState}
            action={
              azMissing ? (
                <button className="btn btn--sm" disabled={busy} onClick={onReviewSetup}>
                  Install from setup
                </button>
              ) : (
                adding?.service !== 'az' &&
                azureState !== 'checking' &&
                (az.signedIn || otherAzure.length > 0 ? (
                  <AddButton disabled={busy} onClick={() => setAdding({ service: 'az' })} />
                ) : (
                  <button
                    className="btn btn--sm btn--primary"
                    disabled={busy}
                    aria-label="Sign in to the Azure CLI"
                    onClick={() => setAdding({ service: 'az' })}
                  >
                    Sign in
                  </button>
                ))
              )
            }
          >
            {az.signedIn && (
              <Row
                name={az.user ?? 'Signed in'}
                meta={azureTenant}
                title={az.tenant}
                badge="In use"
                badgeTitle="The Azure CLI uses this account now."
              >
                <button
                  className="btn btn--xs btn--ghost acct-quiet"
                  disabled={busy}
                  aria-label="Sign out of the Azure CLI"
                  onClick={() => void azureSignOut(az.user)}
                >
                  {action === `az:out:${az.user ?? ''}` ? 'Signing out…' : 'Sign out'}
                </button>
              </Row>
            )}
            {otherAzure.length > 0 && (
              <ul className="acct-list" aria-label="Other Azure accounts">
                {otherAzure.map((account) => (
                  <AccountRow
                    key={`${account.user}|${account.tenant}`}
                    name={account.user}
                    meta={account.tenantName ?? tenantLabel(account.tenant)}
                    title={account.tenant}
                    busy={busy}
                    using={action === `az:use:${account.user}`}
                    signingOut={action === `az:out:${account.user}`}
                    confirming={confirming === `az:${account.user}|${account.tenant}`}
                    onUse={() => void azureUse(account.user, account.subscription)}
                    onAskSignOut={() => setConfirming(`az:${account.user}|${account.tenant}`)}
                    onCancelSignOut={() => setConfirming(null)}
                    onSignOut={() => void azureSignOut(account.user)}
                  />
                ))}
              </ul>
            )}
            <Foot>
              {errorLine(
                errors.az ?? (az.signedIn ? undefined : az.error) ?? azureAccounts?.error
              )}
              {action === 'az:in' && <SignInProgress log={log} service="Microsoft" />}
              {adding?.service === 'az' && (
                <AddAccountForm
                  key={adding.tenant ?? ''}
                  label="Add an Azure CLI account"
                  defaultTenant={adding.tenant}
                  busy={busy}
                  running={action === 'az:in'}
                  onSubmit={async (tenant) => {
                    if (await azureAdd(tenant)) setAdding(null)
                  }}
                  onCancel={() => setAdding(null)}
                />
              )}
            </Foot>
          </AccountCard>

          <AccountCard
            icon={<Codicon name="github" />}
            title="GitHub"
            purpose="Clones repositories and runs team workspaces. Optional, and shared with your terminal."
            state={githubState}
            action={
              ghMissing ? (
                <button className="btn btn--sm" disabled={busy} onClick={onReviewSetup}>
                  Install from setup
                </button>
              ) : (
                github &&
                !waitingForGithub &&
                (github.accounts.length > 0 ? (
                  <AddButton disabled={busy} onClick={() => void githubAdd()} />
                ) : (
                  <button
                    className="btn btn--sm"
                    disabled={busy}
                    aria-label="Sign in to GitHub"
                    onClick={() => void githubAdd()}
                  >
                    Sign in
                  </button>
                ))
              )
            }
          >
            {github && !ghMissing && github.accounts.length > 0 && (
              <ul className="acct-list" aria-label="GitHub accounts">
                {github.accounts.map((account) => (
                  <AccountRow
                    key={account.login}
                    name={account.login}
                    badge={account.active ? 'Default' : undefined}
                    badgeTitle="Clone from GitHub and your terminal use this account. Team workspaces remember their own."
                    warning={account.signedIn ? undefined : 'Sign-in expired'}
                    useLabel="Make default"
                    canUse={!account.active && account.signedIn}
                    signOutTitle="Also signs the GitHub CLI out in your terminal."
                    busy={busy}
                    using={action === `github:use:${account.login}`}
                    signingOut={action === `github:out:${account.login}`}
                    confirming={confirming === `github:${account.login}`}
                    onUse={() => void githubSwitch(account.login)}
                    onAskSignOut={() => setConfirming(`github:${account.login}`)}
                    onCancelSignOut={() => setConfirming(null)}
                    onSignOut={() => void githubSignOut(account.login)}
                  />
                ))}
              </ul>
            )}
            <Foot>
              {ghMissing && (
                <p className="acct-note">
                  The GitHub CLI isn’t installed. You only need it to clone repositories or use team
                  workspaces.
                </p>
              )}
              {errorLine(errors.github ?? github?.error)}
              {waitingForGithub && (
                <div className="acct-progress" role="status">
                  <span className="ws-spinner" aria-hidden="true" />
                  <span>
                    Finish signing in in the terminal window that opened. Your default account stays
                    the same.
                  </span>
                  <button className="btn btn--xs btn--ghost" onClick={stopWaiting}>
                    Stop waiting
                  </button>
                </div>
              )}
            </Foot>
          </AccountCard>

          {modelProviders && <ModelProviders focus={modelProviders.focus} />}
        </div>

        <div className="modal-footer">
          <button className="btn btn--sm btn--link accounts-help" onClick={() => openDocs('accounts')}>
            Accounts help
          </button>
          <button className="btn btn--ghost" disabled={busy} onClick={() => void recheck()}>
            {action === 'recheck' ? 'Checking…' : 'Re-check'}
          </button>
          <button className="btn btn--primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

function AddButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }): JSX.Element {
  return (
    <button className="btn btn--sm btn--ghost acct-add-btn" disabled={disabled} onClick={onClick}>
      <Codicon name="add" />
      Add account
    </button>
  )
}

/** One more signed-in account: switch to it, or sign it out (after confirming). */
function AccountRow({
  name,
  meta,
  title,
  badge,
  badgeTitle,
  warning,
  useLabel = 'Use',
  canUse = true,
  signOutTitle,
  busy,
  using,
  signingOut,
  confirming,
  onUse,
  onAskSignOut,
  onCancelSignOut,
  onSignOut
}: {
  name: string
  meta?: string
  title?: string
  badge?: string
  badgeTitle?: string
  warning?: string
  useLabel?: string
  canUse?: boolean
  signOutTitle?: string
  busy: boolean
  using: boolean
  signingOut: boolean
  confirming: boolean
  onUse: () => void
  onAskSignOut: () => void
  onCancelSignOut: () => void
  onSignOut: () => void
}): JSX.Element {
  return (
    <Row
      as="li"
      name={name}
      meta={meta}
      title={title}
      badge={badge}
      badgeTitle={badgeTitle}
      warning={warning}
    >
      {confirming ? (
        <>
          <span className="acct-confirm">Sign out of {name}?</span>
          <button className="btn btn--xs btn--danger" disabled={busy} onClick={onSignOut}>
            Sign out
          </button>
          <button className="btn btn--xs btn--ghost" onClick={onCancelSignOut}>
            Cancel
          </button>
        </>
      ) : (
        <>
          {canUse && (
            <button
              className="btn btn--xs btn--ghost"
              disabled={busy}
              aria-label={`${useLabel}: ${name}`}
              onClick={onUse}
            >
              {using ? 'Switching…' : useLabel}
            </button>
          )}
          <button
            className="btn btn--xs btn--ghost acct-quiet"
            disabled={busy}
            aria-label={`Sign out of ${name}`}
            title={signOutTitle}
            onClick={onAskSignOut}
          >
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </>
      )}
    </Row>
  )
}

/**
 * Sign in to one more account. The organization is optional: leave it empty for
 * the account's own, or name one it's a guest in.
 */
function AddAccountForm({
  label,
  defaultTenant,
  busy,
  running,
  onSubmit,
  onCancel
}: {
  /** Names the form, e.g. "Add a Fabric account". */
  label: string
  /** The organization to start with, e.g. Fabric's when the Azure CLI should match it. */
  defaultTenant?: string
  busy: boolean
  running: boolean
  onSubmit: (tenant?: string) => Promise<void>
  onCancel: () => void
}): JSX.Element {
  const [tenant, setTenant] = useState(defaultTenant ?? '')
  const inputId = useId()

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    await onSubmit(tenant.trim() || undefined)
  }

  return (
    <form className="acct-add" aria-label={label} onSubmit={(event) => void submit(event)}>
      <label className="field-label" htmlFor={inputId}>
        Organization (optional)
      </label>
      <input
        id={inputId}
        className="field-input"
        type="text"
        autoCapitalize="none"
        autoComplete="off"
        spellCheck={false}
        autoFocus
        value={tenant}
        placeholder="contoso.onmicrosoft.com or a tenant ID"
        disabled={running}
        onChange={(event) => setTenant(event.target.value)}
      />
      <span className="field-hint">
        Leave it empty to use your account’s own organization, or enter one you’re a guest in.
      </span>
      <div className="acct-add-actions">
        <button type="submit" className="btn btn--sm btn--primary" disabled={busy}>
          {running ? 'Waiting for Microsoft…' : 'Continue'}
        </button>
        <button type="button" className="btn btn--sm btn--ghost" disabled={running} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

/** A browser or device-code sign-in in progress: the code to enter, when there is one. */
function SignInProgress({ log, service }: { log: string; service: string }): JSX.Element {
  const { code, url } = deviceCode(log)
  const details = log
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-12)
    .join('\n')
  return (
    <div className="acct-progress" role="status">
      <span className="ws-spinner" aria-hidden="true" />
      {code ? (
        <div className="acct-code">
          <span>Enter this code on {service}:</span>
          <code className="acct-code-value">{code}</code>
          <CopyButton text={code} title="Copy code" />
          {url && (
            <button className="btn btn--xs" onClick={() => void window.api.openExternal(url)}>
              Open {service}
            </button>
          )}
        </div>
      ) : (
        <span>Finish signing in to {service} in your browser.</span>
      )}
      {details && (
        <details className="acct-details">
          <summary>Details</summary>
          <pre>{details}</pre>
        </details>
      )}
    </div>
  )
}
