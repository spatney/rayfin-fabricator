import { readFileSync } from 'fs'
import { resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesignCommand, DesignConnection, DesignSnapshot } from '../../shared/design'

const SOURCE = readFileSync(
  resolve(process.cwd(), 'src-tauri', 'src', 'services', 'design_agent.js'),
  'utf8'
)
const NS = 'rayfin-design-studio'
const ORIGIN = 'https://app.example.test'
// Vitest aliases global.window to its global object, whereas iframe.top is the
// actual jsdom WindowProxy. Run the relay in that real top window.
let TOP: Window & typeof globalThis

interface Studio {
  connect(options: DesignConnection): DesignSnapshot
  peek(sessionId: string): DesignSnapshot | null
  command(command: DesignCommand): DesignSnapshot
  disconnect(sessionId: string): void
}
interface Api {
  studio: Studio
  disable(): void
  setTheme(theme: Record<string, unknown>): void
}
interface Packet {
  ns: string
  protocol: number
  cmd?: string
  evt?: string
  bridgeId: string
  generation: number
  pageId?: string
  options?: DesignConnection
  envelope?: DesignCommand
  snapshot?: DesignSnapshot
}

const options = (): DesignConnection => ({
  sessionId: 'session',
  embedded: true,
  appUrl: `${ORIGIN}/app?preview=1#page`,
  history: [],
  cursor: 0,
  revision: 0,
  route: '/app?preview=1#page'
})

function snapshot(overrides: Partial<DesignSnapshot> = {}): DesignSnapshot {
  return {
    protocol: 1,
    sessionId: 'session',
    documentId: 'app-document',
    revision: 0,
    enabled: true,
    route: '/app?preview=1#page',
    tool: 'select',
    compare: false,
    selection: [],
    layers: [],
    tokens: [],
    breakpoints: [],
    viewport: { width: 480, height: 720 },
    history: [],
    cursor: 0,
    conflicts: [],
    acknowledged: [],
    ...overrides
  }
}

function message(
  source: Window,
  origin: string,
  data: Record<string, unknown>,
  receiver = window
): void {
  receiver.dispatchEvent(
    new MessageEvent('message', { source: source === window ? TOP : source, origin, data })
  )
}

