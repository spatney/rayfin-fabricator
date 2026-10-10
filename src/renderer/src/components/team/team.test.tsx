import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { StudioProject, TeamMapRun, TeamSessionStatus, TeamWorkspace } from '@shared/ipc'
import { OverlayProvider, usePreviewSuppressed } from '../../overlay'
import CreateProjectScreen from '../CreateProjectScreen'
import TeamPublishControl, { teamChipLabel } from './TeamPublishControl'
import TeamDeployCard from './TeamDeployCard'
import CreateTeamWorkspaceModal from './CreateTeamWorkspaceModal'
import { conflictPrompt } from './useTeamWork'

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

function status(over: Partial<TeamSessionStatus> = {}): TeamSessionStatus {
  return {
    ok: true,
    unpublished: 0,
    dirty: false,
    behind: 0,
    conflicted: false,
    requireReview: false,
    view: 'preview',
    ...over
  }
}

describe('team chip label', () => {
  it('describes the most important state first', () => {
    expect(teamChipLabel(undefined, true)).toBe('Saving…')
    expect(teamChipLabel(status({ conflicted: true, unpublished: 3 }), false)).toBe('Combining changes…')
    expect(
      teamChipLabel(
        status({ run: { id: 1, kind: 'preview', status: 'in_progress', url: '', sha: '', steps: [] } }),
        false
      )
    ).toBe('Deploying preview…')
    expect(teamChipLabel(status({ publish: { stage: 'review', at: '' } }), false)).toBe('Waiting for review')
    expect(teamChipLabel(status({ unpublished: 1 }), false)).toBe('1 unpublished')
    expect(teamChipLabel(status({ unpublished: 4 }), false)).toBe('4 unpublished')
    expect(teamChipLabel(status(), false)).toBe('Up to date')
  })
})

describe('conflict prompt', () => {
  it('lists the files and keeps git to Fabricator', () => {
    const prompt = conflictPrompt(['app/src/App.tsx', 'app/rayfin/rayfin.yml'])
    expect(prompt).toContain('- app/src/App.tsx')
    expect(prompt).toContain('- app/rayfin/rayfin.yml')
    expect(prompt).toContain('Don’t run git commands')
  })
})

