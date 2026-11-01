import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { FabricWorkspace, FabricWorkspacesResult, ProcResult } from '@shared/ipc'
import { deferred } from '../../test/deferred'
import DeploymentCreateForm from './DeploymentCreateForm'

function installApi(loginRayfin: ReturnType<typeof vi.fn> = vi.fn(() => Promise.resolve({ ok: true, exitCode: 0 }))): void {
  ;(window as unknown as { api: unknown }).api = {
    auth: {
      loginRayfin
    },
    fabric: {
      listCapacities: vi.fn(() => Promise.resolve({ ok: true, capacities: [] })),
      createWorkspace: vi.fn(() => Promise.resolve({ ok: true }))
    },
    openExternal: vi.fn()
  }
}

beforeEach(() => {
  installApi()
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('DeploymentCreateForm Fabric reauth', () => {
  it('asks you to sign in without showing why the list needed it as an error', () => {
    render(
      <DeploymentCreateForm
        wsResult={{
          ok: false,
          needsLogin: true,
          error: 'Silent token acquisition failed and interactive login was not allowed'
        }}
        loadingWs={false}
        onReload={vi.fn()}
        onSubmit={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: 'Sign in to Fabric' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/Silent token acquisition/)).toBeNull()
  })

  it('signs in and reloads workspaces when Fabric login is needed', async () => {
    const loginRayfin = vi.fn(() => Promise.resolve({ ok: true, exitCode: 0 }))
    const onReload = vi.fn()
    const onSignedIn = vi.fn()
    installApi(loginRayfin)

    render(
      <DeploymentCreateForm
        wsResult={{ ok: false, needsLogin: true }}
        loadingWs={false}
        onReload={onReload}
        onSignedIn={onSignedIn}
        onSubmit={() => {}}
      />
    )

    expect(screen.getByText('Sign in to Microsoft Fabric to list your workspaces.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Fabric' }))

    await waitFor(() => expect(loginRayfin).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1))
    // The parent must be told a sign-in happened so it can refresh the app-level
    // Fabric auth state (e.g. the app bar's account menu), not just reload workspaces.
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1))
  })

  it('surfaces the failure reason when Fabric sign-in fails (issue #17)', async () => {
    const loginRayfin = vi.fn(() =>
      Promise.resolve({
        ok: false,
        exitCode: 1,
        error: '❌ Login failed: AADSTS50020 user from a different tenant'
      })
    )
    const onReload = vi.fn()
    const onSignedIn = vi.fn()
    installApi(loginRayfin)

    render(
      <DeploymentCreateForm
        wsResult={{ ok: false, needsLogin: true }}
        loadingWs={false}
        onReload={onReload}
        onSignedIn={onSignedIn}
        onSubmit={() => {}}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Fabric' }))

    await waitFor(() => expect(loginRayfin).toHaveBeenCalledTimes(1))
    // The reason is shown inline instead of the button silently resetting.
    await screen.findByText(/Login failed: AADSTS50020/)
    // A failed sign-in must not reload workspaces or claim a successful sign-in.
    expect(onReload).not.toHaveBeenCalled()
    expect(onSignedIn).not.toHaveBeenCalled()
  })

  it('surfaces a rejected sign-in and releases the button without reloading', async () => {
    const loginRayfin = vi.fn().mockRejectedValue('Sign-in bridge disconnected')
    const onReload = vi.fn()
    const onSignedIn = vi.fn()
    installApi(loginRayfin)
    render(
      <DeploymentCreateForm
        wsResult={{ ok: false, needsLogin: true }}
        loadingWs={false}
        onReload={onReload}
        onSignedIn={onSignedIn}
        onSubmit={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Fabric' }))

    expect((await screen.findByRole('alert')).textContent).toContain('Sign-in bridge disconnected')
    expect((screen.getByRole('button', { name: 'Sign in to Fabric' }) as HTMLButtonElement).disabled).toBe(false)
    expect(onReload).not.toHaveBeenCalled()
    expect(onSignedIn).not.toHaveBeenCalled()
  })

  it('waits for auth verification and stops reloading when it rejects', async () => {
    const verification = deferred<void>()
    const onReload = vi.fn()
    render(
      <DeploymentCreateForm
        wsResult={{ ok: false, needsLogin: true }}
        loadingWs={false}
        onReload={onReload}
        onSignedIn={() => verification.promise}
        onSubmit={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Fabric' }))
    await act(async () => {})
    expect(onReload).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: 'Signing in…' }) as HTMLButtonElement).disabled).toBe(true)

    await act(async () => verification.reject(new Error('Could not verify the new session')))
    expect(screen.getByRole('alert').textContent).toContain('Could not verify the new session')
    expect(onReload).not.toHaveBeenCalled()
  })

  it('does not run sign-in callbacks after the form is dismissed', async () => {
    const login = deferred<ProcResult>()
    installApi(vi.fn(() => login.promise))
    const onReload = vi.fn()
    const onSignedIn = vi.fn()
    const view = render(
      <DeploymentCreateForm
        wsResult={{ ok: false, needsLogin: true }}
        loadingWs={false}
        onReload={onReload}
        onSignedIn={onSignedIn}
        onSubmit={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Fabric' }))
    view.unmount()
    await act(async () => login.resolve({ ok: true, exitCode: 0 }))
    expect(onSignedIn).not.toHaveBeenCalled()
    expect(onReload).not.toHaveBeenCalled()
  })

  it.each(['loading', 'expired', 'removed'])('blocks a cached workspace selection when %s', async (failure) => {
    const initial: FabricWorkspacesResult = {
      ok: true,
      workspaces: [{ id: 'ws1', displayName: 'App workspace', capacityKind: 'fabric', eligible: true }]
    }
    const onSubmit = vi.fn()
    const props = { wsResult: initial, loadingWs: false, onReload: vi.fn(), onSubmit }
    const view = render(<DeploymentCreateForm {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /App workspace/ }))
    expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(false)

    view.rerender(
      <DeploymentCreateForm
        {...props}
        loadingWs={failure === 'loading'}
        wsResult={failure === 'loading' ? initial : failure === 'expired' ? { ok: false, needsLogin: true } : { ok: true, workspaces: [] }}
      />
    )
    const submit = screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.click(submit)
    fireEvent.keyDown(screen.getByPlaceholderText('e.g. Production'), { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('surfaces capacity authentication failures and blocks workspace creation', async () => {
    vi.mocked(window.api.fabric.listCapacities).mockResolvedValueOnce({
      ok: false,
      needsLogin: true,
      error: 'Fabric session expired while loading capacities'
    })
    render(
      <DeploymentCreateForm
        wsResult={{ ok: true, workspaces: [] }}
        loadingWs={false}
        onReload={vi.fn()}
        onSubmit={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: '+ New workspace' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Fabric session expired')
    fireEvent.change(screen.getByPlaceholderText('New workspace name'), { target: { value: 'Draft name' } })
    fireEvent.keyDown(screen.getByPlaceholderText('New workspace name'), { key: 'Enter' })
    expect(window.api.fabric.createWorkspace).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Sign in to Fabric' })).toBeTruthy()
  })

  it('reloads capacities after successful recovery without losing the workspace name', async () => {
    vi.mocked(window.api.fabric.listCapacities)
      .mockResolvedValueOnce({ ok: false, needsLogin: true, error: 'Session expired' })
      .mockResolvedValueOnce({
        ok: true,
        capacities: [{ id: 'cap1', displayName: 'Capacity One', kind: 'fabric', eligible: true }]
      })
    render(
      <DeploymentCreateForm
        wsResult={{ ok: true, workspaces: [] }}
        loadingWs={false}
        onReload={vi.fn()}
        onSignedIn={vi.fn()}
        onSubmit={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: '+ New workspace' }))
    await screen.findByRole('alert')
    const name = screen.getByPlaceholderText('New workspace name') as HTMLInputElement
    fireEvent.change(name, { target: { value: 'Keep this workspace name' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Fabric' }))

    await screen.findByRole('option', { name: /Capacity One/ })
    expect(name.value).toBe('Keep this workspace name')
    expect(window.api.fabric.listCapacities).toHaveBeenCalledTimes(2)
    expect(window.api.fabric.createWorkspace).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: 'Create workspace' }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('DeploymentCreateForm replace check', () => {
  const workspaces: FabricWorkspacesResult = {
    ok: true,
    workspaces: [
      { id: 'w1', displayName: 'Sales apps', capacityKind: 'fabric', sku: 'F2', eligible: true },
      { id: 'w2', displayName: 'Development', capacityKind: 'fabric', sku: 'F4', eligible: true }
    ]
  }

  it('holds Publish while checking, and asks before replacing a same-named app', async () => {
    const check = deferred<{ itemName: string; conflict?: string }>()
    const checkTarget = vi.fn((ws: string) =>
      ws === 'w1' ? check.promise : Promise.resolve({ itemName: 'notes' })
    )
    const onSubmit = vi.fn()
    render(
      <DeploymentCreateForm
        wsResult={workspaces}
        loadingWs={false}
        onReload={vi.fn()}
        onSubmit={onSubmit}
        submitLabel="Publish app"
        checkTarget={checkTarget}
      />
    )
    const deploy = screen.getByRole('button', { name: 'Publish app' }) as HTMLButtonElement

    fireEvent.click(screen.getByText('Sales apps'))
    expect(checkTarget).toHaveBeenCalledWith('w1')
    expect(screen.getByRole('status').textContent).toContain('Checking Sales apps')
    expect(deploy.disabled).toBe(true)

    await act(async () => check.resolve({ itemName: 'notes', conflict: 'Notes' }))
    expect(screen.getByRole('alert').textContent).toContain('Sales apps already has an app named “Notes”')
    expect(deploy.disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Replace it anyway' }))
    expect(screen.getByRole('alert').textContent).toContain(
      'Publishing will replace the app “Notes”'
    )
    expect(deploy.disabled).toBe(false)

    // Another workspace without that app publishes normally.
    fireEvent.click(screen.getByText('Development'))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(deploy.disabled).toBe(false)
    fireEvent.click(deploy)
    expect(onSubmit).toHaveBeenCalledWith('Development', 'w2')
  })

  it('never blocks publishing when the check fails', async () => {
    const checkTarget = vi.fn(() => Promise.reject(new Error('offline')))
    render(
      <DeploymentCreateForm
        wsResult={workspaces}
        loadingWs={false}
        onReload={vi.fn()}
        onSubmit={vi.fn()}
        submitLabel="Publish app"
        checkTarget={checkTarget}
      />
    )
    fireEvent.click(screen.getByText('Development'))
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Publish app' }) as HTMLButtonElement).disabled
      ).toBe(false)
    )
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('DeploymentCreateForm recent workspaces', () => {
  const ws = (id: string, displayName: string, eligible = true): FabricWorkspace => ({
    id,
    displayName,
    capacityKind: eligible ? 'fabric' : 'none',
    sku: eligible ? 'F2' : undefined,
    eligible
  })

  /** The eligible list top to bottom: headings as `# Heading`, then workspace names. */
  const listed = (): string[] =>
    [...screen.getByRole('listbox').children].map((el) =>
      el.classList.contains('ws-group-label')
        ? `# ${el.textContent}`
        : (el.querySelector('.ws-item-name')?.textContent ?? '')
    )

  it('lists the eligible workspaces your apps use first, under Recent', () => {
    render(
      <DeploymentCreateForm
        wsResult={{
          ok: true,
          workspaces: [ws('a', 'Analytics'), ws('d', 'Development'), ws('f', 'Finance'), ws('s', 'Sales'), ws('o', 'Old', false)]
        }}
        loadingWs={false}
        onReload={vi.fn()}
        onSubmit={vi.fn()}
        recentWorkspaces={['s', 'o', 'gone', 'development']}
      />
    )
    expect(listed()).toEqual(['# Recent', 'Sales', 'Development', '# Other workspaces', 'Analytics', 'Finance'])
  })

  it('lists at most five, and search narrows both groups', () => {
    const workspaces = 'ABCDEFGHIJKL'.split('').map((c, i) => ws(`w${i}`, `Workspace ${c}`))
    render(
      <DeploymentCreateForm
        wsResult={{ ok: true, workspaces }}
        loadingWs={false}
        onReload={vi.fn()}
        onSubmit={vi.fn()}
        recentWorkspaces={['w11', 'w10', 'w9', 'w8', 'w7', 'w6']}
      />
    )
    expect(listed().slice(0, 7)).toEqual([
      '# Recent', 'Workspace L', 'Workspace K', 'Workspace J', 'Workspace I', 'Workspace H', '# Other workspaces'
    ])

    const search = screen.getByPlaceholderText('Search 12 workspaces…')
    fireEvent.change(search, { target: { value: 'workspace l' } })
    expect(listed()).toEqual(['# Recent', 'Workspace L'])
    fireEvent.change(search, { target: { value: 'workspace g' } })
    expect(listed()).toEqual(['Workspace G'])
  })
})

describe('DeploymentCreateForm workspaces Fabric turned apps down in', () => {
  const ws = (
    id: string,
    displayName: string,
    region?: string,
    capacityId?: string
  ): FabricWorkspace => ({
    id,
    displayName,
    region,
    capacityId,
    capacityKind: 'fabric',
    sku: 'F2',
    eligible: true
  })
  const workspaces: FabricWorkspacesResult = {
    ok: true,
    workspaces: [
      ws('w1', 'Analytics', 'UK South', 'cap-a'),
      ws('w2', 'Finance', 'West Europe', 'cap-b'),
      ws('w3', 'Sales', 'UK South', 'cap-c')
    ]
  }
  const sales = { id: 'w3', name: 'Sales', region: 'UK South', capacityId: 'cap-c' }

  const rows = (): string[] =>
    [...screen.getByRole('listbox').querySelectorAll('.ws-item')].map(
      (row) =>
        `${row.querySelector('.ws-item-name')?.textContent} | ${row.querySelector('.ws-item-sub')?.textContent}`
    )

  it('marks workspaces in the region Fabric turned down, lists them last, and links the region list', () => {
    render(
      <DeploymentCreateForm
        wsResult={workspaces}
        loadingWs={false}
        onReload={vi.fn()}
        onSubmit={vi.fn()}
        refused={[sales]}
      />
    )
    expect(rows()).toEqual([
      'Finance | West Europe',
      'Analytics | UK South · Fabric apps unavailable',
      'Sales | UK South · Fabric apps unavailable'
    ])
    const note = screen.getByRole('note')
    expect(note.textContent).toContain(
      'Fabric apps weren’t available in UK South, so workspaces there are marked. Choose one on a capacity in another region.'
    )
    fireEvent.click(within(note).getByRole('button', { name: 'Region availability' }))
    expect(window.api.openExternal).toHaveBeenCalledWith(
      'https://learn.microsoft.com/fabric/admin/region-availability'
    )
  })

  it('asks before publishing to one, and publishes elsewhere straight away', () => {
    const onSubmit = vi.fn()
    render(
      <DeploymentCreateForm
        wsResult={workspaces}
        loadingWs={false}
        onReload={vi.fn()}
        onSubmit={onSubmit}
        refused={[sales]}
      />
    )
    const publish = screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement
    fireEvent.click(screen.getByText('Analytics'))
    expect(screen.getByRole('alert').textContent).toContain(
      'Fabric apps weren’t available in UK South when you published earlier, so publishing here will likely fail.'
    )
    expect(publish.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Publish here anyway' }))
    expect(publish.disabled).toBe(false)

    fireEvent.click(screen.getByText('Finance'))
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(publish)
    expect(onSubmit).toHaveBeenCalledWith('Finance', 'w2')
  })

  it('suggests the Fabric admin once more than one region turned apps down', () => {
    render(
      <DeploymentCreateForm
        wsResult={workspaces}
        loadingWs={false}
        onReload={vi.fn()}
        onSubmit={vi.fn()}
        refused={[sales, { id: 'w2', region: 'West Europe' }]}
      />
    )
    expect(screen.getByRole('note').textContent).toContain(
      'Fabric apps weren’t available in UK South or West Europe, so workspaces there are marked. If no region works, your Fabric admin may need to turn on Fabric Apps.'
    )
  })

  it('lists capacities in that region last when creating a workspace, and picks another', async () => {
    vi.mocked(window.api.fabric.listCapacities).mockResolvedValueOnce({
      ok: true,
      capacities: [
        {
          id: 'cap-c',
          displayName: 'UK capacity',
          sku: 'F4',
          region: 'UK South',
          kind: 'fabric',
          eligible: true
        },
        {
          id: 'cap-b',
          displayName: 'EU capacity',
          sku: 'F2',
          region: 'West Europe',
          kind: 'fabric',
          eligible: true
        }
      ]
    })
    render(
      <DeploymentCreateForm
        wsResult={workspaces}
        loadingWs={false}
        onReload={vi.fn()}
        onSubmit={vi.fn()}
        refused={[sales]}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: '+ New workspace' }))
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent)
    expect(options).toEqual([
      'EU capacity · F2 · West Europe',
      'UK capacity · F4 · UK South · Fabric apps unavailable'
    ])
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('cap-b')
  })
})
