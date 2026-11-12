import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from './store'

async function freshStore() {
  vi.resetModules()
  return import('./store')
}

describe('terminal panel store', () => {
  beforeEach(() => localStorage.clear())

  it('opens a project’s panel with a terminal, and keeps each project’s apart', async () => {
    const { terminalStore, projectTerminals } = await freshStore()
    terminalStore.open('a')
    const a = projectTerminals(terminalStore.getState(), 'a')
    expect(a.open).toBe(true)
    expect(a.tabs).toHaveLength(1)
    expect(a.active).toBe(a.tabs[0].key)
    expect(projectTerminals(terminalStore.getState(), 'b').open).toBe(false)

    // Closing the panel keeps its terminals; opening it again doesn't start another.
    terminalStore.close('a')
    terminalStore.open('a')
    expect(projectTerminals(terminalStore.getState(), 'a').tabs).toHaveLength(1)
  })

  it('brings a new terminal to the front, and remembers the shell picked for the next', async () => {
    const { terminalStore, projectTerminals } = await freshStore()
    terminalStore.open('a')
    terminalStore.add('a', 'cmd')
    const a = projectTerminals(terminalStore.getState(), 'a')
    expect(a.tabs.map((tab) => tab.requestedShell)).toEqual([undefined, 'cmd'])
    expect(a.active).toBe(a.tabs[1].key)
    terminalStore.add('b')
    expect(projectTerminals(terminalStore.getState(), 'b').tabs[0].requestedShell).toBe('cmd')

    const again = await freshStore()
    expect(again.terminalStore.getState().shell).toBe('cmd')
  })

  it('closing a tab fronts its neighbour, and the last one puts the panel away', async () => {
    const { terminalStore, projectTerminals } = await freshStore()
    terminalStore.open('a')
    terminalStore.add('a')
    terminalStore.add('a')
    const [first, second, third] = projectTerminals(terminalStore.getState(), 'a').tabs
    terminalStore.activate('a', second.key)
    terminalStore.remove('a', second.key)
    expect(projectTerminals(terminalStore.getState(), 'a').active).toBe(third.key)
    terminalStore.remove('a', third.key)
    expect(projectTerminals(terminalStore.getState(), 'a').active).toBe(first.key)
    terminalStore.remove('a', first.key)
    expect(projectTerminals(terminalStore.getState(), 'a')).toMatchObject({ open: false, tabs: [] })
  })

  it('marks output seen when its tab comes to the front', async () => {
    const { terminalStore, projectTerminals } = await freshStore()
    terminalStore.open('a')
    terminalStore.add('a')
    const [first] = projectTerminals(terminalStore.getState(), 'a').tabs
    terminalStore.update('a', first.key, { unread: true, status: 'running' })
    terminalStore.activate('a', first.key)
    expect(projectTerminals(terminalStore.getState(), 'a').tabs[0]).toMatchObject({
      unread: false,
      status: 'running'
    })
  })

  it('keeps the text size and panel height in range, and remembers them', async () => {
    const { terminalStore, MAX_FONT_SIZE, MIN_HEIGHT } = await freshStore()
    terminalStore.setFontSize(100)
    terminalStore.setHeight(10)
    expect(terminalStore.getState()).toMatchObject({ fontSize: MAX_FONT_SIZE, height: MIN_HEIGHT })
    terminalStore.setHeight(420)
    const again = await freshStore()
    expect(again.terminalStore.getState()).toMatchObject({ fontSize: MAX_FONT_SIZE, height: 420 })
  })

  it('names tabs by their shell, numbering the second of a kind, and counts live ones', async () => {
    const { tabLabels, liveCount } = await freshStore()
    const tab = (key: string, patch: Partial<TerminalTab>): TerminalTab => ({
      key,
      status: 'running',
      unread: false,
      ...patch
    })
    const tabs = [
      tab('1', { shellId: 'pwsh' }),
      tab('2', { shellId: 'git-bash' }),
      tab('3', { requestedShell: 'pwsh', status: 'starting' }),
      tab('4', { status: 'exited', exitCode: 0 })
    ]
    expect([...tabLabels(tabs).values()]).toEqual(['pwsh', 'bash', 'pwsh 2', 'terminal'])
    expect(liveCount({ open: true, active: '1', tabs, output: false })).toBe(3)
  })

  it('shows the app’s Output in front of the shells, without starting one', async () => {
    const { terminalStore, projectTerminals } = await freshStore()
    const a = (): ReturnType<typeof projectTerminals> =>
      projectTerminals(terminalStore.getState(), 'a')
    terminalStore.showOutput('a')
    expect(a()).toMatchObject({ open: true, output: true, tabs: [] })

    // The terminal shortcut goes to a shell, starting one; the tab strip back to Output.
    terminalStore.open('a')
    expect(a()).toMatchObject({ open: true, output: false })
    expect(a().tabs).toHaveLength(1)
    terminalStore.showOutput('a')
    terminalStore.activate('a', a().tabs[0].key)
    expect(a().output).toBe(false)

    // Closing the last shell leaves Output showing, if that's what's in front.
    terminalStore.showOutput('a')
    terminalStore.remove('a', a().tabs[0].key)
    expect(a()).toMatchObject({ open: true, output: true })
    terminalStore.hideOutput('a')
    expect(a()).toMatchObject({ open: false, output: false })
  })
})