describe('TeamPublishControl', () => {
  function Probe(): JSX.Element {
    return <span data-testid="suppressed">{String(usePreviewSuppressed())}</span>
  }

  it('hides the native preview while its menu is open', () => {
    const project: StudioProject = {
      id: 'p1',
      name: 'Trips',
      path: 'C:/team/trips/trips',
      addedAt: '',
      team: { workspaceId: 'w1', folder: 'trips', worktree: 'C:/team/trips' }
    }
    render(
      <OverlayProvider>
        <Probe />
        <TeamPublishControl
          project={project}
          status={status({ unpublished: 2 })}
          syncing={false}
          onPublish={() => {}}
          onUpdate={() => {}}
          onCombine={() => {}}
          onDiscard={() => {}}
          onSetView={() => {}}
          onViewLogs={() => {}}
          onRefresh={() => {}}
        />
      </OverlayProvider>
    )
    expect(screen.getByTestId('suppressed').textContent).toBe('false')
    // One split control: what's waiting, and Publish (no duplicate count badge).
    const chip = screen.getByRole('button', { name: /2 unpublished/ })
    expect(chip.title).toContain('2 changes not published yet')
    expect(document.querySelector('.team-count')).toBeNull()
    fireEvent.click(chip)
    expect(screen.getByRole('dialog', { name: 'Team app' })).toBeTruthy()
    expect(screen.getByTestId('suppressed').textContent).toBe('true')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByTestId('suppressed').textContent).toBe('false')
  })

  it('shows the run’s steps while it deploys or after it fails, not once it succeeded', () => {
    const project: StudioProject = {
      id: 'p1',
      name: 'Trips',
      path: 'C:/team/trips/trips',
      addedAt: '',
      team: { workspaceId: 'w1', folder: 'trips', worktree: 'C:/team/trips' }
    }
    const run = (over: Partial<NonNullable<TeamSessionStatus['run']>>): NonNullable<TeamSessionStatus['run']> => ({
      id: 9,
      kind: 'preview',
      status: 'in_progress',
      url: '',
      sha: '',
      steps: [
        { name: 'Install dependencies', status: 'completed', conclusion: 'success' },
        { name: 'Deploy with Rayfin', status: 'in_progress' }
      ],
      ...over
    })
    const onViewLogs = vi.fn()
    const view = (s: TeamSessionStatus): JSX.Element => (
      <OverlayProvider>
        <TeamPublishControl
          project={project}
          status={s}
          syncing={false}
          onPublish={() => {}}
          onUpdate={() => {}}
          onCombine={() => {}}
          onDiscard={() => {}}
          onSetView={() => {}}
          onViewLogs={onViewLogs}
          onRefresh={() => {}}
        />
      </OverlayProvider>
    )
    const { rerender } = render(view(status({ unpublished: 1, run: run({}) })))
    fireEvent.click(screen.getByRole('button', { name: /Deploying preview/ }))
    expect(screen.getByText('Deploying your preview')).toBeTruthy()
    expect(screen.getByText('Deploy with Rayfin')).toBeTruthy()
    expect(screen.getByRole('radio', { name: /My preview/ }).getAttribute('aria-checked')).toBe('true')

    rerender(view(status({ unpublished: 1, run: run({ status: 'completed', conclusion: 'success' }) })))
    expect(screen.queryByText('Deploy with Rayfin')).toBeNull()

    rerender(view(status({ unpublished: 1, run: run({ status: 'completed', conclusion: 'failure' }) })))
    expect(screen.getByText(/Deploying your preview · failed/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'View logs' }))
    expect(onViewLogs).toHaveBeenCalledWith(9)
  })

  it('offers a Copilot diagnosis for a failed run or publish, not a cancelled run', () => {
    const project: StudioProject = {
      id: 'p1',
      name: 'Trips',
      path: 'C:/team/trips/trips',
      addedAt: '',
      team: { workspaceId: 'w1', folder: 'trips', worktree: 'C:/team/trips' }
    }
    const ended = (conclusion: string): NonNullable<TeamSessionStatus['run']> => ({
      id: 9,
      kind: 'preview',
      status: 'completed',
      conclusion,
      url: '',
      sha: '',
      steps: []
    })
    const onDiagnose = vi.fn()
    const view = (s: TeamSessionStatus): JSX.Element => (
      <OverlayProvider>
        <TeamPublishControl
          project={project}
          status={s}
          syncing={false}
          onPublish={() => {}}
          onUpdate={() => {}}
          onCombine={() => {}}
          onDiscard={() => {}}
          onSetView={() => {}}
          onViewLogs={() => {}}
          onDiagnose={onDiagnose}
          onRefresh={() => {}}
        />
      </OverlayProvider>
    )
    const { rerender } = render(view(status({ unpublished: 1, run: ended('cancelled') })))
    fireEvent.click(screen.getByRole('button', { name: /1 unpublished/ }))
    expect(screen.getByRole('button', { name: 'View logs' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Diagnose with Copilot/ })).toBeNull()

    rerender(view(status({ unpublished: 1, run: ended('failure') })))
    fireEvent.click(screen.getByRole('button', { name: /Diagnose with Copilot/ }))
    expect(onDiagnose).toHaveBeenCalledWith({ runId: 9 })
    expect(screen.queryByRole('dialog', { name: 'Team app' })).toBeNull()

    const runUrl = 'https://github.com/o/r/actions/runs/12'
    rerender(view(status({ unpublished: 1, publish: { stage: 'failed', error: 'The deploy failed.', runUrl, runId: 12, at: '' } })))
    fireEvent.click(screen.getByRole('button', { name: /1 unpublished/ }))
    fireEvent.click(screen.getByRole('button', { name: /Diagnose with Copilot/ }))
    expect(onDiagnose).toHaveBeenLastCalledWith({ runId: 12, runUrl, error: 'The deploy failed.' })
  })

  it('reads the app’s status again when the workspace sees its deploy start or finish', () => {
    const project: StudioProject = {
      id: 'p1',
      name: 'Trips',
      path: 'C:/team/trips/trips',
      addedAt: '',
      team: { workspaceId: 'w1', folder: 'trips', worktree: 'C:/team/trips' }
    }
    const branch = 'fabricator/me/trips-20261003-191000'
    const deploy = (state: string): TeamMapRun => ({ id: 7, kind: 'preview', status: state, url: '', sha: 'a', branch, jobs: [] })
    const onRefresh = vi.fn()
    const view = (runs: TeamMapRun[]): JSX.Element => (
      <OverlayProvider>
        <TeamPublishControl
          project={project}
          status={status({ branch, unpublished: 1 })}
          runs={runs}
          syncing={false}
          onPublish={() => {}}
          onUpdate={() => {}}
          onCombine={() => {}}
          onDiscard={() => {}}
          onSetView={() => {}}
          onViewLogs={() => {}}
          onRefresh={onRefresh}
        />
      </OverlayProvider>
    )
    const { rerender } = render(view([]))
    expect(onRefresh).not.toHaveBeenCalled()
    rerender(view([deploy('queued')]))
    expect(onRefresh).toHaveBeenCalledTimes(1)
    rerender(view([deploy('queued')]))
    expect(onRefresh).toHaveBeenCalledTimes(1)
    rerender(view([deploy('completed')]))
    expect(onRefresh).toHaveBeenCalledTimes(2)
    // A teammate's deploy isn't this app's.
    rerender(view([{ ...deploy('in_progress'), id: 8, branch: 'fabricator/amy/trips-20261003-120000' }]))
    expect(onRefresh).toHaveBeenCalledTimes(2)
  })
})

