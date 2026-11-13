import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { LocalStatus, RayfinLatest } from '@shared/ipc'
import HomeView from './HomeView'
import { displayPath } from './projectDisplay'
import { makeProject } from '../../test/harness'
import { localBackendStore } from '../localBackend'
import { resetProjectFactsForTests } from '../projectFacts'
import { thumbnailStore } from '../thumbnails'

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
    onOpenGallery: vi.fn(),
    onChangeWorkspaceRoot: vi.fn()
  }
}

/** What Home reads besides its props: Rayfin's releases, changes since a publish, local backends and pictures. */
function homeApi({
  latest = {},
  changed = [],
  running = [],
  thumbnails = {}
}: {
  latest?: RayfinLatest
  changed?: string[]
  running?: string[]
  thumbnails?: Record<string, string>
} = {}) {
  return {
    rayfin: { latest: vi.fn(() => Promise.resolve(latest)) },
    deploy: { hasChanges: vi.fn((id: string) => Promise.resolve(changed.includes(id))) },
    local: {
      status: vi.fn((projectId: string) =>
        Promise.resolve({
          projectId,
          state: running.includes(projectId) ? 'running' : 'stopped',
          revision: 1
        } as LocalStatus)
      ),
      onState: vi.fn(() => () => {})
    },
    projects: { thumbnails: vi.fn(() => Promise.resolve(thumbnails)) }
  }
}

function installHomeApi(over: Parameters<typeof homeApi>[0] = {}): ReturnType<typeof homeApi> {
  const api = homeApi(over)
  ;(window as unknown as { api: unknown }).api = api
  return api
}

