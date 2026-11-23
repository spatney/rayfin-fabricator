import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { GitMessageResult, GitRemoteStatus, GitStatus } from '@shared/ipc'
import GitControl from './GitControl'
import { setLanguage } from '../i18n'
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

const upstream: GitRemoteStatus = {
  isRepo: true,
  hasRemote: true,
  hasUpstream: true,
  ahead: 0,
  behind: 2
}

function installGit<T extends Record<string, unknown>>(git: T) {
  const api = {
    status: vi.fn().mockResolvedValue(clean),
    remoteStatus: vi.fn().mockResolvedValue(local),
    ...git
  }
  ;(window as unknown as { api: unknown }).api = { projects: { git: api } }
  return api
}

describe('GitControl branches and merges', () => {
  it('switches to a branch from its list, saving uncommitted changes on this one first', async () => {
    const git = installGit({
      status: vi.fn().mockResolvedValue({ ...dirty, branch: 'main' }),
      branches: vi.fn().mockResolvedValue({
        current: 'main',
        branches: [
          { name: 'main', upstream: 'origin/main' },
          { name: 'origin/feature', remote: true }
        ]
      }),
      switchBranch: vi.fn().mockResolvedValue({
        ok: true,
        packagesChanged: true,
        status: { ...clean, branch: 'feature' },
        remote: local
      })
    })
    const onSynced = vi.fn()
    const { rerender } = render(
      <GitControl projectId="p1" refreshKey={0} busy onSynced={onSynced} />
    )
    fireEvent.click(await screen.findByRole('button', { name: /1 uncommitted/ }))
    const switcher = screen.getByRole('button', { name: 'Switch…' }) as HTMLButtonElement
    expect(switcher.disabled, 'not while Copilot works on the app').toBe(true)
    rerender(<GitControl projectId="p1" refreshKey={0} onSynced={onSynced} />)
    fireEvent.click(switcher)

    const list = await screen.findByRole('group', { name: 'Branches' })
    const feature = await within(list).findByRole('button', { name: /origin\/feature/ })
    expect(within(list).getByRole('button', { name: /main/ }).getAttribute('aria-current')).toBe(
      'true'
    )
    expect(screen.getByText('Your 1 uncommitted change is saved on main first.')).toBeTruthy()
    fireEvent.click(feature)
    await waitFor(() => expect(onSynced).toHaveBeenCalledWith(true))
    expect(git.switchBranch).toHaveBeenCalledWith('p1', 'origin/feature')
    expect(screen.queryByRole('dialog', { name: 'Git' })).toBeNull()
  })

  it('offers Copilot when the latest changes overlap yours, and hands it the conflicts', async () => {
    const merging: GitStatus = {
      ...clean,
      changedCount: 1,
      merging: true,
      conflicts: ['src/App.tsx']
    }
    const git = installGit({
      remoteStatus: vi.fn().mockResolvedValue(upstream),
      pull: vi.fn().mockResolvedValue({
        ok: false,
        conflict: true,
        error:
          'Your changes and the latest changes overlap and couldn’t be combined automatically.',
        status: clean,
        remote: upstream
      }),
      mergeLatest: vi.fn().mockResolvedValue({
        ok: false,
        conflict: true,
        error: 'Your changes and the latest changes overlap in 1 file.',
        status: merging,
        remote: upstream
      })
    })
    const onSendToChat = vi.fn()
    render(<GitControl projectId="p1" refreshKey={0} onSendToChat={onSendToChat} />)
    fireEvent.click(await screen.findByRole('button', { name: /clean/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Get latest' }))
    expect(await screen.findByText(/overlap and couldn’t be combined/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Ask Copilot to resolve' }))
    await waitFor(() => expect(onSendToChat).toHaveBeenCalledTimes(1))
    expect(git.mergeLatest).toHaveBeenCalledWith('p1')
    const [display, prompt] = onSendToChat.mock.lastCall!
    expect(display).toBe('Resolve the merge conflict in src/App.tsx')
    expect(prompt).toContain('- src/App.tsx')
    expect(prompt).toContain('git commit --no-edit')
    expect(screen.getByRole('button', { name: /1 conflict/ })).toBeTruthy()
  })

  it('sends a merge’s conflicts to Copilot, and finishes the merge once they’re resolved', async () => {
    const git = installGit({
      status: vi
        .fn()
        .mockResolvedValue({
          ...clean,
          changedCount: 2,
          merging: true,
          conflicts: ['a.ts', 'b.ts']
        }),
      finishMerge: vi
        .fn()
        .mockResolvedValue({ ok: true, packagesChanged: true, status: clean, remote: local })
    })
    const onSynced = vi.fn()
    const onSendToChat = vi.fn()
    render(
      <GitControl projectId="p1" refreshKey={0} onSynced={onSynced} onSendToChat={onSendToChat} />
    )
    fireEvent.click(await screen.findByRole('button', { name: /2 conflicts/ }))
    expect(screen.getByText('2 files have conflicts')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel merge' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Finish merge' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Ask Copilot to resolve' }))
    expect(onSendToChat).toHaveBeenCalledWith(
      'Resolve the merge conflicts in 2 files',
      expect.stringContaining('- b.ts')
    )

    git.status.mockResolvedValue({ ...clean, changedCount: 2, merging: true })
    fireEvent.click(screen.getByRole('button', { name: /2 conflicts/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Finish merge' }))
    await waitFor(() => expect(onSynced).toHaveBeenCalledWith(true))
    expect(git.finishMerge).toHaveBeenCalledWith('p1')
  })
})

describe('GitControl in German', () => {
  afterEach(async () => {
    cleanup()
    await setLanguage('en')
    localStorage.clear()
  })

  it('counts a merge’s conflicts with German plurals', async () => {
    installGit({
      status: vi.fn().mockResolvedValue({
        ...clean,
        changedCount: 1,
        merging: true,
        conflicts: ['a.ts']
      })
    })
    await act(() => setLanguage('de'))
    render(<GitControl projectId="p1" refreshKey={0} />)
    fireEvent.click(await screen.findByRole('button', { name: /1 Konflikt/ }))
    expect(screen.getByText('1 Datei hat Konflikte')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Merge abbrechen' })).toBeTruthy()
  })
})

describe('GitControl GitHub repository', () => {
  function installGithub(createRepo: ReturnType<typeof vi.fn>): void {
    const api = window as unknown as { api: Record<string, unknown> }
    api.api.github = {
      accounts: vi.fn().mockResolvedValue({
        ghInstalled: true,
        accounts: [{ login: 'octo', active: true, signedIn: true }]
      }),
      owners: vi.fn().mockResolvedValue({ ok: true, owners: [{ login: 'octo', isOrg: false }] }),
      checkRepo: vi.fn().mockResolvedValue({ ok: true }),
      createRepo
    }
  }

  it('gives an app with no remote a GitHub repository named after its folder', async () => {
    const git = installGit({})
    const createRepo = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'Create the GitHub repository: Not Found' })
      .mockResolvedValue({ ok: true, url: 'https://github.com/octo/Trip-Logger' })
    installGithub(createRepo)
    render(<GitControl projectId="p1" refreshKey={0} folderName="Trip Logger" />)
    fireEvent.click(await screen.findByRole('button', { name: /clean/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Create a GitHub repository' }))

    const name = (await screen.findByLabelText('Repository name')) as HTMLInputElement
    expect(name.value).toBe('Trip-Logger')
    const create = screen.getByRole('button', { name: 'Create repository' }) as HTMLButtonElement
    await waitFor(() => expect(create.disabled).toBe(false), { timeout: 5000 })
    fireEvent.click(create)
    // A failure stays on the form, to try again.
    expect(await screen.findByText('Create the GitHub repository: Not Found')).toBeTruthy()
    expect(createRepo).toHaveBeenCalledWith('p1', {
      account: 'octo',
      owner: 'octo',
      private: true,
      name: 'Trip-Logger'
    })

    const fetches = git.remoteStatus.mock.calls.length
    fireEvent.click(create)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Git' })).toBeNull())
    expect(createRepo).toHaveBeenCalledTimes(2)
    expect(git.remoteStatus.mock.calls.length).toBeGreaterThan(fetches)
  })

  it('doesn’t offer one to an app that has a remote', async () => {
    installGit({ remoteStatus: vi.fn().mockResolvedValue(upstream) })
    installGithub(vi.fn())
    render(<GitControl projectId="p1" refreshKey={0} folderName="trip-logger" />)
    fireEvent.click(await screen.findByRole('button', { name: /clean/ }))
    await screen.findByRole('button', { name: 'Get latest' })
    expect(screen.queryByRole('button', { name: 'Create a GitHub repository' })).toBeNull()
  })
})
