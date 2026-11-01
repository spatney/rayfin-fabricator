import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { GitMessageResult, GitRemoteStatus, GitStatus } from '@shared/ipc'
import GitControl from './GitControl'
import { deferred } from '../../test/deferred'

const dirty: GitStatus = { isRepo: true, branch: 'master', changedCount: 1 }
const clean: GitStatus = { isRepo: true, branch: 'master', changedCount: 0 }
const local: GitRemoteStatus = {
  isRepo: true,
  hasRemote: false,
  hasUpstream: false,
  ahead: 0,
  behind: 0
}

function installApi(message: (id: string) => Promise<GitMessageResult>): {
  commit: ReturnType<typeof vi.fn>
  message: ReturnType<typeof vi.fn>
} {
  const git = {
    status: vi.fn().mockResolvedValue(dirty),
    remoteStatus: vi.fn().mockResolvedValue(local),
    commit: vi.fn().mockResolvedValue({ ok: true, status: clean }),
    message: vi.fn(message)
  }
  ;(window as unknown as { api: unknown }).api = { projects: { git } }
  return git
}

async function openCommit(): Promise<void> {
  render(<GitControl projectId="p1" refreshKey={0} />)
  fireEvent.click(await screen.findByRole('button', { name: /1 uncommitted/ }))
}

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('GitControl commit message', () => {
  it('lets Copilot write the message, to edit or commit as it is', async () => {
    const written = deferred<GitMessageResult>()
    const git = installApi(() => written.promise)
    await openCommit()

    fireEvent.click(screen.getByRole('button', { name: 'Write a message with Copilot' }))
    const box = screen.getByRole('textbox', { name: 'Commit message' }) as HTMLInputElement
    expect(box.disabled).toBe(true)
    expect(box.placeholder).toBe('Writing a message…')
    expect(git.message).toHaveBeenCalledWith('p1')

    await act(async () => written.resolve({ ok: true, message: 'Add a chart of expenses' }))
    expect(box.value).toBe('Add a chart of expenses')
    expect(box.disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Commit all' }))
    await waitFor(() => expect(git.commit).toHaveBeenCalledWith('p1', 'Add a chart of expenses'))
  })

  it('says why when Copilot couldn’t write one', async () => {
    installApi(() =>
      Promise.resolve({ ok: false, error: 'Couldn’t write a message: Couldn’t reach the model.' })
    )
    await openCommit()

    fireEvent.click(screen.getByRole('button', { name: 'Write a message with Copilot' }))

    expect(
      await screen.findByText('Couldn’t write a message: Couldn’t reach the model.')
    ).toBeTruthy()
    expect(
      (screen.getByRole('textbox', { name: 'Commit message' }) as HTMLInputElement).value
    ).toBe('')
  })
})
