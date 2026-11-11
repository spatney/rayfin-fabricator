import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { GithubRepoResult } from '@shared/ipc'
import { OverlayProvider } from '../overlay'
import { ToastProvider } from '../toast'
import CreateProjectScreen from './CreateProjectScreen'

/**
 * Guards issue #2: the Project name field must not let macOS/WebKit auto-correct
 * or auto-capitalize what the user types (e.g. "app-builder" → "App-builder").
 * That is controlled by the DOM autocapitalize/autocorrect/spellcheck attributes,
 * so we assert they are disabled on the input.
 */

/** Minimal `window.api` surface CreateProjectScreen touches. */
function installApi(): void {
  ;(window as unknown as { api: unknown }).api = {
    projects: {
      communityTemplates: vi.fn(() => Promise.resolve({ ok: true, gallery: { templates: [] } })),
      checkName: vi.fn(() => Promise.resolve({ ok: true })),
      create: vi.fn(() => Promise.resolve({ ok: true }))
    },
    onProcLog: vi.fn(() => () => {})
  }
}

beforeEach(() => {
  installApi()
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('CreateProjectScreen project name input', () => {
  it('disables auto-capitalize / auto-correct / spellcheck so names are typed verbatim (issue #2)', async () => {
    await act(async () => {
      render(
        <OverlayProvider>
          <CreateProjectScreen onCancel={() => {}} />
        </OverlayProvider>
      )
    })

    const input = screen.getByPlaceholderText('My Rayfin App')
    expect(input.getAttribute('autocapitalize')).toBe('off')
    expect(input.getAttribute('autocorrect')).toBe('off')
    expect(input.getAttribute('spellcheck')).toBe('false')
  })
})

/**
 * Regression: while a project is being created (the slow scaffold + npm install),
 * the name / starting-point fields must be hidden so the progress status sits at
 * the top of the panel instead of below the (now-irrelevant) inputs.
 */
describe('CreateProjectScreen create progress', () => {
  it('hides the name + starting point once creation starts', async () => {
    let resolveCreate: (v: unknown) => void = () => {}
    const createPromise = new Promise((r) => {
      resolveCreate = r
    })
    ;(window as unknown as { api: unknown }).api = {
      projects: {
        communityTemplates: vi.fn(() =>
          Promise.resolve({ ok: true, gallery: { templates: [] } })
        ),
        create: vi.fn(() => createPromise)
      },
      onProcLog: vi.fn(() => () => {})
    }

    await act(async () => {
      render(
        <OverlayProvider>
          <CreateProjectScreen onCancel={() => {}} />
        </OverlayProvider>
      )
    })

    // Before creating: the starting point is on screen.
    const startField = screen
      .getByRole('button', { name: 'Start from a community example' })
      .closest('.field') as HTMLElement
    const nameField = screen.getByPlaceholderText('My Rayfin App').closest('.field') as HTMLElement
    expect(startField.className).not.toContain('create-field-hidden')
    expect(nameField.className).not.toContain('create-field-hidden')

    // Name it, then start creating. `create()` stays pending, so `busy` holds.
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('My Rayfin App'), {
        target: { value: 'My App' }
      })
    })
    await act(async () => {
      fireEvent.click(screen.getByText('Create project'))
    })

    // Now the inputs are hidden and the header reflects the in-progress install.
    expect(startField.className).toContain('create-field-hidden')
    expect(nameField.className).toContain('create-field-hidden')
    expect(screen.getByText(/Setting up/)).toBeTruthy()

    // Resolve the pending create so no promise dangles past the test.
    await act(async () => {
      resolveCreate({ ok: false, error: 'stop' })
    })
  })
})

