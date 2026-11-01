import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FabricDeleteResult, ProcResult, ProjectsState } from '@shared/ipc'
import { useProjectRemovals } from './projectRemovals'
import { makeProject } from '../test/harness'
import { deferred } from '../test/deferred'

const needsLogin: FabricDeleteResult = { ok: false, needsLogin: true, deleted: 0, failures: [] }
const deleted: FabricDeleteResult = { ok: true, deleted: 1, failures: [] }
const state: ProjectsState = { workspaceRoot: 'C:/projects', projects: [], activeProjectId: null }

function installApi(api: {
  deleteApps?: (id: string) => Promise<FabricDeleteResult>
  loginRayfin?: () => Promise<ProcResult>
  remove?: (id: string, deleteFiles?: boolean) => Promise<ProjectsState>
}): void {
  ;(window as unknown as { api: unknown }).api = {
    onDeleteProgress: vi.fn(() => () => {}),
    fabric: { deleteApps: api.deleteApps ?? vi.fn() },
    auth: { loginRayfin: api.loginRayfin ?? vi.fn() },
    projects: { remove: api.remove ?? vi.fn() }
  }
}

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('useProjectRemovals', () => {
  it('removes projects side by side, and they share one Fabric sign-in', async () => {
    const login = deferred<ProcResult>()
    const loginRayfin = vi.fn(() => login.promise)
    const deleteApps = vi
      .fn<(id: string) => Promise<FabricDeleteResult>>()
      .mockResolvedValueOnce(needsLogin)
      .mockResolvedValueOnce(needsLogin)
      .mockResolvedValue(deleted)
    const trashed = { p1: deferred<ProjectsState>(), p2: deferred<ProjectsState>() }
    const remove = vi.fn((id: string) => trashed[id as 'p1' | 'p2'].promise)
    installApi({ deleteApps, loginRayfin, remove })
    const onSignedIn = vi.fn()
    const onRemoved = vi.fn()
    const { result } = renderHook(() => useProjectRemovals({ onSignedIn, onRemoved }))

    act(() => {
      result.current.start(makeProject('p1'), { deleteApp: true })
      result.current.start(makeProject('p2'), { deleteApp: true })
    })
    await waitFor(() => expect(result.current.removals.p2?.step).toBe('signin'))
    expect(result.current.removals.p1?.step).toBe('signin')
    expect(loginRayfin).toHaveBeenCalledTimes(1)

    await act(async () => login.resolve({ ok: true, exitCode: 0 }))
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(2))
    expect(onSignedIn).toHaveBeenCalledTimes(1)
    expect(deleteApps).toHaveBeenCalledTimes(4)
    expect(remove).toHaveBeenCalledWith('p1', true)
    expect(remove).toHaveBeenCalledWith('p2', true)

    // Each finishes on its own.
    await act(async () => trashed.p2.resolve(state))
    expect(onRemoved).toHaveBeenCalledWith(expect.objectContaining({ id: 'p2' }), state, true)
    expect(Object.keys(result.current.removals)).toEqual(['p1'])
    await act(async () => trashed.p1.resolve(state))
    expect(onRemoved).toHaveBeenCalledTimes(2)
    expect(result.current.removals).toEqual({})
  })

  it.each(['failed login', 'rejected login', 'rejected verification'])(
    'stops before deleting anything else after a %s',
    async (failure) => {
      const deleteApps = vi.fn().mockResolvedValue(needsLogin)
      const loginRayfin = vi.fn().mockResolvedValue({ ok: true, exitCode: 0 })
      const onSignedIn = vi.fn().mockResolvedValue(undefined)
      if (failure === 'failed login') {
        loginRayfin.mockResolvedValueOnce({
          ok: false,
          exitCode: 1,
          error: 'Fabric authentication cancelled'
        })
      } else if (failure === 'rejected login') {
        loginRayfin.mockRejectedValueOnce('Fabric authentication cancelled')
      } else {
        onSignedIn.mockRejectedValueOnce(new Error('Fabric authentication cancelled'))
      }
      const remove = vi.fn()
      installApi({ deleteApps, loginRayfin, remove })
      const onRemoved = vi.fn()
      const onFailed = vi.fn()
      const { result } = renderHook(() => useProjectRemovals({ onSignedIn, onRemoved, onFailed }))

      act(() => result.current.start(makeProject('p1'), { deleteApp: true }))

      await waitFor(() =>
        expect(result.current.removals.p1?.error).toBe('Fabric authentication cancelled')
      )
      expect(onFailed).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'p1' }),
        'Fabric authentication cancelled'
      )
      expect(deleteApps).toHaveBeenCalledTimes(1)
      expect(remove).not.toHaveBeenCalled()
      expect(onRemoved).not.toHaveBeenCalled()
    }
  )

  it('does not resume destructive work after unmounting during sign-in', async () => {
    const login = deferred<ProcResult>()
    const deleteApps = vi.fn().mockResolvedValue(needsLogin)
    const remove = vi.fn()
    installApi({ deleteApps, loginRayfin: vi.fn(() => login.promise), remove })
    const onSignedIn = vi.fn()
    const view = renderHook(() => useProjectRemovals({ onSignedIn, onRemoved: vi.fn() }))

    act(() => view.result.current.start(makeProject('p1'), { deleteApp: true }))
    await waitFor(() => expect(view.result.current.removals.p1?.step).toBe('signin'))
    view.unmount()
    await act(async () => login.resolve({ ok: true, exitCode: 0 }))

    expect(deleteApps).toHaveBeenCalledTimes(1)
    expect(remove).not.toHaveBeenCalled()
    expect(onSignedIn).not.toHaveBeenCalled()
  })

  it('keeps a project whose folder could not be trashed, and a retry only trashes the folder', async () => {
    const deleteApps = vi.fn().mockResolvedValue(deleted)
    const remove = vi
      .fn()
      .mockRejectedValueOnce("Couldn't move the folder to trash: The file is in use.")
      .mockResolvedValue(state)
    installApi({ deleteApps, remove })
    const onRemoved = vi.fn()
    const { result } = renderHook(() => useProjectRemovals({ onRemoved }))

    act(() => result.current.start(makeProject('p1'), { deleteApp: true }))
    await waitFor(() =>
      expect(result.current.removals.p1).toMatchObject({
        step: 'folder',
        appDeleted: true,
        error: "Couldn't move the folder to trash: The file is in use."
      })
    )
    expect(onRemoved).not.toHaveBeenCalled()

    act(() => result.current.retry('p1'))
    await waitFor(() => expect(onRemoved).toHaveBeenCalledTimes(1))
    expect(deleteApps).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledTimes(2)
    expect(onRemoved).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }), state, true)
  })
})
