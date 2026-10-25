import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { AppSettings, AppVersions } from '@shared/ipc'
import SettingsModal from './SettingsModal'

/** Install the minimal `window.api` surface SettingsModal touches. */
function installApi(exportImpl?: () => Promise<string>): {
  export: ReturnType<typeof vi.fn>
  openLogs: ReturnType<typeof vi.fn>
  openExternal: ReturnType<typeof vi.fn>
} {
  const exportFn = vi.fn(exportImpl ?? (() => Promise.resolve('C:/logs/bundle.md')))
  const openLogs = vi.fn(() => Promise.resolve('C:/logs'))
  const openExternal = vi.fn(() => Promise.resolve())
  ;(window as unknown as { api: unknown }).api = {
    projects: {
      state: vi.fn(() =>
        Promise.resolve({ workspaceRoot: 'C:/ws', activeProjectId: null, projects: [] })
      )
    },
    diagnostics: { export: exportFn },
    openLogs,
    openExternal
  }
  return { export: exportFn, openLogs, openExternal }
}

const settings: AppSettings = { theme: 'system' }

/** The Full-diagnostics checkbox, resolved via its wrapping ToggleRow label. */
function fullDiagnosticsCheckbox(): HTMLInputElement {
  const label = screen.getByText('Full diagnostics').closest('label')
  if (!label) throw new Error('Full diagnostics label not found')
  const cb = label.querySelector('input[type="checkbox"]') as HTMLInputElement | null
  if (!cb) throw new Error('Full diagnostics checkbox not found')
  return cb
}

async function renderModal(over: Partial<Parameters<typeof SettingsModal>[0]> = {}): Promise<{
  onChange: ReturnType<typeof vi.fn>
}> {
  const onChange = vi.fn()
  await act(async () => {
    render(
      <SettingsModal
        settings={settings}
        versions={null}
        onChange={onChange}
        onClose={() => {}}
        {...over}
      />
    )
  })
  return { onChange }
}

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('SettingsModal accounts and setup', () => {
  it('opens Accounts and setup when the workbench offers them', async () => {
    installApi()
    const onManageAccounts = vi.fn()
    const onReviewSetup = vi.fn()
    await renderModal({ onManageAccounts, onReviewSetup })
    fireEvent.click(screen.getByRole('button', { name: 'Manage accounts' }))
    expect(onManageAccounts).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Open setup' }))
    expect(onReviewSetup).toHaveBeenCalledTimes(1)
  })

  it('hides them otherwise', async () => {
    installApi()
    await renderModal()
    expect(screen.queryByRole('button', { name: 'Manage accounts' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open setup' })).toBeNull()
  })
})

describe('SettingsModal diagnostics', () => {
  it('renders the Full diagnostics toggle plus Export and Open-logs buttons', async () => {
    installApi()
    await renderModal()
    expect(screen.getByText('Full diagnostics')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Export diagnostics' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open logs folder' })).toBeTruthy()
  })

  it('reflects the persisted fullDiagnostics flag', async () => {
    installApi()
    await renderModal({ settings: { theme: 'system', fullDiagnostics: true } })
    expect(fullDiagnosticsCheckbox().checked).toBe(true)
  })

  it('is off by default (metadata-only capture)', async () => {
    installApi()
    await renderModal()
    expect(fullDiagnosticsCheckbox().checked).toBe(false)
  })

  it('persists a fullDiagnostics change via onChange', async () => {
    installApi()
    const { onChange } = await renderModal()
    fireEvent.click(fullDiagnosticsCheckbox())
    expect(onChange).toHaveBeenCalledWith({ fullDiagnostics: true })
  })

  it('exports diagnostics when the Export button is clicked', async () => {
    const api = installApi()
    await renderModal()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export diagnostics' }))
    })
    expect(api.export).toHaveBeenCalledTimes(1)
  })

  it('never surfaces an error when diagnostics export fails', async () => {
    const api = installApi(() => Promise.reject(new Error('disk full')))
    await renderModal()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export diagnostics' }))
    })
    // The rejection is swallowed inside the handler; the button re-enables.
    expect(api.export).toHaveBeenCalledTimes(1)
    expect(
      (screen.getByRole('button', { name: 'Export diagnostics' }) as HTMLButtonElement).disabled
    ).toBe(false)
  })
})

