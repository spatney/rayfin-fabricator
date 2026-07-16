import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import DeploymentCreateForm from './DeploymentCreateForm'

function installApi(loginRayfin = vi.fn(() => Promise.resolve({ ok: true, exitCode: 0 }))): void {
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
    // Fabric auth state (e.g. the workbench titlebar), not just reload workspaces.
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
})
