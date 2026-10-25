import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { AuthStatus, ProcLogEvent, ProcResult, RayfinStudioApi } from '@shared/ipc'
import { OverlayProvider } from '../overlay'
import AccountsModal from './AccountsModal'

const CONTOSO = '72f988bf-86f1-41af-91ab-2d7cd011db47'
const FABRIKAM = 'aaaaaaaa-0000-0000-0000-000000000000'

const auth: AuthStatus = {
  copilot: { signedIn: true, user: 'octocat', host: 'https://github.com' },
  rayfin: { signedIn: true, user: 'alice@contoso.com', tenant: CONTOSO },
  az: { signedIn: true, user: 'alice@contoso.com', tenant: CONTOSO, tenantName: 'Contoso' }
}

const ok = { ok: true, exitCode: 0 }

function installApi() {
  let log: ((event: ProcLogEvent) => void) | undefined
  const api = {
    accounts: {
      fabric: vi.fn<RayfinStudioApi['accounts']['fabric']>().mockResolvedValue({
        accounts: [
          { id: 'shared', user: 'alice@contoso.com', tenant: CONTOSO, active: true, shared: true },
          {
            id: 'f'.repeat(32),
            user: 'alice@fabrikam.com',
            tenant: FABRIKAM,
            active: false,
            shared: false
          }
        ],
        sharedTokenStore: false
      }),
      addFabric: vi.fn<RayfinStudioApi['accounts']['addFabric']>().mockResolvedValue(ok),
      useFabric: vi.fn<RayfinStudioApi['accounts']['useFabric']>().mockResolvedValue(ok),
      signOutFabric: vi.fn<RayfinStudioApi['accounts']['signOutFabric']>().mockResolvedValue(ok),
      azure: vi.fn<RayfinStudioApi['accounts']['azure']>().mockResolvedValue({
        azInstalled: true,
        accounts: [
          {
            user: 'alice@contoso.com',
            tenant: CONTOSO,
            tenantName: 'Contoso',
            subscription: CONTOSO,
            active: true
          },
          {
            user: 'alice@fabrikam.com',
            tenant: FABRIKAM,
            tenantName: 'Fabrikam',
            subscription: '22222222-2222-2222-2222-222222222222',
            active: false
          }
        ]
      }),
      useAzure: vi.fn<RayfinStudioApi['accounts']['useAzure']>().mockResolvedValue(ok),
      signOutAzure: vi.fn<RayfinStudioApi['accounts']['signOutAzure']>().mockResolvedValue(ok)
    },
    auth: {
      loginAz: vi.fn<RayfinStudioApi['auth']['loginAz']>().mockResolvedValue(ok),
      logoutAz: vi.fn<RayfinStudioApi['auth']['logoutAz']>().mockResolvedValue(ok),
      loginCopilot: vi.fn<RayfinStudioApi['auth']['loginCopilot']>().mockResolvedValue(ok),
      logoutCopilot: vi.fn<RayfinStudioApi['auth']['logoutCopilot']>().mockResolvedValue(ok)
    },
    github: {
      accounts: vi.fn<RayfinStudioApi['github']['accounts']>().mockResolvedValue({
        ghInstalled: true,
        accounts: [
          { login: 'octo', active: true, signedIn: true },
          { login: 'octo_contoso', active: false, signedIn: true }
        ]
      }),
      addAccount: vi.fn<RayfinStudioApi['github']['addAccount']>().mockResolvedValue(ok),
      switchAccount: vi.fn<RayfinStudioApi['github']['switchAccount']>().mockResolvedValue(ok),
      signOutAccount: vi.fn<RayfinStudioApi['github']['signOutAccount']>().mockResolvedValue(ok)
    },
    openExternal: vi.fn(() => Promise.resolve()),
    onProcLog: vi.fn((callback: (event: ProcLogEvent) => void) => {
      log = callback
      return () => {}
    })
  }
  ;(window as unknown as { api: unknown }).api = api
  return { api, emit: (event: ProcLogEvent) => log?.(event) }
}

