import { readFileSync } from 'fs'
import { resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesignCommand, DesignConnection, DesignSnapshot } from '@shared/design'
import { DesignSession } from './session'
import { assertDesignSnapshot } from './protocol'
import { createDesignHarness } from './testFixtures'

const SCRIPT = readFileSync(resolve(process.cwd(), 'src-tauri', 'src', 'services', 'design_agent.js'), 'utf8')
let session: DesignSession | undefined

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function runtime() {
  const controller: unknown = Reflect.get(window, '__rayfinDesign')
  if (!object(controller) || !object(controller.studio)) throw new Error('Studio controller not installed')
  const studio = controller.studio
  const { connect, peek, command, disconnect } = studio
  if (typeof connect !== 'function' || typeof peek !== 'function' || typeof command !== 'function' || typeof disconnect !== 'function') {
    throw new Error('Studio bridge is incomplete')
  }
  return {
    connect: (options: DesignConnection): unknown => Reflect.apply(connect, studio, [options]),
    peek: (id: string): unknown => Reflect.apply(peek, studio, [id]),
    command: (input: DesignCommand): unknown => Reflect.apply(command, studio, [input]),
    disconnect: (id: string): void => { Reflect.apply(disconnect, studio, [id]) }
  }
}

function wire(value: unknown, sessionId: string): DesignSnapshot {
  const snapshot: unknown = JSON.parse(JSON.stringify(value))
  try {
    assertDesignSnapshot(snapshot, sessionId)
  } catch (reason) {
    throw new Error(`${String(reason)}; controller JSON: ${JSON.stringify(snapshot).slice(0, 6000)}`)
  }
  return snapshot
}

function page(): void {
  document.body.innerHTML = '<main><h1 id="heading">Hello</h1><button id="action"><span data-icon="true">*</span> Run</button></main>'
}

async function setup() {
  const harness = createDesignHarness()
  harness.api.connect.mockImplementation(async (options) => wire(runtime().connect(options), options.sessionId))
  harness.api.poll.mockImplementation(async (id) => {
    const value = runtime().peek(id)
    return value == null ? null : wire(value, id)
  })
  harness.api.command.mockImplementation(async (input) => wire(runtime().command(input), input.sessionId))
  harness.api.disconnect.mockImplementation(async (id) => runtime().disconnect(id))
  session = new DesignSession('p1', harness.api)
  await session.initialize('direct')
  session.setTarget({ url: window.location.href, appUrl: window.location.href, embedded: false })
  await session.reconnect()
  return { session, harness }
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, 200, 40))
  Reflect.deleteProperty(window, '__rayfinDesign')
  page()
  new Function(SCRIPT)()
})

afterEach(async () => {
  if (session) {
    await session.suspend()
    session = undefined
  }
  Reflect.deleteProperty(window, '__rayfinDesign')
  vi.unstubAllGlobals()
})

describe('renderer and injected controller wire integration', () => {
  it('saves an actual visual edit over JSON and restores it into a fresh document', async () => {
    const { session, harness } = await setup()
    const heading = session.getSnapshot().snapshot?.layers.find((item) => item.selector === '#heading')
    expect(heading).toBeDefined()
    await session.command({ type: 'select', target: heading! })
    await session.command({ type: 'style', values: { color: '#ff0000' } })
    await session.flush()
    expect(document.getElementById('heading')?.style.color).toBe('rgb(255, 0, 0)')
    expect(harness.stored()?.cursor).toBe(1)
    const oldSession = session.getSnapshot().snapshot!.sessionId
    runtime().disconnect(oldSession)
    Reflect.deleteProperty(window, '__rayfinDesign')
    page()
    new Function(SCRIPT)()
    await session.reconnect()
    expect(document.getElementById('heading')?.style.color).toBe('rgb(255, 0, 0)')
    expect(session.getSnapshot().snapshot?.conflicts).toEqual([])
  })

  it('edits and undoes a nested button label without replacing the icon or its listeners', async () => {
    const { session } = await setup()
    const target = session.getSnapshot().snapshot?.layers.find((item) => item.selector === '#action')
    expect(target).toBeDefined()
    const icon = document.querySelector('[data-icon]')!
    const click = vi.fn()
    icon.addEventListener('fixture-event', click)
    await session.command({ type: 'select', target: target! })
    await session.command({ type: 'text', value: 'Ship it' })
    expect(document.getElementById('action')?.textContent).toContain('Ship it')
    await session.command({ type: 'undo' })
    expect(document.querySelector('[data-icon]')).toBe(icon)
    icon.dispatchEvent(new Event('fixture-event'))
    expect(click).toHaveBeenCalledTimes(1)
  })
})
