import { describe, expect, it } from 'vitest'
import type { AppVersions } from '@shared/ipc'
import { formatCopilotCli } from './copilotVersion'

const base: AppVersions = {
  app: '1.0.0',
  tauri: '2.0.0',
  webview2: '120.0.0',
  copilot: '1.0.74-0'
}

describe('formatCopilotCli', () => {
  it('shows both running and bundled when they differ', () => {
    expect(formatCopilotCli({ ...base, copilotBundled: '1.0.71' })).toBe('1.0.74-0 (bundled 1.0.71)')
  })

  it('shows only the running version when bundled matches', () => {
    expect(formatCopilotCli({ ...base, copilotBundled: '1.0.74-0' })).toBe('1.0.74-0')
  })

  it('shows only the running version when bundled is absent', () => {
    expect(formatCopilotCli(base)).toBe('1.0.74-0')
    expect(formatCopilotCli({ ...base, copilotBundled: null })).toBe('1.0.74-0')
  })

  it('degrades to "unknown" when the running version is missing', () => {
    expect(formatCopilotCli({ ...base, copilot: null })).toBe('unknown')
    expect(formatCopilotCli({ ...base, copilot: null, copilotBundled: '1.0.71' })).toBe('unknown')
    expect(formatCopilotCli(null)).toBe('unknown')
    expect(formatCopilotCli(undefined)).toBe('unknown')
  })
})