describe('Design Studio — top-frame relay', () => {
  let api: Api
  let app: HTMLIFrameElement
  let other: HTMLIFrameElement
  let sent: ReturnType<typeof vi.spyOn>
  let bridge: Packet

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1)
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    document.body.innerHTML = '<button id="fabric-shell">Fabric shell</button>'
    app = document.createElement('iframe')
    other = document.createElement('iframe')
    document.body.append(app, other)
    TOP = app.contentWindow!.top! as Window & typeof globalThis
    delete (TOP as unknown as { __rayfinDesign?: Api }).__rayfinDesign
    new Function('window', 'document', SOURCE)(TOP, document)
    api = (TOP as unknown as { __rayfinDesign: Api }).__rayfinDesign
    sent = vi.spyOn(app.contentWindow!, 'postMessage').mockImplementation(() => {})
  })

  afterEach(() => {
    api.studio.disconnect('session')
    api.studio.disconnect('new-session')
    api.disable()
    app.remove()
    other.remove()
    delete (TOP as unknown as { __rayfinDesign?: Api }).__rayfinDesign
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function hello(pageId = 'app-page', source = app.contentWindow!, origin = ORIGIN): void {
    message(source, origin, { ns: NS, protocol: 1, evt: 'hello', pageId })
    bridge = sent.mock.calls
      .map((call) => call[0] as Packet)
      .filter((packet) => packet.cmd === 'connect')
      .at(-1)!
  }

  function status(
    value = snapshot(),
    overrides: Record<string, unknown> = {},
    source = app.contentWindow!,
    origin = ORIGIN
  ): void {
    message(source, origin, {
      ns: NS,
      protocol: 1,
      evt: 'snapshot',
      bridgeId: bridge.bridgeId,
      pageId: bridge.pageId,
      epoch: 1,
      sessionId: 'session',
      snapshot: value,
      ...overrides
    })
  }

  function connect(): void {
    api.studio.connect(options())
    hello()
    status()
  }

  it('waits for an app-origin handshake and never enables editing of the Fabric shell', () => {
    const pending = api.studio.connect(options())
    expect(pending).toMatchObject({
      protocol: 1,
      sessionId: 'session',
      enabled: false,
      documentId: '',
      viewport: { width: 0, height: 0 }
    })
    expect(pending.notice).toMatch(/Fabric shell is never edited/i)
    expect(api.studio.peek('session')).toBeNull()
    expect(document.getElementById('__rayfin_design_host')).toBeNull()
    hello('wrong', app.contentWindow!, 'https://attacker.example')
    expect(sent.mock.calls.filter((call) => (call[0] as Packet).cmd === 'connect')).toHaveLength(0)
    hello()
    expect(bridge.options).toMatchObject({
      embedded: false,
      appUrl: options().appUrl,
      sessionId: 'session',
      route: '/app?preview=1#page'
    })
    expect(sent.mock.calls.find((call) => (call[0] as Packet).cmd === 'connect')?.[1]).toBe(ORIGIN)
    status()
    expect(api.studio.peek('session')).toMatchObject({
      documentId: 'app-document',
      viewport: { width: 480, height: 720 }
    })
    expect(document.getElementById('__rayfin_design_host')).toBeNull()
    expect(document.getElementById('fabric-shell')!.getAttribute('style')).toBeNull()
  })

  it('accepts a buffered hello before connect, but ignores status before a session exists', () => {
    message(app.contentWindow!, ORIGIN, {
      ns: NS,
      protocol: 1,
      evt: 'snapshot',
      snapshot: snapshot({ revision: 20 })
    })
    expect(api.studio.peek('session')).toBeNull()
    hello()
    api.studio.connect(options())
    bridge = sent.mock.calls
      .map((call) => call[0] as Packet)
      .find((packet) => packet.cmd === 'connect')!
    expect(bridge).toBeTruthy()
    status()
    expect(api.studio.peek('session')?.revision).toBe(0)
  })

  it('forwards commands immediately, caches snapshots, and waits for the specific acknowledgement instead of inventing success', () => {
    connect()
    const envelope: DesignCommand = {
      type: 'style',
      values: { color: 'red' },
      sessionId: 'session',
      documentId: 'app-document',
      commandId: 'style-1'
    }
    const immediate = api.studio.command(envelope)
    expect(immediate.acknowledged).not.toContain('style-1')
    const packet = sent.mock.calls
      .map((call) => call[0] as Packet)
      .find((item) => item.cmd === 'command')!
    expect(packet.envelope).toEqual(envelope)
    expect(packet.bridgeId).toBe(bridge.bridgeId)
    const count = sent.mock.calls.length
    api.studio.command(envelope)
    expect(sent.mock.calls).toHaveLength(count)
    status(snapshot({ revision: 1, acknowledged: ['select-1', 'style-1'] }))
    expect(api.studio.peek('session')).toMatchObject({
      revision: 1,
      acknowledged: ['select-1', 'style-1']
    })
    expect(api.studio.command(envelope).acknowledged).toContain('style-1')
    expect(sent.mock.calls).toHaveLength(count)
  })

  it('routes the existing host theme API to the app iframe without mounting Studio on the Fabric shell', () => {
    connect()
    const before = api.studio.peek('session')
    const theme = { accent: '#4f46e5', panel: '#ffffff', txt: '#111111', scale: 1.5 }
    api.setTheme(theme)
    const forwarded = sent.mock.calls.find((call) => (call[0] as Packet).cmd === 'theme')!
    expect(forwarded[0]).toMatchObject({
      ns: NS,
      protocol: 1,
      cmd: 'theme',
      bridgeId: bridge.bridgeId,
      sessionId: 'session',
      documentId: 'app-document',
      theme
    })
    expect(forwarded[1]).toBe(ORIGIN)
    expect(document.getElementById('__rayfin_design_host')).toBeNull()
    expect(document.getElementById('fabric-shell')!.getAttribute('style')).toBeNull()
    expect(api.studio.peek('session')).toEqual(before)
  })

  it('gates every status by origin, window source, session, bridge, page and document epoch', () => {
    connect()
    const accepted = api.studio.peek('session')
    const forged = snapshot({ revision: 100, acknowledged: ['forged'] })
    status(forged, {}, app.contentWindow!, 'https://attacker.example')
    status(forged, {}, other.contentWindow!)
    for (const override of [
      { sessionId: 'other' },
      { bridgeId: 'other' },
      { pageId: 'old-page' },
      { epoch: 0 },
      { snapshot: { ...forged, sessionId: 'other' } },
      { snapshot: { ...forged, documentId: 'another-document' }, epoch: 1 }
    ])
      status(forged, override)
    expect(api.studio.peek('session')).toEqual(accepted)
    // Another live iframe at the same app origin cannot steal the active bridge.
    const count = sent.mock.calls.length
    hello('other-page', other.contentWindow!)
    expect(sent.mock.calls).toHaveLength(count)
    expect(api.studio.peek('session')).toEqual(accepted)
  })

  it('rejects stale commands explicitly and never sends them to either frame', () => {
    connect()
    const before = sent.mock.calls.length
    const rejected = api.studio.command({
      type: 'remove',
      sessionId: 'old',
      documentId: 'app-document',
      commandId: 'bad-session'
    })
    expect(rejected.error).toMatch(/stale/i)
    expect(rejected.acknowledged).toContain('bad-session')
    expect(rejected.sessionId).toBe('old')
    expect(rejected.documentId).toBe('app-document')
    expect(rejected.history).toEqual([])
    const stale = api.studio.command({
      type: 'remove',
      sessionId: 'session',
      documentId: 'old-document',
      commandId: 'bad-doc'
    })
    expect(stale.error).toMatch(/stale/i)
    expect(stale.acknowledged).toContain('bad-doc')
    expect(stale.sessionId).toBe('session')
    expect(stale.documentId).toBe('old-document')
    expect(stale.history).toEqual([])
    expect(sent.mock.calls).toHaveLength(before)
    expect(api.studio.peek('session')!.acknowledged).toEqual([])
  })

  it('caches app command errors with their acknowledgement and reports malformed app responses', () => {
    connect()
    api.studio.command({
      type: 'remove',
      sessionId: 'session',
      documentId: 'app-document',
      commandId: 'remove'
    })
    status(snapshot({ acknowledged: ['remove'], error: 'The app root cannot be removed.' }))
    expect(api.studio.peek('session')).toMatchObject({
      error: 'The app root cannot be removed.',
      acknowledged: ['remove']
    })
    status(snapshot(), { snapshot: { protocol: 1, sessionId: 'session' } })
    expect(api.studio.peek('session')?.error).toMatch(/invalid Studio snapshot/i)
  })

  it('does not leak a previous command error into a new pending command or its successful acknowledgement', () => {
    connect()
    status(snapshot({ error: 'Previous failure', acknowledged: ['old-command'] }))
    const pending = api.studio.command({
      type: 'tool',
      tool: 'interact',
      sessionId: 'session',
      documentId: 'app-document',
      commandId: 'retry'
    })
    expect(pending.error).toBeUndefined()
    expect(pending.acknowledged).not.toContain('retry')
    status(snapshot({ error: 'Previous failure', acknowledged: ['old-command'] }))
    expect(api.studio.peek('session')?.error).toBeUndefined()
    status(snapshot({ tool: 'interact', acknowledged: ['old-command', 'retry'] }))
    expect(api.studio.peek('session')).toMatchObject({
      tool: 'interact',
      acknowledged: ['old-command', 'retry']
    })
    expect(api.studio.peek('session')?.error).toBeUndefined()
  })

  it('rehydrates the latest draft after a new app document, retires old status, and preserves app viewport and route identity', () => {
    connect()
    status(
      snapshot({
        revision: 4,
        acknowledged: ['old-command'],
        route: '/app?preview=1#other',
        documentId: 'routed-document'
      }),
      { epoch: 2 }
    )
    const oldBridge = bridge
    hello('new-app-page')
    expect(bridge.bridgeId).not.toBe(oldBridge.bridgeId)
    expect(bridge.options?.revision).toBe(4)
    expect(bridge.options?.route).toBe(options().route)
    expect(api.studio.peek('session')).toBeNull()
    const count = sent.mock.calls.length
    expect(
      api.studio.command({
        type: 'undo',
        sessionId: 'session',
        documentId: 'routed-document',
        commandId: 'during-reload'
      }).error
    ).toMatch(/unavailable/i)
    expect(sent.mock.calls).toHaveLength(count)
    status(
      snapshot({ revision: 4, documentId: 'new-document', viewport: { width: 390, height: 844 } })
    )
    expect(api.studio.peek('session')).toMatchObject({
      documentId: 'new-document',
      viewport: { width: 390, height: 844 }
    })
    status(snapshot({ revision: 500 }), {
      bridgeId: oldBridge.bridgeId,
      pageId: oldBridge.pageId,
      epoch: 99
    })
    hello('app-page')
    expect(api.studio.peek('session')?.documentId).toBe('new-document')
  })

  it('can adopt a replacement iframe only after the previous app frame has actually left the frame tree', () => {
    connect()
    app.remove()
    const replacementSent = vi
      .spyOn(other.contentWindow!, 'postMessage')
      .mockImplementation(() => {})
    message(other.contentWindow!, ORIGIN, {
      ns: NS,
      protocol: 1,
      evt: 'hello',
      pageId: 'replacement-page'
    })
    const packet = replacementSent.mock.calls
      .map((call) => call[0] as Packet)
      .find((item) => item.cmd === 'connect')!
    expect(packet).toBeTruthy()
    expect(packet.pageId).toBe('replacement-page')
    expect(api.studio.peek('session')).toBeNull()
  })

  it('cleans up only the matching session and stops discovery on disconnect', () => {
    connect()
    const count = sent.mock.calls.length
    api.studio.disconnect('old')
    expect(sent.mock.calls).toHaveLength(count)
    expect(api.studio.peek('session')).not.toBeNull()
    api.studio.disconnect('session')
    const disconnect = sent.mock.calls.map((call) => call[0] as Packet).at(-1)!
    expect(disconnect.cmd).toBe('disconnect')
    expect(api.studio.peek('session')).toBeNull()
    status(snapshot({ revision: 100 }))
    vi.advanceTimersByTime(10000)
    expect(api.studio.peek('session')).toBeNull()
    expect(document.getElementById('__rayfin_design_host')).toBeNull()
  })
})

