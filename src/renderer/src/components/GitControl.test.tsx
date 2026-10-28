import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { GitBranch, GitRemoteStatus, GitStatus } from '@shared/ipc'
import { api } from '../api'
import { useSuppressPreview } from '../overlay'
import { deferred } from '../../test/deferred'
import GitControl from './GitControl'

vi.mock('../overlay', () => ({ useSuppressPreview: vi.fn() }))

const clean: GitStatus = { isRepo: true, branch: 'main', changedCount: 0 }
const remote: GitRemoteStatus = {
  isRepo: true, branch: 'main', hasRemote: true, hasUpstream: true, ahead: 0, behind: 0
}
const branches: GitBranch[] = [
  { refName: 'refs/heads/main', name: 'main', current: true, remote: false },
  { refName: 'refs/heads/feature/report', name: 'feature/report', current: false, remote: false },
  { refName: 'refs/remotes/ado/review', name: 'ado/review', current: false, remote: true }
]

beforeEach(() => {
  window.api = api
  vi.spyOn(api.projects.git, 'status').mockResolvedValue(clean)
  vi.spyOn(api.projects.git, 'remoteStatus').mockResolvedValue(remote)
  vi.spyOn(api.projects.git, 'divergence').mockResolvedValue({ ...remote, branch: 'feature/report' })
  vi.spyOn(api.projects.git, 'branches').mockResolvedValue(branches)
  vi.spyOn(api.projects.git, 'switchBranch').mockResolvedValue({ ...clean, branch: 'feature/report' })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

async function openPicker(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: /main.*clean/ }))
  await screen.findByRole('button', { name: 'feature/report Local' })
}

describe('GitControl branch switching', () => {
  it('opens a clean repository, suppresses native preview, and filters local and remote branches', async () => {
    render(<GitControl projectId="p1" refreshKey={0} />)
    await openPicker()
    expect(useSuppressPreview).toHaveBeenLastCalledWith(true)
    expect(screen.getByRole('button', { name: 'main Current' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'ado/review Remote' })).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter branches' }), { target: { value: 'REVIEW' } })
    expect(screen.queryByRole('button', { name: 'feature/report Local' })).toBeNull()
    expect(screen.getByRole('button', { name: 'ado/review Remote' })).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter branches' }), { target: { value: 'missing' } })
    expect(screen.getByText('No matching branches.')).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(screen.queryByText('Switch branch')).toBeNull()
  })

  it.each([
    ['feature/report Local', 'refs/heads/feature/report'],
    ['ado/review Remote', 'refs/remotes/ado/review']
  ])('switches %s using its full ref and refreshes the parent', async (label, refName) => {
    const onSynced = vi.fn()
    render(<GitControl projectId="nested-ado-app" refreshKey={0} onSynced={onSynced} />)
    await openPicker()
    fireEvent.click(screen.getByRole('button', { name: label }))
    await waitFor(() => expect(onSynced).toHaveBeenCalledOnce())
    expect(api.projects.git.switchBranch).toHaveBeenCalledWith('nested-ado-app', refName)
    expect(await screen.findByRole('button', { name: /feature\/report.*clean/ })).toBeTruthy()
    expect(screen.queryByText('Switch branch')).toBeNull()
    expect(api.projects.git.divergence).toHaveBeenCalledWith('nested-ado-app')
  })

  it('shows checkout failures without changing the branch or refreshing the parent', async () => {
    vi.mocked(api.projects.git.switchBranch).mockRejectedValue('Commit or stash all changes first.')
    const onSynced = vi.fn()
    render(<GitControl projectId="p1" refreshKey={0} onSynced={onSynced} />)
    await openPicker()
    fireEvent.click(screen.getByRole('button', { name: 'feature/report Local' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Commit or stash all changes first.')
    expect(screen.getByRole('button', { name: /main.*clean/ })).toBeTruthy()
    expect(onSynced).not.toHaveBeenCalled()
  })

  it('ignores an old branch fetch that completes after switching branches', async () => {
    const fetching = deferred<GitRemoteStatus>()
    vi.mocked(api.projects.git.remoteStatus).mockReturnValue(fetching.promise)
    render(<GitControl projectId="p1" refreshKey={0} />)
    await openPicker()
    fireEvent.click(screen.getByRole('button', { name: 'feature/report Local' }))
    await screen.findByRole('button', { name: /feature\/report.*clean/ })
    await act(async () => fetching.resolve({ ...remote, ahead: 10, behind: 20 }))
    expect(screen.queryByText('↑10')).toBeNull()
    expect(screen.queryByText('↓20')).toBeNull()
  })

  it('shows a post-switch status error rather than hiding it in a closed picker', async () => {
    vi.mocked(api.projects.git.divergence).mockRejectedValue('Could not read remote status.')
    const onSynced = vi.fn()
    render(<GitControl projectId="p1" refreshKey={0} onSynced={onSynced} />)
    await openPicker()
    fireEvent.click(screen.getByRole('button', { name: 'feature/report Local' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Could not read remote status.')
    expect(onSynced).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: /feature\/report.*clean/ })).toBeTruthy()
  })

  it('surfaces branch-list and fetch failures', async () => {
    vi.mocked(api.projects.git.branches).mockRejectedValue('Could not list branches.')
    vi.mocked(api.projects.git.remoteStatus).mockResolvedValue({ ...remote, fetchError: 'ADO sign-in required.' })
    render(<GitControl projectId="p1" refreshKey={0} />)
    fireEvent.click(await screen.findByRole('button', { name: /main.*clean/ }))
    expect(await screen.findByText('Could not list branches.')).toBeTruthy()
    expect(await screen.findByText('ADO sign-in required.')).toBeTruthy()
  })

  it('disables switching during chat/deployment and during a pending checkout', async () => {
    const pending = deferred<GitStatus>()
    vi.mocked(api.projects.git.switchBranch).mockReturnValue(pending.promise)
    const { rerender } = render(<GitControl projectId="p1" refreshKey={0} switchDisabled />)
    await openPicker()
    const target = screen.getByRole('button', { name: 'feature/report Local' })
    expect(target.hasAttribute('disabled')).toBe(true)
    rerender(<GitControl projectId="p1" refreshKey={0} />)
    fireEvent.click(target)
    expect(screen.getByRole('button', { name: 'ado/review Remote' }).hasAttribute('disabled')).toBe(true)
    await act(async () => pending.resolve({ ...clean, branch: 'feature/report' }))
  })

  it('keeps commit, pull, and push available with branch switching', async () => {
    vi.mocked(api.projects.git.status).mockResolvedValue({ ...clean, changedCount: 2 })
    vi.mocked(api.projects.git.remoteStatus).mockResolvedValue({ ...remote, ahead: 1, behind: 1 })
    vi.spyOn(api.projects.git, 'commit').mockResolvedValue({ ok: true, status: clean })
    const onSynced = vi.fn()
    render(<GitControl projectId="p1" refreshKey={0} onSynced={onSynced} />)
    fireEvent.click(await screen.findByRole('button', { name: /main.*2 uncommitted/ }))
    expect(await screen.findByRole('button', { name: 'Get latest' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Push' })).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('Commit message'), { target: { value: 'Save changes' } })
    fireEvent.click(screen.getByRole('button', { name: 'Commit all' }))
    await waitFor(() => expect(onSynced).toHaveBeenCalledOnce())
    expect(api.projects.git.commit).toHaveBeenCalledWith('p1', 'Save changes')
  })
})
