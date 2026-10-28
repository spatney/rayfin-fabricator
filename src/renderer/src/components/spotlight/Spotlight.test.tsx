import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { FileNode, HelpAnswer, HelpEventEnvelope } from '@shared/ipc'
import { OverlayProvider } from '../../overlay'
import Spotlight, { RESUME_MS, resetSpotlightMemory, type SpotlightProps } from './Spotlight'
import type { SearchItem } from './model'

let emit: (envelope: HelpEventEnvelope) => void = () => {}
const ask =
  vi.fn<(input: { askId: string; question: string; projectId?: string }) => Promise<HelpAnswer>>()

function action(id: string, title: string): SearchItem {
  return {
    id: `action:${id}`,
    group: 'actions',
    title,
    icon: { kind: 'codicon', name: 'gear' },
    run: vi.fn()
  }
}

const tree: FileNode[] = [
  {
    name: 'src',
    path: 'src',
    type: 'dir',
    children: [{ name: 'Dashboard.tsx', path: 'src/Dashboard.tsx', type: 'file' }]
  }
]

function setup(overrides: Partial<SpotlightProps> = {}): SpotlightProps {
  const props: SpotlightProps = {
    onClose: vi.fn(),
    items: [
      action('settings', 'Settings'),
      action('open-logs', 'Open logs folder'),
      action('open-folder', 'Open folder')
    ],
    recentProjects: [],
    questions: [{ id: 'new', question: 'What’s new in this release?' }],
    openUrl: vi.fn(),
    help: {
      available: true,
      context: { projectId: 'p1' },
      onUnavailable: vi.fn(),
      onOpen: vi.fn(),
      onAction: vi.fn(),
      onReportIssue: vi.fn()
    },
    modKey: 'Ctrl',
    ...overrides
  }
  render(
    <OverlayProvider>
      <Spotlight {...props} />
    </OverlayProvider>
  )
  return props
}

const field = (): HTMLInputElement =>
  screen.getByRole('combobox', { name: /^(Search|Ask Help)$/ }) as HTMLInputElement
const type = (text: string): void => {
  fireEvent.change(field(), { target: { value: text } })
}
const press = (key: string, init: Partial<KeyboardEventInit> = {}): void => {
  fireEvent.keyDown(field(), { key, ...init })
}

