/// <reference types="node" />
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PickCaptureLayout, PickEvent, PickRef, PickStatus, PickTarget } from '@shared/pick'

/**
 * The Touch Up agent injected into the preview
 * (`src-tauri/src/services/pick_agent.js`). It's a document-start IIFE: these
 * tests eval it into jsdom and drive it through its API and real DOM events,
 * as the app's own page (`direct`), as the Fabric shell relaying to the app's
 * iframe (`relay`), and as that iframe.
 */

const SRC = readFileSync(resolve(process.cwd(), 'src-tauri/src/services/pick_agent.js'), 'utf8')
const HOST_ID = '__fabricator_pick'
const MSG = 'fabricator-pick'
const APP_ORIGIN = 'https://p1.example.app'
/** The Fabric portal hosting the app: the only top frame the app side trusts. */
const PORTAL = 'https://app.fabric.microsoft.com'

interface Agent {
  __v: number
  set: (
    mode: string,
    appOrigin: string | null,
    options: { armed?: boolean; on?: boolean; picks?: PickRef[] }
  ) => void
  peek: (opts?: { page: string | null; since: number }) => PickStatus | null
  command: (cmd: Record<string, unknown>) => { accepted: boolean }
  __test: {
    labelOf: (el: Element) => string
    pick: (node: Node) => Element | null
    describe: (el: Element) => PickTarget
  }
}
type Packet = Record<string, unknown> & { ns: string }

let frames: FrameRequestCallback[] = []
function flushFrames(): void {
  const run = frames
  frames = []
  run.forEach((cb) => cb(0))
}

function install(): Agent {
  delete (window as unknown as { __fabricatorPick?: unknown }).__fabricatorPick
  new Function(SRC)()
  return (window as unknown as { __fabricatorPick: Agent }).__fabricatorPick
}
function shadow(): ShadowRoot | null {
  return document.getElementById(HOST_ID)?.shadowRoot ?? null
}
function hint(): string {
  return shadow()?.querySelector('.hint')?.textContent ?? ''
}
function add(html: string): HTMLElement {
  const wrap = document.createElement('div')
  wrap.innerHTML = html.trim()
  const el = wrap.firstElementChild as HTMLElement
  document.body.appendChild(el)
  return el
}
function rect(el: Element, r: { x: number; y: number; w: number; h: number }): void {
  ;(el as HTMLElement).getBoundingClientRect = () =>
    ({
      left: r.x,
      top: r.y,
      right: r.x + r.w,
      bottom: r.y + r.h,
      width: r.w,
      height: r.h,
      x: r.x,
      y: r.y,
      toJSON() {}
    }) as DOMRect
}
function pointerDown(el: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
    ...init
  })
  el.dispatchEvent(event)
  return event
}
/** Drag the pointer (pressed, as the agent saw it go down) to `x`, `y` and let go. */
function dragTo(x: number, y: number): void {
  window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y, bubbles: true }))
  window.dispatchEvent(
    new MouseEvent('pointerup', { clientX: x, clientY: y, bubbles: true, cancelable: true })
  )
}
function shortcut(target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'C',
    code: 'KeyC',
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true
  })
  target.dispatchEvent(event)
  return event
}
function events(agent: Agent): PickEvent[] {
  return agent.peek()?.events ?? []
}
function picked(agent: Agent): Extract<PickEvent, { type: 'pick' }>[] {
  return events(agent).filter((e): e is Extract<PickEvent, { type: 'pick' }> => e.type === 'pick')
}

