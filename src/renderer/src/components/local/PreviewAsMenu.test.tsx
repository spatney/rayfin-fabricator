import type { ComponentProps, JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { LocalIdentity, LocalIdentityRequest, LocalStatus, LocalUser } from '@shared/ipc'
import { deferred } from '../../../test/deferred'
import { LocalBackendError, localBackendStore } from '../../localBackend'
import { OverlayProvider, usePreviewSuppressed } from '../../overlay'
import PreviewAsMenu from './PreviewAsMenu'

function user(username: string, patch: Partial<LocalUser> = {}): LocalUser {
  return {
    id: `id-${username}`,
    username,
    email: username.includes('@') ? username : null,
    createdAt: '2026-10-30T08:00:00.000Z',
    signIn: [],
    developer: false,
    ...patch
  }
}

const entra = user('ana@contoso.com', { signIn: ['entra'], developer: true })
const localDeveloper = user('developer@example.com', { developer: true })
const bob = user('bob@example.com')
const carol = user('carol@example.com')

/** A local backend's sign-in identity and users, behind a mocked `window.api`. */
function installApi(identity: LocalIdentity, users: LocalUser[] = [entra, bob, carol]) {
  const backend = { identity, users: [...users] }
  const local = {
    identity: vi.fn(async (_projectId: string) => backend.identity),
    users: vi.fn(async (_projectId: string) => backend.users),
    setIdentity: vi.fn(async (_projectId: string, request: LocalIdentityRequest) => {
      if (request.kind !== 'user') {
        backend.identity = { kind: request.kind, user: null }
        return backend.identity
      }
      let found = backend.users.find((u) => u.username.toLowerCase() === request.user.toLowerCase())
      if (!found && !request.create) {
        throw new LocalBackendError({
          code: 'user-not-found',
          message: `There's no user ${request.user}.`,
          status: 404
        })
      }
      if (!found) {
        found = user(request.user)
        backend.users.push(found)
      }
      backend.identity = { kind: 'user', user: found }
      return backend.identity
    }),
    onState: vi.fn(() => () => {})
  }
  const preview = { resetSiteData: vi.fn(async () => true) }
  ;(window as unknown as { api: unknown }).api = { local, preview }
  return { backend, local, preview }
}

function status(patch: Partial<LocalStatus>): LocalStatus {
  return {
    projectId: 'p1',
    state: 'running',
    revision: 1,
    phase: null,
    pid: 4242,
    version: '0.2.0',
    projectRoot: null,
    signInAs: null,
    ready: null,
    analysis: null,
    schema: null,
    functions: null,
    vite: null,
    config: null,
    warnings: [],
    error: null,
    stopped: null,
    crashes: 0,
    startedAt: null,
    updatedAt: null,
    ...patch
  }
}

function PreviewProbe(): JSX.Element {
  return <output aria-label="preview">{usePreviewSuppressed() ? 'hidden' : 'shown'}</output>
}

type Props = ComponentProps<typeof PreviewAsMenu>

function tree(props: Partial<Props>, onSwitched: () => void): JSX.Element {
  return (
    <OverlayProvider>
      <button type="button">Elsewhere</button>
      <PreviewAsMenu projectId="p1" onSwitched={onSwitched} {...props} />
      <PreviewProbe />
    </OverlayProvider>
  )
}

function renderMenu(props: Partial<Props> = {}) {
  const onSwitched = vi.fn()
  const view = render(tree(props, onSwitched))
  return { onSwitched, rerender: (next: Partial<Props>) => view.rerender(tree(next, onSwitched)) }
}

const trigger = (): HTMLButtonElement =>
  screen.getByRole('button', { name: /^Preview as/ }) as HTMLButtonElement
const option = (name: string): HTMLButtonElement =>
  screen.getByRole('menuitemradio', { name }) as HTMLButtonElement
const addItem = (): HTMLButtonElement =>
  screen.getByRole('menuitem', { name: 'Add test user…' }) as HTMLButtonElement
const emailField = (): HTMLInputElement =>
  screen.getByLabelText('Test user’s email') as HTMLInputElement

/** Flush the open menu's deferred initial focus. */
async function frame(): Promise<void> {
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
}

async function openMenu(): Promise<HTMLElement> {
  fireEvent.click(trigger())
  const menu = screen.getByRole('menu', { name: 'Preview as' })
  await frame()
  return menu
}

afterEach(() => {
  cleanup()
  localBackendStore.clear()
  delete (window as unknown as { api?: unknown }).api
})

describe('PreviewAsMenu', () => {
  it.each([
    ['you', { kind: 'developer', user: entra } as LocalIdentity, 'Preview as: You'],
    ['a test user', { kind: 'user', user: bob } as LocalIdentity, 'Preview as: bob@example.com'],
    ['no one', { kind: 'none', user: null } as LocalIdentity, 'Preview as: Signed out']
  ])('says the preview signs in as %s', async (_who, identity, name) => {
    installApi(identity)
    renderMenu()
    expect(await screen.findByRole('button', { name })).toBeTruthy()
  })

  it('lists you, the test users and signed out, with the current one checked', async () => {
    const { local } = installApi({ kind: 'developer', user: entra })
    renderMenu()
    await screen.findByRole('button', { name: 'Preview as: You' })
    expect(screen.getByLabelText('preview').textContent).toBe('shown')

    const menu = await openMenu()
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByLabelText('preview').textContent, 'the menu covers the preview').toBe(
      'hidden'
    )
    await waitFor(() => expect(option('bob@example.com')).toBeTruthy())
    expect(local.users).toHaveBeenCalledWith('p1')
    // Your Entra account is you, not a test user.
    expect(
      within(menu)
        .getAllByRole('menuitemradio')
        .map((item) => item.getAttribute('aria-label'))
    ).toEqual(['You', 'bob@example.com', 'carol@example.com', 'Signed out'])
    expect(within(menu).getByRole('group', { name: 'Test users' })).toBeTruthy()
    expect(option('You').getAttribute('aria-checked')).toBe('true')
    expect(option('bob@example.com').getAttribute('aria-checked')).toBe('false')
    expect(option('You').getAttribute('aria-describedby')).toBeTruthy()
    expect(screen.getByText('ana@contoso.com · Microsoft Entra ID')).toBeTruthy()
    expect(addItem()).toBeTruthy()
    expect(document.activeElement, 'focus starts on the current identity').toBe(option('You'))
  })

  it('shows the local developer account when Microsoft Entra isn’t used', async () => {
    installApi({ kind: 'developer', user: localDeveloper }, [localDeveloper, bob])
    renderMenu()
    await screen.findByRole('button', { name: 'Preview as: You' })
    await openMenu()
    expect(await screen.findByText('developer@example.com · local account')).toBeTruthy()
  })

  it('checks the test user it signs in as, before that user exists', async () => {
    localBackendStore.accept(status({ signInAs: 'user:dana@example.com' }))
    installApi({ kind: 'user', user: null })
    renderMenu()
    expect(await screen.findByRole('button', { name: 'Preview as: dana@example.com' })).toBeTruthy()
    await openMenu()
    await waitFor(() =>
      expect(option('dana@example.com').getAttribute('aria-checked')).toBe('true')
    )
    expect(option('bob@example.com').getAttribute('aria-checked')).toBe('false')
  })

  it('switches to a test user, then clears and reloads the preview', async () => {
    const { local, preview } = installApi({ kind: 'developer', user: entra })
    const answer = deferred<LocalIdentity>()
    local.setIdentity.mockReturnValueOnce(answer.promise)
    const { onSwitched } = renderMenu()
    await screen.findByRole('button', { name: 'Preview as: You' })
    await openMenu()
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'bob@example.com' }))

    expect(local.setIdentity).toHaveBeenCalledWith('p1', { kind: 'user', user: 'bob@example.com' })
    expect(screen.getByText('Signing in as bob@example.com…').getAttribute('role')).toBe('status')
    expect(trigger().getAttribute('aria-busy')).toBe('true')
    expect(option('You').getAttribute('aria-disabled')).toBe('true')
    expect(preview.resetSiteData).not.toHaveBeenCalled()

    await act(async () => answer.resolve({ kind: 'user', user: bob }))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(preview.resetSiteData).toHaveBeenCalledTimes(1)
    expect(local.setIdentity.mock.invocationCallOrder[0]).toBeLessThan(
      preview.resetSiteData.mock.invocationCallOrder[0]
    )
    expect(onSwitched).toHaveBeenCalledTimes(1)
    expect(trigger().getAttribute('aria-label')).toBe('Preview as: bob@example.com')
    expect(trigger().getAttribute('aria-busy')).toBeNull()
    expect(document.activeElement).toBe(trigger())
    expect(screen.getByLabelText('preview').textContent).toBe('shown')
  })

  it('switches to signed out and back to you', async () => {
    const { local, preview } = installApi({ kind: 'developer', user: entra })
    renderMenu()
    await screen.findByRole('button', { name: 'Preview as: You' })
    await openMenu()
    fireEvent.click(option('Signed out'))
    await screen.findByRole('button', { name: 'Preview as: Signed out' })
    expect(local.setIdentity).toHaveBeenLastCalledWith('p1', { kind: 'none' })

    await openMenu()
    expect(option('Signed out').getAttribute('aria-checked')).toBe('true')
    fireEvent.click(option('You'))
    await screen.findByRole('button', { name: 'Preview as: You' })
    expect(local.setIdentity).toHaveBeenLastCalledWith('p1', { kind: 'developer' })
    expect(preview.resetSiteData).toHaveBeenCalledTimes(2)
  })

  it('only closes the menu when the current identity is picked again', async () => {
    const { local, preview } = installApi({ kind: 'developer', user: entra })
    renderMenu()
    await screen.findByRole('button', { name: 'Preview as: You' })
    await openMenu()
    fireEvent.click(option('You'))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(local.setIdentity).not.toHaveBeenCalled()
    expect(preview.resetSiteData).not.toHaveBeenCalled()
  })

  it('reports a failed switch inline, with the backend’s message and hint', async () => {
    const { local, preview } = installApi({ kind: 'developer', user: entra })
    local.setIdentity.mockRejectedValueOnce(
      new LocalBackendError({
        code: 'not-running',
        message: 'The local backend is still starting.',
        hint: 'Try again once it’s running.'
      })
    )
    const { onSwitched } = renderMenu()
    await screen.findByRole('button', { name: 'Preview as: You' })
    await openMenu()
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'carol@example.com' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('The local backend is still starting.')
    expect(alert.textContent).toContain('Try again once it’s running.')
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(preview.resetSiteData).not.toHaveBeenCalled()
    expect(onSwitched).not.toHaveBeenCalled()
    expect(trigger().getAttribute('aria-label')).toBe('Preview as: You')
    expect(option('You').getAttribute('aria-checked')).toBe('true')
  })

  it('says to reload when the preview couldn’t be reset after a switch', async () => {
    const { preview } = installApi({ kind: 'developer', user: entra })
    // The Rust command rejects with its message.
    preview.resetSiteData.mockRejectedValueOnce('The preview didn’t answer, so it wasn’t reloaded.')
    const { onSwitched } = renderMenu()
    await screen.findByRole('button', { name: 'Preview as: You' })
    await openMenu()
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'bob@example.com' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('The preview didn’t answer, so it wasn’t reloaded.')
    expect(alert.textContent).toContain('Reload the preview to see the app as bob@example.com.')
    // The backend switched all the same.
    expect(trigger().getAttribute('aria-label')).toBe('Preview as: bob@example.com')
    expect(onSwitched).not.toHaveBeenCalled()
  })

  it('adds a test user by email after checking it, and switches to it', async () => {
    const { local, preview } = installApi({ kind: 'developer', user: entra })
    const { onSwitched } = renderMenu()
    await screen.findByRole('button', { name: 'Preview as: You' })
    await openMenu()
    await screen.findByRole('menuitemradio', { name: 'bob@example.com' })
    fireEvent.click(addItem())
    expect(addItem().getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(emailField())

    const add = screen.getByRole('button', { name: 'Add' })
    const tryEmail = (value: string): string | null => {
      fireEvent.change(emailField(), { target: { value } })
      fireEvent.click(add)
      return emailField().getAttribute('aria-invalid') === 'true'
        ? (document.getElementById(emailField().getAttribute('aria-describedby') ?? '')
            ?.textContent ?? null)
        : null
    }
    expect(tryEmail('   ')).toBe('Enter an email address.')
    expect(tryEmail('dana')).toBe('Enter an email address, like ana@example.com.')
    expect(tryEmail('BOB@example.com')).toBe('bob@example.com is already a test user.')
    expect(tryEmail('ana@contoso.com')).toBe('That’s your own account. Choose You instead.')
    expect(local.setIdentity).not.toHaveBeenCalled()

    fireEvent.change(emailField(), { target: { value: ' dana@example.com ' } })
    expect(emailField().getAttribute('aria-invalid'), 'typing clears the problem').toBeNull()
    fireEvent.submit(emailField().form as HTMLFormElement)
    expect(local.setIdentity).toHaveBeenCalledWith('p1', {
      kind: 'user',
      user: 'dana@example.com',
      create: true
    })
    await screen.findByRole('button', { name: 'Preview as: dana@example.com' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(preview.resetSiteData).toHaveBeenCalledTimes(1)
    expect(onSwitched).toHaveBeenCalledTimes(1)

    await openMenu()
    expect(option('dana@example.com').getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByLabelText('Test user’s email'), 'the form starts closed').toBeNull()
  })

  it('moves with the arrow keys, and Escape and Tab leave', async () => {
    installApi({ kind: 'developer', user: entra })
    renderMenu()
    await screen.findByRole('button', { name: 'Preview as: You' })
    await openMenu()
    await screen.findByRole('menuitemradio', { name: 'bob@example.com' })
    expect(document.activeElement).toBe(option('You'))
    fireEvent.keyDown(option('You'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(option('bob@example.com'))
    fireEvent.keyDown(option('bob@example.com'), { key: 'End' })
    expect(document.activeElement).toBe(addItem())
    fireEvent.keyDown(addItem(), { key: 'ArrowDown' })
    expect(document.activeElement, 'it wraps around').toBe(option('You'))

    // Escape closes the add form first, then the menu.
    fireEvent.click(addItem())
    fireEvent.keyDown(emailField(), { key: 'Escape' })
    expect(screen.queryByLabelText('Test user’s email')).toBeNull()
    expect(document.activeElement).toBe(addItem())
    fireEvent.keyDown(addItem(), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger())

    // ArrowDown on the button opens the menu, Tab leaves it from the button.
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' })
    expect(screen.getByRole('menu')).toBeTruthy()
    await frame()
    fireEvent.keyDown(option('You'), { key: 'Tab' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger())

    // So does a press anywhere else.
    await openMenu()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Elsewhere' }))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('stays shut while disabled, and closes when it becomes disabled', async () => {
    installApi({ kind: 'user', user: bob })
    const { rerender } = renderMenu({ disabled: true })
    // It still says who the preview signs in as.
    expect(await screen.findByRole('button', { name: 'Preview as: bob@example.com' })).toBeTruthy()
    expect(trigger().disabled).toBe(true)
    fireEvent.click(trigger())
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' })
    expect(screen.queryByRole('menu')).toBeNull()

    rerender({ disabled: false })
    await openMenu()
    rerender({ disabled: true })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger().disabled).toBe(true)
    expect(screen.getByLabelText('preview').textContent).toBe('shown')
  })
})
