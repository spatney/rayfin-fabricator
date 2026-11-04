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
      ),
      describe: vi.fn(async () => ({
        ok: true,
        description: 'Tracks team expenses and approvals.'
      })),
      quickLook: {
        show: vi.fn().mockResolvedValue(undefined),
        setBounds: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined)
      }
    },
    projects: {
      communityTemplates: vi.fn(async () => ({
        ok: true,
        gallery: {
          repoUrl: 'https://github.com/microsoft/awesome-rayfin',
          displayName: 'Awesome Rayfin',
          templates: [
            {
              repoUrl: 'https://github.com/microsoft/awesome-rayfin',
              path: 'apps/expenses',
              name: 'Expense tracker',
              description: 'Submit and approve expenses'
            }
          ]
        }
      })),
      thumbnails: vi.fn().mockResolvedValue({})
    },
    rayfin: { latest: vi.fn().mockResolvedValue({}) },
    deploy: { hasChanges: vi.fn().mockResolvedValue(false) },
    local: {
      status: vi.fn(async (projectId: string) => ({ projectId, state: 'stopped', revision: 1 })),
      onState: vi.fn(() => () => {})
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
/** Each card's name in a list, leaving out its pin. */
const shownNames = (list = 'Apps'): string[] =>
  within(screen.getByRole('list', { name: list }))
    .getAllByRole('listitem')
    .map((item) => within(item).getAllByRole('button')[0].getAttribute('aria-label') ?? '')
const saved = (): unknown => JSON.parse(localStorage.getItem('rayfin.gallery') ?? '{}')

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
    fireEvent.click(screen.getByRole('button', { name: 'Sort: Name' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Recently published/ }))
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

  it('lists the workspaces your apps here use first, and keeps Esc in its menu', async () => {
    installApi()
    const { props } = renderGallery({
      recentWorkspaces: [{ workspace: 'ws-travel', at: Date.now() - 2 * DAY }]
    })
    await screen.findByRole('button', { name: /^expense-tracker/ })
    fireEvent.click(screen.getByRole('button', { name: 'Workspace: All workspaces' }))
    const menu = screen.getByRole('menu', { name: 'Workspace' })
    const group = (name: string): HTMLElement => within(menu).getByRole('group', { name })
    const names = (name: string): string[] =>
      within(group(name))
        .getAllByRole('menuitemradio')
        .map((item) => item.getAttribute('title') ?? '')
    expect(names('Recent')).toEqual(['Travel'])
    expect(within(group('Recent')).getByText('2 days ago')).toBeTruthy()
    expect(names('Other workspaces')).toEqual(['Sales'])
    expect(within(group('Other workspaces')).getByText('2 apps')).toBeTruthy()

    fireEvent.keyDown(within(menu).getByRole('menuitemradio', { name: /^Travel/ }), {
      key: 'Escape'
    })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(props.onClose).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Workspace: All workspaces' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Travel/ }))
    expect(shownNames()).toEqual(['Trip logger, in Travel'])
    expect(screen.getByRole('button', { name: 'Workspace: Travel' })).toBeTruthy()

    // Enter in its search picks the first match.
    fireEvent.click(screen.getByRole('button', { name: 'Workspace: Travel' }))
    const search = screen.getByRole('textbox', { name: 'Search workspaces' })
    fireEvent.change(search, { target: { value: 'sal' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(shownNames()).toEqual(['expense-tracker, in Sales', 'sales-dashboard, in Sales'])
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

  it('pins an app to the top without opening it, and remembers it', async () => {
    installApi()
    const first = renderGallery()
    await screen.findByRole('button', { name: /^expense-tracker/ })
    fireEvent.click(screen.getByRole('button', { name: 'Pin Trip logger', pressed: false }))
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(shownNames()).toEqual([
      'Trip logger, in Travel',
      'expense-tracker, in Sales',
      'sales-dashboard, in Sales'
    ])
    expect(saved()).toMatchObject({ where: 'all', sort: 'name', pinned: ['c'] })
    first.unmount()

    installApi()
    renderGallery()
    const pin = await screen.findByRole('button', { name: 'Pin Trip logger', pressed: true })
    expect(pin.title).toBe('Unpin')
    expect(shownNames()[0]).toBe('Trip logger, in Travel')

    // The details pin and unpin it too.
    fireEvent.click(card(/^Trip logger/))
    const details = screen.getByRole('complementary', { name: 'About Trip logger' })
    fireEvent.click(within(details).getByRole('button', { name: 'Unpin' }))
    expect(within(details).getByRole('button', { name: 'Pin to the top' })).toBeTruthy()
    expect(shownNames()).toEqual([
      'expense-tracker, in Sales',
      'sales-dashboard, in Sales',
      'Trip logger, in Travel'
    ])
    expect(saved()).toMatchObject({ pinned: [] })
  })

  it('groups pinned apps first by workspace, and the pin keeps the focus as its card moves', async () => {
    localStorage.setItem(
      'rayfin.gallery',
      JSON.stringify({ sort: 'workspace', pinned: ['c', 7, null, 'c'] })
    )
    installApi()
    renderGallery()
    await screen.findByRole('button', { name: /^expense-tracker/ })
    expect(saved()).toMatchObject({ where: 'all', sort: 'workspace', pinned: ['c'] })
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual([
      'Pinned',
      'Sales'
    ])
    // Under Pinned, cards still say where they are.
    expect(
      within(screen.getByRole('list', { name: 'Pinned apps' })).getByText('Travel')
    ).toBeTruthy()

    const pin = screen.getByRole('button', { name: 'Pin sales-dashboard' })
    pin.focus()
    fireEvent.click(pin)
    expect(shownNames('Pinned apps')).toEqual([
      'sales-dashboard, in Sales',
      'Trip logger, in Travel'
    ])
    expect(shownNames('Apps in Sales')).toEqual(['expense-tracker, in Sales'])
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Pin sales-dashboard', pressed: true })
    )

    // Search still applies to pinned apps.
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search apps' }), {
      target: { value: 'expense' }
    })
    expect(screen.queryByRole('region', { name: 'Pinned' })).toBeNull()
    expect(shownNames('Apps in Sales')).toEqual(['expense-tracker, in Sales'])
  })

  it('offers a new project when there are no apps yet', async () => {
    installApi({ ok: true, apps: [] })
    const { props } = renderGallery()
    fireEvent.click(await screen.findByRole('button', { name: 'New project' }))
    expect(props.onNewProject).toHaveBeenCalledTimes(1)
  })

  it('lists the apps as a table, and remembers the layout', async () => {
    installApi(ok, { b: { id: 'b', publishedAt: new Date(Date.now() - 2 * DAY).toISOString() } })
    renderGallery()
    await screen.findByRole('button', { name: /^expense-tracker/ })
    fireEvent.click(screen.getByRole('button', { name: 'Table' }))
    const table = screen.getByRole('table', { name: 'Apps' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(
      rows.map((row) => within(row).getAllByRole('button')[0].getAttribute('aria-label'))
    ).toEqual(['expense-tracker, in Sales', 'sales-dashboard, in Sales', 'Trip logger, in Travel'])
    expect(await within(rows[1]).findByText('2 days ago')).toBeTruthy()
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'sales-dashboard, in Sales' }))
    expect(screen.getByRole('complementary', { name: 'About sales-dashboard' })).toBeTruthy()
    expect(saved()).toMatchObject({ view: 'table' })
  })

  it('finds the apps that need attention, and the ones you can change', async () => {
    const editable: GalleryApp[] = [
      { ...apps[0], canEdit: true },
      { ...apps[1], canEdit: false },
      { ...apps[2], canEdit: true }
    ]
    installApi(
      { ...ok, apps: editable },
      {
        a: {
          id: 'a',
          hostingUrl: 'https://expenses.example.net',
          publishedAt: new Date().toISOString()
        },
        b: { id: 'b' },
        c: { id: 'c', publishedAt: new Date().toISOString(), deployState: 'failed' }
      }
    )
    const failed = {
      id: 'p1',
      name: 'Expenses',
      path: 'C:/p1',
      addedAt: '2026-01-01',
      lastDeploy: { status: 'error', error: 'It broke' }
    }
    renderGallery({ projects: [failed] })
    await screen.findByRole('button', { name: /^expense-tracker/ })
    const attention = screen.getByRole('button', { name: /^Needs attention/ })
    fireEvent.click(attention)
    expect(attention.getAttribute('aria-pressed')).toBe('true')
    // Its last publish from here failed; one never published; one Fabric says failed.
    await waitFor(() =>
      expect(shownNames()).toEqual([
        'expense-tracker, in Sales',
        'sales-dashboard, in Sales',
        'Trip logger, in Travel'
      ])
    )
    expect(
      within(screen.getByRole('list', { name: 'Apps' })).getAllByText('Publish failed')
    ).toHaveLength(2)
    fireEvent.click(attention)

    fireEvent.click(screen.getByRole('button', { name: /^Apps I can edit/ }))
    expect(shownNames()).toEqual(['expense-tracker, in Sales', 'Trip logger, in Travel'])
  })

  it('puts the apps opened last first under Recently opened', async () => {
    installApi(ok, { b: { id: 'b', hostingUrl: 'https://sales.example.net' } })
    renderGallery()
    await screen.findByRole('button', { name: /^expense-tracker/ })
    fireEvent.click(card(/^sales-dashboard/))
    const details = screen.getByRole('complementary', { name: 'About sales-dashboard' })
    fireEvent.click(await within(details).findByRole('button', { name: 'Open app' }))
    fireEvent.click(screen.getByRole('button', { name: /^Sort/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Recently opened/ }))
    expect(shownNames()[0]).toBe('sales-dashboard, in Sales')
  })

  it('looks at a live app with Space, and Escape puts it away', async () => {
    const api = installApi()
    const box = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 10,
      y: 20,
      left: 10,
      top: 20,
      right: 810,
      bottom: 620,
      width: 800,
      height: 600,
      toJSON: () => ({})
    })
    try {
      renderGallery()
      const expenses = await screen.findByRole('button', { name: /^expense-tracker/ })
      fireEvent.keyDown(expenses, { key: ' ' })
      const look = await screen.findByRole('dialog', { name: 'Quick look at expense-tracker' })
      expect(api.gallery.quickLook.show).toHaveBeenCalledWith(
        'https://expenses.example.net',
        expect.objectContaining({ width: 800, height: 600 })
      )
      // Space didn't select it: no details opened.
      expect(screen.queryByRole('complementary')).toBeNull()
      fireEvent.click(within(look).getByRole('button', { name: 'Open app' }))
      expect(api.openExternal).toHaveBeenLastCalledWith('https://expenses.example.net')
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(screen.queryByRole('dialog')).toBeNull()
      await waitFor(() => expect(api.gallery.quickLook.close).toHaveBeenCalled())
    } finally {
      box.mockRestore()
    }
  })

  it('has Copilot describe an app published from this computer that has no description', async () => {
    const api = installApi({
      ...ok,
      apps: [{ ...apps[0], description: undefined, canEdit: true }, apps[1]]
    })
    renderGallery()
    fireEvent.click(await screen.findByRole('button', { name: /^expense-tracker/ }))
    const details = screen.getByRole('complementary', { name: 'About expense-tracker' })
    fireEvent.click(within(details).getByRole('button', { name: 'Write a description' }))
    expect(await within(details).findByText('Tracks team expenses and approvals.')).toBeTruthy()
    expect(api.gallery.describe).toHaveBeenCalledWith('p1')
    // An app not on this computer, or one you can't change, isn't offered it.
    fireEvent.click(card(/^sales-dashboard/))
    const other = screen.getByRole('complementary', { name: 'About sales-dashboard' })
    expect(within(other).queryByRole('button', { name: 'Write a description' })).toBeNull()
  })

  it('offers examples to start a new app from', async () => {
    installApi()
    const onUseExample = vi.fn()
    renderGallery({ onUseExample })
    await screen.findByRole('button', { name: /^expense-tracker/ })
    fireEvent.click(screen.getByRole('tab', { name: 'Examples' }))
    expect(screen.queryByRole('searchbox', { name: 'Search apps' })).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: 'Use Expense tracker' }))
    expect(onUseExample).toHaveBeenCalledWith(expect.objectContaining({ path: 'apps/expenses' }))
  })
})
