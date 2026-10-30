import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { LocalSecret, SecretInfo, SecretsState, StudioProject } from '@shared/ipc'
import { OverlayProvider } from '../overlay'
import { LocalDevelopmentContext } from '../localDevelopment'
import SecretsView from './SecretsView'
import { nameProblem, toSecretName } from './secrets/SecretDialog'

const OPENAI: SecretInfo = {
  name: 'OPENAI_KEY',
  description: 'Key for the chat function',
  declared: true,
  stored: true,
  createdAt: '2026-10-01T10:00:00Z',
  updatedAt: '2026-10-02T10:00:00Z'
}
const MISSING: SecretInfo = { name: 'STRIPE_KEY', declared: true, stored: false }
const UNPUBLISHED: SecretInfo = {
  ...OPENAI,
  stored: false,
  createdAt: undefined,
  updatedAt: undefined
}

function ready(secrets: SecretInfo[], extra: Partial<SecretsState> = {}): SecretsState {
  return { status: 'ready', secrets, functionsEnabled: true, rayfinVersion: '1.36.2', ...extra }
}

function unpublished(secrets: SecretInfo[]): SecretsState {
  return { status: 'not-deployed', secrets, functionsEnabled: true, rayfinVersion: '1.36.2' }
}

function value(name: string, source: LocalSecret['source'], declared = true): LocalSecret {
  return { name, declared, description: null, source }
}

/** `local` is what rayfin-local lists, or why it couldn't. */
function installApi(state: SecretsState, local: LocalSecret[] | Error = []) {
  const api = {
    secrets: {
      list: vi.fn(() => Promise.resolve(state)),
      set: vi.fn(() => Promise.resolve({ ok: true })),
      remove: vi.fn(() => Promise.resolve({ ok: true })),
      declare: vi.fn(() => Promise.resolve({ ok: true }))
    },
    local: {
      secrets: vi.fn(() =>
        local instanceof Error ? Promise.reject(local) : Promise.resolve(local)
      ),
      setSecret: vi.fn(() => Promise.resolve()),
      deleteSecret: vi.fn(() => Promise.resolve())
    },
    openExternal: vi.fn(() => Promise.resolve())
  }
  ;(window as unknown as { api: unknown }).api = api
  return api
}

async function renderView(
  props: {
    onChanged?: () => void
    onSendToChat?: (d: string, p: string) => void
    /** The Local development experiment (on unless a test says otherwise). */
    localDevelopment?: boolean
  } = {}
) {
  await act(async () => {
    render(
      <OverlayProvider>
        <LocalDevelopmentContext.Provider value={props.localDevelopment ?? true}>
          <SecretsView
            project={
              { id: 'p1', lastDeploy: { url: 'https://app.example' } } as unknown as StudioProject
            }
            onChanged={props.onChanged ?? (() => {})}
            onSendToChat={props.onSendToChat}
          />
        </LocalDevelopmentContext.Provider>
      </OverlayProvider>
    )
  })
}

