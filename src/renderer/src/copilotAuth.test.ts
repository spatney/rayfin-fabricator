import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getCopilotHost, isCopilotAuthError, signInToCopilot, signOutOfCopilot } from './copilotAuth'
import { invalidateCopilotModels } from './copilotModels'

vi.mock('./copilotModels', () => ({ invalidateCopilotModels: vi.fn() }))

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  vi.stubGlobal('api', {
    auth: { loginCopilot: vi.fn(), logoutCopilot: vi.fn() }
  })
})

afterEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('Copilot account changes', () => {
  it('remembers the selected host only after verified sign-in', async () => {
    expect(getCopilotHost()).toBe('github.com')
    vi.mocked(window.api.auth.loginCopilot).mockResolvedValue({ ok: true, exitCode: 0 })
    await signInToCopilot('company.ghe.com')
    expect(window.api.auth.loginCopilot).toHaveBeenCalledWith('company.ghe.com')
    expect(getCopilotHost()).toBe('company.ghe.com')
    expect(invalidateCopilotModels).toHaveBeenCalledOnce()

    vi.mocked(window.api.auth.loginCopilot).mockResolvedValue({ ok: false, exitCode: 1, error: 'Denied' })
    await signInToCopilot('other.ghe.com')
    expect(getCopilotHost()).toBe('company.ghe.com')
    expect(invalidateCopilotModels).toHaveBeenCalledTimes(2)
  })

  it('invalidates models after successful or partially failed sign-out without forgetting the host', async () => {
    vi.mocked(window.api.auth.loginCopilot).mockResolvedValue({ ok: true, exitCode: 0 })
    await signInToCopilot('company.ghe.com')
    vi.mocked(invalidateCopilotModels).mockClear()
    vi.mocked(window.api.auth.logoutCopilot)
      .mockResolvedValueOnce({ ok: true, exitCode: null })
      .mockResolvedValueOnce({ ok: false, exitCode: null, error: 'Another account is still active' })
    expect((await signOutOfCopilot()).ok).toBe(true)
    expect((await signOutOfCopilot()).ok).toBe(false)
    expect(invalidateCopilotModels).toHaveBeenCalledTimes(2)
    expect(getCopilotHost()).toBe('company.ghe.com')
  })

  it('preserves rejected IPC errors and invalidates stale account models', async () => {
    vi.mocked(window.api.auth.loginCopilot).mockRejectedValue(new Error('Sign-in IPC failed'))
    vi.mocked(window.api.auth.logoutCopilot).mockRejectedValue(new Error('Sign-out IPC failed'))
    await expect(signInToCopilot()).rejects.toThrow('Sign-in IPC failed')
    await expect(signOutOfCopilot()).rejects.toThrow('Sign-out IPC failed')
    expect(invalidateCopilotModels).toHaveBeenCalledTimes(2)
  })
})

describe('Copilot authentication errors', () => {
  it.each([
    'Not logged in',
    'GitHub Copilot is not signed in.',
    'Not authenticated',
    'Execution failed: Error: Session was not created with authentication info or custom provider',
    'Authentication failed',
    '401: Unauthorized',
    'Bad credentials',
    'Token has expired',
    'Invalid authentication token'
  ])('recognizes %s', (message) => {
    expect(isCopilotAuthError(message)).toBe(true)
  })

  it.each([undefined, 'Session not found abc', 'Rate limit exceeded', 'Network timeout', 'File not found'])(
    'does not mistake %s for a sign-in failure',
    (message) => expect(isCopilotAuthError(message)).toBe(false)
  )
})
