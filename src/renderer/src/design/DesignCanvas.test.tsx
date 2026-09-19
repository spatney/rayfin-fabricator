import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import DesignCanvas from './DesignCanvas'
import { DesignSession } from './session'
import { newDesignDraft } from './protocol'
import { createDesignHarness, designReceipt, designTransaction } from './testFixtures'
import { makeProject } from '../../test/harness'

vi.mock('../components/PreviewPane', () => ({
  default: () => <div data-testid="native-canvas" />,
  readFabricatorTheme: () => ({ accent: '#357be8', panel: '#ffffff', txt: '#20232a', scale: 1 })
}))

async function fixture(overrides: Partial<ComponentProps<typeof DesignCanvas>> = {}) {
  const h = createDesignHarness()
  const session = new DesignSession('p1', h.api)
  const draft = newDesignDraft('p1', 'direct', 'source-1')
  draft.history = [designTransaction()]
  draft.cursor = 1
  const snapshot = await h.api.connect({
    sessionId: 'connection',
    appUrl: 'https://p1.example.app',
    embedded: false,
    history: draft.history,
    cursor: 1,
    revision: 0
  })
  const command = vi.spyOn(session, 'command').mockResolvedValue(snapshot)
  const props: ComponentProps<typeof DesignCanvas> = {
    project: makeProject('p1'),
    session,
    view: {
      ...session.getSnapshot(),
      draft,
      snapshot,
      ready: true,
      loading: false,
      savedRevision: 0
    },
    localStarting: false,
    copilotAuth: { signedIn: true },
    messages: [],
    onExit: vi.fn(async () => {}),
    onApply: vi.fn(async () => {}),
    onRetryDeployment: vi.fn(async () => {}),
    onStartLocal: vi.fn(async () => {}),
    onCancelApply: vi.fn(async () => {}),
    onAuthChanged: vi.fn(async () => {}),
    onOpenCode: vi.fn(),
    onChooseWorkspace: vi.fn(),
    onAnswerQuestion: vi.fn(async () => {}),
    ...overrides
  }
  const theme = vi.fn(async () => {})
  const login = vi.fn(async (_host?: string) => ({ ok: true, exitCode: 0 }))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      designStudio: h.api,
      preview: { design: { setTheme: theme } },
      auth: { loginCopilot: login },
      onProcLog: vi.fn(() => vi.fn())
    }
  })
  const { rerender } = render(<DesignCanvas {...props} />)
  return { props, command, h, login, rerender }
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  Reflect.deleteProperty(window, 'api')
})

