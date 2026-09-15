import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AuthStatus, DoctorReport, ProcResult, ToolStatus } from '@shared/ipc'
import SetupScreen from './SetupScreen'

function tool(overrides: Partial<ToolStatus>): ToolStatus {
  return {
    id: 'node',
    name: 'Node.js',
    found: true,
    satisfied: true,
    version: 'v20.0.0',
    installHint: '',
    autoInstallable: false,
    required: true,
    ...overrides
  }
}

const doctor: DoctorReport = {
  ready: true,
  tools: [
    tool({ id: 'node', name: 'Node.js' }),
    tool({ id: 'npm', name: 'npm' }),
    tool({ id: 'git', name: 'Git' }),
    tool({ id: 'az', name: 'Azure CLI' })
  ]
}

const auth: AuthStatus = {
  copilot: { signedIn: false },
  rayfin: { signedIn: false },
  az: { signedIn: false }
}

beforeEach(() => {
  localStorage.clear()
  ;(window as unknown as { api: unknown }).api = {
    onProcLog: vi.fn(() => () => {}),
    doctor: {
      install: vi.fn(),
      installAll: vi.fn()
    },
    auth: {
      loginCopilot: vi.fn(),
      loginAz: vi.fn(),
      logoutCopilot: vi.fn(),
      logoutAz: vi.fn()
    },
    relaunch: vi.fn()
  }
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  delete (window as unknown as { api?: unknown }).api
})

