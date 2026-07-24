import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { StudioProject } from '@shared/ipc'
import { OverlayProvider } from '../overlay'
import DeploymentsControl from './DeploymentsControl'

function makeProject(over: Partial<StudioProject> = {}): StudioProject {
  return {
    id: 'p1',
    name: 'Project',
    path: 'C:/projects/p1',
    addedAt: '2024-01-01T00:00:00.000Z',
    ...over
  }
}

afterEach(() => {
  cleanup()
})

describe('DeploymentsControl chip', () => {
  it('labels the chip “Deployment:” (the workspace name now lives in the footer)', () => {
    render(
      <OverlayProvider>
        <DeploymentsControl
          project={makeProject({
            workspace: 'de0fcf1a-8c94-46cf-a029-650b2e87f172',
            workspaceName: 'Rayfin Apps'
          })}
          running={false}
          onCreate={() => {}}
          onRedeploy={() => {}}
          onSwitch={() => Promise.resolve({ ok: true, outcome: 'success' })}
          onChanged={() => {}}
        />
      </OverlayProvider>
    )
    expect(screen.getByText('Deployment:')).toBeTruthy()
    expect(screen.queryByText('Workspace:')).toBeNull()
  })

  it('copies the active deployment URL to the clipboard', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(
      <OverlayProvider>
        <DeploymentsControl
          project={makeProject({
            lastDeploy: { url: 'https://sales.example.app/', status: 'success' }
          })}
          running={false}
          onCreate={() => {}}
          onRedeploy={() => {}}
          onSwitch={() => Promise.resolve({ ok: true, outcome: 'success' })}
          onChanged={() => {}}
        />
      </OverlayProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Copy app URL' }))
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('https://sales.example.app/')
    )
  })
})