describe('TeamDeployCard', () => {
  it('shows a first preview deploying, step by step, with its logs', () => {
    const openExternal = vi.fn()
    ;(window as unknown as { api: unknown }).api = { openExternal }
    const onOpenMap = vi.fn()
    render(
      <TeamDeployCard
        first
        onOpenMap={onOpenMap}
        run={{
          id: 5,
          kind: 'preview',
          status: 'in_progress',
          url: 'https://github.com/o/r/actions/runs/5',
          sha: 'a',
          startedAt: new Date(Date.now() - 65_000).toISOString(),
          steps: [
            { name: 'Install dependencies', status: 'completed', conclusion: 'success' },
            { name: 'Deploy with Rayfin', status: 'in_progress' },
            { name: 'Record the deployment', status: 'pending' }
          ]
        }}
      />
    )
    const card = screen.getByRole('status')
    expect(card.textContent).toContain('Deploying your first preview')
    expect(card.textContent).toContain('Deploy with Rayfin · step 2 of 3 · 1:05')
    // One step done and one under way, of three.
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50')
    fireEvent.click(screen.getByRole('button', { name: /Watch in overview/ }))
    fireEvent.click(screen.getByRole('button', { name: /Logs/ }))
    expect(onOpenMap).toHaveBeenCalled()
    expect(openExternal).toHaveBeenCalledWith('https://github.com/o/r/actions/runs/5')
  })
})

