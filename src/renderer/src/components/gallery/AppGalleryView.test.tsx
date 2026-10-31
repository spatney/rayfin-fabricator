import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { GalleryApp, GalleryResult, GalleryStatus } from '@shared/ipc'
import { deferred } from '../../../test/deferred'
import AppGalleryView, { resetGallerySnapshotForTests } from './AppGalleryView'

const DAY = 86_400_000

function app(id: string, name: string, over: Partial<GalleryApp> = {}): GalleryApp {
  return {
    id,
    name,
    workspaceId: 'ws-sales',
    workspaceName: 'Sales',
    portalUrl: `https://app.fabric.microsoft.com/groups/ws-sales/appbackends/${id}`,
    ...over
  }
}

const apps: GalleryApp[] = [
  app('a', 'expense-tracker', {
    description: 'Team expenses and approvals',
    local: { projectId: 'p1', projectName: 'Expenses' },
    hostingUrl: 'https://expenses.example.net'
  }),
  app('b', 'sales-dashboard'),
  app('c', 'Trip logger', {
    workspaceId: 'ws-travel',
    workspaceName: 'Travel',
    team: { workspaceId: 't1', name: 'Trips team', preview: false }
  })
]
const ok: GalleryResult = { ok: true, apps, account: { user: 'amy@contoso.com' } }

function installApi(
  list: GalleryResult | ((refresh?: boolean) => Promise<GalleryResult>) = ok,
  statuses: Record<string, GalleryStatus> = {}
) {
  const api = {
    gallery: {
      list: vi.fn(typeof list === 'function' ? list : async () => list),
      status: vi.fn(async (wanted: Array<{ id: string }>) =>
        wanted.map((w) => statuses[w.id] ?? { id: w.id })
      )
    },
    auth: { loginAz: vi.fn().mockResolvedValue({ ok: true }) },
    openExternal: vi.fn().mockResolvedValue(undefined)
  }
  ;(window as unknown as { api: unknown }).api = api
  return api
}

function renderGallery(over: Partial<Parameters<typeof AppGalleryView>[0]> = {}) {
  const props = {
    onClose: vi.fn(),
    onOpenProject: vi.fn(),
    onNewProject: vi.fn(),
    onSignedIn: vi.fn(),
    ...over
  }
  return { props, ...render(<AppGalleryView {...props} />) }
}

const card = (name: RegExp): HTMLElement => screen.getByRole('button', { name })
const shownNames = (): string[] =>
  within(screen.getByRole('list', { name: 'Apps' }))
    .getAllByRole('button')
    .map((b) => b.getAttribute('aria-label') ?? '')

beforeEach(() => {
  resetGallerySnapshotForTests()
  localStorage.clear()
})
afterEach(() => cleanup())