describe('Design Studio — real app-frame controller', () => {
  let iframe: HTMLIFrameElement
  let frame: Window & typeof globalThis
  let app: Api
  let posted: ReturnType<typeof vi.spyOn>
  let hello: Packet
  const bridgeId = 'bridge-from-top'

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1)
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    iframe = document.createElement('iframe')
    iframe.src = `${window.location.origin}/real-app`
    document.body.appendChild(iframe)
    frame = iframe.contentWindow! as Window & typeof globalThis
    TOP = frame.top! as Window & typeof globalThis
    const doc = iframe.contentDocument!
    doc.open()
    doc.write('<html><head></head><body><button id="app-button">App action</button></body></html>')
    doc.close()
    posted = vi.spyOn(TOP, 'postMessage').mockImplementation(() => {})
    new Function(
      'window',
      'document',
      'getComputedStyle',
      'MutationObserver',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'CSS',
      SOURCE
    )(
      frame,
      doc,
      frame.getComputedStyle.bind(frame),
      frame.MutationObserver,
      () => 1,
      () => {},
      frame.CSS
    )
    app = (frame as unknown as { __rayfinDesign: Api }).__rayfinDesign
    vi.advanceTimersByTime(0)
    hello = posted.mock.calls
      .map((call) => call[0] as Packet)
      .find((packet) => packet.ns === NS && packet.evt === 'hello')!
    expect(hello).toBeTruthy()
  })

  afterEach(() => {
    app.studio.disconnect('session')
    app.disable()
    iframe.remove()
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function connect(): DesignSnapshot {
    message(
      window,
      window.location.origin,
      {
        ns: NS,
        protocol: 1,
        cmd: 'connect',
        bridgeId,
        generation: 10,
        sessionId: 'session',
        pageId: hello.pageId,
        options: { ...options(), embedded: false, appUrl: iframe.src, route: '/real-app' }
      },
      frame
    )
    return app.studio.peek('session')!
  }

  it('enables only after the top-frame handshake and immediately publishes command acknowledgements from the app frame', () => {
    expect(app.studio.peek('session')).toBeNull()
    const state = connect()
    expect(state.enabled).toBe(true)
    expect(state.route).toBe('/real-app')
    expect(iframe.contentDocument!.getElementById('__rayfin_design_host')).toBeTruthy()
    expect(document.getElementById('__rayfin_design_host')).toBeNull()
    const selected = state.layers.find((layer) => layer.selector === '#app-button')!
    message(
      window,
      window.location.origin,
      {
        ns: NS,
        protocol: 1,
        cmd: 'command',
        bridgeId,
        sessionId: 'session',
        documentId: state.documentId,
        envelope: {
          type: 'select',
          target: selected,
          sessionId: 'session',
          documentId: state.documentId,
          commandId: 'select'
        }
      },
      frame
    )
    message(
      window,
      window.location.origin,
      {
        ns: NS,
        protocol: 1,
        cmd: 'command',
        bridgeId,
        sessionId: 'session',
        documentId: state.documentId,
        envelope: {
          type: 'text',
          value: 'Edited locally',
          sessionId: 'session',
          documentId: state.documentId,
          commandId: 'edit'
        }
      },
      frame
    )
    expect(iframe.contentDocument!.getElementById('app-button')!.textContent).toBe('Edited locally')
    const latest = posted.mock.calls
      .map((call) => call[0] as Packet)
      .filter((packet) => packet.evt === 'snapshot')
      .at(-1)!
    expect(latest.snapshot?.acknowledged).toContain('edit')
    expect(latest.snapshot?.revision).toBe(1)
    expect(latest.snapshot?.viewport).toEqual({
      width: frame.innerWidth,
      height: frame.innerHeight
    })
    expect(posted.mock.calls.at(-1)?.[1]).toBe(window.location.origin)
  })

  it('repaints app-frame Studio theme and UI scale from an origin-gated legacy setTheme relay message', () => {
    const initial = connect()
    const before = iframe.contentDocument!.body.innerHTML
    const packet = {
      ns: NS,
      protocol: 1,
      cmd: 'theme',
      bridgeId,
      sessionId: 'session',
      documentId: initial.documentId,
      theme: { accent: '#2563eb', panel: '#ffffff', txt: '#111111', scale: 1.5 }
    }
    message(window, 'https://wrong.example', packet, frame)
    const chrome = iframe.contentDocument!.getElementById('__rayfin_design_host')!.shadowRoot!
    expect(chrome.querySelector('style')!.textContent).not.toContain('#2563eb')
    message(window, window.location.origin, packet, frame)
    expect(chrome.querySelector('style')!.textContent).toContain('#2563eb')
    expect(chrome.querySelector('style')!.textContent).toContain('--fs-base:20px')
    expect((chrome.querySelector('.tb') as HTMLElement).style.display).toBe('none')
    expect((chrome.querySelector('.insp') as HTMLElement).style.display).toBe('none')
    expect(chrome.querySelector('.legend')).toBeNull()
    expect(iframe.contentDocument!.body.innerHTML).toBe(before)
    expect(app.studio.peek('session')!.history).toEqual([])
    expect(app.studio.peek('session')!.revision).toBe(initial.revision)
    expect(document.getElementById('__rayfin_design_host')).toBeNull()
  })

  it('runs contextual selection and Look gestures inside the actual app frame and publishes their journal immediately', () => {
    connect()
    const button = iframe.contentDocument!.getElementById('app-button')!
    iframe.contentDocument!.elementFromPoint = () => button
    button.dispatchEvent(
      new frame.MouseEvent('pointerdown', {
        bubbles: true,
        composed: true,
        cancelable: true,
        clientX: 30,
        clientY: 30
      })
    )
    const chrome = iframe.contentDocument!.getElementById('__rayfin_design_host')!.shadowRoot!
    const context = chrome.querySelector<HTMLElement>('.studio-context')!
    expect(context.hidden).toBe(false)
    expect(
      Array.from(context.querySelectorAll('[data-studio-action]')).map((node) => node.textContent)
    ).toEqual(['Color', 'Shape', 'Look'])
    context.querySelector<HTMLButtonElement>('[data-studio-action="Look"]')!.click()
    const soft = context.querySelector<HTMLButtonElement>('[data-studio-look="Soft"]')!
    soft.dispatchEvent(new frame.MouseEvent('pointerenter'))
    expect(button.style.borderTopLeftRadius).toBe('18px')
    expect(app.studio.peek('session')!.history).toEqual([])
    soft.click()
    const latest = posted.mock.calls
      .map((call) => call[0] as Packet)
      .filter((packet) => packet.evt === 'snapshot')
      .at(-1)!
    expect(latest.snapshot?.history).toHaveLength(1)
    expect(latest.snapshot?.revision).toBe(1)
    expect(latest.snapshot?.history[0].edits.every((edit) => edit.kind === 'style')).toBe(true)
    expect(document.getElementById('__rayfin_design_host')).toBeNull()
  })

  it('publishes field and list styling from the app frame without recording form data', () => {
    const doc = iframe.contentDocument!
    doc.body.insertAdjacentHTML(
      'afterbegin',
      '<select id="field"><option>private-option</option></select><ul id="list"><li>One</li><li>Two</li></ul>'
    )
    connect()
    const field = doc.getElementById('field') as HTMLSelectElement
    const list = doc.getElementById('list')!
    function pick(target: HTMLElement): void {
      doc.elementFromPoint = () => target
      target.dispatchEvent(
        new frame.MouseEvent('pointerdown', {
          bubbles: true,
          composed: true,
          cancelable: true,
          clientX: 30,
          clientY: 30
        })
      )
    }
    pick(field)
    const context = doc
      .getElementById('__rayfin_design_host')!
      .shadowRoot!.querySelector<HTMLElement>('.studio-context')!
    expect(context.hidden).toBe(false)
    context.querySelector<HTMLButtonElement>('[data-studio-action="Shape"]')!.click()
    const slider = context.querySelector<HTMLInputElement>('input[type="range"]')!
    slider.focus()
    for (const type of ['keydown', 'keyup']) {
      slider.dispatchEvent(
        new frame.KeyboardEvent(type, {
          key: 'ArrowRight',
          bubbles: true,
          composed: true,
          cancelable: true
        })
      )
    }
    expect(field.style.borderTopLeftRadius).toBeTruthy()
    pick(list)
    context.querySelector<HTMLButtonElement>('[data-studio-action="Layout"]')!.click()
    context.querySelector<HTMLButtonElement>('[data-studio-layout="horizontal"]')!.click()
    expect(list.style.flexDirection).toBe('row')
    const latest = posted.mock.calls
      .map((call) => call[0] as Packet)
      .filter((packet) => packet.evt === 'snapshot')
      .at(-1)!
    expect(latest.snapshot?.history).toHaveLength(2)
    expect(
      latest.snapshot?.history.every((tx) => tx.edits.every((edit) => edit.kind === 'style'))
    ).toBe(true)
    expect(JSON.stringify(latest.snapshot)).not.toContain('private-option')
    expect(field.value).toBe('private-option')
    expect(document.getElementById('__rayfin_design_host')).toBeNull()
  })

  it('ignores wrong origin/source/bridge/session/document and stale connection generations without touching the app', () => {
    const state = connect()
    const selected = state.layers.find((layer) => layer.selector === '#app-button')!
    app.studio.command({
      type: 'select',
      target: selected,
      sessionId: 'session',
      documentId: state.documentId,
      commandId: 'select'
    })
    const packet = {
      ns: NS,
      protocol: 1,
      cmd: 'command',
      bridgeId,
      sessionId: 'session',
      documentId: state.documentId,
      envelope: {
        type: 'text',
        value: 'Wrong',
        sessionId: 'session',
        documentId: state.documentId,
        commandId: 'bad'
      }
    }
    message(window, 'https://wrong.example', packet, frame)
    message(frame, window.location.origin, packet, frame)
    for (const override of [{ bridgeId: 'old' }, { sessionId: 'old' }, { documentId: 'old' }])
      message(window, window.location.origin, { ...packet, ...override }, frame)
    message(
      window,
      window.location.origin,
      {
        ns: NS,
        protocol: 1,
        cmd: 'connect',
        bridgeId: 'old',
        generation: 9,
        sessionId: 'old',
        pageId: hello.pageId,
        options: { ...options(), sessionId: 'old', embedded: false, appUrl: iframe.src }
      },
      frame
    )
    expect(iframe.contentDocument!.getElementById('app-button')!.textContent).toBe('App action')
    expect(app.studio.peek('session')?.revision).toBe(0)
    expect(app.studio.peek('old')).toBeNull()
    expect(app.studio.peek('session')?.acknowledged).not.toContain('bad')
  })

  it('publishes route changes without DOM mutations while keeping the app-frame viewport authoritative', () => {
    const initial = connect()
    frame.history.pushState(null, '', '/real-app?route=two#details')
    vi.advanceTimersByTime(250)
    const latest = posted.mock.calls
      .map((call) => call[0] as Packet)
      .filter((packet) => packet.evt === 'snapshot')
      .at(-1)!
    expect(latest.snapshot?.route).toBe('/real-app?route=two#details')
    expect(latest.snapshot?.documentId).not.toBe(initial.documentId)
    expect(latest.snapshot?.revision).toBe(0)
  })

  it('clears a previous error before publishing intermediate snapshots for a successful new command', () => {
    const initial = connect()
    const failed = app.studio.command({
      type: 'text',
      value: 'No selection',
      sessionId: 'session',
      documentId: initial.documentId,
      commandId: 'failed'
    })
    expect(failed.error).toBeTruthy()
    posted.mockClear()
    const selected = app.studio.command({
      type: 'select',
      target: initial.layers.find((layer) => layer.selector === '#app-button')!,
      sessionId: 'session',
      documentId: initial.documentId,
      commandId: 'recovered'
    })
    expect(selected.error).toBeUndefined()
    const snapshots = posted.mock.calls
      .map((call) => call[0] as Packet)
      .filter((packet) => packet.evt === 'snapshot')
    expect(snapshots.length).toBeGreaterThan(1)
    expect(snapshots.every((packet) => packet.snapshot?.error === undefined)).toBe(true)
    expect(app.studio.peek('session')?.error).toBeUndefined()
  })
})