describe('CreateProjectScreen after creating', () => {
  it('hands the new app to the workbench, with no publish step', async () => {
    const project = { id: 'p1', name: 'Trip Logger', path: 'C:/projects/trip-logger', addedAt: '' }
    const create = (
      window as unknown as { api: { projects: { create: ReturnType<typeof vi.fn> } } }
    ).api.projects.create
    create.mockResolvedValue({ ok: true, project })
    const onCreated = vi.fn()
    await act(async () => {
      render(
        <OverlayProvider>
          <CreateProjectScreen onCancel={() => {}} onCreated={onCreated} />
        </OverlayProvider>
      )
    })
    expect(screen.queryByLabelText('Progress')).toBeNull()

    fireEvent.change(screen.getByPlaceholderText('My Rayfin App'), {
      target: { value: 'Trip Logger' }
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    })

    expect(onCreated).toHaveBeenCalledWith({ ok: true, project })
    expect(screen.queryByText('Publish your app')).toBeNull()
    expect(screen.queryByRole('button', { name: /Continue without publishing/ })).toBeNull()
    // The screen waits for the workbench to take over, and can't create it twice.
    const nameField = screen.getByPlaceholderText('My Rayfin App').closest('.field') as HTMLElement
    expect(nameField.className).toContain('create-field-hidden')
    const opening = screen.getByRole('button', { name: 'Opening…' }) as HTMLButtonElement
    const cancel = screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement
    expect(opening.disabled && cancel.disabled).toBe(true)
  })
})

describe('CreateProjectScreen location', () => {
  it('creates a project in another folder, offering to create it, with recent folders to pick', async () => {
    const projects = (
      window as unknown as { api: { projects: Record<string, ReturnType<typeof vi.fn>> } }
    ).api.projects
    projects.checkLocation = vi.fn(async (path: string) =>
      path === 'C:\\code\\apps'
        ? { ok: false, missing: true, message: 'This folder doesn’t exist yet.' }
        : { ok: true }
    )
    projects.createLocation = vi.fn(async () => ({ ok: true }))
    await act(async () => {
      render(
        <OverlayProvider>
          <CreateProjectScreen
            onCancel={() => {}}
            projectsFolder="C:\Users\me\RayfinProjects"
            recentLocations={['C:\\code\\demos', 'c:\\users\\me\\rayfinprojects\\']}
          />
        </OverlayProvider>
      )
    })
    const location = screen.getByLabelText('Location') as HTMLInputElement
    expect(location.value).toBe('C:\\Users\\me\\RayfinProjects')
    // Folders other than the projects folder are offered.
    const recents = screen.getByRole('group', { name: 'Recent locations' })
    expect(
      within(recents)
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual(['C:\\code\\demos'])

    fireEvent.change(screen.getByPlaceholderText('My Rayfin App'), {
      target: { value: 'Trip Logger' }
    })
    fireEvent.change(location, { target: { value: 'C:\\code\\apps' } })
    const create = screen.getByRole('button', { name: 'Create project' }) as HTMLButtonElement
    const offer = await screen.findByRole('button', { name: 'Create folder' })
    expect(create.disabled).toBe(true)
    await act(async () => {
      fireEvent.click(offer)
    })
    expect(projects.createLocation).toHaveBeenCalledWith('C:\\code\\apps')
    await waitFor(() => expect(create.disabled).toBe(false))
    await waitFor(() =>
      expect(projects.checkName).toHaveBeenLastCalledWith(
        'Trip Logger',
        undefined,
        'C:\\code\\apps'
      )
    )
    expect(
      within(screen.getByRole('group', { name: 'Recent locations' }))
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual(['Projects folder', 'C:\\code\\demos'])

    await act(async () => {
      fireEvent.click(create)
    })
    expect(projects.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Trip Logger', location: 'C:\\code\\apps' })
    )
  })
})

describe('CreateProjectScreen suggested name', () => {
  it('starts with a random name that’s free where the project goes, until one is typed', async () => {
    const projects = (
      window as unknown as { api: { projects: Record<string, ReturnType<typeof vi.fn>> } }
    ).api.projects
    let first: string | undefined
    projects.checkName.mockImplementation(async (name: string) => {
      first ??= name
      return name === first ? { ok: false, message: 'Taken.' } : { ok: true }
    })
    projects.checkLocation = vi.fn(async () => ({ ok: true }))
    await act(async () => {
      render(
        <OverlayProvider>
          <CreateProjectScreen onCancel={() => {}} projectsFolder="C:\Users\me\RayfinProjects" />
        </OverlayProvider>
      )
    })
    const input = screen.getByPlaceholderText('My Rayfin App') as HTMLInputElement
    await waitFor(() => expect(input.value).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/), { timeout: 5000 })
    const suggested = input.value
    expect(suggested).not.toBe(first)
    expect(projects.checkName).toHaveBeenCalledWith(first, undefined, undefined)

    // Another folder keeps the name while it's free there too.
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'C:\\code\\apps' } })
    await waitFor(
      () => expect(projects.checkName).toHaveBeenCalledWith(suggested, undefined, 'C:\\code\\apps'),
      { timeout: 5000 }
    )
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(input.value).toBe(suggested)

    fireEvent.change(input, { target: { value: 'Trip Logger' } })
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'C:\\code\\demos' } })
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(input.value).toBe('Trip Logger')
  })
})

