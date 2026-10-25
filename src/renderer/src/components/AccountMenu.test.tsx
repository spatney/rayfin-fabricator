import type { ComponentProps, JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { OverlayProvider, usePreviewSuppressed } from '../overlay'
import AccountMenu, { avatarInitials } from './AccountMenu'

type Props = ComponentProps<typeof AccountMenu>

function makeProps(overrides: Partial<Props> = {}): Props {
  return {
    signedIn: true,
    user: 'first.last@example.com',
    busy: false,
    signingIn: false,
    signingOut: false,
    refreshing: false,
    canRefresh: true,
    onSignIn: vi.fn(),
    onSignOut: vi.fn(),
    onRefresh: vi.fn(),
    onManageAccounts: vi.fn(),
    onOpenSettings: vi.fn(),
    ...overrides
  }
}

function PreviewProbe(): JSX.Element {
  return <output aria-label="preview">{usePreviewSuppressed() ? 'hidden' : 'shown'}</output>
}

function renderMenu(overrides: Partial<Props> = {}): Props {
  const props = makeProps(overrides)
  render(
    <OverlayProvider>
      <button>Elsewhere</button>
      <AccountMenu {...props} />
      <PreviewProbe />
    </OverlayProvider>
  )
  return props
}

const trigger = (): HTMLButtonElement =>
  screen.getByRole('button', { name: /^Account/ }) as HTMLButtonElement
const item = (name: string): HTMLButtonElement =>
  screen.getByRole('menuitem', { name }) as HTMLButtonElement

/** Flush the open menu's deferred initial focus. */
async function frame(): Promise<void> {
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
}

afterEach(cleanup)

describe('avatarInitials', () => {
  it.each([
    ['first.last@example.com', 'FL'],
    ['sapatney@example.com', 'SA'],
    [undefined, '?']
  ])('derives %s → %s', (email, initials) => {
    expect(avatarInitials(email)).toBe(initials)
  })
})

describe('AccountMenu', () => {
  it('opens a menu with the account identity and its actions', async () => {
    const props = renderMenu({ tenant: 'Contoso' })
    expect(trigger().textContent).toBe('FL')
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(trigger().title).toBe('Signed in to Fabric as first.last@example.com · Contoso')
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.click(trigger())
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('menu', { name: 'Fabric account' })).toBeTruthy()
    expect(screen.getByText('first.last@example.com')).toBeTruthy()
    expect(screen.getByText('Microsoft Fabric · Contoso')).toBeTruthy()
    await frame()
    expect(document.activeElement).toBe(item('Manage accounts…'))

    fireEvent.click(item('Sign out'))
    expect(props.onSignOut).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })

  it('opens every account from the menu', () => {
    const props = renderMenu()
    fireEvent.click(trigger())
    fireEvent.click(item('Manage accounts…'))
    expect(props.onManageAccounts).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('offers credential refresh only when a project is open', () => {
    const props = renderMenu({ canRefresh: false })
    fireEvent.click(trigger())
    expect(screen.queryByRole('menuitem', { name: 'Refresh Fabric authentication' })).toBeNull()
    fireEvent.click(item('Sign out'))
    expect(props.onSignOut).toHaveBeenCalledTimes(1)
    expect(props.onRefresh).not.toHaveBeenCalled()
  })

  it('refocuses the account control before a picked action opens its dialog', () => {
    let focusedAtAction: Element | null = null
    const onRefresh = vi.fn(() => {
      focusedAtAction = document.activeElement
    })
    renderMenu({ onRefresh })
    fireEvent.click(trigger())
    fireEvent.click(item('Refresh Fabric authentication'))
    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(focusedAtAction).toBe(trigger())
  })

  it('shows progress and blocks account actions while Fabric is busy', () => {
    const props = renderMenu({ busy: true, refreshing: true })
    fireEvent.click(trigger())
    expect(item('Refreshing authentication…').disabled).toBe(true)
    expect(item('Sign out').disabled).toBe(true)
    fireEvent.click(item('Sign out'))
    expect(props.onSignOut).not.toHaveBeenCalled()
  })

  it('labels a sign-out in progress', () => {
    renderMenu({ busy: true, signingOut: true })
    fireEvent.click(trigger())
    expect(item('Signing out…').disabled).toBe(true)
  })

  it('closes on Escape (returning focus), outside presses, and Tab', async () => {
    renderMenu()
    fireEvent.click(trigger())
    await frame()
    fireEvent.keyDown(item('Refresh Fabric authentication'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger())

    fireEvent.click(trigger())
    fireEvent.pointerDown(screen.getByRole('menu'))
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Elsewhere' }))
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.click(trigger())
    fireEvent.keyDown(trigger(), { key: 'Tab' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('moves between items with the arrow keys', async () => {
    renderMenu()
    fireEvent.click(trigger())
    await frame()
    const manage = item('Manage accounts…')
    const refresh = item('Refresh Fabric authentication')
    const signOut = item('Sign out')
    const settings = item('Settings')
    expect(document.activeElement).toBe(manage)
    fireEvent.keyDown(manage, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(refresh)
    fireEvent.keyDown(refresh, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(signOut)
    fireEvent.keyDown(signOut, { key: 'ArrowDown' })
    expect(document.activeElement, 'the separator is skipped').toBe(settings)
    fireEvent.keyDown(settings, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(manage)
    fireEvent.keyDown(manage, { key: 'End' })
    expect(document.activeElement).toBe(settings)
  })

  it('opens Settings from the menu, signed in or out', () => {
    const props = renderMenu()
    fireEvent.click(trigger())
    fireEvent.click(item('Settings'))
    expect(props.onOpenSettings).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
    cleanup()

    const signedOut = renderMenu({ signedIn: false, user: undefined, canRefresh: false })
    fireEvent.click(screen.getByRole('button', { name: 'Settings and accounts' }))
    fireEvent.click(item('Settings'))
    expect(signedOut.onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('hides the native preview only while the menu is open', () => {
    renderMenu()
    const preview = screen.getByLabelText('preview')
    expect(preview.textContent).toBe('shown')
    fireEvent.click(trigger())
    expect(preview.textContent).toBe('hidden')
    fireEvent.click(trigger())
    expect(preview.textContent).toBe('shown')
  })

  it('keeps sign-in one click away when signed out, with refresh behind the caret', () => {
    const props = renderMenu({ signedIn: false, user: undefined })
    expect(screen.queryByRole('button', { name: /^Account/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Fabric' }))
    expect(props.onSignIn).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Settings and accounts' }))
    expect(screen.getByText('Not signed in to Fabric')).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'Sign out' })).toBeNull()
    fireEvent.click(item('Refresh Fabric authentication'))
    expect(props.onRefresh).toHaveBeenCalledTimes(1)
  })

  it('offers account management behind the caret even with no project open', () => {
    const props = renderMenu({ signedIn: false, user: undefined, canRefresh: false, signingIn: true, busy: true })
    const signIn = screen.getByRole('button', { name: 'Signing in…' }) as HTMLButtonElement
    expect(signIn.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Settings and accounts' }))
    expect(screen.queryByRole('menuitem', { name: 'Refresh Fabric authentication' })).toBeNull()
    fireEvent.click(item('Manage accounts…'))
    expect(props.onManageAccounts).toHaveBeenCalledTimes(1)
  })

  it('stays neutral while the launch check runs instead of asking to sign in', async () => {
    const props = renderMenu({ signedIn: false, user: undefined, checking: true })
    expect(screen.queryByRole('button', { name: 'Sign in to Fabric' })).toBeNull()
    const pending = screen.getByRole('button', { name: 'Account: checking sign-in' })
    expect(pending.title).toBe('Checking your Microsoft Fabric sign-in…')
    fireEvent.click(pending)
    expect(screen.getByText('Checking your Fabric sign-in…')).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'Refresh Fabric authentication' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Sign out' })).toBeNull()
    await frame()
    fireEvent.click(item('Manage accounts…'))
    expect(props.onManageAccounts).toHaveBeenCalledTimes(1)
  })
})
