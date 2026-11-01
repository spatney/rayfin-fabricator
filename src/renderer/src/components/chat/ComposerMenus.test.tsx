import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { McpServer } from '@shared/ipc'
import { AddMenu, PluginsMenu } from './ComposerMenus'
import { offeredPlugins } from './plugins'

afterEach(cleanup)

function renderMenu(over: { imageNote?: string } = {}) {
  const handlers = { onImage: vi.fn(), onConnectData: vi.fn(), onReferenceFile: vi.fn() }
  render(<AddMenu attaching={false} imageNote={over.imageNote} {...handlers} />)
  const open = (): HTMLElement => {
    fireEvent.click(screen.getByRole('button', { name: 'Add images, files or data' }))
    return screen.getByRole('menu', { name: 'Add' })
  }
  return { ...handlers, open }
}

describe('AddMenu', () => {
  it('opens the kinds of Fabric data beside the menu, each opening the data picker on its kind', () => {
    const { open, onConnectData } = renderMenu()
    const menu = open()
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['ImageOr paste', 'File@', 'Fabric data'])

    fireEvent.click(within(menu).getByRole('menuitem', { name: /Fabric data/ }))
    const kinds = screen.getByRole('menu', { name: 'Fabric data' })
    expect(within(kinds).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Semantic modelDAX',
      'WarehouseRead & write',
      'SQL databaseRead & write',
      'LakehouseRead-only',
      'Browse all Fabric data…'
    ])
    fireEvent.click(within(kinds).getByRole('menuitem', { name: /Warehouse/ }))
    expect(onConnectData).toHaveBeenLastCalledWith('warehouse')
    expect(screen.queryByRole('menu')).toBeNull()

    // From the keyboard: → opens the list, ← closes it.
    fireEvent.keyDown(within(open()).getByRole('menuitem', { name: /Fabric data/ }), { key: 'ArrowRight' })
    const list = screen.getByRole('menu', { name: 'Fabric data' })
    fireEvent.keyDown(within(list).getByRole('menuitem', { name: /Lakehouse/ }), { key: 'ArrowLeft' })
    expect(screen.queryByRole('menu', { name: 'Fabric data' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: /Fabric data/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Browse all Fabric data…' }))
    expect(onConnectData).toHaveBeenLastCalledWith()
  })

  it('says why images can’t be added, and references a file', () => {
    const { open, onImage, onReferenceFile } = renderMenu({ imageNote: 'o3-mini can’t read images' })
    const menu = open()
    const image = within(menu).getByRole('menuitem', { name: /Image/ }) as HTMLButtonElement
    expect(image.disabled).toBe(true)
    expect(image.textContent).toContain('o3-mini can’t read images')
    fireEvent.click(image)
    expect(onImage).not.toHaveBeenCalled()
    fireEvent.click(within(menu).getByRole('menuitem', { name: /File/ }))
    expect(onReferenceFile).toHaveBeenCalledTimes(1)
  })
})

describe('PluginsMenu', () => {
  function renderPlugins(over: { on?: string[]; workIq?: boolean; disabled?: boolean } = {}) {
    const onToggle = vi.fn()
    const onLearnMore = vi.fn()
    render(
      <PluginsMenu
        plugins={offeredPlugins({ workIq: over.workIq })}
        on={over.on ?? []}
        disabled={over.disabled}
        onToggle={onToggle}
        onLearnMore={onLearnMore}
      />
    )
    return { onToggle, onLearnMore }
  }

  it('offers Fabric IQ, off to start, and Work IQ only while its experiment is on', () => {
    const { onToggle } = renderPlugins()
    fireEvent.click(screen.getByRole('button', { name: 'Plugins' }))
    const fabric = screen.getByRole('menuitemcheckbox', { name: /Fabric IQ/ })
    expect(screen.getAllByRole('menuitemcheckbox')).toEqual([fabric])
    expect(fabric.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(fabric)
    expect(onToggle).toHaveBeenLastCalledWith('fabric-iq', true)
    // Switching a plugin leaves the menu open for the next one.
    expect(screen.getByRole('menu', { name: 'Plugins & tools' })).toBeTruthy()
    expect(screen.getByText('0 enabled')).toBeTruthy()

    cleanup()
    renderPlugins({ workIq: true })
    fireEvent.click(screen.getByRole('button', { name: 'Plugins' }))
    const work = screen.getByRole('menuitemcheckbox', { name: /Work IQ/ })
    expect(work.textContent).toContain('Experiment')
  })

  it('names the plugins that are on, which turn off from the menu', () => {
    const { onToggle, onLearnMore } = renderPlugins({ on: ['work-iq', 'fabric-iq'], workIq: true })
    fireEvent.click(screen.getByRole('button', { name: 'Plugins: Fabric IQ, Work IQ' }))
    expect(screen.getByText('2 enabled')).toBeTruthy()
    const work = screen.getByRole('menuitemcheckbox', { name: /Work IQ/ })
    expect(work.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(work)
    expect(onToggle).toHaveBeenLastCalledWith('work-iq', false)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Learn about plugins' }))
    expect(onLearnMore).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()

    // Without its experiment, Work IQ is neither named nor offered, even when it was on.
    cleanup()
    renderPlugins({ on: ['work-iq'] })
    expect(screen.getByRole('button', { name: 'Plugins' })).toBeTruthy()
  })

  it('can’t be changed while the assistant is working', () => {
    renderPlugins({ on: ['fabric-iq'], disabled: true })
    const trigger = screen.getByRole('button', { name: 'Plugins: Fabric IQ' }) as HTMLButtonElement
    expect(trigger.disabled).toBe(true)
  })

  describe('with the MCP servers experiment', () => {
    const servers: McpServer[] = [
      {
        id: 'chart',
        name: 'Charts',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@antv/mcp-server-chart'],
        readOnly: false,
        addedAt: '2026-10-31T00:00:00Z'
      },
      {
        id: 'learn',
        name: 'Microsoft Learn',
        transport: 'http',
        url: 'https://learn.microsoft.com/api/mcp',
        readOnly: true,
        addedAt: '2026-10-31T00:00:00Z'
      }
    ]

    function renderWithServers(list: McpServer[], on: string[] = []) {
      const onToggle = vi.fn()
      const onManageServers = vi.fn()
      render(
        <PluginsMenu
          plugins={offeredPlugins({ mcpServers: true })}
          servers={list}
          on={on}
          onToggle={onToggle}
          onManageServers={onManageServers}
        />
      )
      return { onToggle, onManageServers }
    }

    it('lists your servers under their own heading, each off until turned on in this chat', () => {
      const { onToggle, onManageServers } = renderWithServers(servers, ['mcp:learn', 'fabric-iq'])
      fireEvent.click(screen.getByRole('button', { name: 'Plugins: Fabric IQ, Microsoft Learn' }))
      const menu = screen.getByRole('menu', { name: 'Plugins & tools' })
      expect(menu.textContent).toContain('MCP serversExperiment')
      const charts = within(menu).getByRole('menuitemcheckbox', { name: /Charts/ })
      expect(charts.getAttribute('aria-checked')).toBe('false')
      expect(charts.textContent).toContain('npx -y @antv/mcp-server-chart')
      expect(charts.textContent).not.toContain('Read-only')
      const learn = within(menu).getByRole('menuitemcheckbox', { name: /Microsoft Learn/ })
      expect(learn.getAttribute('aria-checked')).toBe('true')
      expect(learn.textContent).toContain('Read-only')
      expect(learn.textContent).toContain('learn.microsoft.com/api/mcp')
      fireEvent.click(charts)
      expect(onToggle).toHaveBeenLastCalledWith('mcp:chart', true)
      fireEvent.click(learn)
      expect(onToggle).toHaveBeenLastCalledWith('mcp:learn', false)
      // Not every plugin only reads any more.
      expect(menu.textContent).toContain('An MCP server can do whatever its tools do.')
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Manage MCP servers…' }))
      expect(onManageServers).toHaveBeenLastCalledWith(false)
      expect(screen.queryByRole('menu')).toBeNull()
    })

    it('offers adding the first server', () => {
      const { onManageServers } = renderWithServers([])
      fireEvent.click(screen.getByRole('button', { name: 'Plugins' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Add an MCP server…' }))
      expect(onManageServers).toHaveBeenLastCalledWith(true)
    })

    it('shows no servers without the experiment, even ones that were on', () => {
      renderPlugins({ on: ['mcp:chart'] })
      fireEvent.click(screen.getByRole('button', { name: 'Plugins' }))
      expect(screen.queryByText('MCP servers')).toBeNull()
      const menu = screen.getByRole('menu', { name: 'Plugins & tools' })
      expect(menu.textContent).toContain('Read-only')
      expect(menu.textContent).not.toContain('An MCP server')
    })
  })
})
