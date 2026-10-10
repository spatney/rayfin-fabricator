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

/** Minimal `window.api` surface CreateProjectScreen touches on mount (create mode). */
function installApi(): void {
  ;(window as unknown as { api: unknown }).api = {
    projects: {
      communityTemplates: vi.fn(() => Promise.resolve({ ok: true, gallery: { templates: [] } })),
      checkName: vi.fn(() => Promise.resolve({ ok: true })),
      create: vi.fn(() => Promise.resolve({ ok: true }))
    },
    onProcLog: vi.fn(() => () => {}),
    fabric: { listWorkspaces: vi.fn(() => Promise.resolve({ ok: true, workspaces: [] })) }
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
          <CreateProjectScreen
            mode="create"
            onCancel={() => {}}
            onDeploy={() => {}}
            onContinueWithoutDeploy={() => {}}
          />
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
      onProcLog: vi.fn(() => () => {}),
      fabric: { listWorkspaces: vi.fn(() => Promise.resolve({ ok: true, workspaces: [] })) }
    }

    await act(async () => {
      render(
        <OverlayProvider>
          <CreateProjectScreen
            mode="create"
            onCancel={() => {}}
            onDeploy={() => {}}
            onContinueWithoutDeploy={() => {}}
          />
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

describe('CreateProjectScreen starting point', () => {
  function renderCreate(): void {
    render(
      <OverlayProvider>
        <CreateProjectScreen
          mode="create"
          onCancel={() => {}}
          onDeploy={() => {}}
          onContinueWithoutDeploy={() => {}}
        />
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
