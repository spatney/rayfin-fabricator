import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { StudioProject } from '@shared/ipc'
import WorkspaceStatus from './WorkspaceStatus'

const WS_GUID = 'de0fcf1a-8c94-46cf-a029-650b2e87f172'

function makeProject(over: Partial<StudioProject> = {}): StudioProject {
  return {
    id: 'p1',
    name: 'Project',
    path: 'C:/projects/p1',
    addedAt: '2024-01-01T00:00:00.000Z',
    ...over
  }
}

let openExternal: ReturnType<typeof vi.fn>

beforeEach(() => {
  openExternal = vi.fn()
  ;(window as unknown as { api: unknown }).api = { openExternal }
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('WorkspaceStatus footer item', () => {
  it('shows the workspace name and deep-links to the Fabric workspace on click', () => {
    render(
      <WorkspaceStatus project={makeProject({ workspace: WS_GUID, workspaceName: 'Rayfin Apps' })} />
    )
    const btn = screen.getByRole('button', { name: /Rayfin Apps/ })
    fireEvent.click(btn)
    expect(openExternal).toHaveBeenCalledWith(
      `https://app.fabric.microsoft.com/groups/${WS_GUID}/`
    )
  })

  it('uses the raw workspace value as the label when there is no friendly name', () => {
    render(<WorkspaceStatus project={makeProject({ workspace: WS_GUID })} />)
    expect(screen.getByRole('button', { name: new RegExp(WS_GUID) })).toBeTruthy()
  })

  it('renders a plain, non-clickable readout when the workspace is a display name (no GUID)', () => {
    render(
      <WorkspaceStatus
        project={makeProject({ workspace: 'Rayfin Apps', workspaceName: 'Rayfin Apps' })}
      />
    )
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('Rayfin Apps')).toBeTruthy()
  })

  it('renders nothing when the project has no workspace', () => {
    const { container } = render(<WorkspaceStatus project={makeProject()} />)
    expect(container.firstChild).toBeNull()
  })
})
