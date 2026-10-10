import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import HomeView from './HomeView'
import { displayPath } from './projectDisplay'
import { makeProject } from '../../test/harness'

function baseProps(): ComponentProps<typeof HomeView> {
  return {
    projects: [],
    activeId: null,
    workspaceRoot: 'C:/workspace',
    opening: false,
    onSelect: vi.fn(),
    onManageProject: vi.fn(),
    onNewProject: vi.fn(),
    onOpenExisting: vi.fn(),
    onCloneFromGitHub: vi.fn(),
    onChangeWorkspaceRoot: vi.fn()
  }
}

afterEach(() => cleanup())

describe('HomeView project launcher', () => {
  it('routes each direct quick-start action without hiding folder or GitHub options in a menu', () => {
    const props = baseProps()
    render(<HomeView {...props} />)

    fireEvent.click(screen.getByRole('button', { name: /new project/i }))
    fireEvent.click(screen.getByRole('button', { name: /open folder/i }))
    fireEvent.click(screen.getByRole('button', { name: /clone from github/i }))

    expect(props.onNewProject).toHaveBeenCalledTimes(1)
    expect(props.onOpenExisting).toHaveBeenCalledTimes(1)
    expect(props.onCloneFromGitHub).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: /open existing/i })).toBeNull()
    expect(document.querySelectorAll('.home-action-icon > svg')).toHaveLength(3)
  })

  it('uses separate native controls to open and manage a recent project', () => {
    const props = baseProps()
    const project = makeProject('p1', { name: 'Sales' })
    props.projects = [project]
    render(<HomeView {...props} />)

    const open = screen.getByRole('button', { name: 'Open Sales' })
    expect(open.tagName).toBe('BUTTON')
    fireEvent.click(open)
    fireEvent.click(screen.getByRole('button', { name: 'Manage Sales' }))

    expect(props.onSelect).toHaveBeenCalledWith(project)
    expect(props.onManageProject).toHaveBeenCalledWith(project)
  })

  it('keeps the workspace location actionable', () => {
    const props = baseProps()
    render(<HomeView {...props} />)

    expect(screen.getByText('C:/workspace')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Change folder' }))

    expect(props.onChangeWorkspaceRoot).toHaveBeenCalledTimes(1)
  })

  it('shows the most recent projects first and the rest on request', () => {
    const props = baseProps()
    props.projects = Array.from({ length: 9 }, (_, i) => makeProject(`p${i}`, { name: `App ${i}` }))
    render(<HomeView {...props} />)
    expect(screen.getAllByRole('listitem')).toHaveLength(6)
    fireEvent.click(screen.getByRole('button', { name: 'Show all 9 projects' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(9)
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(6)
  })

  it('shortens the user folder in project paths', () => {
    expect(displayPath('C:\\Users\\sachi\\RayfinProjects\\notes')).toBe('~\\RayfinProjects\\notes')
    expect(displayPath('/Users/amy/apps/notes')).toBe('~/apps/notes')
    expect(displayPath('D:\\work\\notes')).toBe('D:\\work\\notes')
  })
})

describe('HomeView team workspaces', () => {
  function installTeamApi(): { openProject: ReturnType<typeof vi.fn> } {
    const openProject = vi.fn(() =>
      Promise.resolve({ ok: true, project: makeProject('t1', { name: 'Leads' }) })
    )
    ;(window as unknown as { api: unknown }).api = {
      openExternal: vi.fn(),
      team: {
        joinOptions: vi.fn(() =>
          Promise.resolve({
            ok: true,
            invitations: [{ id: 7, repo: 'octo/marketing', inviter: 'amy' }],
            discovered: []
          })
        ),
        reviewRequests: vi.fn(() => Promise.resolve([])),
        map: vi.fn(() =>
          Promise.resolve({
            ok: true,
            fetchedAt: '',
            members: [],
            runs: [],
            apps: [
              {
                folder: 'leads',
                name: 'Leads',
                published: true,
                production: { environment: 'production/leads', state: 'success' },
                copies: []
              }
            ]
          })
        ),
        activity: vi.fn(() => Promise.resolve({ ok: true, runs: [], fetchedAt: '' })),
        openProject
      }
    }
    return { openProject }
  }

  const workspace = {
    id: 'w1',
    name: 'Sales team',
    repo: 'octo/sales-team',
    defaultBranch: 'main',
    dir: 'C:/team',
    role: 'owner' as const,
    addedAt: '2026-10-01T00:00:00Z'
  }

  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
  })

  it('stays hidden unless the experiment provides it', () => {
    render(<HomeView {...baseProps()} />)
    expect(screen.queryByText('Team workspaces')).toBeNull()
  })

  it('explains team workspaces before there is one, with both ways in', async () => {
    installTeamApi()
    render(
      <HomeView {...baseProps()} team={{ workspaces: [], onOpened: vi.fn(), onNewApp: vi.fn(), onChanged: vi.fn() }} />
    )
    const section = screen.getByRole('region', { name: 'Team workspaces' })
    expect(within(section).getByText('Build apps together')).toBeTruthy()
    for (const point of ['Shared on GitHub', 'Your own copy', 'Published to Fabric']) {
      expect(within(section).getByText(point)).toBeTruthy()
    }
    // The glyph has its own element: codicon styles on the tile itself pinned it to the top.
    const tile = section.querySelector('.team-empty-icon')
    expect(tile?.classList.contains('codicon')).toBe(false)
    expect(tile?.querySelector('.codicon-organization')).toBeTruthy()

    expect(within(section).getByRole('button', { name: 'Create a team workspace' }).className).toContain('btn--primary')
    const join = within(section).getByRole('button', { name: /^Join/ })
    await waitFor(() => expect(join.textContent).toBe('Join1'))
    fireEvent.click(join)
    expect(await screen.findByRole('dialog', { name: 'Join a team workspace' })).toBeTruthy()
  })

  it('lists workspaces with their apps, invitations, and opens an app on a branch', async () => {
    const { openProject } = installTeamApi()
    const onOpened = vi.fn()
    const onOpenMap = vi.fn()
    render(
      <HomeView
        {...baseProps()}
        team={{ workspaces: [workspace], onOpened, onNewApp: vi.fn(), onOpenMap, onChanged: vi.fn() }}
      />
    )

    expect(screen.getByText('Team workspaces')).toBeTruthy()
    expect(await screen.findByText('octo/marketing')).toBeTruthy()
    expect(screen.getByText(/invited to/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /overview/i }))
    expect(onOpenMap).toHaveBeenCalledWith('w1')
    fireEvent.click(await screen.findByRole('button', { name: 'Open Leads' }))
    await waitFor(() => expect(onOpened).toHaveBeenCalled())
    expect(openProject).toHaveBeenCalledWith('w1', 'leads')
  })

  it('labels team projects in recents with their workspace', () => {
    installTeamApi()
    const props = baseProps()
    props.projects = [
      makeProject('t1', {
        name: 'Leads',
        path: 'C:/team/leads/leads',
        team: { workspaceId: 'w1', folder: 'leads', worktree: 'C:/team/leads' }
      })
    ]
    render(
      <HomeView
        {...props}
        team={{ workspaces: [workspace], onOpened: vi.fn(), onNewApp: vi.fn(), onChanged: vi.fn() }}
      />
    )
    const recents = screen.getByRole('region', { name: 'Recent projects' })
    const row = within(recents).getByRole('button', { name: 'Open Leads' })
    expect(row.textContent).toContain('Sales team')
    // A team app's deep worktree path isn't shown, only kept in the tooltip.
    expect(row.textContent).not.toContain('C:/team/leads/leads')
  })
})
