import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { PortConflict } from '@shared/ipc'
import { OverlayProvider } from '../overlay'
import PortConflictModal, {
  canUsePort,
  describeHolder,
  hasPortChoice,
  type PortPromptContext
} from './PortConflictModal'

const base: PortConflict = { port: 5173, canStop: false, suggestedPort: 5174, needsPush: true }
const TOY_STORY = 'C:\\Users\\ana\\RayfinProjects\\toy-story'
const projects = [{ name: 'Toy Story', path: TOY_STORY }]

/** What the OS reports for a process: rayfin-local's Vite for Toy Story, or any command. */
function heldBy(commandLine: string, name = 'node.exe'): PortConflict {
  return { ...base, canStop: true, occupant: { pid: 4321, name, commandLine } }
}
const toyStoryPreview = heldBy(
  `"C:\\Program Files\\nodejs\\node.exe" ${TOY_STORY}\\.rayfin-local\\cache\\js\\vite-dev-1\\vite-dev.mjs --root ${TOY_STORY}`
)

function show(
  conflict: PortConflict,
  extra: Partial<Parameters<typeof PortConflictModal>[0]> = {},
  context: PortPromptContext = 'turn'
) {
  const handlers = { onUsePort: vi.fn(), onStop: vi.fn(), onSkip: vi.fn() }
  render(
    <OverlayProvider>
      <PortConflictModal
        conflict={conflict}
        context={context}
        busy={null}
        error={null}
        log={[]}
        {...handlers}
        {...extra}
      />
    </OverlayProvider>
  )
  return handlers
}

const dialogText = (): string => screen.getByRole('dialog').textContent ?? ''

afterEach(cleanup)