beforeEach(() => {
  installHomeApi()
  resetProjectFactsForTests()
  localBackendStore.clear()
  thumbnailStore.clear()
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('HomeView project launcher', () => {
  it('starts a new project, or opens an existing one from a folder or GitHub', () => {
    const props = baseProps()
    render(<HomeView {...props} />)

    fireEvent.click(screen.getByRole('button', { name: /new project/i }))
    expect(props.onNewProject).toHaveBeenCalledTimes(1)

    const existing = screen.getByRole('button', { name: /open existing/i })
    fireEvent.click(existing)
    expect(existing.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('menuitem', { name: /open folder/i }))
    expect(props.onOpenExisting).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.click(existing)
    fireEvent.keyDown(screen.getByRole('menu', { name: 'Open existing' }), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.click(existing)
    fireEvent.click(screen.getByRole('menuitem', { name: /clone from github/i }))
    expect(props.onCloneFromGitHub).toHaveBeenCalledTimes(1)
    expect(document.querySelectorAll('.home-action-icon > svg')).toHaveLength(2)
    expect(screen.queryByRole('menuitem', { name: /import a project/i })).toBeNull()
  })

  it('imports a project someone exported', () => {
    const props = baseProps()
    props.onImportProject = vi.fn()
    render(<HomeView {...props} />)

    const existing = screen.getByRole('button', { name: /open existing/i })
    expect(existing.textContent).toContain('From a folder, GitHub or a file')
    fireEvent.click(existing)
    fireEvent.click(screen.getByRole('menuitem', { name: /import a project/i }))
    expect(props.onImportProject).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('offers to migrate a Power BI report only when the experiment provides it', () => {
    const props = baseProps()
    const { rerender } = render(<HomeView {...props} />)
    expect(screen.queryByRole('button', { name: /migrate a power bi report/i })).toBeNull()

    const onMigrateReport = vi.fn()
    rerender(<HomeView {...props} onMigrateReport={onMigrateReport} />)
    fireEvent.click(screen.getByRole('button', { name: /migrate a power bi report/i }))
    expect(onMigrateReport).toHaveBeenCalledTimes(1)
  })

  it('offers the app gallery to everyone, after the ways to start a project', () => {
    const props = baseProps()
    render(<HomeView {...props} onMigrateReport={vi.fn()} />)

    const actions = within(screen.getByRole('group', { name: 'Project actions' }))
      .getAllByRole('button')
      .map((button) => button.querySelector('.home-action-label')?.textContent)
    expect(actions).toEqual([
      'New project',
      'Open existing',
      'App gallery',
      'Migrate a Power BI report'
    ])
    fireEvent.click(screen.getByRole('button', { name: /app gallery/i }))
    expect(props.onOpenGallery).toHaveBeenCalledTimes(1)
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

  it('offers a Rayfin update only on projects behind the newest release, and hands it on', async () => {
    installHomeApi({ latest: { latest: '1.37.0', recommended: '1.36.2' } })
    const props = baseProps()
    const behind = makeProject('p1', { name: 'Sales', rayfinVersion: '1.35.1' })
    props.projects = [
      behind,
      makeProject('p2', { name: 'Notes', rayfinVersion: '1.36.2' }),
      makeProject('p3', {
        name: 'Trips',
        rayfinVersion: '1.36.2',
        team: { workspaceId: 'w', folder: 'trips', worktree: 'C:/t' }
      })
    ]
    props.onUpdateRayfin = vi.fn()
    render(<HomeView {...props} />)
    const [sales, notes, trips] = screen.getAllByRole('listitem')
    const update = await within(sales).findByRole('button', {
      name: 'Update Rayfin in Sales to 1.36.2'
    })
    expect(within(sales).getByText(/^Rayfin 1\.35\.1/)).toBeTruthy()
    // Up to date for this computer: no version at all.
    expect(within(notes).queryByText(/^Rayfin \d/)).toBeNull()
    // A team app runs on this computer too, so it stops at the same release.
    expect(within(trips).queryByRole('button', { name: /^Update Rayfin in Trips/ })).toBeNull()
    expect(within(trips).queryByText(/^Rayfin \d/)).toBeNull()
    fireEvent.click(update)
    expect(props.onUpdateRayfin).toHaveBeenCalledWith(behind, '1.36.2')
    expect(props.onSelect).not.toHaveBeenCalled()
  })

  it('says how each project’s publish stands, and which run on this computer', async () => {
    const now = Date.now()
    installHomeApi({ changed: ['p2'], running: ['p4'] })
    const props = baseProps()
    props.projects = [
      makeProject('p1', {
        name: 'Sales',
        lastDeploy: {
          status: 'success',
          at: new Date(now - 2 * 86_400_000).toISOString(),
          commit: 'a'
        }
      }),
      makeProject('p2', {
        name: 'Notes',
        lastDeploy: { status: 'success', at: new Date(now).toISOString(), commit: 'b' }
      }),
      makeProject('p3', {
        name: 'Trips',
        lastDeploy: { status: 'error', error: 'workspace not found' }
      }),
      makeProject('p4', { name: 'Recipes', lastDeploy: undefined })
    ]
    render(<HomeView {...props} publishing={new Set(['p5'])} />)
    const rows = screen.getAllByRole('listitem')
    expect(within(rows[0]).getByText('Published 2 days ago')).toBeTruthy()
    expect(await within(rows[1]).findByText('Changes not published')).toBeTruthy()
    const failed = within(rows[2]).getByText('Publish failed')
    expect(failed.getAttribute('title')).toBe('Workspace not found')
    expect(within(rows[3]).getByText('Not published')).toBeTruthy()
    expect(await within(rows[3]).findByText('Running locally')).toBeTruthy()
  })

  it('groups projects by when they were opened, pinned ones first, and pins from the row', () => {
    const now = Date.now()
    const props = baseProps()
    const old = makeProject('p3', { name: 'Old', lastOpenedAt: '2025-01-01T00:00:00.000Z' })
    props.projects = [
      makeProject('p1', { name: 'Today', lastOpenedAt: new Date(now).toISOString() }),
      makeProject('p2', {
        name: 'Pinned',
        pinned: true,
        lastOpenedAt: new Date(now - 3 * 86_400_000).toISOString()
      }),
      old
    ]
    props.onPinProject = vi.fn()
    render(<HomeView {...props} />)
    const groups = screen.getAllByRole('list').map((list) => ({
      name:
        list.getAttribute('aria-labelledby') &&
        document.getElementById(list.getAttribute('aria-labelledby') ?? '')?.textContent,
      projects: within(list)
        .getAllByRole('listitem')
        .map((row) => within(row).getAllByRole('button')[0].textContent)
    }))
    expect(groups).toEqual([
      { name: 'Pinned', projects: ['Pinned'] },
      { name: 'Today', projects: ['Today'] },
      { name: 'Earlier', projects: ['Old'] }
    ])
    expect(screen.getByText('Opened just now')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Pin Old' }))
    expect(props.onPinProject).toHaveBeenCalledWith(old, true)
  })

  it('filters the projects with /, and moves through them with the arrow keys', () => {
    const props = baseProps()
    props.projects = Array.from({ length: 8 }, (_, i) =>
      makeProject(`p${i}`, { name: i === 5 ? 'Lead tracker' : `App ${i}` })
    )
    render(<HomeView {...props} />)
    fireEvent.keyDown(window, { key: '/' })
    const filter = screen.getByRole('searchbox', { name: 'Filter projects' })
    expect(document.activeElement).toBe(filter)
    fireEvent.change(filter, { target: { value: 'lead' } })
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByText('1 of 8 projects')).toBeTruthy()
    fireEvent.change(filter, { target: { value: 'nothing like it' } })
    fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(6)

    const first = screen.getByRole('button', { name: 'Open App 0' })
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open App 1' }))
    fireEvent.keyDown(document.activeElement as Element, { key: 'End' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open Lead tracker' }))
  })

  it('offers a project’s actions on right-click', () => {
    const props = baseProps()
    const sales = makeProject('p1', {
      name: 'Sales',
      lastDeploy: {
        status: 'success',
        url: 'https://sales.example.app',
        portalUrl: 'https://app.fabric.microsoft.com/x'
      }
    })
    props.projects = [sales]
    props.onRevealProject = vi.fn()
    props.onOpenUrl = vi.fn()
    render(<HomeView {...props} />)
    fireEvent.contextMenu(screen.getByRole('listitem'), { clientX: 40, clientY: 40 })
    const menu = screen.getByRole('menu', { name: 'Sales' })
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent)
    ).toEqual([
      'Open',
      'Open app',
      'Open in Fabric',
      'Show in Explorer',
      'Copy folder path',
      'Manage…'
    ])
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Open app' }))
    expect(props.onOpenUrl).toHaveBeenCalledWith('https://sales.example.app')
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.contextMenu(screen.getByRole('listitem'), { clientX: 40, clientY: 40 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show in Explorer' }))
    expect(props.onRevealProject).toHaveBeenCalledWith(sales)
  })

  it('shows a project’s picture once Fabricator has drawn one', async () => {
    installHomeApi({ thumbnails: { p1: 'data:image/webp;base64,UklGRg==' } })
    const props = baseProps()
    props.projects = [
      makeProject('p1', { name: 'Sales', thumbnailAt: '2026-11-01T00:00:00.000Z' }),
      makeProject('p2', { name: 'Github Buddy' })
    ]
    const { container } = render(<HomeView {...props} />)
    await waitFor(() => expect(container.querySelector('.ptile-img')).not.toBeNull())
    expect(container.querySelector('.ptile-img')?.getAttribute('src')).toBe(
      'data:image/webp;base64,UklGRg=='
    )
    // Without one: its two letters.
    expect(within(screen.getAllByRole('listitem')[1]).getByText('GB')).toBeTruthy()
    await act(async () => {})
  })

  it('shows projects being removed in the background, and what to do when one stops', () => {
    const props = baseProps()
    const sales = makeProject('p1', { name: 'Sales', workspaceName: 'fabcon' })
    const notes = makeProject('p2', { name: 'Notes' })
    const crm = makeProject('p3', { name: 'CRM' })
    props.projects = [sales, notes, crm]
    props.removals = {
      p1: { project: sales, deleteApp: true, appDeleted: false, step: 'app' },
      p2: {
        project: notes,
        deleteApp: false,
        appDeleted: false,
        step: 'folder',
        error: 'Couldn’t move the folder to trash: The file is in use.'
      },
      p3: {
        project: crm,
        deleteApp: false,
        appDeleted: false,
        step: 'folder',
        progress: { id: 'p3', phase: 'trashing', processed: 1200, total: 1200 },
        trashingSince: Date.now() - 5000
      }
    }
    props.onRetryRemoval = vi.fn()
    props.onDismissRemoval = vi.fn()
    render(<HomeView {...props} />)

    const removing = screen.getByRole('button', { name: 'Open Sales' }) as HTMLButtonElement
    const row = (button: HTMLElement): HTMLElement =>
      button.closest('[role="listitem"]') as HTMLElement
    expect(removing.disabled).toBe(true)
    expect(row(removing).textContent).toContain('Removing')
    expect(row(removing).textContent).toContain('Deleting the published app from fabcon…')
    expect(screen.queryByRole('button', { name: 'Manage Sales' })).toBeNull()
    expect(row(screen.getByRole('button', { name: 'Open CRM' })).textContent).toContain(
      'Moving 1,200 files to trash… 5s'
    )

    const stopped = screen.getByRole('button', { name: 'Open Notes' }) as HTMLButtonElement
    expect(stopped.disabled).toBe(false)
    expect(row(stopped).textContent).toContain('Not removed')
    expect(row(stopped).textContent).toContain('The file is in use.')
    fireEvent.click(screen.getByRole('button', { name: 'Try again to remove Notes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Keep Notes' }))
    expect(props.onRetryRemoval).toHaveBeenCalledWith('p2')
    expect(props.onDismissRemoval).toHaveBeenCalledWith('p2')
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
      ...homeApi(),
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
    const row = within(recents).getByRole('listitem')
    expect(within(row).getByRole('button', { name: 'Open Leads' })).toBeTruthy()
    expect(row.textContent).toContain('Sales team')
    // A team app's deep worktree path isn't shown, only kept in the tooltip.
    expect(row.textContent).not.toContain('C:/team/leads/leads')
  })
})