describe('SetupScreen sign-in providers', () => {
  it('passes the selected Enterprise host to Copilot sign-in', async () => {
    vi.mocked(window.api.auth.loginCopilot).mockResolvedValue({ ok: true, exitCode: 0 })
    const refresh = vi.fn()
    render(<SetupScreen doctor={doctor} auth={auth} refreshing={false} onRefresh={refresh} onEnter={() => {}} />)
    expect((screen.getByLabelText('GitHub host') as HTMLInputElement).value).toBe('github.com')
    fireEvent.change(screen.getByLabelText('GitHub host'), { target: { value: 'https://company.ghe.com' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Sign in' })[0])
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
    expect(window.api.auth.loginCopilot).toHaveBeenCalledWith('https://company.ghe.com')
  })

  it.each([
    ['GitHub Copilot', 'logoutCopilot', 'copilot'],
    ['Azure CLI', 'logoutAz', 'az']
  ] as const)('signs out of %s and refreshes readiness without signing out the other provider', async (name, method, provider) => {
    const ready: AuthStatus = {
      ...auth,
      copilot: { signedIn: true, user: 'enterprise-user', host: 'https://company.ghe.com' },
      az: { signedIn: true, user: 'azure-user' }
    }
    vi.mocked(window.api.auth[method]).mockResolvedValue({ ok: true, exitCode: 0 })
    const refresh = vi.fn()
    const props = { doctor, refreshing: false, onRefresh: refresh, onEnter: vi.fn() }
    const { rerender } = render(<SetupScreen {...props} auth={ready} />)
    fireEvent.click(screen.getByRole('button', { name: `Sign out of ${name}` }))
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
    expect(window.api.auth[method]).toHaveBeenCalledOnce()
    expect(window.api.auth[method === 'logoutCopilot' ? 'logoutAz' : 'logoutCopilot']).not.toHaveBeenCalled()
    rerender(<SetupScreen {...props} auth={{ ...ready, [provider]: { signedIn: false } }} />)
    expect(screen.queryByRole('button', { name: `Sign out of ${name}` })).toBeNull()
    expect(screen.getAllByText('Connected')).toHaveLength(1)
    expect((screen.getByRole('button', { name: /Enter Fabricator/ }) as HTMLButtonElement).disabled).toBe(true)
    if (provider === 'copilot') {
      expect((screen.getByLabelText('GitHub host') as HTMLInputElement).value).toBe('https://company.ghe.com')
    }
  })

  it('serializes sign-out and keeps account actions and entry disabled through the re-check', async () => {
    let finishLogout!: (result: ProcResult) => void
    let finishRefresh!: () => void
    vi.mocked(window.api.auth.logoutCopilot).mockReturnValue(new Promise((resolve) => { finishLogout = resolve }))
    const refresh = vi.fn(() => new Promise<void>((resolve) => { finishRefresh = resolve }))
    const ready = { ...auth, copilot: { signedIn: true }, az: { signedIn: true } }
    const enter = vi.fn()
    render(<SetupScreen doctor={doctor} auth={ready} refreshing={false} onRefresh={refresh} onEnter={enter} />)
    const signOut = screen.getByRole('button', { name: 'Sign out of GitHub Copilot' }) as HTMLButtonElement
    fireEvent.click(signOut)
    fireEvent.click(signOut)
    expect(window.api.auth.logoutCopilot).toHaveBeenCalledOnce()
    expect(signOut.disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Sign out of Azure CLI' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByText('All checks passed')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Enter Fabricator/ }))
    expect(enter).not.toHaveBeenCalled()
    await act(async () => finishLogout({ ok: true, exitCode: 0 }))
    expect(refresh).toHaveBeenCalledOnce()
    expect(signOut.disabled).toBe(true)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await act(async () => finishRefresh())
    expect(signOut.disabled).toBe(false)
  })

  it.each([
    ['GitHub Copilot', 'logoutCopilot'],
    ['Azure CLI', 'logoutAz']
  ] as const)('surfaces %s sign-out failures and leaves the account retryable', async (name, method) => {
    const ready = { ...auth, copilot: { signedIn: true }, az: { signedIn: true } }
    vi.mocked(window.api.auth[method]).mockResolvedValue({ ok: false, exitCode: 1, error: 'Could not remove credentials' })
    const refresh = vi.fn()
    render(<SetupScreen doctor={doctor} auth={ready} refreshing={false} onRefresh={refresh} onEnter={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: `Sign out of ${name}` }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Could not remove credentials'))
    expect(refresh).toHaveBeenCalledOnce()
    expect((screen.getByRole('button', { name: `Sign out of ${name}` }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getAllByText('Connected')).toHaveLength(2)
    expect(screen.queryByText('All checks passed')).toBeNull()
  })

  it('surfaces rejected sign-out calls and refreshes the account status', async () => {
    vi.mocked(window.api.auth.logoutCopilot).mockRejectedValue(new Error('IPC unavailable'))
    const refresh = vi.fn()
    render(<SetupScreen doctor={doctor} auth={{ ...auth, copilot: { signedIn: true } }}
      refreshing={false} onRefresh={refresh} onEnter={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Sign out of GitHub Copilot' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('IPC unavailable'))
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('does not allow entry using stale connected accounts when post-logout verification rejects', async () => {
    vi.mocked(window.api.auth.logoutCopilot).mockResolvedValue({ ok: true, exitCode: 0 })
    const ready = { ...auth, copilot: { signedIn: true }, az: { signedIn: true } }
    render(<SetupScreen doctor={doctor} auth={ready} refreshing={false}
      onRefresh={() => Promise.reject(new Error('Connection lost'))} onEnter={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Sign out of GitHub Copilot' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Could not verify account status'))
    expect((screen.getByRole('button', { name: /Enter Fabricator/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByText('All checks passed')).toBeNull()
  })

  it('offers re-check rather than reinstall when an existing CLI cannot be verified', async () => {
    const error = 'Azure CLI was found, but its version check failed.'
    const report: DoctorReport = {
      ready: false,
      tools: doctor.tools.map((item) => item.id === 'az'
        ? { ...item, found: true, satisfied: false, version: null, autoInstallable: true, checkError: error }
        : item)
    }
    const refresh = vi.fn()
    render(<SetupScreen doctor={report} auth={auth} refreshing={false} onRefresh={refresh} onEnter={() => {}} />)
    expect(screen.getByRole('alert').textContent).toBe(error)
    expect(screen.getByText('Resolve the Azure CLI check error first')).toBeTruthy()
    expect(screen.queryByText('Install the Azure CLI first')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Install all' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull()
    expect(screen.queryByText(/null.*update to/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Re-check Azure CLI' }))
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
    expect(window.api.doctor.install).not.toHaveBeenCalled()
    expect(window.api.doctor.installAll).not.toHaveBeenCalled()
  })

  it('does not bulk-install over a failed required tool check', () => {
    const report: DoctorReport = {
      ready: false,
      tools: [
        tool({ id: 'node', name: 'Node.js', found: false, satisfied: false, autoInstallable: true }),
        tool({ id: 'az', name: 'Azure CLI', satisfied: false, autoInstallable: true, checkError: 'Shim failed' })
      ]
    }
    render(<SetupScreen doctor={report} auth={auth} refreshing={false} onRefresh={() => {}} onEnter={() => {}} />)
    expect((screen.getByRole('button', { name: 'Install all' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('still offers an update for a verified but outdated Node installation', () => {
    const report: DoctorReport = {
      ready: false,
      tools: [tool({
        id: 'node', name: 'Node.js', version: '18.20.4', minVersion: '20',
        satisfied: false, autoInstallable: true
      })]
    }
    render(<SetupScreen doctor={report} auth={auth} refreshing={false} onRefresh={() => {}} onEnter={() => {}} />)
    expect(screen.getByRole('button', { name: 'Update' })).toBeTruthy()
    expect(screen.getByText(/18.20.4.*update to 20/)).toBeTruthy()
  })

  it('shows a blocked-install result instead of silently returning to setup', async () => {
    vi.mocked(window.api.doctor.installAll).mockResolvedValue({
      ok: false, exitCode: null, error: 'Resolve the existing CLI check failure first.'
    })
    const report: DoctorReport = {
      ready: false,
      tools: [tool({ id: 'node', name: 'Node.js', found: false, satisfied: false, autoInstallable: true })]
    }
    render(<SetupScreen doctor={report} auth={auth} refreshing={false} onRefresh={() => {}} onEnter={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Install all' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Resolve the existing CLI check failure'))
  })

  it('does not treat a remembered Copilot user as a verified connection', () => {
    render(
      <SetupScreen
        doctor={doctor}
        auth={{ ...auth, copilot: { signedIn: false, user: 'remembered', error: 'Copilot token expired' }, az: { signedIn: true } }}
        refreshing={false}
        onRefresh={() => {}}
        onEnter={() => {}}
      />
    )
    expect(screen.getByText('Copilot token expired')).toBeTruthy()
    expect(screen.queryByText('All checks passed')).toBeNull()
    expect((screen.getByRole('button', { name: /Enter Fabricator/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('blocks entry and removes the all-clear while checks are pending or failed', () => {
    const ready = { ...auth, copilot: { signedIn: true }, az: { signedIn: true } }
    const props = { doctor, auth: ready, onRefresh: vi.fn(), onEnter: vi.fn() }
    const { rerender } = render(<SetupScreen {...props} refreshing={false} />)
    expect(screen.getByText('All checks passed')).toBeTruthy()
    rerender(<SetupScreen {...props} refreshing />)
    expect(screen.queryByText('All checks passed')).toBeNull()
    expect((screen.getByRole('button', { name: /Enter Fabricator/ }) as HTMLButtonElement).disabled).toBe(true)
    rerender(<SetupScreen {...props} refreshing={false} error="Could not check accounts" />)
    expect(screen.getByRole('alert').textContent).toContain('Could not check accounts')
    expect(screen.queryByText('All checks passed')).toBeNull()
  })

  it('surfaces a failed CLI sign-in result instead of silently refreshing', async () => {
    vi.mocked(window.api.auth.loginCopilot).mockResolvedValue({
      ok: false, exitCode: 1, error: 'Credential store is unavailable'
    })
    const refresh = vi.fn()
    render(<SetupScreen doctor={doctor} auth={auth} refreshing={false} onRefresh={refresh} onEnter={() => {}} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Sign in' })[0])
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Credential store is unavailable'))
    expect(refresh).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.queryByText('All checks passed')).toBeNull()
  })

  it('requires the post-login auth check, not merely a zero exit code', async () => {
    vi.mocked(window.api.auth.loginCopilot).mockResolvedValue({ ok: true, exitCode: 0 })
    const refresh = vi.fn()
    render(<SetupScreen doctor={doctor} auth={auth} refreshing={false} onRefresh={refresh} onEnter={() => {}} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Sign in' })[0])
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
    expect((screen.getByRole('button', { name: /Enter Fabricator/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('leaves a retryable screen when post-login verification rejects', async () => {
    vi.mocked(window.api.auth.loginCopilot).mockResolvedValue({ ok: true, exitCode: 0 })
    render(
      <SetupScreen doctor={doctor} auth={auth} refreshing={false}
        onRefresh={() => Promise.reject(new Error('Connection lost'))} onEnter={() => {}} />
    )
    fireEvent.click(screen.getAllByRole('button', { name: 'Sign in' })[0])
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Connection lost'))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('does not show Microsoft Fabric sign-in before a project exists', () => {
    render(
      <SetupScreen
        doctor={doctor}
        auth={auth}
        refreshing={false}
        onRefresh={() => {}}
        onEnter={() => {}}
      />
    )

    expect(screen.getByText('GitHub Copilot')).toBeTruthy()
    expect(screen.getAllByText('Azure CLI').length).toBeGreaterThan(0)
    expect(screen.queryByText('Microsoft Fabric')).toBeNull()
  })
})
