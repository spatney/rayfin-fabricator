import { useState, type JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { GithubAccountsResult, RayfinStudioApi } from '@shared/ipc'
import GithubRepoFields, { NEW_GITHUB_REPO, type GithubRepoChoice } from './GithubRepoFields'

const twoAccounts: GithubAccountsResult = {
  ghInstalled: true,
  accounts: [
    { login: 'octo', active: true, signedIn: true },
    { login: 'octo_contoso', active: false, signedIn: true }
  ]
}

function installApi(accounts: GithubAccountsResult = twoAccounts) {
  const github = {
    accounts: vi.fn<RayfinStudioApi['github']['accounts']>().mockResolvedValue(accounts),
    owners: vi.fn<RayfinStudioApi['github']['owners']>(async (account) => ({
      ok: true,
      owners:
        account === 'octo_contoso'
          ? [
              { login: 'octo_contoso', isOrg: false },
              { login: 'contoso', isOrg: true, canCreate: false }
            ]
          : [{ login: 'octo', isOrg: false }]
    })),
    checkRepo: vi.fn<RayfinStudioApi['github']['checkRepo']>().mockResolvedValue({ ok: true }),
    addAccount: vi
      .fn<RayfinStudioApi['github']['addAccount']>()
      .mockResolvedValue({ ok: true, exitCode: null })
  }
  ;(window as unknown as { api: unknown }).api = { github }
  return github
}

/** The fields with their state held, and what they chose shown. */
function Fields({
  editable = false,
  onReviewSetup
}: {
  editable?: boolean
  onReviewSetup?: () => void
}): JSX.Element {
  const [value, setValue] = useState<GithubRepoChoice>(NEW_GITHUB_REPO)
  const [name, setName] = useState('trip-logger')
  const [ready, setReady] = useState(false)
  return (
    <>
      <GithubRepoFields
        name={name}
        onNameChange={editable ? setName : undefined}
        value={value}
        onChange={setValue}
        onReady={setReady}
        onReviewSetup={onReviewSetup}
      />
      <output aria-label="choice">
        {`${value.account}|${value.owner}|${value.private ? 'private' : 'public'}|${ready ? 'ready' : 'not ready'}`}
      </output>
    </>
  )
}

/** The fields wait out a debounce after loading accounts and owners, which is slow on a busy machine. */
const slow = { timeout: 5000 }

const choice = (): string => screen.getByRole('status', { name: 'choice' }).textContent ?? ''

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  delete (window as unknown as { api?: unknown }).api
})

describe('GithubRepoFields', () => {
  it('creates as the active account, in its own name, and follows another account to its organizations', async () => {
    const github = installApi()
    render(<Fields />)
    await waitFor(() => expect(choice()).toBe('octo|octo|private|ready'), slow)
    await waitFor(
      () => expect(github.checkRepo).toHaveBeenCalledWith('octo', 'octo', 'trip-logger'),
      slow
    )
    expect(screen.getByText('github.com/octo/trip-logger')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('GitHub account'), { target: { value: 'octo_contoso' } })
    await waitFor(() => expect(choice()).toBe('octo_contoso|octo_contoso|private|ready'), slow)
    expect(github.owners).toHaveBeenLastCalledWith('octo_contoso')

    // The organization doesn't let its members create private repositories.
    fireEvent.change(screen.getByLabelText('Owner'), { target: { value: 'contoso' } })
    expect((await screen.findByRole('alert', {}, slow)).textContent).toBe(
      'contoso doesn’t let you create private repositories. Choose Public, or another owner.'
    )
    expect(choice()).toBe('octo_contoso|contoso|private|not ready')
    fireEvent.click(screen.getByRole('radio', { name: 'Public' }))
    await waitFor(() => expect(choice()).toBe('octo_contoso|contoso|public|ready'), slow)
  })

  it('says when GitHub already has the name, and uses an empty repository that has it', async () => {
    const github = installApi()
    github.checkRepo.mockImplementation(async (_account, owner, name) =>
      name === 'trip-logger'
        ? { ok: false, message: `github.com/${owner}/${name} already exists. Choose another name.` }
        : {
            ok: true,
            message: `github.com/${owner}/${name} is empty, so Fabricator puts the app in it.`
          }
    )
    render(<Fields editable />)
    expect((await screen.findByRole('alert', {}, slow)).textContent).toBe(
      'github.com/octo/trip-logger already exists. Choose another name.'
    )
    expect(choice()).toBe('octo|octo|private|not ready')

    const name = screen.getByLabelText('Repository name')
    fireEvent.change(name, { target: { value: 'trip logger' } })
    expect(screen.getByRole('alert').textContent).toBe(
      'Use only letters, numbers, hyphens, underscores and periods in the repository name.'
    )

    fireEvent.change(name, { target: { value: 'trip-logger-2' } })
    expect(
      await screen.findByText(
        'github.com/octo/trip-logger-2 is empty, so Fabricator puts the app in it.',
        {},
        slow
      )
    ).toBeTruthy()
    await waitFor(() => expect(choice()).toBe('octo|octo|private|ready'), slow)
  })

  it('signs in to GitHub in a terminal, then uses the account it signed in', async () => {
    vi.useFakeTimers()
    const github = installApi({ ghInstalled: true, accounts: [] })
    render(<Fields />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to GitHub' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(github.addAccount).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Waiting…' })).toBeTruthy()

    github.accounts.mockResolvedValue({
      ghInstalled: true,
      accounts: [{ login: 'octo', active: true, signedIn: true }]
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(choice()).toMatch(/^octo\|octo\|private/)
    expect(screen.queryByRole('button', { name: 'Waiting…' })).toBeNull()
  })

  it('offers setup when the GitHub CLI isn’t installed', async () => {
    installApi({ ghInstalled: false, accounts: [] })
    const onReviewSetup = vi.fn()
    render(<Fields onReviewSetup={onReviewSetup} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Install from setup' }))
    expect(onReviewSetup).toHaveBeenCalledTimes(1)
    expect(choice()).toBe('||private|not ready')
  })
})
