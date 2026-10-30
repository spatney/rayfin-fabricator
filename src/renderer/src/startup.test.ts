import { afterEach, describe, expect, it } from 'vitest'
import type { AuthStatus, DoctorReport, ToolStatus } from '@shared/ipc'
import {
  CHECKING_AUTH,
  failedAuth,
  hasCompletedSetup,
  listText,
  pickAuth,
  rememberSetupComplete,
  setupAttention,
  startupStage
} from './startup'

const tool = (overrides: Partial<ToolStatus>): ToolStatus => ({
  id: 'node',
  name: 'Node.js',
  found: true,
  satisfied: true,
  version: '22.0.0',
  installHint: '',
  autoInstallable: true,
  required: true,
  ...overrides
})

const signedIn: AuthStatus = {
  copilot: { signedIn: true },
  rayfin: { signedIn: true },
  az: { signedIn: true }
}

afterEach(() => localStorage.clear())

describe('setup completion', () => {
  it('is remembered on this computer', () => {
    expect(hasCompletedSetup()).toBe(false)
    rememberSetupComplete()
    expect(hasCompletedSetup()).toBe(true)
  })
})

describe('setupAttention', () => {
  it('reports nothing when the checks pass or are still running', () => {
    expect(setupAttention({ ready: true, tools: [tool({})] }, signedIn, null)).toBeNull()
    expect(setupAttention(null, CHECKING_AUTH, null)).toBeNull()
  })

  it('lists missing required tools and a signed-out Copilot, never Azure, Fabric or optional tools', () => {
    const doctor: DoctorReport = {
      ready: false,
      tools: [
        tool({ name: 'Node.js', satisfied: false }),
        tool({ id: 'gh', name: 'GitHub CLI (gh)', satisfied: false, required: false }),
        tool({ id: 'az', name: 'Azure CLI', found: false, satisfied: false, required: false }),
        tool({ id: 'git', name: 'Git' })
      ]
    }
    const auth: AuthStatus = {
      copilot: { signedIn: false, error: 'Session expired' },
      rayfin: { signedIn: false },
      az: { signedIn: false }
    }
    expect(setupAttention(doctor, auth, null)).toEqual({
      tools: ['Node.js'],
      signIns: ['GitHub Copilot'],
      error: undefined
    })
  })

  it('has nothing to raise when only the optional Azure sign-in is missing', () => {
    const auth: AuthStatus = { ...signedIn, az: { signedIn: false, error: 'Sign-in expired' } }
    expect(setupAttention({ ready: true, tools: [tool({})] }, auth, null)).toBeNull()
  })

  it('reports a tool check that could not run', () => {
    expect(setupAttention(null, signedIn, 'Could not check the installed tools.')).toEqual({
      tools: [],
      signIns: [],
      error: 'Could not check the installed tools.'
    })
  })
})

describe('auth results', () => {
  it('keeps only the providers asked for', () => {
    expect(pickAuth(signedIn, ['az'])).toEqual({ az: { signedIn: true } })
    expect(pickAuth({ copilot: { signedIn: true } }, ['copilot', 'rayfin'])).toEqual({
      copilot: { signedIn: true }
    })
  })

  it('marks failed providers as signed out with the error', () => {
    expect(failedAuth(['copilot', 'az'], 'Offline')).toEqual({
      copilot: { signedIn: false, error: 'Offline' },
      az: { signedIn: false, error: 'Offline' }
    })
  })
})

describe('listText', () => {
  it.each([
    [['a'], 'a'],
    [['a', 'b'], 'a and b'],
    [['a', 'b', 'c'], 'a, b, and c']
  ])('joins %j', (items, text) => {
    expect(listText(items)).toBe(text)
  })
})

describe('startupStage', () => {
  const ready: DoctorReport = { ready: true, tools: [tool({})] }

  it('follows the checks: tools, then the Copilot sign-in, then the outcome', () => {
    expect(startupStage(null, null, false)).toBe('tools')
    expect(startupStage(null, signedIn, false)).toBe('tools')
    expect(startupStage(ready, null, false)).toBe('accounts')
    expect(startupStage(ready, { ...CHECKING_AUTH, rayfin: { signedIn: true } }, false)).toBe('accounts')
    expect(startupStage(ready, signedIn, false)).toBe('ready')
  })

  it('heads to setup when a tool or Copilot is missing, whatever Azure and Fabric say', () => {
    expect(startupStage({ ready: false, tools: [tool({ satisfied: false })] }, signedIn, false)).toBe('setup')
    expect(startupStage(ready, { ...signedIn, copilot: { signedIn: false } }, false)).toBe('setup')
    expect(startupStage(ready, { ...signedIn, az: { signedIn: false } }, false)).toBe('ready')
    expect(
      startupStage(ready, { ...signedIn, az: { signedIn: false, checking: true } }, false)
    ).toBe('ready')
    expect(startupStage(ready, { ...signedIn, rayfin: { signedIn: false } }, false)).toBe('ready')
  })

  it('reports a check that could not run', () => {
    expect(startupStage(null, null, true)).toBe('error')
  })
})