describe('Touch Up agent in the app’s page', () => {
  let agent: Agent

  beforeEach(() => {
    vi.useFakeTimers()
    frames = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
    vi.stubGlobal('cancelAnimationFrame', () => {})
    document.head.innerHTML = ''
    document.body.innerHTML = ''
    agent = install()
  })
  afterEach(() => {
    agent.set('direct', null, { armed: false })
    delete (window as unknown as { __fabricatorPick?: unknown }).__fabricatorPick
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('stays dormant until armed; armed, Ctrl+Shift+C turns picking on and off', () => {
    expect(shortcut().defaultPrevented).toBe(false)
    expect(agent.peek()).toMatchObject({ v: 1, armed: false, on: false, events: [] })

    agent.set('direct', null, { armed: true, on: false })
    expect(document.getElementById(HOST_ID)).toBeNull()
    // Caught before the preview's DevTools open their inspector on it.
    expect(shortcut().defaultPrevented).toBe(true)
    expect(agent.peek()).toMatchObject({ armed: true, on: true })
    expect(hint()).toContain('Click anything you want to change')
    expect(hint()).toContain('Shift+ drag to clip a screenshot')
    expect(document.getElementById('__fabricator_pick_cursor')).not.toBeNull()

    shortcut()
    expect(agent.peek()?.on).toBe(false)
    expect(events(agent).map((e) => e.type)).toEqual(['enter', 'exit'])
    expect(document.getElementById(HOST_ID)).toBeNull()
    expect(document.getElementById('__fabricator_pick_cursor')).toBeNull()
  })

  it('finishes picking on Escape or Done', () => {
    agent.set('direct', null, { armed: true, on: true })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
    expect(agent.peek()?.on).toBe(false)

    agent.set('direct', null, { armed: true, on: true })
    const done = [...shadow()!.querySelectorAll('button')].find((b) => b.textContent === 'Done')!
    done.click()
    expect(agent.peek()?.on).toBe(false)
    expect(events(agent).map((e) => e.type)).toEqual(['exit', 'exit'])
  })

  it('picks what is clicked, without the app seeing the click, and a second click drops it', () => {
    const main = add(
      '<main><h2>Deals</h2><button id="save" class="btn btn-primary" data-variant="solid">Save <svg><path d="M0 0"/></svg></button></main>'
    )
    const button = main.querySelector('button')!
    const appClick = vi.fn()
    button.addEventListener('click', appClick)
    agent.set('direct', null, { armed: true, on: true })

    // The icon inside the button means the button.
    pointerDown(main.querySelector('path')!)
    button.click()
    expect(appClick).not.toHaveBeenCalled()
    const [first] = picked(agent)
    expect(first.pick).toMatchObject({
      n: 1,
      rect: null,
      target: {
        label: 'Button · Save',
        role: 'button',
        tag: 'button',
        selector: '#save',
        route: '/',
        text: 'Save',
        classes: 'btn btn-primary',
        nearestHeading: 'Deals',
        region: 'main',
        dataAttrs: { 'data-variant': 'solid' }
      }
    })
    expect(first.pick.target.html).toBe(
      '<button id="save" class="btn btn-primary" data-variant="solid">Save <svg></svg></button>'
    )
    expect(hint()).toContain('1 picked · say in chat what to change')

    pointerDown(button)
    expect(events(agent).slice(-1)[0]).toEqual({ seq: 2, type: 'unpick', id: first.pick.id })
    expect(hint()).toContain('Click anything you want to change')
  })

  it('lets the app have clicks made with Alt held', () => {
    const button = add('<button>Save</button>')
    const appClick = vi.fn()
    button.addEventListener('click', appClick)
    agent.set('direct', null, { armed: true, on: true })
    pointerDown(button, { altKey: true })
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, altKey: true }))
    expect(appClick).toHaveBeenCalledOnce()
    expect(events(agent)).toEqual([])
  })

  it('clips any region on Shift+drag, showing its size, instead of picking', () => {
    const card = add('<section><h3>Pipeline</h3><p>12 open deals</p></section>')
    agent.set('direct', null, { armed: true, on: true })
    pointerDown(card.querySelector('p')!, { shiftKey: true, clientX: 30, clientY: 40 })
    window.dispatchEvent(
      new MouseEvent('pointermove', { clientX: 230, clientY: 160, bubbles: true })
    )
    const clip = shadow()!.querySelector('.clip') as HTMLElement
    expect(clip.style.display).toBe('block')
    expect([clip.style.left, clip.style.top, clip.style.width, clip.style.height]).toEqual([
      '30px',
      '40px',
      '200px',
      '120px'
    ])
    expect(clip.textContent).toBe('200 × 120')

    // Dragged up and to the left, past the edge of the view: it's the same region, kept in view.
    dragTo(-50, 10)
    expect(clip.style.display).toBe('none')
    expect(events(agent)).toEqual([
      {
        seq: 1,
        type: 'capture',
        capture: { id: expect.any(String), label: 'Clip', rect: { x: 0, y: 10, w: 30, h: 30 } }
      }
    ])
    expect(picked(agent)).toEqual([])
  })

  it('lets go of a clip on Escape, and of one too small to see', () => {
    agent.set('direct', null, { armed: true, on: true })
    pointerDown(document.body, { shiftKey: true, clientX: 10, clientY: 10 })
    window.dispatchEvent(
      new MouseEvent('pointermove', { clientX: 100, clientY: 100, bubbles: true })
    )
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
    // Escape let go of the clip, not of picking.
    expect(agent.peek()?.on).toBe(true)
    expect((shadow()!.querySelector('.clip') as HTMLElement).style.display).toBe('none')
    dragTo(100, 100)

    pointerDown(document.body, { shiftKey: true, clientX: 10, clientY: 10 })
    dragTo(14, 30)
    expect(events(agent)).toEqual([])
  })

  it('reports only the events after the one the host last saw, on the same page', () => {
    agent.set('direct', null, { armed: true, on: false })
    shortcut()
    pointerDown(add('<button>One</button>'))
    pointerDown(add('<button>Two</button>'))
    const page = agent.peek()!.page
    expect(agent.peek({ page, since: 2 })!.events.map((e) => e.seq)).toEqual([3])
    expect(agent.peek({ page, since: 3 })!.events).toEqual([])
    // A host that saw another page load gets everything this page has.
    expect(agent.peek({ page: 'p-old', since: 3 })!.events.map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('stops at eight picks, and says so', () => {
    agent.set('direct', null, { armed: true, on: true })
    for (let i = 0; i < 9; i++) pointerDown(add(`<button>B${i}</button>`))
    expect(picked(agent)).toHaveLength(8)
    expect(shadow()!.querySelector('.toast')?.textContent).toBe(
      'You can pick up to 8 elements at a time'
    )
  })

  it('hides the highlight for a capture, reports where each pick and clip is, and flashes a clip', () => {
    const button = add('<button>Save</button>')
    rect(button, { x: 40, y: 50, w: 80, h: 32 })
    agent.set('direct', null, { armed: true, on: true })
    pointerDown(button)
    const id = picked(agent)[0].pick.id
    expect(agent.command({ op: 'prepareCapture', requestId: 'r1', ids: [id, 'gone'] })).toEqual({
      accepted: true
    })
    const layout = agent.peek()!.results.r1 as PickCaptureLayout
    expect(layout).toEqual({
      viewport: { w: window.innerWidth, h: window.innerHeight, dpr: 1 },
      frame: { x: 0, y: 0 },
      rects: { [id]: { x: 40, y: 50, w: 80, h: 32 } }
    })
    const layer = shadow()!.querySelector('.layer')!
    expect(layer.classList.contains('capturing')).toBe(true)

    agent.command({ op: 'endCapture', flash: id })
    expect(layer.classList.contains('capturing')).toBe(false)
    expect(shadow()!.querySelector('.flash')).not.toBeNull()

    // A clip's screenshot says it went to chat.
    pointerDown(document.body, { shiftKey: true, clientX: 100, clientY: 120 })
    dragTo(400, 320)
    const capture = events(agent).slice(-1)[0] as Extract<PickEvent, { type: 'capture' }>
    agent.command({ op: 'prepareCapture', requestId: 'r2', ids: [capture.capture.id] })
    expect((agent.peek()!.results.r2 as PickCaptureLayout).rects).toEqual({
      [capture.capture.id]: { x: 100, y: 120, w: 300, h: 200 }
    })
    agent.command({ op: 'endCapture', flash: capture.capture.id })
    expect(shadow()!.querySelector('.toast')?.textContent).toBe('Clip added to chat')
  })

  it('outlines a pick for a while when its chip is hovered, even with picking off', () => {
    const button = add('<button>Save</button>')
    rect(button, { x: 40, y: 50, w: 80, h: 32 })
    agent.set('direct', null, { armed: true, on: true })
    pointerDown(button)
    const id = picked(agent)[0].pick.id
    shortcut()
    expect(document.getElementById(HOST_ID)).toBeNull()

    agent.command({ op: 'focus', id })
    flushFrames()
    const focus = shadow()!.querySelector('.focus') as HTMLElement
    expect(focus.style.display).toBe('block')
    expect(focus.style.left).toBe('39px')

    agent.command({ op: 'focus', id: null })
    flushFrames()
    expect(document.getElementById(HOST_ID)).toBeNull()
  })

  it('finds the host’s picks again after a reload, keeping its numbers', () => {
    add('<button id="save">Save</button>')
    const other = add('<a href="/deals">Deals</a>')
    agent.set('direct', null, {
      armed: true,
      on: true,
      picks: [
        { id: 'k1', n: 1, selector: '#save', route: '/' },
        { id: 'k2', n: 2, selector: '#elsewhere', route: '/other' }
      ]
    })
    expect(hint()).toContain('2 picked · say in chat what to change')
    pointerDown(document.getElementById('save')!)
    expect(events(agent)).toEqual([{ seq: 1, type: 'unpick', id: 'k1' }])
    pointerDown(other)
    expect(picked(agent)[0].pick).toMatchObject({ n: 2, target: { label: 'Link · Deals' } })
  })

  it('names elements the way people see them', () => {
    const { labelOf } = agent.__test
    expect(labelOf(add('<h1>Revenue</h1>'))).toBe('Heading · Revenue')
    expect(labelOf(add('<input placeholder="Search deals">'))).toBe('Field · Search deals')
    expect(labelOf(add('<img alt="Company logo">'))).toBe('Image · Company logo')
    expect(labelOf(add('<button aria-label="Close dialog">×</button>'))).toBe(
      'Button · Close dialog'
    )
    expect(
      labelOf(
        add('<div data-graphein-spec=\'{"type":"bar","title":"Deals by stage"}\'><svg></svg></div>')
      )
    ).toBe('Chart · Deals by stage')
    expect(labelOf(add('<ul><li>One</li><li>Two</li></ul>'))).toBe('List · One')
  })
})

function message(target: Window, origin: string, source: unknown, data: Packet): void {
  target.dispatchEvent(new MessageEvent('message', { origin, source: source as Window, data }))
}

describe('Touch Up agent as the Fabric shell’s relay', () => {
  let agent: Agent
  let appWin: { postMessage: ReturnType<typeof vi.fn> }
  const sent = (): Packet[] => appWin.postMessage.mock.calls.map((c) => c[0] as Packet)

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    document.body.innerHTML = ''
    agent = install()
    appWin = { postMessage: vi.fn() }
  })
  afterEach(() => {
    agent.set('direct', null, { armed: false })
    delete (window as unknown as { __fabricatorPick?: unknown }).__fabricatorPick
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('arms the app frame once it says hello, and mirrors its state', () => {
    agent.set('relay', APP_ORIGIN, { armed: true, on: true, picks: [] })
    expect(document.getElementById(HOST_ID)).toBeNull()
    expect(agent.peek()).toMatchObject({ page: null, armed: true, on: true, events: [] })

    message(window, APP_ORIGIN, appWin, { ns: MSG, evt: 'hello' })
    expect(sent()).toEqual([{ ns: MSG, cmd: 'set', options: { armed: true, on: true, picks: [] } }])
    expect(appWin.postMessage.mock.calls[0][1]).toBe(APP_ORIGIN)

    const status = {
      v: 1,
      page: 'p-app',
      armed: true,
      on: true,
      seq: 2,
      events: [
        { seq: 1, type: 'enter' },
        { seq: 2, type: 'exit' }
      ],
      results: {},
      route: '/',
      viewport: { w: 800, h: 600, dpr: 1 }
    }
    message(window, APP_ORIGIN, appWin, { ns: MSG, evt: 'state', status })
    expect(agent.peek({ page: 'p-app', since: 1 })).toMatchObject({
      page: 'p-app',
      events: [{ seq: 2, type: 'exit' }]
    })
  })

  it('ignores hellos and state from other origins', () => {
    agent.set('relay', APP_ORIGIN, { armed: true, on: false })
    const other = { postMessage: vi.fn() }
    message(window, 'https://evil.example', other, { ns: MSG, evt: 'hello' })
    expect(other.postMessage).not.toHaveBeenCalled()
    message(window, APP_ORIGIN, appWin, { ns: MSG, evt: 'hello' })
    message(window, 'https://evil.example', appWin, {
      ns: MSG,
      evt: 'state',
      status: { page: 'evil', events: [] }
    })
    expect(agent.peek()?.page).toBeNull()
  })

  it('forwards commands, and the shortcut while the shell has the keyboard', () => {
    agent.set('relay', APP_ORIGIN, { armed: true, on: false })
    // Nothing to forward to until the app frame says hello.
    expect(agent.command({ op: 'toggle' })).toEqual({ accepted: false })
    message(window, APP_ORIGIN, appWin, { ns: MSG, evt: 'hello' })
    expect(agent.command({ op: 'focus', id: 'k1' })).toEqual({ accepted: true })
    expect(shortcut().defaultPrevented).toBe(true)
    expect(
      sent()
        .filter((p) => p.cmd === 'command')
        .map((p) => p.command)
    ).toEqual([{ op: 'focus', id: 'k1' }, { op: 'toggle' }])
  })

  it('adds where the app frame sits to capture layouts, so the host can crop', () => {
    const iframe = document.createElement('iframe')
    iframe.style.border = '0'
    document.body.appendChild(iframe)
    rect(iframe, { x: 240, y: 56, w: 800, h: 600 })
    agent.set('relay', APP_ORIGIN, { armed: true, on: true })
    const frameWin = iframe.contentWindow!
    vi.spyOn(frameWin, 'postMessage').mockImplementation(() => {})
    message(window, APP_ORIGIN, frameWin, { ns: MSG, evt: 'hello' })
    const layout = {
      viewport: { w: 800, h: 600, dpr: 1 },
      frame: null,
      rects: { k1: { x: 10, y: 20, w: 100, h: 40 } }
    }
    message(window, APP_ORIGIN, frameWin, {
      ns: MSG,
      evt: 'state',
      status: {
        v: 1,
        page: 'p-app',
        armed: true,
        on: true,
        seq: 0,
        events: [],
        results: { cap: layout },
        route: '/',
        viewport: layout.viewport
      }
    })
    expect(agent.peek()?.results.cap).toMatchObject({
      frame: { x: 240, y: 56 },
      rects: { k1: { x: 10, y: 20 } },
      viewport: { w: window.innerWidth }
    })
  })
})

describe('Touch Up agent in the app’s iframe', () => {
  let iframe: HTMLIFrameElement
  let frame: Window & typeof globalThis
  let posted: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    frame = iframe.contentWindow! as Window & typeof globalThis
    const doc = iframe.contentDocument!
    doc.open()
    doc.write('<html><head></head><body><button>Save</button></body></html>')
    doc.close()
    posted = vi.spyOn(frame.top!, 'postMessage').mockImplementation(() => {})
    new Function(
      'window',
      'document',
      'location',
      'getComputedStyle',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'CSS',
      SRC
    )(
      frame,
      doc,
      frame.location,
      frame.getComputedStyle.bind(frame),
      () => 1,
      () => {},
      frame.CSS
    )
    vi.advanceTimersByTime(0)
  })
  afterEach(() => {
    iframe.remove()
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const packets = (): Packet[] => posted.mock.calls.map((c: unknown[]) => c[0] as Packet)
  const arm = (origin: string, source: unknown = frame.top): void => {
    frame.dispatchEvent(
      new MessageEvent('message', {
        origin,
        source: source as Window,
        data: { ns: MSG, cmd: 'set', options: { armed: true, on: true } }
      })
    )
  }

  it('says hello to the top frame, and picks once the Fabric portal arms it', () => {
    expect(packets().some((p) => p.evt === 'hello')).toBe(true)
    arm(PORTAL)
    expect(iframe.contentDocument!.getElementById(HOST_ID)).not.toBeNull()
    const state = packets()
      .filter((p) => p.evt === 'state')
      .pop()!
    expect(state).toMatchObject({ status: { armed: true, on: true } })
    // State only goes back to the portal.
    expect(
      posted.mock.calls
        .filter((c: unknown[]) => (c[0] as Packet).evt === 'state')
        .every((c: unknown[]) => c[1] === PORTAL)
    ).toBe(true)
  })

  it('accepts other Fabric and Power BI portal hosts', () => {
    arm('https://msit.powerbi.com')
    expect(iframe.contentDocument!.getElementById(HOST_ID)).not.toBeNull()
  })

  it('ignores commands that do not come from the top frame', () => {
    arm(PORTAL, null)
    expect(iframe.contentDocument!.getElementById(HOST_ID)).toBeNull()
  })

  // Any page loaded in the preview could frame a site; only the Fabric portal may drive it.
  it.each([
    'https://evil.example',
    'http://app.fabric.microsoft.com',
    'https://fabric.microsoft.com.evil.example'
  ])('ignores a top frame at %s', (origin) => {
    arm(origin)
    frame.dispatchEvent(
      new MessageEvent('message', {
        origin,
        source: frame.top as Window,
        data: {
          ns: MSG,
          cmd: 'command',
          command: { op: 'prepareCapture', requestId: 'r', ids: [] }
        }
      })
    )
    expect(iframe.contentDocument!.getElementById(HOST_ID)).toBeNull()
    expect(packets().some((p) => p.evt === 'state')).toBe(false)
  })
})