describe('SettingsModal help links', () => {
  it('opens the docs and the troubleshooting guide in the browser', async () => {
    const api = installApi()
    await renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Documentation' }))
    fireEvent.click(screen.getByRole('button', { name: 'Troubleshooting' }))
    expect(api.openExternal.mock.calls).toEqual([
      ['https://spatney.github.io/rayfin-fabricator/docs'],
      ['https://spatney.github.io/rayfin-fabricator/docs/troubleshooting']
    ])
  })
})

describe('SettingsModal team workspaces experiment', () => {
  function teamCheckbox(): HTMLInputElement {
    fireEvent.click(screen.getByRole('button', { name: /Experiments/ }))
    const label = screen.getByText('Team workspaces').closest('label')
    if (!label) throw new Error('Team workspaces label not found')
    return label.querySelector('input[type="checkbox"]') as HTMLInputElement
  }

  it('is off by default and turns on through the experiment flags', async () => {
    installApi()
    const { onChange } = await renderModal()
    const checkbox = teamCheckbox()
    expect(checkbox.checked).toBe(false)
    fireEvent.click(checkbox)
    expect(onChange).toHaveBeenCalledWith({ experiments: { teamWorkspaces: true } })
  })

  it('reflects the persisted flag', async () => {
    installApi()
    await renderModal({ settings: { theme: 'system', experiments: { teamWorkspaces: true } } })
    expect(teamCheckbox().checked).toBe(true)
  })
})

describe('SettingsModal retired controls', () => {
  it.each([false, true])('does not show retired controls with legacy flags set to %s', async (enabled) => {
    installApi()
    const legacySettings = {
      ...settings,
      experiments: {
        compatibilityRendering: enabled,
        chatModeSelector: enabled,
        localDevPreview: enabled,
        manualDeploy: enabled,
        byok: enabled,
        teamWorkspaces: true
      }
    }
    await renderModal({ settings: legacySettings })
    fireEvent.click(screen.getByRole('button', { name: /Experiments/ }))

    for (const label of [
      'Compatibility rendering',
      'Chat mode selector',
      'Live local preview',
      'Deploy manually',
      'Your own API keys',
      'Performance',
      'Ray',
      'Check for updates'
    ]) {
      expect(screen.queryByText(label)).toBeNull()
    }
    expect(screen.queryByRole('dialog', { name: 'Restart required' })).toBeNull()
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
    expect(screen.getByText('Team workspaces')).toBeTruthy()
    expect(screen.getByText('Full diagnostics')).toBeTruthy()
  })
})

describe('SettingsModal API keys', () => {
  it('opens Model providers in Accounts, with no experiment to turn on first', async () => {
    installApi()
    const onManageKeys = vi.fn()
    await renderModal({ onManageKeys })
    fireEvent.click(screen.getByRole('button', { name: 'Manage API keys' }))
    expect(onManageKeys).toHaveBeenCalledOnce()
  })
})

describe('SettingsModal About', () => {
  const versions: AppVersions = {
    app: '1.18.0',
    tauri: '2.12.3',
    webview2: '155.0.4283.45',
    copilot: '1.0.98',
    copilotBundled: '1.0.96'
  }
  const originalClipboard = (navigator as unknown as { clipboard?: unknown }).clipboard

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true })
  })

  it('lists the versions and copies them for a bug report', async () => {
    installApi()
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await renderModal({ versions })
    const about = screen.getByRole('region', { name: 'About' })
    expect(within(about).getByText('Version 1.18.0')).toBeTruthy()
    expect(within(about).getByText('1.0.98 (bundled 1.0.96)')).toBeTruthy()

    await act(async () => {
      fireEvent.click(within(about).getByRole('button', { name: 'Copy version info' }))
    })
    expect(writeText).toHaveBeenCalledWith(
      'Fabricator 1.18.0\nTauri 2.12.3\nWebView2 155.0.4283.45\nCopilot CLI 1.0.98 (bundled 1.0.96)'
    )
    expect(within(about).getByText('Copied')).toBeTruthy()
  })

  it('lists no versions until they load', async () => {
    installApi()
    await renderModal()
    const about = screen.getByRole('region', { name: 'About' })
    expect(within(about).queryByRole('button', { name: 'Copy version info' })).toBeNull()
    expect(within(about).getByRole('button', { name: 'Documentation' })).toBeTruthy()
  })
})