describe('CreateTeamWorkspaceModal', () => {
  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((r) => (resolve = r))
    return { promise, resolve }
  }

  it('shows each picker loading until its own choices arrive, and retries failures', async () => {
    const owners = deferred<{ ok: boolean; owners: { login: string; isOrg: boolean }[] }>()
    const firstCapacities = deferred<{ ok: boolean; error?: string; capacities: never[] }>()
    const capacities = vi
      .fn()
      .mockReturnValueOnce(firstCapacities.promise)
      .mockResolvedValueOnce({
        ok: true,
        capacities: [{ id: 'cap1', displayName: 'Sales F4', sku: 'F4', kind: 'fabric', eligible: true }]
      })
    ;(window as unknown as { api: unknown }).api = {
      team: {
        envStatus: vi.fn(() =>
          Promise.resolve({
            ghInstalled: true,
            ghSignedIn: true,
            ghUser: 'octo',
            ghMissingScopes: [],
            ghAccounts: [{ login: 'octo', active: true, signedIn: true, missingScopes: [], canDeleteRepos: false }],
            azSignedIn: true
          })
        ),
        owners: vi.fn(() => owners.promise),
        capacities,
        onProgress: vi.fn(() => () => {}),
        onDiagnosis: vi.fn(() => () => {}),
        diagnose: vi.fn(() => new Promise(() => {})),
        cancel: vi.fn(() => Promise.resolve(true))
      }
    }
    await act(async () => {
      render(
        <OverlayProvider>
          <CreateTeamWorkspaceModal onClose={() => {}} onChanged={() => {}} />
        </OverlayProvider>
      )
    })

    expect(screen.getAllByRole('status')).toHaveLength(2)
    expect(screen.getByText('Finding where octo can create repositories…')).toBeTruthy()
    expect(screen.getByText('Finding the Fabric capacities you can use…')).toBeTruthy()
    const create = screen.getByRole('button', { name: 'Create workspace' }) as HTMLButtonElement
    expect(create.disabled).toBe(true)

    await act(async () => owners.resolve({ ok: true, owners: [{ login: 'octo', isOrg: false }] }))
    expect(screen.queryByText('Finding where octo can create repositories…')).toBeNull()
    expect((screen.getByLabelText('GitHub owner') as HTMLSelectElement).value).toBe('octo')
    expect(screen.getByText('Finding the Fabric capacities you can use…')).toBeTruthy()

    await act(async () => firstCapacities.resolve({ ok: false, error: 'Fabric is unreachable.', capacities: [] }))
    expect(screen.getByRole('alert').textContent).toContain('Fabric is unreachable.')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    })
    expect(capacities).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
    expect((screen.getByLabelText('Fabric capacity') as HTMLSelectElement).value).toBe('cap1')
    fireEvent.change(screen.getByPlaceholderText('Sales team apps'), { target: { value: 'Sales apps' } })
    expect(create.disabled).toBe(false)
  })

  it('offers a Copilot diagnosis when a picker can’t load, with what was entered so far', async () => {
    const diagnose = vi.fn(() => new Promise(() => {}))
    const owners = vi.fn(() => Promise.resolve({ ok: true, owners: [{ login: 'contoso', isOrg: true }] }))
    ;(window as unknown as { api: unknown }).api = {
      team: {
        envStatus: vi.fn(() =>
          Promise.resolve({
            ghInstalled: true,
            ghSignedIn: true,
            ghUser: 'octo',
            ghMissingScopes: [],
            ghAccounts: [
              { login: 'octo', active: true, signedIn: true, missingScopes: [], canDeleteRepos: false },
              { login: 'octo_contoso', active: false, signedIn: true, missingScopes: [], canDeleteRepos: false }
            ],
            azSignedIn: true
          })
        ),
        owners,
        capacities: vi.fn(() =>
          Promise.resolve({
            ok: false,
            error: 'List your Fabric capacities: AADSTS53003: Access has been blocked by Conditional Access policies.',
            capacities: []
          })
        ),
        onProgress: vi.fn(() => () => {}),
        onDiagnosis: vi.fn(() => () => {}),
        diagnose,
        cancel: vi.fn(() => Promise.resolve(true))
      }
    }
    await act(async () => {
      render(
        <OverlayProvider>
          <CreateTeamWorkspaceModal onClose={() => {}} onChanged={() => {}} />
        </OverlayProvider>
      )
    })
    await screen.findByRole('button', { name: /Diagnose with Copilot/ })
    expect(owners).toHaveBeenLastCalledWith('octo')
    // Owners follow the chosen account.
    await act(async () => {
      fireEvent.change(screen.getByLabelText('GitHub account'), { target: { value: 'octo_contoso' } })
    })
    expect(owners).toHaveBeenLastCalledWith('octo_contoso')
    fireEvent.change(screen.getByPlaceholderText('Sales team apps'), { target: { value: 'Sales apps' } })
    fireEvent.click(screen.getByRole('button', { name: /Diagnose with Copilot/ }))
    expect(diagnose).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'setup',
        step: 'fabric',
        error: expect.stringContaining('AADSTS53003'),
        request: expect.objectContaining({ name: 'Sales apps', owner: 'contoso', ownerIsOrg: true, account: 'octo_contoso' })
      })
    )
  })
})