beforeEach(() => {
  vi.clearAllMocks()
  resetSpotlightMemory()
  localStorage.clear()
  ask.mockImplementation(() => new Promise(() => {}))
  ;(window as unknown as { api: unknown }).api = {
    help: {
      ask,
      cancel: vi.fn(() => Promise.resolve(true)),
      grounding: vi.fn(() =>
        Promise.resolve({ sourceReady: true, docsReady: true, notesReady: true, pinned: true })
      ),
      prepare: vi.fn(),
      loadHistory: vi.fn(() => Promise.resolve(null)),
      saveHistory: vi.fn(() => Promise.resolve()),
      clearHistory: vi.fn(() => Promise.resolve()),
      onEvent: (cb: (envelope: HelpEventEnvelope) => void) => {
        emit = cb
        return () => {}
      }
    },
    openExternal: vi.fn()
  }
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('Search', () => {
  it('finds what you type and runs it on Enter, closing as it goes', () => {
    const props = setup()
    type('sett')
    expect(screen.getByRole('option', { name: /Settings/ })).toBeTruthy()
    press('Enter')
    expect(props.items[0].run).toHaveBeenCalled()
    expect(props.onClose).toHaveBeenCalled()
  })

  it('moves the selection with the arrow keys', () => {
    const props = setup()
    type('open')
    const first = field().getAttribute('aria-activedescendant')
    press('ArrowDown')
    expect(field().getAttribute('aria-activedescendant')).not.toBe(first)
    press('Enter')
    const ran = props.items.filter(
      (item) => (item.run as ReturnType<typeof vi.fn>).mock.calls.length > 0
    )
    expect(ran).toHaveLength(1)
    expect(ran[0].title).toMatch(/^Open/)
  })

  it('clears what you typed on Escape, then closes', async () => {
    const props = setup()
    type('sett')
    press('Escape')
    expect(field().value).toBe('')
    expect(props.onClose).not.toHaveBeenCalled()
    press('Escape')
    await waitFor(() => expect(props.onClose).toHaveBeenCalled())
  })

  it('asks Help and shows the answer as it arrives, then carries on in Help', async () => {
    const props = setup()
    type('why did my deploy fail?')
    press('Enter')
    expect(await screen.findByText('why did my deploy fail?')).toBeTruthy()
    await waitFor(() => expect(ask).toHaveBeenCalled())
    expect(ask.mock.calls[0][0]).toMatchObject({
      question: 'why did my deploy fail?',
      projectId: 'p1'
    })

    act(() =>
      emit({
        askId: ask.mock.calls[0][0].askId,
        event: { type: 'delta', text: 'No workspace was selected.' }
      })
    )
    expect(await screen.findByText(/No workspace was selected\./)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Open in Help/ }))
    expect(props.help.onOpen).toHaveBeenCalled()
  })

  it('offers what can be done instead when Help can’t answer', () => {
    const help = {
      available: false,
      context: {},
      onUnavailable: vi.fn(),
      onOpen: vi.fn(),
      onAction: vi.fn(),
      onReportIssue: vi.fn()
    }
    setup({ help })
    type('what broke')
    press('Enter', { ctrlKey: true })
    expect(help.onUnavailable).toHaveBeenCalled()
    expect(ask).not.toHaveBeenCalled()
  })

  it('finds the open project’s files and opens one in Code', async () => {
    const open = vi.fn()
    setup({
      files: { projectId: 'p1', projectName: 'Contoso', load: () => Promise.resolve(tree), open }
    })
    type('dash')
    fireEvent.click(await screen.findByRole('option', { name: /Dashboard\.tsx/ }))
    expect(open).toHaveBeenCalledWith('src/Dashboard.tsx')
  })

  it('opens a docs page in the browser', async () => {
    const props = setup()
    type('deploy to microsoft fabric')
    fireEvent.click(await screen.findByRole('option', { name: /^Deploy to Microsoft Fabric/ }))
    expect(props.openUrl).toHaveBeenCalledWith(
      'https://spatney.github.io/rayfin-fabricator/docs/ship/deploy'
    )
  })

  it('lists what else a result can do on Ctrl+K, and runs the one you pick', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const notify = vi.fn()
    const props = setup({ notify })
    type('deploy to microsoft fabric')
    fireEvent.pointerMove(
      await screen.findByRole('option', { name: /^Deploy to Microsoft Fabric/ })
    )
    press('k', { ctrlKey: true })

    const actions = screen.getByRole('listbox', { name: 'Actions' })
    expect(within(actions).getByRole('option', { name: /Open in browser/ })).toBeTruthy()
    const filter = screen.getByRole('combobox', { name: 'Search for actions' })
    fireEvent.change(filter, { target: { value: 'copy' } })
    fireEvent.keyDown(filter, { key: 'Enter' })

    expect(writeText).toHaveBeenCalledWith(
      'https://spatney.github.io/rayfin-fabricator/docs/ship/deploy'
    )
    expect(props.onClose).toHaveBeenCalled()
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Copied the link'))
    expect(props.openUrl).not.toHaveBeenCalled()
  })

  it('asks Help what you typed when you press Tab', async () => {
    setup()
    type('what broke')
    press('Tab')
    await waitFor(() => expect(ask).toHaveBeenCalled())
    expect(ask.mock.calls[0][0]).toMatchObject({ question: 'what broke' })
  })

  it('goes into one kind of thing’s own search, and back out with Escape', async () => {
    setup()
    type('deploy')
    fireEvent.click(await screen.findByRole('option', { name: /^Search the docs/ }))
    expect(field().placeholder).toBe('Search the docs…')
    expect(field().value).toBe('deploy')
    expect(screen.getByRole('group', { name: 'Documentation' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /^Settings/ })).toBeNull()

    press('Escape')
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()
    expect(field().placeholder).toBe('Search for projects, actions and docs…')
  })

  it('keeps its keys when a click leaves the search box, and sends typing back to it', () => {
    const props = setup()
    type('sett')
    // A click in the list leaves the keyboard in the box.
    expect(fireEvent.mouseDown(screen.getByRole('option', { name: /Settings/ }))).toBe(false)

    // A click on something that can't take focus, such as the answer's text.
    const dialog = screen.getByRole('dialog', { name: 'Search' })
    dialog.focus()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(field().value).toBe('')
    fireEvent.keyDown(dialog, { key: 'x' })
    expect(document.activeElement).toBe(field())

    dialog.focus()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(props.onClose).toHaveBeenCalled()
  })

  it('opens where you left it when you come back soon, and starts over after a while', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    try {
      setup()
      type('sett')
      cleanup()
      now.mockReturnValue(1_030_000)
      setup()
      expect(field().value).toBe('sett')
      cleanup()
      now.mockReturnValue(1_030_000 + RESUME_MS + 1)
      setup()
      expect(field().value).toBe('')
    } finally {
      now.mockRestore()
    }
  })
})