async function openDetails(name: string): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${name}`) }))
  return screen.findByRole('complementary', { name: `${name} details` })
}

function row(name: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(`^${name}`) })
}

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('secret names', () => {
  it('turns typed text into UPPER_SNAKE_CASE', () => {
    expect(toSecretName('openai api-key')).toBe('OPENAI_API_KEY')
    expect(toSecretName('my.key!')).toBe('MY_KEY')
    expect(nameProblem('2FA_CODE')).toBe('Start the name with a letter.')
    expect(nameProblem('_X')).not.toBeNull()
    expect(nameProblem('OPENAI_KEY')).toBeNull()
    expect(nameProblem('')).toBeNull()
  })
})

describe('SecretsView', () => {
  it('lists each secret’s value on this computer and on the published app', async () => {
    installApi(ready([OPENAI, MISSING]), [
      value('OPENAI_KEY', 'local'),
      value('STRIPE_KEY', 'none')
    ])
    const onSendToChat = vi.fn()
    await renderView({ onSendToChat })

    await screen.findByRole('region', { name: 'Secrets' })
    expect(row('OPENAI_KEY').textContent).toContain('Local value: Set on this computer')
    expect(row('OPENAI_KEY').textContent).toContain('Published value: Set')
    expect(row('STRIPE_KEY').textContent).toContain('Local value: Not set')
    expect(row('STRIPE_KEY').textContent).toContain('Published value: Not set')

    const details = await openDetails('OPENAI_KEY')
    expect(within(details).getByText('ctx.Secrets.OPENAI_KEY')).toBeTruthy()
    const published = within(details).getByRole('region', { name: 'Published value' })
    expect(within(published).getByText(/^Hidden\./)).toBeTruthy()
    fireEvent.click(within(details).getByRole('button', { name: /Ask Copilot to use it/ }))
    expect(onSendToChat).toHaveBeenCalledTimes(1)
    const [label, prompt] = onSendToChat.mock.calls[0]
    expect(label).toBe('Use secret OPENAI_KEY')
    expect(prompt).toContain('ctx.Secrets.OPENAI_KEY')
    expect(prompt).toContain('Never hard-code its value')
  })

  it('adds a secret before the app is published: its name to rayfin.yml, its value to this computer', async () => {
    const api = installApi(unpublished([]))
    const onChanged = vi.fn()
    await renderView({ onChanged })

    expect(await screen.findByText('No secrets yet')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: /New secret/ })[1])
    const dialog = await screen.findByRole('dialog', { name: 'New secret' })
    fireEvent.change(within(dialog).getByLabelText('Name'), {
      target: { value: 'stripe secret key' }
    })
    expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe(
      'STRIPE_SECRET_KEY'
    )
    const input = within(dialog).getByLabelText('Value') as HTMLInputElement
    expect(input.type).toBe('password')
    fireEvent.change(input, { target: { value: 'sk_live_123' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show value' }))
    expect(input.type).toBe('text')
    fireEvent.change(within(dialog).getByLabelText(/What it’s for/), {
      target: { value: 'Payments' }
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add secret' }))

    await waitFor(() =>
      expect(api.local.setSecret).toHaveBeenCalledWith('p1', 'STRIPE_SECRET_KEY', 'sk_live_123')
    )
    expect(api.secrets.declare).toHaveBeenCalledWith('p1', 'STRIPE_SECRET_KEY', 'Payments')
    expect(api.secrets.set).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(
      await screen.findByText('Added STRIPE_SECRET_KEY, with its value on this computer.')
    ).toBeTruthy()
    expect(onChanged).toHaveBeenCalled()
    await waitFor(() => expect(api.secrets.list).toHaveBeenCalledTimes(2))
    // The value never shows up anywhere on the page afterwards.
    expect(document.body.textContent).not.toContain('sk_live_123')
  })

  it('won’t add a name functions can’t use', async () => {
    const api = installApi(unpublished([]))
    await renderView()

    fireEvent.click((await screen.findAllByRole('button', { name: 'New secret' }))[0])
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: '2fa code' } })
    fireEvent.change(within(dialog).getByLabelText('Value'), { target: { value: 'x' } })
    expect(within(dialog).getByText('Start the name with a letter.')).toBeTruthy()
    const add = within(dialog).getByRole('button', { name: 'Add secret' }) as HTMLButtonElement
    expect(add.disabled).toBe(true)
    expect(api.secrets.declare).not.toHaveBeenCalled()
    expect(api.local.setSecret).not.toHaveBeenCalled()
  })

  it('keeps a secret it added to rayfin.yml when its value can’t be saved', async () => {
    const api = installApi(unpublished([]))
    api.local.setSecret.mockRejectedValueOnce({
      code: 'binary-missing',
      message: 'Fabricator can’t find its local backend.',
      hint: 'Reinstall Fabricator.'
    })
    await renderView()

    fireEvent.click((await screen.findAllByRole('button', { name: 'New secret' }))[0])
    const dialog = await screen.findByRole('dialog', { name: 'New secret' })
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'API_KEY' } })
    fireEvent.change(within(dialog).getByLabelText('Value'), { target: { value: 'abc' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add secret' }))

    const alert = await within(dialog).findByRole('alert')
    expect(alert.textContent).toBe('Fabricator can’t find its local backend. Reinstall Fabricator.')
    expect(api.secrets.declare).toHaveBeenCalledWith('p1', 'API_KEY', undefined)
    expect(api.secrets.list).toHaveBeenCalledTimes(1)
    // Closing shows the secret rayfin.yml has now.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(api.secrets.list).toHaveBeenCalledTimes(2))
  })

  it('sets and removes a value on this computer without a published app', async () => {
    const api = installApi(unpublished([UNPUBLISHED]), [value('OPENAI_KEY', 'none')])
    await renderView()

    // No published values yet, so no column for them.
    await screen.findByRole('region', { name: 'Secrets' })
    expect(row('OPENAI_KEY').textContent).not.toContain('Published value')
    expect(
      screen.getByText('Values for the published app can be set after you publish it.')
    ).toBeTruthy()

    let details = await openDetails('OPENAI_KEY')
    expect(within(details).getByText(/Functions that read it fail/)).toBeTruthy()
    const published = within(details).getByRole('region', { name: 'Published value' })
    expect(within(published).queryByRole('button')).toBeNull()
    fireEvent.click(within(details).getByRole('button', { name: 'Set' }))
    const dialog = await screen.findByRole('dialog', { name: 'Set local value' })
    expect(within(dialog).queryByLabelText('Name')).toBeNull()
    expect(within(dialog).queryByLabelText(/What it’s for/)).toBeNull()
    fireEvent.change(within(dialog).getByLabelText('Value'), { target: { value: 'sk-local' } })
    api.local.secrets.mockResolvedValue([value('OPENAI_KEY', 'local')])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set value' }))

    await waitFor(() =>
      expect(api.local.setSecret).toHaveBeenCalledWith('p1', 'OPENAI_KEY', 'sk-local')
    )
    expect(api.secrets.declare).not.toHaveBeenCalled()
    expect(await screen.findByText('Saved the value of OPENAI_KEY on this computer.')).toBeTruthy()
    await waitFor(() => expect(row('OPENAI_KEY').textContent).toContain('Set on this computer'))
    // Only the published list goes to Fabric, and a local value doesn't change it.
    expect(api.secrets.list).toHaveBeenCalledTimes(1)

    details = screen.getByRole('complementary', { name: 'OPENAI_KEY details' })
    expect(within(details).getByRole('button', { name: 'Change' })).toBeTruthy()
    fireEvent.click(within(details).getByRole('button', { name: 'Remove' }))
    const confirm = await screen.findByRole('dialog', { name: 'Remove local value?' })
    expect(api.local.deleteSecret).not.toHaveBeenCalled()
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(api.local.deleteSecret).toHaveBeenCalledWith('p1', 'OPENAI_KEY'))
    expect(
      await screen.findByText('Removed the value of OPENAI_KEY from this computer.')
    ).toBeTruthy()
  })

  it('removes only values saved on this computer, including ones rayfin.yml doesn’t list', async () => {
    installApi(unpublished([UNPUBLISHED, MISSING]), [
      value('OPENAI_KEY', 'env'),
      value('STRIPE_KEY', 'settings'),
      value('OLD_KEY', 'local', false)
    ])
    await renderView()

    const list = await screen.findByRole('region', { name: 'Secrets' })
    // The ones functions get first.
    const names = within(list)
      .getAllByRole('listitem')
      .map((item) => item.querySelector('.sec-name')?.textContent)
    expect(names).toEqual(['OPENAI_KEY', 'STRIPE_KEY', 'OLD_KEY'])
    expect(row('OPENAI_KEY').textContent).toContain('From your environment')
    expect(row('STRIPE_KEY').textContent).toContain('From local.settings.json')
    expect(row('OLD_KEY').textContent).toContain('Not in rayfin.yml')

    // The environment's value wins, so there's nothing to set or remove here.
    let details = await openDetails('OPENAI_KEY')
    let local = within(details).getByRole('region', { name: 'Local value' })
    expect(within(local).queryByRole('button')).toBeNull()

    details = await openDetails('STRIPE_KEY')
    local = within(details).getByRole('region', { name: 'Local value' })
    expect(within(local).getByRole('button', { name: 'Change' })).toBeTruthy()
    expect(within(local).queryByRole('button', { name: 'Remove' })).toBeNull()

    details = await openDetails('OLD_KEY')
    local = within(details).getByRole('region', { name: 'Local value' })
    expect(within(local).queryByRole('button', { name: /Set|Change/ })).toBeNull()
    fireEvent.click(within(local).getByRole('button', { name: 'Remove' }))
    const confirm = await screen.findByRole('dialog', { name: 'Remove local value?' })
    expect(confirm.textContent).toContain('your app doesn’t use it')
  })

  it('keeps the dialog open with the reason when the published value can’t be saved', async () => {
    const api = installApi(ready([OPENAI]))
    api.secrets.set.mockResolvedValueOnce({
      ok: false,
      error: 'Token expired.',
      signIn: true
    } as never)
    await renderView()

    const details = await openDetails('OPENAI_KEY')
    fireEvent.click(within(details).getByRole('button', { name: /Replace value/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Replace published value' })
    // Replacing keeps the name, and rayfin.yml already describes it.
    expect(within(dialog).queryByLabelText('Name')).toBeNull()
    expect(within(dialog).queryByLabelText(/What it’s for/)).toBeNull()
    fireEvent.change(within(dialog).getByLabelText('Value'), { target: { value: 'sk-new' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace value' }))

    await waitFor(() =>
      expect(api.secrets.set).toHaveBeenCalledWith('p1', 'OPENAI_KEY', 'sk-new', undefined)
    )
    expect(api.local.setSecret).not.toHaveBeenCalled()
    const alert = await within(dialog).findByRole('alert')
    expect(alert.textContent).toContain('Token expired.')
    expect(alert.textContent).toContain('Refresh Fabric authentication')
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('deletes a secret from the published app after confirming', async () => {
    const api = installApi(ready([OPENAI, MISSING]))
    await renderView()

    // A secret without a published value has nothing to delete.
    const missing = await openDetails('STRIPE_KEY')
    expect(within(missing).queryByRole('button', { name: /Delete/ })).toBeNull()
    expect(within(missing).getByRole('button', { name: /Set value/ })).toBeTruthy()

    const details = await openDetails('OPENAI_KEY')
    fireEvent.click(within(details).getByRole('button', { name: /Delete/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete secret?' })
    expect(api.secrets.remove).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.secrets.remove).toHaveBeenCalledWith('p1', 'OPENAI_KEY'))
    expect(await screen.findByText('Deleted OPENAI_KEY from your published app.')).toBeTruthy()
  })

  it('lists the secrets when the published values can’t be read', async () => {
    const api = installApi(
      { ...ready([UNPUBLISHED]), status: 'error', error: 'Fabric said no.', signIn: true },
      [value('OPENAI_KEY', 'local')]
    )
    await renderView()

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(
      'Couldn’t read your published app’s secrets. Fabric said no.'
    )
    expect(alert.textContent).toContain('Refresh Fabric authentication')
    expect(row('OPENAI_KEY').textContent).toContain('Local value: Set on this computer')
    expect(row('OPENAI_KEY').textContent).toContain('Published value: Couldn’t check')
    fireEvent.click(within(alert).getByRole('button', { name: /Try again/ }))
    await waitFor(() => expect(api.secrets.list).toHaveBeenCalledTimes(2))
  })

  it('lists the secrets when the values on this computer can’t be checked', async () => {
    installApi(unpublished([UNPUBLISHED]), new Error('rayfin-local secret list failed.'))
    await renderView()

    expect(
      await screen.findByText(
        'Couldn’t check the values on this computer. rayfin-local secret list failed.'
      )
    ).toBeTruthy()
    expect(row('OPENAI_KEY').textContent).toContain('Local value: Couldn’t check')
    const details = await openDetails('OPENAI_KEY')
    expect(within(details).getByRole('button', { name: 'Set' })).toBeTruthy()
    expect(within(details).queryByRole('button', { name: 'Remove' })).toBeNull()
  })

  it('asks for a newer Rayfin before secrets can be used', async () => {
    installApi({
      status: 'update-rayfin',
      secrets: [],
      functionsEnabled: true,
      rayfinVersion: '1.35.1'
    })
    await renderView()
    expect(await screen.findByText('Update Rayfin to use secrets')).toBeTruthy()
    expect(screen.getByText(/this app uses Rayfin 1.35.1/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'New secret' }) as HTMLButtonElement).disabled).toBe(
      true
    )
  })

  it('shows each deployment of a team app, read-only', async () => {
    const api = installApi({
      status: 'team',
      secrets: [],
      functionsEnabled: true,
      environments: [
        {
          kind: 'published',
          deployed: true,
          portalUrl: 'https://app.fabric.microsoft.com/groups/w/apps/1',
          secrets: [
            {
              name: 'HELLO_WORLD',
              declared: false,
              stored: true,
              updatedAt: '2026-10-05T05:14:53Z'
            }
          ]
        },
        { kind: 'preview', deployed: false, secrets: [] }
      ]
    })
    const onSendToChat = vi.fn()
    await act(async () => {
      render(
        <OverlayProvider>
          <SecretsView
            project={{ id: 'p1', team: { workspaceId: 'w' } } as unknown as StudioProject}
            onChanged={() => {}}
            onSendToChat={onSendToChat}
          />
        </OverlayProvider>
      )
    })

    const published = await screen.findByRole('region', { name: 'Published app' })
    expect(within(published).getByText('Not in rayfin.yml')).toBeTruthy()
    const preview = screen.getByRole('region', { name: 'Your preview' })
    expect(within(preview).getByText(/Not deployed yet/)).toBeTruthy()
    expect((screen.getByRole('button', { name: /New secret/ }) as HTMLButtonElement).disabled).toBe(
      true
    )
    // A team app doesn't run on this computer.
    expect(api.local.secrets).not.toHaveBeenCalled()

    const details = await openDetails('HELLO_WORLD')
    expect(within(details).getByText('Secret · Published app')).toBeTruthy()
    expect(within(details).queryByRole('button', { name: /Replace value/ })).toBeNull()
    expect(within(details).queryByRole('button', { name: /Delete/ })).toBeNull()
    fireEvent.click(within(details).getByRole('button', { name: /Open in Fabric/ }))
    expect(api.openExternal).toHaveBeenCalledWith(
      'https://app.fabric.microsoft.com/groups/w/apps/1'
    )
    fireEvent.click(within(details).getByRole('button', { name: /Ask Copilot to use it/ }))
    expect(onSendToChat.mock.calls[0][1]).toContain("rayfin/rayfin.yml doesn't list it yet")
  })
})

describe('SecretsView without Local development', () => {
  it('shows each secret’s value on the published app alone', async () => {
    const api = installApi(ready([OPENAI, MISSING]))
    await renderView({ localDevelopment: false })

    await screen.findByRole('region', { name: 'Secrets' })
    expect(row('OPENAI_KEY').textContent).toContain('Published value: Set')
    expect(row('STRIPE_KEY').textContent).toContain('Published value: Not set')
    expect(row('OPENAI_KEY').textContent).not.toContain('Local value')
    expect(screen.queryByText('Local value')).toBeNull()
    expect(screen.queryByText('Set on this computer')).toBeNull()
    expect(api.local.secrets).not.toHaveBeenCalled()

    const details = await openDetails('OPENAI_KEY')
    expect(within(details).queryByRole('region', { name: 'Local value' })).toBeNull()
    const published = within(details).getByRole('region', { name: 'Published value' })
    expect(within(published).getByRole('button', { name: /Replace value/ })).toBeTruthy()
  })

  it('waits for the app’s first publish', async () => {
    const api = installApi(unpublished([UNPUBLISHED]))
    await renderView({ localDevelopment: false })

    expect(await screen.findByText('Publish your app first')).toBeTruthy()
    expect(
      screen.getByText(
        'Secrets are stored with your published app, so you can add them once it’s published.'
      )
    ).toBeTruthy()
    expect((screen.getByRole('button', { name: 'New secret' }) as HTMLButtonElement).disabled).toBe(
      true
    )
    expect(api.local.secrets).not.toHaveBeenCalled()
  })

  it('adds a secret with its value on the published app', async () => {
    const api = installApi(ready([]))
    await renderView({ localDevelopment: false })

    expect(await screen.findByText('No secrets yet')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: /New secret/ })[1])
    const dialog = await screen.findByRole('dialog', { name: 'New secret' })
    expect(
      within(dialog).getByText(
        'Sent straight to your published app. Fabricator doesn’t keep it, and nobody can read it back.'
      )
    ).toBeTruthy()
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'API_KEY' } })
    fireEvent.change(within(dialog).getByLabelText('Value'), { target: { value: 'abc' } })
    fireEvent.change(within(dialog).getByLabelText(/What it’s for/), {
      target: { value: 'Payments' }
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add secret' }))

    await waitFor(() =>
      expect(api.secrets.set).toHaveBeenCalledWith('p1', 'API_KEY', 'abc', 'Payments')
    )
    expect(api.secrets.declare).not.toHaveBeenCalled()
    expect(api.local.setSecret).not.toHaveBeenCalled()
    expect(
      await screen.findByText('Added API_KEY. Its value is stored with your published app.')
    ).toBeTruthy()
  })
})
