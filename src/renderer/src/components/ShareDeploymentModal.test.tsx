import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { FabricDeployment } from '@shared/ipc'
import ShareDeploymentModal from './ShareDeploymentModal'
import { makeProject } from '../../test/harness'

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
})
