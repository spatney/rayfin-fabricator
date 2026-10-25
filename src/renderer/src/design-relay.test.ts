/// <reference types="node" />
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesignSnapshot, DesignStatus } from '@shared/design'

/**
 * Tests for the Design controller's Fabric-embedded path
 * (`src-tauri/src/services/design_agent.js`): the top (Fabric shell) frame runs
 * as a `relay` that forwards enable / command / theme to the cross-origin app
 * iframe over origin-gated postMessage and mirrors its state back; the app
 * frame runs the real controller.
 */

const SRC = readFileSync(resolve(process.cwd(), 'src-tauri/src/services/design_agent.js'), 'utf8')
const NS = 'rayfin-design'
const APP_ORIGIN = 'https://p1.example.app'
/** The Fabric portal hosting the app — the only top frame the app side trusts. */
const PORTAL = 'https://app.fabric.microsoft.com'
const HOST_ID = '__rayfin_design_host'

interface Api {
  enable: (mode?: string, origin?: string | null, options?: unknown) => void
  disable: () => void
  peek: () => DesignStatus | null
  snapshot: () => DesignSnapshot | null
  command: (cmd: Record<string, unknown>) => { accepted: boolean }
  setTheme: (theme: Record<string, unknown>) => void
}
type Packet = Record<string, unknown> & { ns: string }

function message(target: Window, origin: string, source: unknown, data: Packet): void {
  target.dispatchEvent(new MessageEvent('message', { origin, source: source as Window, data }))
}

describe('design controller v6 — top-frame relay', () => {
  let api: Api
  let appWin: { postMessage: ReturnType<typeof vi.fn> }
  const sent = (): Packet[] => appWin.postMessage.mock.calls.map((c) => c[0] as Packet)

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    delete (window as unknown as { __rayfinDesign?: unknown }).__rayfinDesign
    document.body.innerHTML = ''
    new Function(SRC)()
    api = (window as unknown as { __rayfinDesign: Api }).__rayfinDesign
    appWin = { postMessage: vi.fn() }
  })
  afterEach(() => {
    api.disable()
    delete (window as unknown as { __rayfinDesign?: unknown }).__rayfinDesign
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('runs the Fabric shell as a relay without its own chrome and reports the host session', () => {
    api.enable('relay', APP_ORIGIN, { sessionId: 's1', items: [] })
    expect(document.getElementById(HOST_ID)).toBeNull()
    expect(api.peek()).toMatchObject({ enabled: true, sessionId: 's1', itemCount: 0 })
    expect(api.snapshot()).toBeNull()
  })

  it('connects the app frame on hello, seeding it with the session, and mirrors its state', () => {
    api.enable('relay', APP_ORIGIN, { sessionId: 's1', items: [], hostTheme: { accent: '#123456', panel: '#000', txt: '#fff' } })
    message(window, APP_ORIGIN, appWin, { ns: NS, evt: 'hello' })
    const enable = sent().find((p) => p.cmd === 'enable')!
    expect(enable).toMatchObject({ options: { sessionId: 's1', items: [], hostTheme: { accent: '#123456' } } })
    expect(appWin.postMessage.mock.calls[0][1]).toBe(APP_ORIGIN)

    const status = { enabled: true, sessionId: 's1', version: 4, hasTheme: true, itemCount: 1, requests: [], results: {}, panel: null }
    const snapshot = { version: 4, route: '/', viewport: { w: 800, h: 600, dpr: 1 }, items: [{ id: 'i1', kind: 'element', tweaks: [], createdAt: 1 }] }
    message(window, APP_ORIGIN, appWin, { ns: NS, evt: 'state', status, snapshot })
    expect(api.peek()).toMatchObject({ version: 4, itemCount: 1 })
    expect(api.snapshot()).toMatchObject({ items: [{ id: 'i1' }] })

    // A later reconnect (the app frame reloaded) re-seeds with the mirrored items.
    appWin.postMessage.mockClear()
    message(window, APP_ORIGIN, appWin, { ns: NS, evt: 'hello' })
    expect(sent().find((p) => p.cmd === 'enable')).toMatchObject({ options: { sessionId: 's1', items: [{ id: 'i1' }] } })
  })

  it('ignores hellos and state from other origins', () => {
    api.enable('relay', APP_ORIGIN, { sessionId: 's1', items: [] })
    const other = { postMessage: vi.fn() }
    message(window, 'https://evil.example', other, { ns: NS, evt: 'hello' })
    expect(other.postMessage).not.toHaveBeenCalled()
    message(window, APP_ORIGIN, appWin, { ns: NS, evt: 'hello' })
    message(window, 'https://evil.example', appWin, { ns: NS, evt: 'state', status: { enabled: true, version: 99 } })
    expect(api.peek()?.version).toBe(0)
  })

  it('forwards commands and theme to the app frame', () => {
    api.enable('relay', APP_ORIGIN, { sessionId: 's1', items: [] })
    message(window, APP_ORIGIN, appWin, { ns: NS, evt: 'hello' })
    expect(api.command({ op: 'openPanel', panel: 'theme' })).toEqual({ accepted: true })
    api.setTheme({ accent: '#abcdef', panel: '#000', txt: '#fff' })
    expect(sent()).toEqual(expect.arrayContaining([
      expect.objectContaining({ cmd: 'command', command: { op: 'openPanel', panel: 'theme' } }),
      expect.objectContaining({ cmd: 'theme', theme: expect.objectContaining({ accent: '#abcdef' }) })
    ]))
    // A seed updates the relay's own session so it reports it until the app answers.
    api.command({ op: 'seed', sessionId: 's9', items: [] })
    expect(api.peek()?.sessionId).toBe('s9')
  })

  it('adds the app frame offset to capture layouts so the host can crop', () => {
    const iframe = document.createElement('iframe')
    iframe.style.border = '0'
    document.body.appendChild(iframe)
    iframe.getBoundingClientRect = () => ({ left: 240, top: 56, right: 1040, bottom: 656, width: 800, height: 600, x: 240, y: 56, toJSON() {} }) as DOMRect
    api.enable('relay', APP_ORIGIN, { sessionId: 's1', items: [] })
    const frameWin = iframe.contentWindow!
    const post = vi.spyOn(frameWin, 'postMessage').mockImplementation(() => {})
    message(window, APP_ORIGIN, frameWin, { ns: NS, evt: 'hello' })
    expect(post).toHaveBeenCalled()
    const layout = { viewport: { w: 800, h: 600, dpr: 1 }, frame: null, rects: { i1: { x: 10, y: 20, w: 100, h: 40 } } }
    message(window, APP_ORIGIN, frameWin, {
      ns: NS, evt: 'state',
      status: { enabled: true, sessionId: 's1', version: 2, hasTheme: true, itemCount: 1, requests: [], results: { cap: layout }, panel: null }
    })
    expect(api.peek()?.results.cap).toMatchObject({ frame: { x: 240, y: 56 }, rects: { i1: { x: 10, y: 20 } }, viewport: { w: window.innerWidth } })
  })
})

