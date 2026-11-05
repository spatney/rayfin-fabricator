import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ChatDefaults, CopilotModel, ExperimentFlags, McpServer } from '@shared/ipc'
import { invalidateCopilotModels } from '../copilotModels'
import { setMcpServers } from '../mcpServers'
import ChatDefaultsModal from './ChatDefaultsModal'

const MODELS: CopilotModel[] = [
  {
    id: 'claude-sonnet-5.5',
    name: 'Claude Sonnet 5.5',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    defaultReasoningEffort: 'medium',
    vision: true
  },
  {
    id: 'gpt-6.1-sol',
    name: 'GPT-6.1 Sol',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    defaultReasoningEffort: 'medium',
    vision: true
  }
]

const chart: McpServer = {
  id: 'chart',
  name: 'Charts',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@antv/mcp-server-chart'],
  readOnly: false,
  addedAt: '2026-01-01T00:00:00.000Z'
}

function renderDefaults(
  props: {
    defaults?: ChatDefaults
    experiments?: ExperimentFlags
    onManageMcpServers?: () => void
  } = {}
) {
  const onChange = vi.fn()
  const onClose = vi.fn()
  render(<ChatDefaultsModal onChange={onChange} onClose={onClose} {...props} />)
  return { onChange, onClose }
}

beforeEach(() => {
  invalidateCopilotModels()
  setMcpServers([])
  ;(window as unknown as { api: unknown }).api = {
    chat: { listModels: vi.fn(async () => MODELS), autoTiers: vi.fn(async () => null) },
    mcp: { list: vi.fn(async () => []) }
  }
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('ChatDefaultsModal', () => {
  it('starts from the saved defaults, and saves each switch with the model kept', () => {
    const { onChange } = renderDefaults({
      defaults: { model: 'gpt-6.1-sol', effort: 'high', plugins: ['fabric-iq'] }
    })
    const fabric = screen.getByRole('checkbox', { name: /Fabric IQ/ }) as HTMLInputElement
    expect(fabric.checked).toBe(true)
    // Work IQ and MCP servers only while their experiments are on.
    expect(screen.queryByRole('checkbox', { name: /Work IQ/ })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'MCP servers' })).toBeNull()

    fireEvent.click(fabric)
    expect(onChange).toHaveBeenLastCalledWith({ model: 'gpt-6.1-sol', effort: 'high', plugins: [] })
    expect(fabric.checked).toBe(false)
  })

  it('saves a model picked from a menu over the dialog, with the plugins kept', async () => {
    const { onChange } = renderDefaults({ defaults: { plugins: ['fabric-iq'] } })
    fireEvent.click(screen.getByRole('button', { name: /^Default model:/ }))
    const auto = (await screen.findByRole('menuitemcheckbox', {
      name: /Auto/
    })) as HTMLButtonElement
    expect(auto.closest('.mp-pop')?.classList.contains('mp-pop--over-dialog')).toBe(true)
    await waitFor(() => expect(auto.disabled).toBe(false))
    fireEvent.click(auto)
    expect(onChange).toHaveBeenLastCalledWith({
      model: 'claude-sonnet-5.5',
      plugins: ['fabric-iq']
    })
  })

  it('closes the model menu on Escape before the dialog', async () => {
    const { onClose } = renderDefaults()
    fireEvent.click(screen.getByRole('button', { name: /^Default model:/ }))
    const menu = await screen.findByRole('menu', { name: 'Default model' })
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByRole('menu', { name: 'Default model' })).toBeNull()
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('offers Work IQ and your MCP servers while their experiments are on', () => {
    setMcpServers([chart])
    const { onChange } = renderDefaults({
      defaults: { plugins: ['fabric-iq'] },
      experiments: { workIq: true, mcpServers: true }
    })
    expect(screen.getByRole('checkbox', { name: /Work IQ/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: /Charts/ }))
    expect(onChange).toHaveBeenLastCalledWith({ plugins: ['fabric-iq', 'mcp:chart'] })
  })

  it('points to MCP servers when none are added yet', () => {
    const onManageMcpServers = vi.fn()
    renderDefaults({ experiments: { mcpServers: true }, onManageMcpServers })
    expect(screen.getByText('No MCP servers yet')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Manage MCP servers' }))
    expect(onManageMcpServers).toHaveBeenCalledTimes(1)
  })
})
