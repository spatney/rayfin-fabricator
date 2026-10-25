import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState, type JSX } from 'react'
import type { TeamEnvStatus, TeamGhAccount, TeamWorkspace } from '@shared/ipc'
import { GithubAccountField } from './common'
import JoinTeamWorkspaceModal from './JoinTeamWorkspaceModal'
import WorkspacePanel from './map/WorkspacePanel'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  delete (window as unknown as { api?: unknown }).api
})

function account(login: string, over: Partial<TeamGhAccount> = {}): TeamGhAccount {
  return { login, active: false, signedIn: true, missingScopes: [], canDeleteRepos: false, ...over }
}

function env(accounts: TeamGhAccount[]): TeamEnvStatus {
  return {
    enabled: true,
    ghInstalled: true,
    ghSignedIn: true,
    ghMissingScopes: [],
    ghCanDeleteRepos: false,
    ghAccounts: accounts,
    azSignedIn: true
  }
}

function install(team: Record<string, unknown>): void {
  ;(window as unknown as { api: unknown }).api = { openExternal: vi.fn(), team }
}

/** The field with its value kept in state, reporting changes and readiness. */
function Field({ start = '', onReady }: { start?: string; onReady?: (ready: boolean) => void }): JSX.Element {
  const [value, setValue] = useState(start)
  return (
    <>
      <GithubAccountField value={value} onChange={setValue} onReady={onReady} />
      <output data-testid="chosen">{value}</output>
    </>
  )
}

describe('GithubAccountField', () => {
  it('starts with the active account and offers the others', async () => {
    install({ envStatus: vi.fn(() => Promise.resolve(env([account('octo', { active: true }), account('octo_work')]))) })
    const onReady = vi.fn()
    await act(async () => {
      render(<Field onReady={onReady} />)
    })
    expect(screen.getByTestId('chosen').textContent).toBe('octo')
    expect(onReady).toHaveBeenLastCalledWith(true)
    const select = screen.getByLabelText('GitHub account') as HTMLSelectElement
    expect([...select.options].map((o) => o.value)).toEqual(['octo', 'octo_work'])
    fireEvent.change(select, { target: { value: 'octo_work' } })
    expect(screen.getByTestId('chosen').textContent).toBe('octo_work')
  })

  it('asks for the chosen account’s missing permissions, then notices them', async () => {
    vi.useFakeTimers()
    const envStatus = vi
      .fn()
      .mockResolvedValueOnce(env([account('octo', { active: true }), account('octo_work', { missingScopes: ['workflow'] })]))
      .mockResolvedValue(env([account('octo', { active: true }), account('octo_work')]))
    const githubSignIn = vi.fn(() => Promise.resolve({ ok: true }))
    install({ envStatus, githubSignIn })
    const onReady = vi.fn()
    await act(async () => {
      render(<Field start="octo_work" onReady={onReady} />)
    })
    expect(onReady).toHaveBeenLastCalledWith(false)
    expect(screen.getByText(/needs more GitHub permissions for octo_work/).textContent).toContain('workflow')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Grant GitHub access' })))
    expect(githubSignIn).toHaveBeenCalledWith(true, false, 'octo_work')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(onReady).toHaveBeenLastCalledWith(true)
    expect(screen.queryByRole('button', { name: /Grant GitHub access|Waiting…/ })).toBeNull()
  })

  it('signs in to another account and chooses it once it appears', async () => {
    vi.useFakeTimers()
    const envStatus = vi
      .fn()
      .mockResolvedValueOnce(env([account('octo', { active: true })]))
      .mockResolvedValueOnce(env([account('octo', { active: true })]))
      .mockResolvedValue(env([account('octo', { active: true }), account('octo_contoso')]))
    const githubSignIn = vi.fn(() => Promise.resolve({ ok: true }))
    install({ envStatus, githubSignIn })
    await act(async () => {
      render(<Field />)
    })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add account' })))
    expect(githubSignIn).toHaveBeenCalledWith(false)
    expect(screen.getByText(/Finish signing in in the terminal window/)).toBeTruthy()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(screen.getByTestId('chosen').textContent, 'not added yet').toBe('octo')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(screen.getByTestId('chosen').textContent).toBe('octo_contoso')
    expect(screen.queryByText(/Finish signing in/)).toBeNull()
  })

  it('offers a sign-in when the GitHub CLI has no account', async () => {
    const githubSignIn = vi.fn(() => Promise.resolve({ ok: true }))
    install({ envStatus: vi.fn(() => Promise.resolve(env([]))), githubSignIn })
    await act(async () => {
      render(<Field />)
    })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sign in to GitHub' })))
    expect(githubSignIn).toHaveBeenCalledWith(false)
  })
})

