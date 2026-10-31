import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { McpCheckResult, McpServer, McpServerInput } from '@shared/ipc'
import { invalidateMcpServers } from '../../mcpServers'
import McpServersModal from './McpServersModal'

const LEARN: McpServer = {
  id: 'microsoft-learn',
  name: 'Microsoft Learn',
  transport: 'http',
  url: 'https://learn.microsoft.com/api/mcp',
  headers: ['Authorization'],
  readOnly: false,
  addedAt: '2026-10-31T00:00:00Z'
}

let saved: McpServer[]
let api: {
  list: ReturnType<typeof vi.fn>
  save: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  check: ReturnType<typeof vi.fn>
}

function install(servers: McpServer[]): void {
  saved = servers
  api = {
    list: vi.fn(async () => saved),
    save: vi.fn(async (input: McpServerInput) => {
      const id = input.id ?? input.name.toLowerCase().replace(/\s+/g, '-')
      const server: McpServer = {
        id,
        name: input.name,
        transport: input.transport,
        command: input.command,
        args: input.args,
        url: input.url,
        env: input.env?.map((v) => v.name),
        headers: input.headers?.map((v) => v.name),
        readOnly: Boolean(input.readOnly),
        addedAt: 'now'
      }
      saved = [...saved.filter((s) => s.id !== id), server]
      return saved
    }),
    remove: vi.fn(async (id: string) => {
      saved = saved.filter((s) => s.id !== id)
      return saved
    }),
    check: vi.fn(async (): Promise<McpCheckResult> => ({
      status: 'connected',
      tools: [
        { name: 'microsoft_docs_search', description: 'Search Microsoft docs' },
        { name: 'microsoft_docs_fetch' }
      ]
    }))
  }
  ;(window as unknown as { api: unknown }).api = { mcp: api, openExternal: vi.fn() }
}

beforeEach(() => invalidateMcpServers())

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

const dialog = () => screen.getByRole('dialog')

describe('McpServersModal', () => {
  it('offers Microsoft Learn to try, saves it, and checks it straight away', async () => {
    install([])
    const onChanged = vi.fn()
    render(<McpServersModal onClose={() => {}} onChanged={onChanged} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add Microsoft Learn' }))
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Microsoft Learn')
    expect((screen.getByLabelText('URL') as HTMLInputElement).value).toBe(
      'https://learn.microsoft.com/api/mcp'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.check).toHaveBeenCalledWith('microsoft-learn'))
    expect(api.save).toHaveBeenCalledWith({
      id: undefined,
      name: 'Microsoft Learn',
      transport: 'http',
      url: 'https://learn.microsoft.com/api/mcp',
      headers: [],
      readOnly: false
    })
    expect(onChanged).toHaveBeenCalled()
    const card = await screen.findByRole('region', { name: 'Microsoft Learn' })
    expect(await within(card).findByText('It connected, and offers 2 tools:')).toBeTruthy()
    expect(within(card).getByText('microsoft_docs_search').getAttribute('title')).toBe(
      'Search Microsoft docs'
    )
    expect(within(card).getByRole('img', { name: 'Connected' })).toBeTruthy()
  })

  it('fills in a pasted configuration, and asks for the keys it left as placeholders', async () => {
    install([])
    render(<McpServersModal adding onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Paste a configuration…' }))
    fireEvent.change(screen.getByLabelText('Configuration'), {
      target: {
        value: `{ "mcpServers": {
          "mcp-server-chart": { "command": "npx", "args": ["-y", "@antv/mcp-server-chart"], "env": { "API_KEY": "<YOUR_KEY>" } },
          "learn": { "url": "https://learn.microsoft.com/api/mcp" }
        } }`
      }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Fill in' }))
    expect(screen.getByText('It has 2 servers. Choose the one to add:')).toBeTruthy()
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Chart')
    expect((screen.getByLabelText('Command') as HTMLInputElement).value).toBe(
      'npx -y @antv/mcp-server-chart'
    )
    const key = screen.getByLabelText('Value of API_KEY') as HTMLInputElement
    expect(key.type).toBe('password')
    expect(key.value).toBe('')

    api.save.mockRejectedValueOnce('Enter a value for API_KEY.')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Enter a value for API_KEY.'
    )
    fireEvent.change(key, { target: { value: 'k3y' } })
    fireEvent.click(screen.getByLabelText(/Only tools that read/))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(api.save).toHaveBeenLastCalledWith({
        id: undefined,
        name: 'Chart',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@antv/mcp-server-chart'],
        env: [{ name: 'API_KEY', value: 'k3y' }],
        readOnly: true
      })
    )
    expect(await screen.findByRole('region', { name: 'Chart' })).toBeTruthy()
  })

  it('keeps a saved value unless it’s changed, and never shows it', async () => {
    install([LEARN])
    render(<McpServersModal onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Microsoft Learn' }))
    const form = screen.getByRole('form', { name: 'Edit Microsoft Learn' })
    expect(within(form).getByText('Authorization')).toBeTruthy()
    expect(within(form).getByText('Saved')).toBeTruthy()
    expect(within(form).queryByLabelText('Value of Authorization')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(api.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: 'microsoft-learn', headers: [{ name: 'Authorization' }] })
      )
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Edit Microsoft Learn' }))
    fireEvent.click(screen.getByRole('button', { name: 'Change the value of Authorization' }))
    fireEvent.change(screen.getByLabelText('Value of Authorization'), {
      target: { value: 'Bearer new' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(api.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ headers: [{ name: 'Authorization', value: 'Bearer new' }] })
      )
    )
  })

  it('says why a server didn’t connect, and removes one only after asking', async () => {
    install([LEARN])
    api.check.mockResolvedValueOnce({
      status: 'failed',
      error: 'It couldn’t connect (401 Unauthorized).'
    })
    const onChanged = vi.fn()
    render(<McpServersModal onClose={() => {}} onChanged={onChanged} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Check Microsoft Learn' }))
    const card = screen.getByRole('region', { name: 'Microsoft Learn' })
    expect(await within(card).findByText('Didn’t connect')).toBeTruthy()
    expect(within(card).getByRole('alert').textContent).toBe(
      'It couldn’t connect (401 Unauthorized).'
    )

    fireEvent.click(within(card).getByRole('button', { name: 'Remove Microsoft Learn' }))
    expect(api.remove).not.toHaveBeenCalled()
    expect(
      within(card).getByText('Remove Microsoft Learn? Chats that have it on stop using it.')
    ).toBeTruthy()
    fireEvent.click(within(card).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('microsoft-learn'))
    expect(await screen.findByRole('button', { name: 'Add Microsoft Learn' })).toBeTruthy()
    expect(onChanged).toHaveBeenCalled()
  })

  it('leaves the form with Escape before it closes', async () => {
    install([LEARN])
    const onClose = vi.fn()
    render(<McpServersModal onClose={onClose} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Microsoft Learn' }))
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(within(dialog()).queryByRole('form')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(onClose).toHaveBeenCalledOnce()
  })
})