describe('CreateProjectScreen GitHub repository', () => {
  it.each<[string, GithubRepoResult, string, string]>([
    [
      'it’s created',
      { ok: true, url: 'https://github.com/octo/trip-logger' },
      'On GitHub',
      'The app’s first version is at github.com/octo/trip-logger.'
    ],
    [
      'it isn’t',
      { ok: false, error: 'github.com/octo/trip-logger already exists. Choose another name.' },
      'Not on GitHub yet',
      'github.com/octo/trip-logger already exists. Choose another name. Create it from the git item in the status bar.'
    ]
  ])(
    'creates the project, then its repository, and opens it when %s',
    async (_, repo, title, message) => {
      const api = (
        window as unknown as { api: Record<string, Record<string, ReturnType<typeof vi.fn>>> }
      ).api
      const project = {
        id: 'p1',
        name: 'Trip Logger',
        path: 'C:/projects/trip-logger',
        addedAt: ''
      }
      api.projects.create.mockResolvedValue({ ok: true, project })
      const createRepo = vi.fn().mockResolvedValue(repo)
      api.github = {
        accounts: vi.fn().mockResolvedValue({
          ghInstalled: true,
          accounts: [{ login: 'octo', active: true, signedIn: true }]
        }),
        owners: vi.fn().mockResolvedValue({ ok: true, owners: [{ login: 'octo', isOrg: false }] }),
        checkRepo: vi.fn().mockResolvedValue({ ok: true }),
        createRepo
      }
      const onCreated = vi.fn()
      await act(async () => {
        render(
          <ToastProvider>
            <OverlayProvider>
              <CreateProjectScreen onCancel={() => {}} onCreated={onCreated} />
            </OverlayProvider>
          </ToastProvider>
        )
      })
      fireEvent.change(screen.getByPlaceholderText('My Rayfin App'), {
        target: { value: 'Trip Logger' }
      })
      fireEvent.click(screen.getByRole('checkbox', { name: /^Create a GitHub repository/ }))
      const create = screen.getByRole('button', { name: 'Create project' }) as HTMLButtonElement
      await waitFor(() => expect(create.disabled).toBe(false), { timeout: 5000 })
      await act(async () => {
        fireEvent.click(create)
      })

      await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ ok: true, project }))
      expect(createRepo).toHaveBeenCalledWith('p1', {
        account: 'octo',
        owner: 'octo',
        private: true,
        name: 'trip-logger'
      })
      expect(api.projects.create.mock.invocationCallOrder[0]).toBeLessThan(
        createRepo.mock.invocationCallOrder[0]
      )
      expect(screen.getByText(title)).toBeTruthy()
      expect(screen.getByText(message)).toBeTruthy()
    }
  )
})