describe('JoinTeamWorkspaceModal', () => {
  it('joins as the chosen account', async () => {
    const joinOptions = vi.fn((login: string) =>
      Promise.resolve({
        ok: true,
        invitations: login === 'octo_contoso' ? [{ id: 4, repo: 'contoso/sales', inviter: 'amy', account: login }] : [],
        discovered: []
      })
    )
    const acceptInvitation = vi.fn(() => new Promise(() => {}))
    install({
      envStatus: vi.fn(() => Promise.resolve(env([account('octo', { active: true }), account('octo_contoso')]))),
      joinOptions,
      acceptInvitation,
      onDiagnosis: vi.fn(() => () => {})
    })
    await act(async () => {
      render(<JoinTeamWorkspaceModal initialAccount="octo_contoso" onClose={() => {}} onJoined={() => {}} />)
    })
    expect(joinOptions).toHaveBeenCalledWith('octo_contoso')
    expect(joinOptions).not.toHaveBeenCalledWith('octo')
    fireEvent.click(screen.getByRole('button', { name: 'Accept and join' }))
    expect(acceptInvitation).toHaveBeenCalledWith(4, 'contoso/sales', 'octo_contoso')

    await act(async () => {
      fireEvent.change(screen.getByLabelText('GitHub account'), { target: { value: 'octo' } })
    })
    expect(joinOptions).toHaveBeenLastCalledWith('octo')
    expect(screen.getByText(/No pending invitations for octo\./)).toBeTruthy()
  })
})

describe('WorkspacePanel GitHub account', () => {
  const workspace: TeamWorkspace = {
    id: 'w1',
    name: 'Sales',
    repo: 'contoso/sales',
    defaultBranch: 'main',
    dir: 'C:/team',
    role: 'member',
    addedAt: '',
    account: 'octo'
  }

  it('shows the account the workspace uses and changes it', async () => {
    const setAccount = vi.fn(() => Promise.resolve({ ok: true, workspace: { ...workspace, account: 'octo_contoso' } }))
    const onChanged = vi.fn()
    install({
      members: vi.fn(() => Promise.resolve({ ok: true, members: [], canManage: false })),
      health: vi.fn(() => Promise.resolve({ ok: true, items: [] })),
      envStatus: vi.fn(() => Promise.resolve(env([account('octo', { active: true }), account('octo_contoso')]))),
      setAccount,
      onProgress: vi.fn(() => () => {})
    })
    await act(async () => {
      render(
        <WorkspacePanel workspace={workspace} initialTab="settings" onClose={() => {}} onChanged={onChanged} onGone={() => {}} />
      )
    })
    expect(screen.getByText('Fabricator works on this workspace as this account.').parentElement?.textContent).toContain('octo')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Change' })))
    const use = screen.getByRole('button', { name: 'Use this account' }) as HTMLButtonElement
    expect(use.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('GitHub account'), { target: { value: 'octo_contoso' } })
    expect(use.disabled).toBe(false)
    await act(async () => fireEvent.click(use))
    expect(setAccount).toHaveBeenCalledWith('w1', 'octo_contoso')
    expect(onChanged).toHaveBeenCalled()
    expect(screen.getByText('Fabricator now works on this workspace as octo_contoso.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Use this account' })).toBeNull()
  })
})
