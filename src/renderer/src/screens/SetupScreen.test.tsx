import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { AuthStatus, DoctorReport, ToolStatus } from '@shared/ipc'
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
  claude: { installed: false, signedIn: false },
  rayfin: { signedIn: false },
  az: { signedIn: false }
}

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = {
    onProcLog: vi.fn(() => () => {}),
    doctor: {
      install: vi.fn(),
      installAll: vi.fn()
    },
    auth: {
      loginCopilot: vi.fn(),
      loginClaude: vi.fn(),
      loginAz: vi.fn()
    },
    relaunch: vi.fn()
  }
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('SetupScreen sign-in providers', () => {
  it('does not show Microsoft Fabric sign-in before a project exists', () => {
    render(
      <SetupScreen
        doctor={doctor}
        auth={auth}
        engine="copilot"
        refreshing={false}
        onRefresh={() => {}}
        onEnter={() => {}}
      />
    )

    expect(screen.getByText('GitHub Copilot')).toBeTruthy()
    expect(screen.getAllByText('Azure CLI').length).toBeGreaterThan(0)
    expect(screen.queryByText('Microsoft Fabric')).toBeNull()
  })

  it('asks for the Claude sign-in instead of Copilot on the Claude engine', () => {
    render(
      <SetupScreen
        doctor={doctor}
        auth={auth}
        engine="claude"
        refreshing={false}
        onRefresh={() => {}}
        onEnter={() => {}}
      />
    )

    expect(screen.getByText('Claude')).toBeTruthy()
    // Only the engine in use is required, so the other one isn't asked for.
    expect(screen.queryByText('GitHub Copilot')).toBeNull()
  })

  it('blocks the Claude sign-in until its CLI is installed', () => {
    const { rerender } = render(
      <SetupScreen
        doctor={doctor}
        auth={auth}
        engine="claude"
        refreshing={false}
        onRefresh={() => {}}
        onEnter={() => {}}
      />
    )
    expect(screen.getByText(/Install the Claude Code CLI first/i)).toBeTruthy()

    rerender(
      <SetupScreen
        doctor={doctor}
        auth={{ ...auth, claude: { installed: true, signedIn: false } }}
        engine="claude"
        refreshing={false}
        onRefresh={() => {}}
        onEnter={() => {}}
      />
    )
    expect(screen.queryByText(/Install the Claude Code CLI first/i)).toBeNull()
  })
})
