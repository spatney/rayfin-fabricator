import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { FabricDeployment, FabricDirectoryResult } from '@shared/ipc'
import ShareDeploymentModal from './ShareDeploymentModal'
import { makeProject } from '../../test/harness'
import { deferred } from '../../test/deferred'
import { ToastProvider } from '../toast'

interface ApiOverrides {
  projectSemanticModels?: ReturnType<typeof vi.fn>
  shareApp?: ReturnType<typeof vi.fn>
  directorySearch?: ReturnType<typeof vi.fn>
  loginAz?: ReturnType<typeof vi.fn>
  loginRayfin?: ReturnType<typeof vi.fn>
}

function installApi(over: ApiOverrides = {}): Required<ApiOverrides> {
  const api = {
    projectSemanticModels: over.projectSemanticModels ?? vi.fn(() => Promise.resolve([])),
    shareApp: over.shareApp ?? vi.fn(() => Promise.resolve({ ok: true, recipients: [] })),
    directorySearch: over.directorySearch ?? vi.fn(() => Promise.resolve({ ok: true, people: [] })),
    loginAz: over.loginAz ?? vi.fn(() => Promise.resolve({ ok: true, exitCode: 0 })),
    loginRayfin: over.loginRayfin ?? vi.fn(() => Promise.resolve({ ok: true, exitCode: 0 }))
  }
  ;(window as unknown as { api: unknown }).api = {
    fabric: {
      projectSemanticModels: api.projectSemanticModels,
      shareApp: api.shareApp,
      directorySearch: api.directorySearch
    },
    auth: { loginAz: api.loginAz, loginRayfin: api.loginRayfin }
  }
  return api
}

