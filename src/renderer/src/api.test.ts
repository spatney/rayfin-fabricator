import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { api } from './api'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))

beforeEach(() => vi.clearAllMocks())

describe('authentication IPC', () => {
  it('forwards the selected Copilot host and preserves the default invocation', async () => {
    await api.auth.loginCopilot('https://company.ghe.com')
    expect(invoke).toHaveBeenLastCalledWith('auth_login_copilot', { host: 'https://company.ghe.com' })
    await api.auth.loginCopilot()
    expect(invoke).toHaveBeenLastCalledWith('auth_login_copilot', { host: undefined })
  })

  it('routes each sign-out to its own provider', async () => {
    await api.auth.logoutCopilot()
    expect(invoke).toHaveBeenLastCalledWith('auth_logout_copilot')
    await api.auth.logoutAz()
    expect(invoke).toHaveBeenLastCalledWith('auth_logout_az')
    await api.auth.logoutRayfin()
    expect(invoke).toHaveBeenLastCalledWith('auth_logout_rayfin')
  })
})