describe('canvas-first Design shell', () => {
  it('renders the app without a permanent inspector, rail, or exposed tool inventory', async () => {
    const { h } = await fixture()
    expect(screen.getByTestId('native-canvas')).toBeTruthy()
    expect(document.querySelector('aside')).toBeNull()
    expect(document.querySelector('.ds-body')).toBeNull()
    expect(screen.queryByText('Layers')).toBeNull()
    expect(screen.queryByText('Assistant')).toBeNull()
    expect(screen.queryByText('Font family')).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Preview source' })).toBeNull()
    expect(h.api.assets).not.toHaveBeenCalled()
    expect(h.api.apply).not.toHaveBeenCalled()
  })

  it('keeps preview configuration secondary', async () => {
    await fixture()
    fireEvent.click(screen.getByRole('button', { name: 'Preview settings' }))
    expect(screen.getByRole('combobox', { name: 'Preview source' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Preview settings' }))
    expect(screen.queryByRole('combobox', { name: 'Preview source' })).toBeNull()
  })

  it('exposes one explicit Apply action without a composer or prompt', async () => {
    const { props } = await fixture()
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Apply changes to app' }))
    await waitFor(() => expect(props.onApply).toHaveBeenCalledTimes(1))
  })

  it('compares only while Before is held, including release and keyboard use', async () => {
    const { command } = await fixture()
    const button = screen.getByRole('button', { name: 'Hold to compare original' })
    button.setPointerCapture = vi.fn()
    fireEvent.pointerDown(button, { pointerId: 1 })
    fireEvent.pointerUp(button, { pointerId: 1 })
    fireEvent.keyDown(button, { key: ' ' })
    fireEvent.keyUp(button, { key: ' ' })
    await waitFor(() => expect(command).toHaveBeenCalledTimes(4))
    expect(command.mock.calls.map(([body]) => body)).toEqual([
      { type: 'compare', enabled: true },
      { type: 'compare', enabled: false },
      { type: 'compare', enabled: true },
      { type: 'compare', enabled: false }
    ])
  })

  it('shows review only on demand and keeps the canvas mounted', async () => {
    await fixture()
    expect(screen.queryByRole('region', { name: 'Design changes and recovery' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '1 change' }))
    expect(screen.getByRole('region', { name: 'Design changes and recovery' })).toBeTruthy()
    expect(screen.getByTestId('native-canvas')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close change details' }))
    expect(screen.queryByRole('region', { name: 'Design changes and recovery' })).toBeNull()
  })

  it('asks for sign-in only when applying, not for ordinary visual editing', async () => {
    const { props } = await fixture({ copilotAuth: { signedIn: false } })
    expect(screen.queryByText('Copilot needs your attention')).toBeNull()
    expect((screen.getByRole('button', { name: 'Edit' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Apply changes to app' }))
    expect(screen.getByText('Copilot needs your attention')).toBeTruthy()
    expect(props.onApply).not.toHaveBeenCalled()
  })

  it('allows Apply after resolving a receipt authentication error without discarding the draft', async () => {
    const { props, h, login, rerender } = await fixture({
      copilotAuth: { signedIn: true, host: 'company.ghe.com' }
    })
    const receipt = designReceipt({
      phase: 'error',
      error: 'Authentication required',
      sourceRevisionAfter: 'source-1',
      filesModified: []
    })
    const failedProps = { ...props, view: { ...props.view, receipt } }
    rerender(<DesignCanvas {...failedProps} />)
    fireEvent.click(screen.getByRole('button', { name: 'Apply changes to app' }))
    expect(props.onApply).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Copilot' }))
    await waitFor(() => expect(screen.queryByText('Copilot needs your attention')).toBeNull())
    expect(props.onAuthChanged).toHaveBeenCalledOnce()
    expect(login).toHaveBeenCalledWith('company.ghe.com')
    fireEvent.click(screen.getByRole('button', { name: 'Apply changes to app' }))
    await waitFor(() => expect(props.onApply).toHaveBeenCalledOnce())
    expect(h.api.clear).not.toHaveBeenCalled()
    expect(failedProps.view.draft?.cursor).toBe(1)
    expect(failedProps.view.receipt.error).toBe('Authentication required')

    rerender(
      <DesignCanvas
        {...failedProps}
        view={{ ...failedProps.view, receipt: { ...receipt, id: 'apply-2', turnId: 'apply-2' } }}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Apply changes to app' }))
    expect(screen.getByText('Copilot needs your attention')).toBeTruthy()
    expect(props.onApply).toHaveBeenCalledOnce()
  })

  it('keeps Apply blocked if refreshing authentication after sign-in fails', async () => {
    const onAuthChanged = vi.fn(async () => {
      throw new Error('Could not refresh Copilot status')
    })
    const { props, rerender } = await fixture({ onAuthChanged })
    rerender(
      <DesignCanvas
        {...props}
        view={{ ...props.view, receipt: designReceipt({ phase: 'error', error: 'Unauthorized' }) }}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Apply changes to app' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Copilot' }))
    await screen.findByText('Could not refresh Copilot status')
    fireEvent.click(screen.getByRole('button', { name: 'Apply changes to app' }))
    expect(props.onApply).not.toHaveBeenCalled()
  })
})