const deployment: FabricDeployment = {
  workspaceName: 'App Workspace',
  active: true,
  workspaceId: 'ws-app',
  itemId: 'app-item',
  hostingUrl: 'https://sales.example.app/'
}

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('ShareDeploymentModal', () => {
  beforeEach(() => {
    installApi()
  })

  it('previews the app grant and which models get Build vs are covered', async () => {
    installApi({
      projectSemanticModels: vi.fn(() =>
        Promise.resolve([
          { alias: 'sales', workspaceId: 'ws-other', itemId: 'ds-1' },
          { alias: 'local', workspaceId: 'WS-APP', itemId: 'ds-2' }
        ])
      )
    })
    render(<ShareDeploymentModal project={makeProject('p1')} deployment={deployment} onClose={vi.fn()} />)

    // The app workspace is granted Contributor (scope to the targets list — the
    // intro paragraph mentions the same words).
    expect(screen.getByText('App Workspace', { selector: '.share-target-main' })).toBeTruthy()
    expect(screen.getByText('Contributor', { selector: '.share-target-tag' })).toBeTruthy()
    // A different-workspace model gets Build; a same-workspace one (case-insensitive) is covered.
    expect(await screen.findByText('sales', { selector: '.share-target-main' })).toBeTruthy()
    expect(screen.getByText('Build', { selector: '.share-target-tag' })).toBeTruthy()
    expect(screen.getByText('local', { selector: '.share-target-main' })).toBeTruthy()
    expect(screen.getByText('Covered by workspace')).toBeTruthy()
  })

  it('suggests directory matches and adds one as a chip', async () => {
    const directorySearch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        people: [{ id: '1', displayName: 'Ada Lovelace', email: 'ada@contoso.com' }]
      })
    )
    installApi({ directorySearch })
    render(<ShareDeploymentModal project={makeProject('p1')} deployment={deployment} onClose={vi.fn()} />)

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'ada l' } })
    // A space (typing a full name) must NOT stop the search.
    const option = await screen.findByRole('option')
    expect(option.textContent).toContain('Ada Lovelace')
    await waitFor(() => expect(directorySearch).toHaveBeenCalledWith('ada l'))
    fireEvent.click(option)

    // …and selecting it adds a friendly name chip and enables Share.
    expect(screen.getByText('Ada Lovelace', { selector: '.share-chip-name' })).toBeTruthy()
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Share' }) as HTMLButtonElement).disabled).toBe(false)
    )
  })

  it('validates emails and gates the Share button', async () => {
    render(<ShareDeploymentModal project={makeProject('p1')} deployment={deployment} onClose={vi.fn()} />)
    const shareBtn = screen.getByRole('button', { name: 'Share' }) as HTMLButtonElement
    // No recipients yet → disabled.
    expect(shareBtn.disabled).toBe(true)

    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'not-an-email' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    // Invalid chip is flagged and Share stays disabled.
    expect(await screen.findByText(/Not a valid email/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Share' }) as HTMLButtonElement).disabled).toBe(true)

    // Remove the bad chip, type a valid address → enabled.
    fireEvent.click(screen.getByRole('button', { name: 'Remove not-an-email' }))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'dev@contoso.com' } })
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Share' }) as HTMLButtonElement).disabled).toBe(false)
    )
  })

  it('shares and renders per-recipient results', async () => {
    const shareApp = vi.fn(() =>
      Promise.resolve({
        ok: true,
        recipients: [
          {
            email: 'dev@contoso.com',
            resolved: true,
            principalType: 'User',
            app: { ok: true },
            models: [{ alias: 'sales', itemId: 'ds-1', ok: true, skipped: true }]
          }
        ]
      })
    )
    installApi({
      shareApp,
      projectSemanticModels: vi.fn(() =>
        Promise.resolve([{ alias: 'sales', workspaceId: 'ws-other', itemId: 'ds-1' }])
      )
    })
    render(<ShareDeploymentModal project={makeProject('p1')} deployment={deployment} onClose={vi.fn()} />)

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'dev@contoso.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))

    await waitFor(() =>
      expect(shareApp).toHaveBeenCalledWith('p1', 'ws-app', ['dev@contoso.com'])
    )
    // Result rows: the app grant and the model grant, with idempotent wording.
    expect(await screen.findByText('dev@contoso.com', { selector: '.share-result-email' })).toBeTruthy()
    expect(screen.getByText('Shared')).toBeTruthy()
    expect(screen.getByText('Already had access')).toBeTruthy()

    // Once shared, the app link can be copied to send to recipients.
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    fireEvent.click(screen.getByRole('button', { name: /Copy link/ }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://sales.example.app/'))
  })

  it('prompts for Azure sign-in and retries when needsAz', async () => {
    const shareApp = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, recipients: [], needsAz: true, error: 'az login required' })
      .mockResolvedValueOnce({
        ok: true,
        recipients: [{ email: 'dev@contoso.com', resolved: true, app: { ok: true }, models: [] }]
      })
    const loginAz = vi.fn(() => Promise.resolve({ ok: true, exitCode: 0 }))
    installApi({ shareApp, loginAz })
    render(<ShareDeploymentModal project={makeProject('p1')} deployment={deployment} onClose={vi.fn()} />)

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'dev@contoso.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))

    const retry = await screen.findByRole('button', { name: /Sign in to Azure/ })
    fireEvent.click(retry)

    await waitFor(() => expect(loginAz).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(shareApp).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('dev@contoso.com', { selector: '.share-result-email' })).toBeTruthy()
  })

  it.each([
    ['rayfin', 'failed login'],
    ['rayfin', 'rejected login'],
    ['rayfin', 'rejected verification'],
    ['az', 'failed login'],
    ['az', 'rejected login'],
    ['az', 'rejected verification']
  ])('does not retry sharing after %s %s', async (kind, failure) => {
    const login = vi.fn().mockResolvedValue({ ok: true, exitCode: 0 })
    const onSignedIn = vi.fn().mockResolvedValue(undefined)
    if (failure === 'failed login') {
      login.mockResolvedValueOnce({ ok: false, exitCode: 1, error: 'Session verification failed' })
    } else if (failure === 'rejected login') {
      login.mockRejectedValueOnce('Session verification failed')
    } else {
      onSignedIn.mockRejectedValueOnce(new Error('Session verification failed'))
    }
    const shareApp = vi.fn().mockResolvedValue({
      ok: false,
      recipients: [],
      needsLogin: kind === 'rayfin',
      needsAz: kind === 'az'
    })
    installApi({ shareApp, ...(kind === 'az' ? { loginAz: login } : { loginRayfin: login }) })
    render(
      <ToastProvider>
        <ShareDeploymentModal
          project={makeProject('p1')}
          deployment={deployment}
          onClose={vi.fn()}
          onSignedIn={onSignedIn}
        />
      </ToastProvider>
    )
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'dev@contoso.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    const buttonName = kind === 'az' ? 'Sign in to Azure & retry' : 'Sign in & retry'
    fireEvent.click(await screen.findByRole('button', { name: buttonName }))

    expect((await screen.findByRole('alert')).textContent).toContain('Session verification failed')
    expect(shareApp).toHaveBeenCalledTimes(1)
    expect((screen.getByRole('button', { name: buttonName }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByText('dev@contoso.com', { selector: '.share-chip-name' })).toBeTruthy()
  })

  it('waits for the parent auth refresh before retrying a share', async () => {
    const verification = deferred<void>()
    const shareApp = vi.fn()
      .mockResolvedValueOnce({ ok: false, recipients: [], needsAz: true })
      .mockResolvedValue({ ok: true, recipients: [] })
    const onSignedIn = vi.fn(() => verification.promise)
    installApi({ shareApp })
    render(
      <ToastProvider>
        <ShareDeploymentModal
          project={makeProject('p1')}
          deployment={deployment}
          onClose={vi.fn()}
          onSignedIn={onSignedIn}
        />
      </ToastProvider>
    )
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'dev@contoso.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in to Azure & retry' }))
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1))
    expect(shareApp).toHaveBeenCalledTimes(1)
    expect((screen.getByRole('button', { name: 'Signing in…' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => verification.resolve(undefined))
    expect(shareApp).toHaveBeenCalledTimes(2)
  })

  it('shows directory auth failures rather than silently claiming there are no matches', async () => {
    const api = installApi({
      directorySearch: vi.fn().mockRejectedValue('Directory sign-in check unavailable')
    })
    render(
      <ToastProvider>
        <ShareDeploymentModal project={makeProject('p1')} deployment={deployment} onClose={vi.fn()} />
      </ToastProvider>
    )
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Ada' } })
    expect((await screen.findByRole('alert')).textContent).toContain('Directory sign-in check unavailable')
    expect(screen.queryByText('No matches')).toBeNull()
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('Ada')
    expect(api.shareApp).not.toHaveBeenCalled()
  })

  it('ignores directory results that arrive after the query is cleared', async () => {
    const search = deferred<FabricDirectoryResult>()
    const directorySearch = vi.fn(() => search.promise)
    installApi({ directorySearch })
    render(
      <ToastProvider>
        <ShareDeploymentModal project={makeProject('p1')} deployment={deployment} onClose={vi.fn()} />
      </ToastProvider>
    )
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Ada' } })
    await waitFor(() => expect(directorySearch).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } })
    await act(async () => search.resolve({
      ok: true,
      people: [{ displayName: 'Ada', email: 'ada@contoso.com' }]
    }))
    expect(screen.queryByRole('option')).toBeNull()
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it.each(['rayfin', 'az'])('recovers a %s directory session without sharing or losing the query', async (kind) => {
    const verification = deferred<void>()
    const onSignedIn = vi.fn(() => verification.promise)
    const api = installApi({
      directorySearch: vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          people: [],
          needsLogin: kind === 'rayfin',
          needsAz: kind === 'az',
          error: 'Directory session expired'
        })
        .mockResolvedValue({
          ok: true,
          people: [{ displayName: 'Ada Lovelace', email: 'ada@contoso.com' }]
        })
    })
    render(
      <ToastProvider>
        <ShareDeploymentModal
          project={makeProject('p1')}
          deployment={deployment}
          onClose={vi.fn()}
          onSignedIn={onSignedIn}
        />
      </ToastProvider>
    )
    const input = screen.getByRole('combobox') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Ada Lovelace' } })
    const provider = kind === 'az' ? 'Azure' : 'Fabric'
    fireEvent.click(await screen.findByRole('button', { name: `Sign in to ${provider} to search` }))
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1))

    expect(kind === 'az' ? api.loginAz : api.loginRayfin).toHaveBeenCalledTimes(1)
    expect(kind === 'az' ? api.loginRayfin : api.loginAz).not.toHaveBeenCalled()
    expect(api.directorySearch).toHaveBeenCalledTimes(1)
    expect(api.shareApp).not.toHaveBeenCalled()
    expect(input.value).toBe('Ada Lovelace')

    await act(async () => verification.resolve(undefined))
    expect((await screen.findByRole('option')).textContent).toContain('Ada Lovelace')
    expect(api.directorySearch).toHaveBeenLastCalledWith('Ada Lovelace')
    expect(api.directorySearch).toHaveBeenCalledTimes(2)
    expect(api.shareApp).not.toHaveBeenCalled()
    expect(input.value).toBe('Ada Lovelace')
  })

  it.each([
    ['rayfin', 'failed login'],
    ['rayfin', 'rejected login'],
    ['rayfin', 'rejected verification'],
    ['az', 'failed login'],
    ['az', 'rejected login'],
    ['az', 'rejected verification']
  ])('does not retry a directory lookup after %s %s', async (kind, failure) => {
    const login = vi.fn().mockResolvedValue({ ok: true, exitCode: 0 })
    const onSignedIn = vi.fn().mockResolvedValue(undefined)
    if (failure === 'failed login') {
      login.mockResolvedValueOnce({ ok: false, exitCode: 1, error: 'Directory sign-in failed' })
    } else if (failure === 'rejected login') {
      login.mockRejectedValueOnce('Directory sign-in failed')
    } else {
      onSignedIn.mockRejectedValueOnce(new Error('Directory sign-in failed'))
    }
    const api = installApi({
      ...(kind === 'az' ? { loginAz: login } : { loginRayfin: login }),
      directorySearch: vi.fn().mockResolvedValue({
        ok: false,
        people: [],
        needsLogin: kind === 'rayfin',
        needsAz: kind === 'az',
        error: 'Session expired'
      })
    })
    render(
      <ToastProvider>
        <ShareDeploymentModal
          project={makeProject('p1')}
          deployment={deployment}
          onClose={vi.fn()}
          onSignedIn={onSignedIn}
        />
      </ToastProvider>
    )
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Ada Lovelace' } })
    const buttonName = `Sign in to ${kind === 'az' ? 'Azure' : 'Fabric'} to search`
    fireEvent.click(await screen.findByRole('button', { name: buttonName }))

    await screen.findByText('Directory sign-in failed')
    expect(api.directorySearch).toHaveBeenCalledTimes(1)
    expect(api.shareApp).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: buttonName }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('Ada Lovelace')
  })

  it('does not turn a directory permission error into a sign-in prompt', async () => {
    const api = installApi({
      directorySearch: vi.fn().mockResolvedValue({
        ok: false,
        people: [],
        error: '403: Directory access forbidden'
      })
    })
    render(
      <ToastProvider>
        <ShareDeploymentModal project={makeProject('p1')} deployment={deployment} onClose={vi.fn()} />
      </ToastProvider>
    )
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Ada' } })
    expect((await screen.findByRole('alert')).textContent).toContain('403: Directory access forbidden')
    expect(screen.queryByRole('button', { name: /Sign in/ })).toBeNull()
    expect(api.loginAz).not.toHaveBeenCalled()
    expect(api.loginRayfin).not.toHaveBeenCalled()
  })
})