describe('CreateProjectScreen team destination', () => {
  const workspaces: TeamWorkspace[] = [
    {
      id: 'w1',
      name: 'Sales team',
      repo: 'octo/sales-team',
      defaultBranch: 'main',
      dir: 'C:/team',
      role: 'member',
      addedAt: '2026-10-01T00:00:00Z'
    },
    {
      id: 'w2',
      name: 'Half set up',
      repo: 'octo/half',
      defaultBranch: 'main',
      dir: 'C:/half',
      role: 'owner',
      addedAt: '2026-10-01T00:00:00Z',
      setup: { request: { name: 'Half set up', owner: 'octo', capacityId: 'c' }, completed: [], done: false }
    }
  ]

  function installApi(): { create: ReturnType<typeof vi.fn>; createProject: ReturnType<typeof vi.fn> } {
    const create = vi.fn(() => Promise.resolve({ ok: true }))
    const createProject = vi.fn(() =>
      Promise.resolve({ ok: true, project: { id: 't1', name: 'Leads', path: 'C:/team/leads/leads', addedAt: '' } })
    )
    ;(window as unknown as { api: unknown }).api = {
      projects: {
        communityTemplates: vi.fn(() => Promise.resolve({ ok: true, gallery: { templates: [] } })),
        checkName: vi.fn(() => Promise.resolve({ ok: true })),
        create
      },
      team: { createProject },
      onProcLog: vi.fn(() => () => {}),
      fabric: { listWorkspaces: vi.fn(() => Promise.resolve({ ok: true, workspaces: [] })) }
    }
    return { create, createProject }
  }

  it('creates the app in the preselected team workspace without a deploy step', async () => {
    const { create, createProject } = installApi()
    const onTeamCreated = vi.fn()
    await act(async () => {
      render(
        <OverlayProvider>
          <CreateProjectScreen
            mode="create"
            onCancel={() => {}}
            onDeploy={() => {}}
            onContinueWithoutDeploy={() => {}}
            teamWorkspaces={workspaces}
            initialTeamWorkspaceId="w1"
            onTeamCreated={onTeamCreated}
          />
        </OverlayProvider>
      )
    })

    const where = screen.getByRole('combobox') as HTMLSelectElement
    expect(where.value).toBe('w1')
    // Workspaces whose setup didn't finish aren't offered.
    expect(Array.from(where.options).map((o) => o.textContent)).toEqual([
      'Just me, on this computer',
      'Team workspace: Sales team'
    ])
    expect(screen.queryByLabelText('Progress')).toBeNull()

    fireEvent.change(screen.getByPlaceholderText('My Rayfin App'), { target: { value: 'Leads' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    })

    expect(createProject).toHaveBeenCalledWith('w1', {
      name: 'Leads',
      template: 'universal-app',
      templateName: undefined
    })
    expect(create).not.toHaveBeenCalled()
    expect(onTeamCreated).toHaveBeenCalledTimes(1)
  })

  it('keeps creating local projects by default', async () => {
    const { create, createProject } = installApi()
    await act(async () => {
      render(
        <OverlayProvider>
          <CreateProjectScreen
            mode="create"
            onCancel={() => {}}
            onDeploy={() => {}}
            onContinueWithoutDeploy={() => {}}
            teamWorkspaces={workspaces}
          />
        </OverlayProvider>
      )
    })
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('')
    fireEvent.change(screen.getByPlaceholderText('My Rayfin App'), { target: { value: 'Mine' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    })
    expect(create).toHaveBeenCalledTimes(1)
    expect(createProject).not.toHaveBeenCalled()
  })
})