function renderModal(overrides: Partial<ComponentProps<typeof AccountsModal>> = {}) {
  const props: ComponentProps<typeof AccountsModal> = {
    auth,
    onAuthChanged: vi.fn().mockResolvedValue(undefined),
    fabric: {
      busy: false,
      signingIn: false,
      signingOut: false,
      canRefresh: true,
      projectId: 'p1',
      onSignIn: vi.fn(),
      onSignOut: vi.fn(),
      onRefresh: vi.fn()
    },
    onReviewSetup: vi.fn(),
    onClose: vi.fn(),
    ...overrides
  }
  render(
    <OverlayProvider>
      <AccountsModal {...props} />
    </OverlayProvider>
  )
  return props
}

const card = (name: string): HTMLElement => screen.getByRole('region', { name })

/** The button, once the action before it has finished. */
async function enabled(scope: HTMLElement, name: string): Promise<HTMLButtonElement> {
  const button = (await within(scope).findByRole('button', { name })) as HTMLButtonElement
  await waitFor(() => expect(button.disabled).toBe(false))
  return button
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  delete (window as unknown as { api?: unknown }).api
})

describe('AccountsModal', () => {
  it('shows who each account is signed in as, and to which organization', async () => {
    installApi()
    renderModal()
    expect(screen.getByRole('dialog', { name: 'Accounts' })).toBeTruthy()
    expect(within(card('GitHub Copilot')).getByText('octocat')).toBeTruthy()
    expect(within(card('GitHub Copilot')).getByText('github.com')).toBeTruthy()
    expect(within(card('Microsoft Fabric')).getByText('alice@contoso.com')).toBeTruthy()
    expect(within(card('Microsoft Fabric')).getByText('Contoso')).toBeTruthy()
    expect(within(card('Azure CLI')).getByText('alice@contoso.com')).toBeTruthy()
    expect(await within(card('GitHub')).findByText('octo_contoso')).toBeTruthy()
    expect(within(card('GitHub')).getByText('Default')).toBeTruthy()
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('offers one way to sign in to each service before any account is signed in', async () => {
    const { api } = installApi()
    api.accounts.fabric.mockResolvedValue({ accounts: [], sharedTokenStore: false })
    api.accounts.azure.mockResolvedValue({ azInstalled: true, accounts: [] })
    api.github.accounts.mockResolvedValue({ ghInstalled: true, accounts: [] })
    renderModal({
      auth: { copilot: { signedIn: false }, rayfin: { signedIn: false }, az: { signedIn: false } }
    })
    await within(card('GitHub')).findByRole('button', { name: 'Sign in to GitHub' })
    expect(screen.getByRole('button', { name: 'Sign in to GitHub Copilot' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sign in to Microsoft Fabric' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add account' })).toBeNull()

    const azure = card('Azure CLI')
    fireEvent.click(within(azure).getByRole('button', { name: 'Sign in to the Azure CLI' }))
    fireEvent.click(within(azure).getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(api.auth.loginAz).toHaveBeenCalledWith(undefined))
  })

  it('warns when Fabric and the Azure CLI use different organizations, and switches it to match', async () => {
    const { api } = installApi()
    renderModal({ auth: { ...auth, rayfin: { ...auth.rayfin, tenant: FABRIKAM } } })
    const note = screen.getByRole('note')
    expect(note.textContent).toContain('use one organization for both')
    fireEvent.click(
      await within(note).findByRole('button', { name: 'Use alice@fabrikam.com in the Azure CLI' })
    )
    await waitFor(() =>
      expect(api.accounts.useAzure).toHaveBeenCalledWith(
        'alice@fabrikam.com',
        '22222222-2222-2222-2222-222222222222'
      )
    )
    // Fabric's organization is named by the Azure CLI account in it.
    expect(note.textContent).toContain('Fabric uses Fabrikam and the Azure CLI uses Contoso')
  })

  it('offers to sign the Azure CLI in to Fabric’s organization when it has no account there', async () => {
    const { api } = installApi()
    const elsewhere = 'bbbbbbbb-0000-0000-0000-000000000000'
    renderModal({ auth: { ...auth, rayfin: { ...auth.rayfin, tenant: elsewhere } } })
    await waitFor(() => expect(api.accounts.azure).toHaveBeenCalled())
    fireEvent.click(
      within(screen.getByRole('note')).getByRole('button', {
        name: 'Sign in to Fabric’s organization in the Azure CLI'
      })
    )
    const form = within(card('Azure CLI')).getByRole('form', { name: 'Add an Azure CLI account' })
    expect((within(form).getByLabelText('Organization (optional)') as HTMLInputElement).value).toBe(
      elsewhere
    )
    fireEvent.click(within(form).getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(api.auth.loginAz).toHaveBeenCalledWith(elsewhere))
  })

  it('switches to, adds, and signs out of other Fabric accounts', async () => {
    const { api } = installApi()
    const props = renderModal()
    const fabric = card('Microsoft Fabric')
    const other = await within(fabric).findByRole('list', { name: 'Other Fabric accounts' })
    expect(within(other).getByText('alice@fabrikam.com')).toBeTruthy()

    fireEvent.click(await enabled(other, 'Use: alice@fabrikam.com'))
    await waitFor(() => expect(api.accounts.useFabric).toHaveBeenCalledWith('f'.repeat(32)))
    await waitFor(() => expect(props.onAuthChanged).toHaveBeenCalledTimes(1))

    fireEvent.click(await enabled(other, 'Sign out of alice@fabrikam.com'))
    expect(within(other).getByText('Sign out of alice@fabrikam.com?')).toBeTruthy()
    fireEvent.click(within(other).getByRole('button', { name: 'Sign out' }))
    await waitFor(() =>
      expect(api.accounts.signOutFabric).toHaveBeenCalledWith('f'.repeat(32), 'p1')
    )

    fireEvent.click(await enabled(fabric, 'Add account'))
    const form = within(fabric).getByRole('form', { name: 'Add a Fabric account' })
    fireEvent.change(within(form).getByLabelText('Organization (optional)'), {
      target: { value: ' contoso.onmicrosoft.com ' }
    })
    fireEvent.click(within(form).getByRole('button', { name: 'Continue' }))
    await waitFor(() =>
      expect(api.accounts.addFabric).toHaveBeenCalledWith('contoso.onmicrosoft.com', 'p1')
    )
    await waitFor(() => expect(within(fabric).queryByRole('form')).toBeNull())
  })

  it('leaves the account in use to the workbench, which coordinates it with deploys', () => {
    installApi()
    const props = renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out of Microsoft Fabric' }))
    expect(props.fabric.onSignOut).toHaveBeenCalledTimes(1)
    fireEvent.click(
      within(card('Microsoft Fabric')).getByRole('button', { name: 'Refresh sign-in' })
    )
    expect(props.fabric.onRefresh).toHaveBeenCalledTimes(1)
  })

  it('keeps Fabric account changes waiting while a deploy runs', async () => {
    installApi()
    renderModal({
      fabric: {
        busy: true,
        signingIn: false,
        signingOut: false,
        canRefresh: true,
        onSignIn: vi.fn(),
        onSignOut: vi.fn(),
        onRefresh: vi.fn()
      }
    })
    const fabric = card('Microsoft Fabric')
    await within(fabric).findByRole('list', { name: 'Other Fabric accounts' })
    expect(
      (within(fabric).getByRole('button', { name: 'Add account' }) as HTMLButtonElement).disabled
    ).toBe(true)
    expect(
      (within(fabric).getByRole('button', { name: 'Use: alice@fabrikam.com' }) as HTMLButtonElement)
        .disabled
    ).toBe(true)
  })

  it('says when signing out of one Fabric account signs them all out', async () => {
    const { api } = installApi()
    api.accounts.fabric.mockResolvedValue({
      accounts: [
        { id: 'shared', user: 'alice@contoso.com', tenant: CONTOSO, active: true, shared: true },
        {
          id: 'f'.repeat(32),
          user: 'alice@fabrikam.com',
          tenant: FABRIKAM,
          active: false,
          shared: false
        }
      ],
      sharedTokenStore: true
    })
    renderModal()
    expect(await within(card('Microsoft Fabric')).findByText(/signs all of them out/)).toBeTruthy()
  })

  it('switches to, adds, and signs out of Azure CLI accounts', async () => {
    const { api } = installApi()
    const props = renderModal()
    const azure = card('Azure CLI')
    const other = await within(azure).findByRole('list', { name: 'Other Azure accounts' })
    expect(within(other).getByText(/Fabrikam/)).toBeTruthy()

    fireEvent.click(await enabled(other, 'Use: alice@fabrikam.com'))
    await waitFor(() =>
      expect(api.accounts.useAzure).toHaveBeenCalledWith(
        'alice@fabrikam.com',
        '22222222-2222-2222-2222-222222222222'
      )
    )
    await waitFor(() => expect(props.onAuthChanged).toHaveBeenCalled())

    fireEvent.click(await enabled(azure, 'Sign out of the Azure CLI'))
    await waitFor(() => expect(api.accounts.signOutAzure).toHaveBeenCalledWith('alice@contoso.com'))

    fireEvent.click(await enabled(azure, 'Add account'))
    const form = within(azure).getByRole('form', { name: 'Add an Azure CLI account' })
    fireEvent.click(within(form).getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(api.auth.loginAz).toHaveBeenCalledWith(undefined))
  })

  it('shows a failed switch on the Azure card', async () => {
    const { api } = installApi()
    api.accounts.useAzure.mockResolvedValueOnce({
      ok: false,
      exitCode: 1,
      error: 'Another account shares its subscription.'
    })
    const props = renderModal()
    const azure = card('Azure CLI')
    fireEvent.click(await within(azure).findByRole('button', { name: 'Use: alice@fabrikam.com' }))
    expect((await within(azure).findByRole('alert')).textContent).toBe(
      'Another account shares its subscription.'
    )
    expect(props.onAuthChanged).not.toHaveBeenCalled()
  })

  it('shows the device code while signing in to Copilot', async () => {
    const { api, emit } = installApi()
    let finish!: (value: ProcResult) => void
    api.auth.loginCopilot.mockReturnValueOnce(
      new Promise<ProcResult>((resolve) => (finish = resolve))
    )
    const props = renderModal({ auth: { ...auth, copilot: { signedIn: false } } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to GitHub Copilot' }))
    act(() =>
      emit({
        channel: 'login:copilot',
        stream: 'stdout',
        data: 'Enter ABCD-EFGH at github.com/login/device\n'
      })
    )

    const copilot = card('GitHub Copilot')
    expect(within(copilot).getByText('ABCD-EFGH')).toBeTruthy()
    fireEvent.click(within(copilot).getByRole('button', { name: 'Open GitHub' }))
    expect(api.openExternal).toHaveBeenCalledWith('https://github.com/login/device')
    await act(async () => finish({ ok: true, exitCode: 0 }))
    expect(props.onAuthChanged).toHaveBeenCalledTimes(1)
    expect(within(copilot).queryByText('ABCD-EFGH')).toBeNull()
  })

  it('makes another GitHub account the default and signs one out after confirming', async () => {
    const { api } = installApi()
    renderModal()
    const github = card('GitHub')
    fireEvent.click(await enabled(github, 'Make default: octo_contoso'))
    await waitFor(() => expect(api.github.switchAccount).toHaveBeenCalledWith('octo_contoso'))

    fireEvent.click(await enabled(github, 'Sign out of octo'))
    fireEvent.click(within(github).getByRole('button', { name: 'Cancel' }))
    expect(api.github.signOutAccount).not.toHaveBeenCalled()
    fireEvent.click(await enabled(github, 'Sign out of octo'))
    fireEvent.click(within(github).getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(api.github.signOutAccount).toHaveBeenCalledWith('octo'))
  })

  it('offers setup when the GitHub CLI is missing', async () => {
    const { api } = installApi()
    api.github.accounts.mockResolvedValue({ ghInstalled: false, accounts: [] })
    const props = renderModal()
    fireEvent.click(
      await within(card('GitHub')).findByRole('button', { name: 'Install from setup' })
    )
    expect(props.onReviewSetup).toHaveBeenCalledTimes(1)
  })

  it('re-checks every account and closes on Escape', async () => {
    const { api } = installApi()
    const props = renderModal()
    await waitFor(() => expect(api.github.accounts).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Re-check' }))
    await waitFor(() => expect(props.onAuthChanged).toHaveBeenCalledTimes(1))
    expect(api.github.accounts).toHaveBeenCalledTimes(2)
    expect(api.accounts.fabric.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(api.accounts.azure.mock.calls.length).toBeGreaterThanOrEqual(2)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })
})
