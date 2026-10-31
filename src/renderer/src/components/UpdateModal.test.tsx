import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import UpdateModal from './UpdateModal'

const updates = vi.hoisted(() => ({
  status: 'ready' as const,
  info: {
    version: '1.30.0',
    currentVersion: '1.29.0',
    notes: [
      '## Experiment: connect MCP servers to chat',
      '',
      '- **Keys stay private.** They stay in Windows Credential Manager.',
      '- **You decide what chat can do.**',
      '',
      'See [Connect MCP servers](https://spatney.github.io/rayfin-fabricator/docs/build/mcp-servers).'
    ].join('\n')
  },
  progress: null,
  blocking: false,
  modalOpen: true,
  checkNow: vi.fn(),
  install: vi.fn(),
  later: vi.fn(),
  dismiss: vi.fn()
}))

vi.mock('../update', () => ({ useUpdates: () => updates }))

afterEach(() => cleanup())

describe('UpdateModal', () => {
  it('shows the release notes as formatted Markdown', () => {
    const openExternal = vi.fn()
    ;(window as unknown as { api: unknown }).api = { openExternal }
    render(<UpdateModal />)

    expect(
      screen.getByRole('heading', { name: 'Experiment: connect MCP servers to chat' })
    ).toBeTruthy()
    expect(screen.getByText('Keys stay private.').tagName).toBe('STRONG')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.queryByText(/\*\*/)).toBeNull()

    fireEvent.click(screen.getByRole('link', { name: 'Connect MCP servers' }))
    expect(openExternal).toHaveBeenCalledWith(
      'https://spatney.github.io/rayfin-fabricator/docs/build/mcp-servers'
    )
  })
})
