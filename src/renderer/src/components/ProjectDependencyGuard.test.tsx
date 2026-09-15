import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StudioProject } from '@shared/ipc'
import { OverlayProvider } from '../overlay'
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

function renderGuard(onSwitchProjects = vi.fn()): void {
  render(
    <OverlayProvider>
      <ProjectDependencyGuard
        project={makeProject()}
        onSwitchProjects={onSwitchProjects}
        hidden={false}
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
})