describe('CreateProjectScreen starting point', () => {
  function renderCreate(): void {
    render(
      <OverlayProvider>
        <CreateProjectScreen onCancel={() => {}} />
      </OverlayProvider>
    )
  }

  function api(): {
    create: ReturnType<typeof vi.fn>
    communityTemplates: ReturnType<typeof vi.fn>
    checkName: ReturnType<typeof vi.fn>
  } {
    return (window as unknown as { api: { projects: never } }).api.projects
  }

  it('says when the name is already taken and keeps Create disabled', async () => {
    api().checkName.mockResolvedValue({
      ok: false,
      message: 'A folder named “trip-logger” is already in your projects folder. Choose another name.'
    })
    await act(async () => renderCreate())
    fireEvent.change(screen.getByPlaceholderText('My Rayfin App'), { target: { value: 'Trip Logger' } })

    expect((await screen.findByRole('alert')).textContent).toContain('“trip-logger”')
    expect(api().checkName).toHaveBeenCalledWith('Trip Logger', undefined, undefined)
    expect(screen.getByPlaceholderText('My Rayfin App').getAttribute('aria-invalid')).toBe('true')
    expect((screen.getByRole('button', { name: 'Create project' }) as HTMLButtonElement).disabled).toBe(true)

    // A free name clears the warning.
    api().checkName.mockResolvedValue({ ok: true })
    fireEvent.change(screen.getByPlaceholderText('My Rayfin App'), { target: { value: 'Trip Planner' } })
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect((screen.getByRole('button', { name: 'Create project' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('says right away when the Rayfin CLI would refuse a name, and keeps Create disabled', async () => {
    await act(async () => renderCreate())
    fireEvent.change(screen.getByPlaceholderText('My Rayfin App'), { target: { value: 'SalesBenchmark (migrated)' } })

    expect(screen.getByRole('alert').textContent).toBe('Use only letters, numbers, spaces, hyphens and underscores.')
    expect((screen.getByRole('button', { name: 'Create project' }) as HTMLButtonElement).disabled).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(api().checkName).not.toHaveBeenCalledWith(
      'SalesBenchmark (migrated)',
      undefined,
      undefined
    )
  })

  it('offers a Copilot model for an app made from a report', async () => {
    const onChange = vi.fn()
    await act(async () => {
      render(
        <OverlayProvider>
          <CreateProjectScreen
            onCancel={() => {}}
            source={{ label: 'From Power BI', detail: 'Sales · 3 pages' }}
            model={{ value: { model: '', effort: '', autoTier: '', contextTier: '' }, onChange }}
          />
        </OverlayProvider>
      )
    })
    expect(screen.getByText('Copilot model')).toBeTruthy()
    expect(screen.getByText(/Copilot rebuilds the report with this model/)).toBeTruthy()
  })

  it("creates from the Rayfin CLI's default template without asking for a template", async () => {
    await act(async () => renderCreate())
    expect(screen.queryByText('Featured')).toBeNull()
    expect(screen.queryByRole('button', { name: /Universal/ })).toBeNull()
    expect(api().communityTemplates).not.toHaveBeenCalled()

    fireEvent.change(screen.getByPlaceholderText('My Rayfin App'), { target: { value: 'Trip Logger' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    })
    expect(api().create).toHaveBeenCalledWith({
      name: 'Trip Logger',
      template: 'universal-app',
      templateName: undefined
    })
  })

  it('offers community examples on request, and goes back to the starter', async () => {
    const gallery = {
      repoUrl: 'https://github.com/microsoft/awesome-rayfin',
      displayName: 'Awesome Rayfin',
      templates: [
        { repoUrl: 'https://github.com/microsoft/awesome-rayfin', path: 'apps/field', name: 'Field technician', description: 'Jobs and visits.' },
        { repoUrl: 'https://github.com/microsoft/awesome-rayfin', path: 'apps/expenses', name: 'Expenses', description: 'Receipts and approvals.' }
      ]
    }
    api().communityTemplates.mockResolvedValue({ ok: true, gallery })
    await act(async () => renderCreate())

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start from a community example' }))
    })
    expect(api().communityTemplates).toHaveBeenCalledTimes(1)

    // Changing your mind returns to the starter.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start from scratch instead' }))
    })
    expect(screen.getByRole('button', { name: 'Start from a community example' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Expenses/ })).toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start from a community example' }))
    })
    expect(api().communityTemplates).toHaveBeenCalledTimes(1)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Expenses/ }))
    })
    fireEvent.change(screen.getByPlaceholderText('My Rayfin App'), { target: { value: 'Spend' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    })
    expect(api().create).toHaveBeenLastCalledWith({
      name: 'Spend',
      template: 'https://github.com/microsoft/awesome-rayfin',
      templateName: 'Expenses'
    })
  })
})