describe('AppGalleryView', () => {
  it('shows every app, finds them by name, workspace or description, and says when nothing matches', async () => {
    installApi()
    renderGallery()
    await screen.findByRole('button', { name: /^expense-tracker/ })
    expect(screen.getByText('3 apps · 2 workspaces')).toBeTruthy()
    expect(screen.getByText('amy@contoso.com')).toBeTruthy()

    const search = screen.getByRole('searchbox', { name: 'Search apps' })
    fireEvent.change(search, { target: { value: 'travel' } })
    expect(shownNames()).toEqual(['Trip logger, in Travel'])
    fireEvent.change(search, { target: { value: 'approvals' } })
    expect(shownNames()).toEqual(['expense-tracker, in Sales'])
    expect(screen.getByText('Showing 1 of 3 apps')).toBeTruthy()

    fireEvent.change(search, { target: { value: 'zzz' } })
    expect(screen.getByText('No apps match “zzz”')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show all apps' }))
    expect(shownNames()).toHaveLength(3)
    expect((search as HTMLInputElement).value).toBe('')
  })

  it('opens an app in the browser, in Fabric, or in Fabricator when it’s on this computer', async () => {
    const api = installApi(ok, {
      b: {
        id: 'b',
        hostingUrl: 'https://sales.example.net',
        publishedAt: new Date(Date.now() - 2 * DAY).toISOString()
      },
      c: { id: 'c', unknown: true }
    })
    const { props } = renderGallery()
    await screen.findByText('Published 2 days ago')

    fireEvent.click(card(/^sales-dashboard/))
    const details = screen.getByRole('complementary', { name: 'About sales-dashboard' })
    fireEvent.click(within(details).getByRole('button', { name: 'Open app' }))
    expect(api.openExternal).toHaveBeenLastCalledWith('https://sales.example.net')
    fireEvent.click(within(details).getByRole('button', { name: 'Open in Fabric' }))
    expect(api.openExternal).toHaveBeenLastCalledWith(apps[1].portalUrl)
    expect(within(details).queryByRole('button', { name: 'Open in Fabricator' })).toBeNull()

    // An app Fabric won't say more about still opens in Fabric.
    fireEvent.click(card(/^Trip logger/))
    const trip = screen.getByRole('complementary', { name: 'About Trip logger' })
    expect(within(trip).queryByRole('button', { name: 'Open app' })).toBeNull()
    expect(within(trip).getByText(/Open it in Fabric instead/)).toBeTruthy()

    // The app on this computer opens with the address its project records, and in Fabricator.
    fireEvent.click(card(/^expense-tracker/))
    const mine = screen.getByRole('complementary', { name: 'About expense-tracker' })
    fireEvent.click(within(mine).getByRole('button', { name: 'Open app' }))
    expect(api.openExternal).toHaveBeenLastCalledWith('https://expenses.example.net')
    fireEvent.click(within(mine).getByRole('button', { name: 'Open in Fabricator' }))
    expect(props.onOpenProject).toHaveBeenCalledWith('p1')
  })

  it('puts the most recently published first once Fabric says when', async () => {
    installApi(ok, {
      a: { id: 'a', publishedAt: new Date(Date.now() - 9 * DAY).toISOString() },
      c: { id: 'c', publishedAt: new Date(Date.now() - DAY).toISOString() }
    })
    renderGallery()
    await screen.findByRole('button', { name: /^expense-tracker/ })
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort' }), {
      target: { value: 'recent' }
    })
    await waitFor(() =>
      expect(shownNames()).toEqual([
        'Trip logger, in Travel',
        'expense-tracker, in Sales',
        'sales-dashboard, in Sales'
      ])
    )
    expect(JSON.parse(localStorage.getItem('rayfin.gallery') ?? '{}')).toMatchObject({
      sort: 'recent'
    })
  })

  it('asks for an Azure sign-in, then reads with a fresh one', async () => {
    const message =
      'Fabricator finds the apps you can open with your Azure sign-in. Sign in to Azure to see them.'
    const api = installApi(async (refresh) =>
      refresh ? ok : { ok: false, needsAz: true, apps: [], error: message }
    )
    const { props } = renderGallery()
    expect((await screen.findByRole('alert')).textContent).toContain(message)

    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Azure' }))
    await screen.findByRole('button', { name: /^expense-tracker/ })
    expect(api.auth.loginAz).toHaveBeenCalledTimes(1)
    expect(props.onSignedIn).toHaveBeenCalledTimes(1)
    expect(api.gallery.list).toHaveBeenLastCalledWith(true)
  })

  it('closes the details, then clears the search, then leaves on Escape', async () => {
    installApi()
    const { props } = renderGallery()
    await screen.findByRole('button', { name: /^expense-tracker/ })
    const search = screen.getByRole('searchbox', { name: 'Search apps' }) as HTMLInputElement
    fireEvent.change(search, { target: { value: 'sales' } })
    fireEvent.click(card(/^sales-dashboard/))
    expect(screen.getByRole('complementary', { name: 'About sales-dashboard' })).toBeTruthy()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(document.activeElement).toBe(card(/^sales-dashboard/))
    expect(search.value).toBe('sales')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(search.value).toBe('')
    expect(props.onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('remembers where to look, and opens on the apps it read last while it checks again', async () => {
    installApi()
    const first = renderGallery()
    await screen.findByRole('button', { name: /^expense-tracker/ })
    fireEvent.click(screen.getByRole('button', { name: /^On this computer/ }))
    expect(shownNames()).toEqual(['expense-tracker, in Sales'])
    first.unmount()

    const later = deferred<GalleryResult>()
    installApi(() => later.promise)
    renderGallery()
    expect(shownNames()).toEqual(['expense-tracker, in Sales'])
    expect(screen.getByText('Checking Fabric…')).toBeTruthy()
    await act(async () =>
      later.resolve({
        ...ok,
        apps: [...apps, app('d', 'notes', { local: { projectId: 'p2', projectName: 'Notes' } })]
      })
    )
    expect(shownNames()).toEqual(['expense-tracker, in Sales', 'notes, in Sales'])
    expect(screen.queryByText('Checking Fabric…')).toBeNull()
  })

  it('offers a new project when there are no apps yet', async () => {
    installApi({ ok: true, apps: [] })
    const { props } = renderGallery()
    fireEvent.click(await screen.findByRole('button', { name: 'New project' }))
    expect(props.onNewProject).toHaveBeenCalledTimes(1)
  })
})
