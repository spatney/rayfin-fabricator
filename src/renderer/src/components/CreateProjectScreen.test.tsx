import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { OverlayProvider } from '../overlay'
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
  it('hands the new app to the workbench, with no publish step, with Local development', async () => {
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

/** Without Local development, a new app is published before chat unlocks. */
describe('CreateProjectScreen publish step', () => {
  const project = { id: 'p1', name: 'Trip Logger', path: 'C:/projects/trip-logger', addedAt: '' }

  function installPublishApi(): {
    create: ReturnType<typeof vi.fn>
    listWorkspaces: ReturnType<typeof vi.fn>
  } {
    const create = vi.fn(() => Promise.resolve({ ok: true, project }))
    const listWorkspaces = vi.fn(() =>
      Promise.resolve({
        ok: true,
        workspaces: [
          { id: 'w1', displayName: 'Sales apps', capacityKind: 'fabric', sku: 'F2', eligible: true }
        ]
      })
    )
    ;(window as unknown as { api: unknown }).api = {
      projects: {
        communityTemplates: vi.fn(() => Promise.resolve({ ok: true, gallery: { templates: [] } })),
        checkName: vi.fn(() => Promise.resolve({ ok: true })),
        create
      },
      fabric: { listWorkspaces, checkDeployTarget: vi.fn(() => Promise.resolve({})) },
      onProcLog: vi.fn(() => () => {})
    }
    return { create, listWorkspaces }
  }

  it('asks to publish the new app, then publishes it or carries on without', async () => {
    const { listWorkspaces } = installPublishApi()
    const onCreated = vi.fn()
    const onDeploy = vi.fn()
    const onContinueWithoutDeploy = vi.fn()
    await act(async () => {
      render(
        <OverlayProvider>
          <CreateProjectScreen
            publishStep
            onCancel={() => {}}
            onCreated={onCreated}
            onDeploy={onDeploy}
            onContinueWithoutDeploy={onContinueWithoutDeploy}
          />
        </OverlayProvider>
      )
    })
    const steps = screen.getByRole('list', { name: 'Progress' })
    expect(steps.textContent).toBe('1Details2Publish')

    fireEvent.change(screen.getByPlaceholderText('My Rayfin App'), {
      target: { value: 'Trip Logger' }
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    })

    expect(onCreated).toHaveBeenCalledWith({ ok: true, project })
    expect(screen.getByRole('heading', { name: 'Publish your app' })).toBeTruthy()
    expect(
      screen.getByText('Publish Trip Logger to a Fabric workspace to start building with chat.')
    ).toBeTruthy()
    expect(
      screen.getByText(
        'You can publish any time, but chat stays locked until your app is published.'
      )
    ).toBeTruthy()
    expect(listWorkspaces).toHaveBeenCalledTimes(1)
    expect(screen.queryByPlaceholderText('My Rayfin App')).toBeNull()

    fireEvent.click(await screen.findByText('Sales apps'))
    const publish = screen.getByRole('button', { name: 'Publish app' }) as HTMLButtonElement
    await waitFor(() => expect(publish.disabled).toBe(false))
    fireEvent.click(publish)
    expect(onDeploy).toHaveBeenCalledWith('Development', 'w1')

    fireEvent.click(screen.getByRole('button', { name: 'Continue without publishing →' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onContinueWithoutDeploy).toHaveBeenCalledTimes(2)
  })

  it('shows the Publish your app step alone from the chat lock', async () => {
    const { create } = installPublishApi()
    const onContinueWithoutDeploy = vi.fn()
    await act(async () => {
      render(
        <OverlayProvider>
          <CreateProjectScreen
            mode="deploy"
            publishStep
            projectName="Trip Logger"
            onCancel={() => {}}
            onContinueWithoutDeploy={onContinueWithoutDeploy}
          />
        </OverlayProvider>
      )
    })
    expect(screen.getByRole('heading', { name: 'Publish your app' })).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'Progress' })).toBeNull()
    expect(screen.queryByPlaceholderText('My Rayfin App')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Maybe later' }))
    expect(onContinueWithoutDeploy).toHaveBeenCalledTimes(1)
    expect(create).not.toHaveBeenCalled()
  })
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
    expect(api().checkName).toHaveBeenCalledWith('Trip Logger', undefined)
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
    expect(api().checkName).not.toHaveBeenCalledWith('SalesBenchmark (migrated)', undefined)
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