describe('PortConflictModal', () => {
  it('says who has the address in plain words, with the process under Technical details', () => {
    show(toyStoryPreview, { projects })
    const dialog = screen.getByRole('dialog', { name: 'Your live preview needs localhost:5173' })
    expect(dialog.textContent).toContain('It’s the address your app’s sign-in accepts.')
    expect(dialog.textContent).toContain('A preview of Toy Story is using it.')
    // Stopping a preview loses nothing, so it's the recommended way out, and has focus.
    const stop = screen.getByRole('button', { name: 'Stop that preview' })
    expect(stop.textContent).toContain('Recommended')
    expect(stop.textContent).toContain('Nothing is lost')
    expect(document.activeElement).toBe(stop)
    const details = dialog.querySelector('details')
    expect(details?.open).toBe(false)
    expect(details?.textContent).toContain('node.exe (PID 4321)')
    expect(details?.textContent).toContain('vite-dev.mjs')
  })

  it('recognizes an earlier preview of the same app, an app it doesn’t know, and a dev server', () => {
    expect(describeHolder(toyStoryPreview, projects, `${TOY_STORY}\\`)).toEqual({
      kind: 'app',
      name: 'Toy Story',
      self: true
    })
    expect(describeHolder(toyStoryPreview)).toEqual({ kind: 'app', name: 'toy-story', self: false })
    expect(describeHolder(heldBy('node C:\\other-app\\node_modules\\vite\\bin\\vite.js'))).toEqual({
      kind: 'dev-server',
      name: 'other-app'
    })
    expect(
      describeHolder(
        heldBy('/usr/local/bin/node /Users/ana/notes/node_modules/.bin/vite --port 5173')
      )
    ).toEqual({
      kind: 'dev-server',
      name: 'notes'
    })
    expect(describeHolder(heldBy('python -m http.server 5173', 'python.exe'))).toEqual({
      kind: 'program',
      name: 'python.exe'
    })
    expect(describeHolder({ ...base, canStop: true, occupant: { pid: 7, name: 'PID 7' } })).toEqual(
      {
        kind: 'unknown'
      }
    )

    show(toyStoryPreview, { projects, projectPath: TOY_STORY })
    expect(dialogText()).toContain('An earlier preview of Toy Story is still running and using it.')
    expect(screen.getByRole('button', { name: 'Stop the earlier preview' })).toBeTruthy()
  })

  it('recommends another address over stopping a program that may hold unsaved work', () => {
    show(heldBy('python -m http.server 5173', 'python.exe'))
    expect(dialogText()).toContain('python.exe, another program on this computer, is using it.')
    const use = screen.getByRole('button', { name: 'Use localhost:5174 instead' })
    expect(use.textContent).toContain('Recommended')
    expect(document.activeElement).toBe(use)
    const stop = screen.getByRole('button', { name: 'Stop python.exe' })
    expect(stop.textContent).toContain('Anything unsaved in python.exe is lost.')
    expect(stop.textContent).not.toContain('Recommended')
    cleanup()

    // Mid-turn, stopping is the only choice left, and it still isn't recommended.
    show(heldBy('python -m http.server 5173', 'python.exe'), {}, 'plan')
    expect(screen.queryByRole('button', { name: 'Use localhost:5174 instead' })).toBeNull()
    expect(dialogText()).not.toContain('Recommended')
  })

  it('names another app in Fabricator, and stops its local backend but never its live preview', () => {
    show({ ...base, holder: { projectId: 'p2', name: 'Lead Tracker', kind: 'preview' } })
    expect(dialogText()).toContain(
      'The live preview of Lead Tracker is using it while Copilot works on that app.'
    )
    expect(screen.queryByRole('button', { name: /^Stop/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Use localhost:5174 instead' })).toBeTruthy()
    cleanup()

    const handlers = show(
      { ...base, holder: { projectId: 'p2', name: 'Lead Tracker', kind: 'backend' } },
      { holderWorking: true }
    )
    expect(dialogText()).toContain(
      'Lead Tracker, another app running on this computer, is using it.'
    )
    const stop = screen.getByRole('button', { name: 'Stop Lead Tracker' })
    expect(stop.textContent).toContain('Copilot is working on Lead Tracker right now.')
    expect(stop.textContent).not.toContain('Recommended')
    expect(screen.queryByText('Technical details')).toBeNull()
    fireEvent.click(stop)
    expect(handlers.onStop).toHaveBeenCalledTimes(1)
  })

  it('explains an unidentified listener and what another address takes', () => {
    show(base)
    expect(dialogText()).toContain('Fabricator can’t tell which')
    expect(
      screen.getByRole('button', { name: 'Use localhost:5174 instead' }).textContent
    ).toContain('Adds it to your app’s sign-in settings and updates them in Fabric.')
  })

  it('only edits rayfin.yml for an app that has no backend yet', () => {
    show({ ...base, needsPush: false })
    expect(dialogText()).toContain('Sign-in accepts it once you publish.')
  })

  it('routes each choice to its action, and skips on Escape', () => {
    const handlers = show(heldBy('python -m http.server 5173', 'python.exe'))
    fireEvent.click(screen.getByRole('button', { name: 'Use localhost:5174 instead' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop python.exe' }))
    fireEvent.click(screen.getByRole('button', { name: 'Skip live preview' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(handlers.onUsePort).toHaveBeenCalledTimes(1)
    expect(handlers.onStop).toHaveBeenCalledTimes(1)
    expect(handlers.onSkip).toHaveBeenCalledTimes(2)
  })

  it('shows the choice that runs, and holds the others until it ends', () => {
    show(toyStoryPreview, { projects, busy: 'register', log: ['Pushing sign-in settings\n'] })
    const running = screen.getByRole('button', { name: 'Updating your sign-in settings…' })
    expect((running as HTMLButtonElement).disabled).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Stop that preview' }) as HTMLButtonElement).disabled
    ).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Skip live preview' }) as HTMLButtonElement).disabled
    ).toBe(true)
    expect(screen.getByLabelText('Port registration log').textContent).toContain(
      'Pushing sign-in settings'
    )
  })

  it('offers a new port mid-turn only when nothing has to be pushed', () => {
    expect(canUsePort(base, 'turn')).toBe(true)
    expect(canUsePort(base, 'plan')).toBe(false)
    expect(canUsePort({ ...base, needsPush: false }, 'plan')).toBe(true)
    expect(canUsePort({ ...base, suggestedPort: undefined }, 'turn')).toBe(false)
    expect(hasPortChoice(base, 'plan')).toBe(false)
    expect(hasPortChoice({ ...base, canStop: true, occupant: { pid: 1, name: 'node' } }, 'plan')).toBe(true)
    const backend = { ...base, holder: { projectId: 'p2', name: 'A', kind: 'backend' as const } }
    expect(hasPortChoice(backend, 'plan')).toBe(true)

    show(base, {}, 'plan')
    expect(screen.queryByRole('button', { name: 'Use localhost:5174 instead' })).toBeNull()
    expect(dialogText()).toContain('can’t happen while Copilot is working')
  })
})
