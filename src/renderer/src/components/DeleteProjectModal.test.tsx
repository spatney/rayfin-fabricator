import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ProcResult } from '@shared/ipc'
import { OverlayProvider } from '../overlay'
import DeleteProjectModal from './DeleteProjectModal'
import { makeProject } from '../../test/harness'
import { deferred } from '../../test/deferred'

function installApi(): void {
  ;(window as unknown as { api: unknown }).api = {
    onDeleteProgress: vi.fn(() => () => {})
  }
}

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('DeleteProjectModal', () => {
  it('defaults permanent Fabric app cleanup on for a deployed project, and lets the user turn it off', () => {
    installApi()
    render(
      <OverlayProvider>
        <DeleteProjectModal
          project={makeProject('p1', { name: 'Sales' })}
          onRemoved={vi.fn()}
          onClose={vi.fn()}
        />
      </OverlayProvider>
    )

    expect(screen.getByRole('heading', { name: 'Remove project' })).toBeTruthy()
    expect(screen.getByText('Local project folder')).toBeTruthy()
    expect(
      screen.getByText(/Move it to your system trash. You can restore it from there/i)
    ).toBeTruthy()
    const toggle = screen.getByRole('checkbox', {
      name: /also permanently delete the deployed Fabric app/i
    }) as HTMLInputElement
    // Checked by default when a deployed Fabric app exists.
    expect(toggle.checked).toBe(true)
    expect(screen.getByText(/Fabric workspace itself is not deleted/i)).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Move folder to trash and delete Fabric app' })
    ).toBeTruthy()

    // The destructive default is still opt-out.
    fireEvent.click(toggle)

    expect(toggle.checked).toBe(false)
    expect(screen.getByRole('button', { name: 'Move folder to trash' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Delete project?' })).toBeNull()
  })

  it('makes clear that an undeployed project only moves its local folder to trash', () => {
    installApi()
    render(
      <OverlayProvider>
        <DeleteProjectModal
          project={makeProject('p1', { lastDeploy: undefined })}
          onRemoved={vi.fn()}
          onClose={vi.fn()}
        />
      </OverlayProvider>
    )

    expect(screen.getByText(/No deployed Fabric app is linked to this project/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Move folder to trash' })).toBeTruthy()
  })

  it.each(['failed login', 'rejected login', 'rejected verification'])(
    'stops both Fabric retries and local deletion after %s',
    async (failure) => {
      const deleteApps = vi.fn().mockResolvedValue({
        ok: false,
        needsLogin: true,
        deleted: 0,
        failures: []
      })
      const loginRayfin = vi.fn().mockResolvedValue({ ok: true, exitCode: 0 })
      const onSignedIn = vi.fn().mockResolvedValue(undefined)
      if (failure === 'failed login') {
        loginRayfin.mockResolvedValueOnce({ ok: false, exitCode: 1, error: 'Fabric authentication cancelled' })
      } else if (failure === 'rejected login') {
        loginRayfin.mockRejectedValueOnce('Fabric authentication cancelled')
      } else {
        onSignedIn.mockRejectedValueOnce(new Error('Fabric authentication cancelled'))
      }
      const remove = vi.fn()
      ;(window as unknown as { api: unknown }).api = {
        onDeleteProgress: vi.fn(() => () => {}),
        fabric: { deleteApps },
        auth: { loginRayfin },
        projects: { remove }
      }
      const onRemoved = vi.fn()
      render(
        <OverlayProvider>
          <DeleteProjectModal
            project={makeProject('p1')}
            onRemoved={onRemoved}
            onClose={vi.fn()}
            onSignedIn={onSignedIn}
          />
        </OverlayProvider>
      )
      fireEvent.click(screen.getByRole('button', { name: 'Move folder to trash and delete Fabric app' }))

      expect(await screen.findByText('Fabric authentication cancelled')).toBeTruthy()
      expect(deleteApps).toHaveBeenCalledTimes(1)
      expect(remove).not.toHaveBeenCalled()
      expect(onRemoved).not.toHaveBeenCalled()
      expect(screen.queryByText(/Deleting from Fabric is taking longer/)).toBeNull()
    }
  )

  it('does not resume destructive work after the dialog unmounts during sign-in', async () => {
    const login = deferred<ProcResult>()
    const loginRayfin = vi.fn(() => login.promise)
    const deleteApps = vi.fn().mockResolvedValue({ ok: false, needsLogin: true, failures: [], deleted: 0 })
    const remove = vi.fn()
    const onSignedIn = vi.fn()
    ;(window as unknown as { api: unknown }).api = {
      onDeleteProgress: vi.fn(() => () => {}),
      fabric: { deleteApps },
      auth: { loginRayfin },
      projects: { remove }
    }
    const view = render(
      <OverlayProvider>
        <DeleteProjectModal
          project={makeProject('p1')}
          onRemoved={vi.fn()}
          onClose={vi.fn()}
          onSignedIn={onSignedIn}
        />
      </OverlayProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Move folder to trash and delete Fabric app' }))
    await waitFor(() => expect(loginRayfin).toHaveBeenCalledTimes(1))
    view.unmount()
    await act(async () => login.resolve({ ok: true, exitCode: 0 }))
    expect(deleteApps).toHaveBeenCalledTimes(1)
    expect(remove).not.toHaveBeenCalled()
    expect(onSignedIn).not.toHaveBeenCalled()
  })
})
