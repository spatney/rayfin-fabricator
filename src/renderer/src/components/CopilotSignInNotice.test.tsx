import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ProcLogEvent, ProcResult } from '@shared/ipc'
import CopilotSignInNotice from './CopilotSignInNotice'

const unsubscribe = vi.fn()
const login = vi.fn<() => Promise<ProcResult>>()
const onProcLog = vi.fn<(listener: (event: ProcLogEvent) => void) => () => void>(() => unsubscribe)

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('api', { auth: { loginCopilot: login }, onProcLog })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('in-chat Copilot sign-in', () => {
  it('surfaces returned failures and unsubscribes from process output', async () => {
    login.mockResolvedValue({ ok: false, exitCode: 1, error: 'Login was denied' })
    const signedIn = vi.fn()
    render(<CopilotSignInNotice onSignedIn={signedIn} />)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Copilot' }))
    await screen.findByText('Login was denied')
    expect(signedIn).not.toHaveBeenCalled()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('shows device-code instructions only from this sign-in, then verifies completion', async () => {
    let finish!: (result: ProcResult) => void
    login.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const signedIn = vi.fn()
    render(<CopilotSignInNotice onSignedIn={signedIn} />)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Copilot' }))
    const listener = onProcLog.mock.calls[0][0]
    act(() => {
      listener({ channel: 'login:copilot', stream: 'stdout', data: 'Enter ABCD-EFGH at github.com/login/device' })
      listener({ channel: 'login:az', stream: 'stdout', data: 'Unrelated Azure output' })
    })
    expect(screen.getByText(/ABCD-EFGH/)).toBeTruthy()
    expect(screen.queryByText('Unrelated Azure output')).toBeNull()
    expect((screen.getByRole('button', { name: 'Signing in to Copilot...' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => finish({ ok: true, exitCode: 0 }))
    expect(signedIn).toHaveBeenCalledOnce()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('shows rejected IPC failures and permits another attempt', async () => {
    login.mockRejectedValue(new Error('Could not start the bundled CLI'))
    render(<CopilotSignInNotice onSignedIn={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Copilot' }))
    await waitFor(() => expect(screen.getByText('Could not start the bundled CLI')).toBeTruthy())
    expect((screen.getByRole('button', { name: 'Sign in to Copilot' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
