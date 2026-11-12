import type { JSX } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalStatus, StudioProject } from '@shared/ipc'
import type { LocalBackend } from '../../localBackend'
import { projectTerminals, terminalStore } from '../../terminal/store'
import TerminalPanel from './TerminalPanel'

// xterm.js draws on a canvas jsdom doesn't have: the terminals are stand-ins.
const fake = vi.hoisted(() => {
  const views = new Map<string, Record<string, unknown>>()
  const view = (key: string): Record<string, unknown> => {
    let found = views.get(key)
    if (!found) {
      found = {
        key,
        attach: vi.fn(),
        detach: vi.fn(),
        focus: vi.fn(),
        fit: vi.fn(),
        clear: vi.fn(),
        hasSelection: () => false,
        text: () => '',
        shellRunning: true,
        restart: vi.fn()
      }
      views.set(key, found)
    }
    return found
  }
  return { views, view }
})

vi.mock('../../terminal/session', () => ({
  outputKey: (projectId: string) => `output:${projectId}`,
  outputFor: (projectId: string) => fake.view(`output:${projectId}`),
  sessionFor: (_projectId: string, _path: string, tab: { key: string }) => fake.view(tab.key),
  existingView: (key: string | null) => (key ? fake.views.get(key) : undefined),
  existingSession: (key: string | null) =>
    key && !key.startsWith('output:') ? fake.views.get(key) : undefined,
  setTerminalHooks: () => {}
}))

const project = { id: 'p1', name: 'Notes', path: 'C:\\apps\\notes' } as StudioProject

function local(status: Partial<LocalStatus>): LocalBackend {
  return {
    status: { projectId: 'p1', state: 'running', ...status } as LocalStatus,
    state: status.state ?? 'running',
    busy: false,
    actionError: null,
    restart: vi.fn(async () => null)
  } as unknown as LocalBackend
}

const panel = (backend?: LocalBackend): JSX.Element => (
  <TerminalPanel project={project} hidden={false} onOpenFile={() => {}} local={backend} />
)

beforeEach(() => {
  fake.views.clear()
  terminalStore.forget('p1')
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    }
  )
  ;(window as unknown as { api: unknown }).api = { terminal: { shells: vi.fn(async () => []) } }
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete (window as unknown as { api?: unknown }).api
})

describe('TerminalPanel Output', () => {
  it('shows the app’s Output first, with its problems and Restart app', async () => {
    const stuck = local({
      analysis: {
        ok: false,
        sdk: null,
        entities: [],
        storageFolders: [],
        message: 'The data package packages/data has not been built',
        time: null
      }
    })
    terminalStore.showOutput('p1')
    render(panel(stuck))
    await act(async () => {})

    const tab = screen.getByRole('tab', { name: /Output/ })
    expect(tab.getAttribute('aria-selected')).toBe('true')
    expect(fake.views.get('output:p1')?.attach).toHaveBeenCalled()
    expect(screen.getByRole('list', { name: 'Problems' }).textContent).toContain(
      'Your app’s latest data model change couldn’t be read'
    )
    expect(screen.getByRole('button', { name: 'Copy output' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Restart shell' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Restart app' }))
    await act(async () => {})
    expect(stuck.restart).toHaveBeenCalledTimes(1)
  })

  it('goes back to a shell from its tab, and lets Output go when the app stops running here', async () => {
    terminalStore.open('p1')
    terminalStore.showOutput('p1')
    const view = render(panel(local({})))
    await act(async () => {})
    const tabs = within(screen.getByRole('tablist', { name: 'Terminals' })).getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Output', 'terminal'])

    fireEvent.click(tabs[1])
    expect(projectTerminals(terminalStore.getState(), 'p1').output).toBe(false)
    expect(screen.getByRole('button', { name: 'Restart shell' })).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'Problems' })).toBeNull()

    terminalStore.showOutput('p1')
    view.rerender(panel(undefined))
    await act(async () => {})
    expect(screen.queryByRole('tab', { name: /Output/ })).toBeNull()
    expect(projectTerminals(terminalStore.getState(), 'p1')).toMatchObject({
      open: true,
      output: false
    })
  })
})
