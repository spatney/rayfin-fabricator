import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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
      templates: vi.fn(() => Promise.resolve([])),
      communityTemplates: vi.fn(() => Promise.resolve({ ok: true, gallery: { templates: [] } })),
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
 * the name / template inputs must be hidden so the progress status sits at the top
 * of the panel instead of below the (now-irrelevant) template picker.
 */
describe('CreateProjectScreen create progress', () => {
  it('hides the name + template fields once creation starts', async () => {
    let resolveCreate: (v: unknown) => void = () => {}
    const createPromise = new Promise((r) => {
      resolveCreate = r
    })
    ;(window as unknown as { api: unknown }).api = {
      projects: {
        templates: vi.fn(() =>
          Promise.resolve([
            {
              name: 'fabricator-blankapp',
              displayName: 'Blank App',
              description: 'Bare-bones starter.',
              defaultPreviewMode: null
            }
          ])
        ),
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

    // Before creating: the template picker is on screen.
    const templateField = screen.getByText('Template', { exact: true }).parentElement as HTMLElement
    const nameField = screen.getByPlaceholderText('My Rayfin App').closest('.field') as HTMLElement
    expect(templateField.className).not.toContain('create-field-hidden')
    expect(nameField.className).not.toContain('create-field-hidden')
    expect(screen.getByText('Featured')).toBeTruthy()

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
    expect(templateField.className).toContain('create-field-hidden')
    expect(nameField.className).toContain('create-field-hidden')
    expect(screen.getByText(/Setting up/)).toBeTruthy()

    // Resolve the pending create so no promise dangles past the test.
    await act(async () => {
      resolveCreate({ ok: false, error: 'stop' })
    })
  })
})
