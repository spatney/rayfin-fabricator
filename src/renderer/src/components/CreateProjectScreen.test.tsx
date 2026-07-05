import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
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
