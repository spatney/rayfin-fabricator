import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { PortConflict } from '@shared/ipc'
import { OverlayProvider } from '../overlay'
import PortConflictModal, { canUsePort, hasPortChoice, type PortPromptContext } from './PortConflictModal'

const base: PortConflict = { port: 5173, canStop: false, suggestedPort: 5174, needsPush: true }

function show(conflict: PortConflict, context: PortPromptContext = 'turn', localOnly = false) {
  const handlers = { onUsePort: vi.fn(), onStop: vi.fn(), onSkip: vi.fn() }
  render(
    <OverlayProvider>
      <PortConflictModal conflict={conflict} context={context} localOnly={localOnly} busy={null} error={null} log={[]} {...handlers} />
    </OverlayProvider>
  )
  return handlers
}

afterEach(cleanup)

describe('PortConflictModal', () => {
  it.each(['turn', 'plan'] as const)('offers a local-only port without registration during %s', (context) => {
    const handlers = show(base, context, true)
    const text = screen.getByRole('dialog').textContent ?? ''
    expect(text).toContain('No configuration is changed and nothing is pushed to Fabric')
    expect(text).toContain('Local sign-in is supported')
    expect(text).not.toContain('adds http://localhost:5174 to rayfin.yml')
    expect(canUsePort(base, context, true)).toBe(true)
    expect(hasPortChoice(base, context, true)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Use port 5174' }))
    expect(handlers.onUsePort).toHaveBeenCalledTimes(1)
  })

  it('names another project in this window instead of offering to stop it', () => {
    show({ ...base, ownProject: 'Lead Tracker' })
    expect(screen.getByRole('dialog').textContent).toContain('Your live preview for Lead Tracker is using it.')
    expect(screen.queryByRole('button', { name: /^Stop/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Use port 5174' })).toBeTruthy()
  })

  it('explains an unidentified listener and the push that registering needs', () => {
    show(base)
    const text = screen.getByRole('dialog').textContent ?? ''
    expect(text).toContain("couldn't tell which one")
    expect(text).toContain('http://localhost:5174')
    expect(text).toContain('pushes your sign-in settings to Fabric')
  })

  it('only edits rayfin.yml for an app that has no backend yet', () => {
    show({ ...base, needsPush: false })
    expect(screen.getByRole('dialog').textContent).toContain('Your next deploy registers it for sign-in.')
  })

  it('routes each button to its action', () => {
    const handlers = show({ ...base, canStop: true, occupant: { pid: 99, name: 'python.exe' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use port 5174' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop python.exe' }))
    fireEvent.click(screen.getByRole('button', { name: 'Skip live preview' }))
    expect(handlers.onUsePort).toHaveBeenCalledTimes(1)
    expect(handlers.onStop).toHaveBeenCalledTimes(1)
    expect(handlers.onSkip).toHaveBeenCalledTimes(1)
  })

  it('offers a new port mid-turn only when nothing has to be pushed', () => {
    expect(canUsePort(base, 'turn')).toBe(true)
    expect(canUsePort(base, 'plan')).toBe(false)
    expect(canUsePort({ ...base, needsPush: false }, 'plan')).toBe(true)
    expect(canUsePort({ ...base, suggestedPort: undefined }, 'turn')).toBe(false)
    expect(hasPortChoice(base, 'plan')).toBe(false)
    expect(hasPortChoice({ ...base, canStop: true, occupant: { pid: 1, name: 'node' } }, 'plan')).toBe(true)
  })
})