describe('design controller v6 — app frame', () => {
  let iframe: HTMLIFrameElement
  let frame: Window & typeof globalThis
  let posted: ReturnType<typeof vi.spyOn>
  let app: Api

  beforeEach(() => {
    vi.useFakeTimers()
    iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    frame = iframe.contentWindow! as Window & typeof globalThis
    const doc = iframe.contentDocument!
    doc.open()
    doc.write('<html><head></head><body><h1 class="text-2xl">Dashboard</h1></body></html>')
    doc.close()
    posted = vi.spyOn(frame.top!, 'postMessage').mockImplementation(() => {})
    new Function('window', 'document', 'location', 'getComputedStyle', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'CSS', SRC)(
      frame, doc, frame.location, frame.getComputedStyle.bind(frame), frame.MutationObserver, () => 1, () => {}, frame.CSS
    )
    app = (frame as unknown as { __rayfinDesign: Api }).__rayfinDesign
    vi.advanceTimersByTime(0)
  })
  afterEach(() => {
    app.disable()
    iframe.remove()
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('says hello to the top frame, then runs the controller when the relay enables it', () => {
    const packets = (): Packet[] => posted.mock.calls.map((c: unknown[]) => c[0] as Packet)
    expect(packets().some((p) => p.ns === NS && p.evt === 'hello')).toBe(true)
    frame.dispatchEvent(new MessageEvent('message', {
      origin: PORTAL, source: frame.top,
      data: { ns: NS, cmd: 'enable', options: { sessionId: 's1', items: [] } }
    }))
    expect(iframe.contentDocument!.getElementById(HOST_ID)).not.toBeNull()
    const state = packets().filter((p) => p.evt === 'state').pop()!
    expect(state).toMatchObject({ status: { enabled: true, sessionId: 's1' }, snapshot: { items: [] } })
    // State only goes back to the relay's origin.
    expect(posted.mock.calls.filter((c: unknown[]) => (c[0] as Packet).evt === 'state').every((c: unknown[]) => c[1] === PORTAL)).toBe(true)
  })

  it('ignores commands that do not come from the top frame', () => {
    frame.dispatchEvent(new MessageEvent('message', { origin: PORTAL, source: null, data: { ns: NS, cmd: 'enable', options: { sessionId: 'x', items: [] } } }))
    expect(iframe.contentDocument!.getElementById(HOST_ID)).toBeNull()
  })

  // Any page loaded in the preview could frame a site; only the Fabric portal may drive it.
  it.each(['https://evil.example', 'http://app.fabric.microsoft.com', 'https://fabric.microsoft.com.evil.example'])(
    'ignores a top frame at %s',
    (origin) => {
      frame.dispatchEvent(new MessageEvent('message', { origin, source: frame.top, data: { ns: NS, cmd: 'enable', options: { sessionId: 'x', items: [] } } }))
      frame.dispatchEvent(new MessageEvent('message', { origin, source: frame.top, data: { ns: NS, cmd: 'command', command: { op: 'collectPage', requestId: 'r' } } }))
      expect(iframe.contentDocument!.getElementById(HOST_ID)).toBeNull()
      expect(posted.mock.calls.some((c: unknown[]) => (c[0] as Packet).evt === 'state')).toBe(false)
    }
  )

  it('accepts other Fabric and Power BI portal hosts', () => {
    frame.dispatchEvent(new MessageEvent('message', {
      origin: 'https://msit.powerbi.com', source: frame.top,
      data: { ns: NS, cmd: 'enable', options: { sessionId: 's2', items: [] } }
    }))
    expect(iframe.contentDocument!.getElementById(HOST_ID)).not.toBeNull()
  })
})
