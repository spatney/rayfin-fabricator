import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StudioProject } from '@shared/ipc'
import { OverlayProvider } from '../overlay'
import { MascotProvider, resetMascotForTests } from './mascot/stage'
import ProjectDependencyGuard from './ProjectDependencyGuard'

function makeProject(): StudioProject {
  return {
    id: 'project-1',
    name: 'Cloned app',
    path: 'C:/projects/cloned-app',
    addedAt: '2024-01-01T00:00:00.000Z'
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function installApi(ensureDependencies: ReturnType<typeof vi.fn>): void {
  ;(window as unknown as { api: unknown }).api = {
    projects: { ensureDependencies }
  }
}

function renderGuard(onSwitchProjects = vi.fn(), onReadyChange?: ReturnType<typeof vi.fn>): void {
  render(
    <OverlayProvider>
      <ProjectDependencyGuard
        project={makeProject()}
        onSwitchProjects={onSwitchProjects}
        hidden={false}
        onReadyChange={onReadyChange}
      >
        <p>Project tools are ready</p>
      </ProjectDependencyGuard>
    </OverlayProvider>
  )
}

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('ProjectDependencyGuard', () => {
  it('waits for dependency preparation before exposing project tools', async () => {
    const preparation = deferred<{ ok: boolean }>()
    const ensureDependencies = vi.fn(() => preparation.promise)
    installApi(ensureDependencies)

    renderGuard()

    expect(await screen.findByRole('status', { name: 'Preparing Cloned app' })).toBeTruthy()
    expect(screen.queryByText('Project tools are ready')).toBeNull()
    expect(ensureDependencies).toHaveBeenCalledWith('project-1')

    await act(async () => {
      preparation.resolve({ ok: true })
    })

    expect(await screen.findByText('Project tools are ready')).toBeTruthy()
  })

  it('keeps a failed install recoverable with a retry', async () => {
    const ensureDependencies = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'npm install failed (exit code 1).' })
      .mockResolvedValueOnce({ ok: true })
    const onSwitchProjects = vi.fn()
    installApi(ensureDependencies)

    renderGuard(onSwitchProjects)

    expect(await screen.findByRole('alert', { name: 'Could not prepare Cloned app' })).toBeTruthy()
    expect(screen.getByText('npm install failed (exit code 1).')).toBeTruthy()
    screen.getByRole('button', { name: 'Retry installation' }).click()

    await waitFor(() => expect(ensureDependencies).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('Project tools are ready')).toBeTruthy()
  })

  it('reports readiness so chrome outside the guard can follow the same gate', async () => {
    const preparation = deferred<{ ok: boolean }>()
    installApi(vi.fn(() => preparation.promise))
    const onReadyChange = vi.fn()

    renderGuard(vi.fn(), onReadyChange)

    await screen.findByRole('status', { name: 'Preparing Cloned app' })
    expect(onReadyChange.mock.calls).toEqual([['project-1', false]])

    await act(async () => {
      preparation.resolve({ ok: true })
    })

    await screen.findByText('Project tools are ready')
    expect(onReadyChange).toHaveBeenLastCalledWith('project-1', true)
    cleanup()
    expect(onReadyChange).toHaveBeenLastCalledWith('project-1', false)
  })

  it('never reports a failed install as ready', async () => {
    installApi(vi.fn().mockResolvedValue({ ok: false, error: 'npm install failed (exit code 1).' }))
    const onReadyChange = vi.fn()

    renderGuard(vi.fn(), onReadyChange)

    expect(await screen.findByRole('alert', { name: 'Could not prepare Cloned app' })).toBeTruthy()
    expect(onReadyChange).not.toHaveBeenCalledWith('project-1', true)
    expect(onReadyChange).toHaveBeenLastCalledWith('project-1', false)
  })
})

describe('ProjectDependencyGuard with Ray', () => {
  afterEach(() => {
    vi.useRealTimers()
    resetMascotForTests()
    delete (window as unknown as { matchMedia?: unknown }).matchMedia
  })

  it('brings Ray along for an install that takes a while, but not for a quick check', async () => {
    vi.useFakeTimers()
    // Reduced motion: Ray appears in place, so no animation frames are needed.
    window.matchMedia = ((query: string) => ({
      matches: query.includes('reduce'),
      addEventListener: () => {},
      removeEventListener: () => {}
    })) as unknown as typeof window.matchMedia
    const preparation = deferred<{ ok: boolean }>()
    installApi(vi.fn(() => preparation.promise))
    const ray = (): HTMLElement | null =>
      screen.queryByRole('button', { name: /Ray, the Fabricator stingray/ })

    render(
      <OverlayProvider>
        <MascotProvider enabled>
          <ProjectDependencyGuard project={makeProject()} onSwitchProjects={vi.fn()} hidden={false}>
            <p>Project tools are ready</p>
          </ProjectDependencyGuard>
        </MascotProvider>
      </OverlayProvider>
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(ray()).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(700)
    })
    expect(ray()).not.toBeNull()

    await act(async () => {
      preparation.resolve({ ok: true })
    })
    expect(screen.getByText('Project tools are ready')).toBeTruthy()
    expect(document.querySelector('.mascot-bubble')?.textContent).toMatch(/All set!/)
  })
})
