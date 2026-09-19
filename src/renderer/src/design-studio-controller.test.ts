import { readFileSync } from 'fs'
import { resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DesignCommand,
  DesignCommandBody,
  DesignConnection,
  DesignJson,
  DesignSnapshot,
  DesignTarget,
  DesignTransaction
} from '../../shared/design'

const SOURCE = readFileSync(
  resolve(process.cwd(), 'src-tauri', 'src', 'services', 'design_agent.js'),
  'utf8'
)
const HOST = '__rayfin_design_host'
const IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO6kAAAAASUVORK5CYII='
const originalHitTest = document.elementFromPoint

interface Controller {
  __v: number
  disable(): void
  peek(): { changeCount: number }
  setTheme(theme: Record<string, unknown>): void
  studio: {
    connect(options: DesignConnection): DesignSnapshot
    peek(sessionId: string): DesignSnapshot | null
    command(command: DesignCommand): DesignSnapshot
    disconnect(sessionId: string): void
  }
}

let controller: Controller
let sequence = 0

function open(
  html = '<main id="app"><h1 id="title">Original title</h1><button id="button">Save</button></main>',
  overrides: Partial<DesignConnection> = {}
): DesignSnapshot {
  controller?.studio.disconnect('session')
  document.body.innerHTML = html
  delete (window as unknown as { __rayfinDesign?: Controller }).__rayfinDesign
  document.elementFromPoint = originalHitTest
  new Function(SOURCE)()
  controller = (window as unknown as { __rayfinDesign: Controller }).__rayfinDesign
  return controller.studio.connect({
    sessionId: 'session',
    appUrl: window.location.href,
    embedded: false,
    history: [],
    cursor: 0,
    revision: 0,
    ...overrides
  })
}

function peek(): DesignSnapshot {
  return controller.studio.peek('session')!
}

function command(body: DesignCommandBody): DesignSnapshot {
  const state = peek()
  return controller.studio.command({
    ...body,
    sessionId: 'session',
    documentId: state.documentId,
    commandId: `cmd-${++sequence}`
  })
}

function target(selector: string): DesignTarget {
  const found = peek().layers.find((layer) => layer.selector === selector)
  expect(found, `layer ${selector}`).toBeTruthy()
  return found!
}

function select(selector: string, toggle = false): DesignSnapshot {
  return command({ type: 'select', target: target(selector), toggle })
}

function shadow(): ShadowRoot {
  return document.getElementById(HOST)!.shadowRoot!
}

function mouse(
  el: EventTarget,
  type: string,
  x: number,
  y: number,
  extras: MouseEventInit = {}
): void {
  el.dispatchEvent(
    new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, ...extras })
  )
}

function bounds(el: Element, left: number, top: number, width: number, height: number): void {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({})
  } as DOMRect)
}

describe('Design Studio — serializable page engine', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1)
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    window.history.replaceState(null, '', '/studio?mode=local#canvas')
    document.head.querySelectorAll('[data-test-style]').forEach((node) => node.remove())
    document.documentElement.removeAttribute('style')
    sequence = 0
  })

  afterEach(() => {
    controller?.studio.disconnect('session')
    controller?.disable()
    delete (window as unknown as { __rayfinDesign?: Controller }).__rayfinDesign
    document.elementFromPoint = originalHitTest
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps v5 dormant, returns the full contract, and mounts handles without legacy chrome or a perpetual rAF', () => {
    const state = open()
    expect(controller.__v).toBe(5)
    expect(controller.peek().changeCount).toBe(0)
    expect(state).toMatchObject({
      protocol: 1,
      sessionId: 'session',
      revision: 0,
      enabled: true,
      route: '/studio?mode=local#canvas',
      tool: 'select',
      compare: false,
      cursor: 0,
      selection: [],
      history: [],
      conflicts: [],
      acknowledged: [],
      viewport: { width: window.innerWidth, height: window.innerHeight }
    })
    for (const key of ['layers', 'tokens', 'breakpoints'])
      expect(Array.isArray(state[key as keyof DesignSnapshot])).toBe(true)
    expect(state.documentId).not.toBe('')
    expect((shadow().querySelector('.tb') as HTMLElement).style.display).toBe('none')
    expect(shadow().querySelector('.legend')).toBeNull()
    const selected = select('#button')
    expect(selected.selection[0]).toMatchObject({
      tag: 'button',
      label: 'Button · Save',
      textEditable: true,
      ownText: 'Save',
      canContain: false
    })
    expect(selected.selection[0].parent?.selector).toBe('#app')
    expect(selected.selection[0].styles).toHaveProperty('display')
    expect(shadow().querySelectorAll('.hnd')).toHaveLength(3)
    expect((shadow().querySelector('.insp') as HTMLElement).style.display).toBe('none')
    expect(selected.revision).toBe(0)
    expect(requestAnimationFrame).not.toHaveBeenCalled()
    expect(controller.studio.peek('missing')).toBeNull()
    controller.studio.disconnect('session')
    expect(controller.studio.peek('session')).toBeNull()
    expect(document.getElementById(HOST)).toBeNull()
  })

  it('repaints Studio chrome with the existing host theme and scale API without changing the app or journal', () => {
    open()
    select('#button')
    command({ type: 'style', values: { 'border-radius': '0.5rem' } })
    const before = peek()
    const app = document.body.innerHTML
    const handles = Array.from(shadow().querySelectorAll('.hnd'))
    controller.setTheme({ accent: '#4f46e5', panel: '#ffffff', txt: '#111111', scale: 1.5 })
    const css = shadow().querySelector('style')!.textContent!
    expect(css).toContain('#4f46e5')
    expect(css).toContain('--fs-base:20px')
    expect(css).toContain('--icon:24px')
    expect(Array.from(shadow().querySelectorAll('.hnd'))).toEqual(handles)
    expect((shadow().querySelector('.tb') as HTMLElement).style.display).toBe('none')
    expect((shadow().querySelector('.insp') as HTMLElement).style.display).toBe('none')
    expect(shadow().querySelector('.legend')).toBeNull()
    expect(document.body.innerHTML).toBe(app)
    expect(peek().history).toEqual(before.history)
    expect(peek().cursor).toBe(before.cursor)
    expect(peek().revision).toBe(before.revision)
    expect(controller.peek().changeCount).toBe(0)
  })

  it.each(['compare', 'capture'] as const)(
    'keeps %s chrome suppressed during host theme updates',
    (mode) => {
      open()
      select('#title')
      command({ type: 'style', values: { color: 'red' } })
      command({ type: mode, enabled: true })
      const before = peek()
      controller.setTheme({ accent: '#2563eb', panel: '#18181b', txt: '#ffffff', scale: 1.25 })
      expect(document.getElementById(HOST)!.style.display).toBe('none')
      expect(peek().history).toEqual(before.history)
      expect(peek().revision).toBe(before.revision)
      command({ type: mode, enabled: false })
      expect(document.getElementById(HOST)!.style.display).toBe('')
      expect((shadow().querySelector('.tb') as HTMLElement).style.display).toBe('none')
      expect((shadow().querySelector('.insp') as HTMLElement).style.display).toBe('none')
    }
  )

  it('updates an active text gesture’s chrome without replacing its nodes or committing the text', () => {
    open('<button id="button"><svg id="icon"></svg>Save</button>')
    const button = document.getElementById('button')!
    const icon = document.getElementById('icon')!
    document.elementFromPoint = vi.fn(() => button)
    mouse(button, 'dblclick', 10, 10)
    const editor = button.querySelector<HTMLElement>('[data-rayfin-studio-text]')!
    editor.textContent = 'Still editing'
    controller.setTheme({ accent: '#4f46e5', scale: 1.5 })
    expect(button.querySelector('[data-rayfin-studio-text]')).toBe(editor)
    expect(document.getElementById('icon')).toBe(icon)
    expect(editor.style.outlineColor).toBe('rgb(79, 70, 229)')
    expect(peek().history).toEqual([])
    expect(peek().revision).toBe(0)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(button.textContent).toBe('Save')
  })

  it('acknowledges errors and idempotent commands without allowing stale identities to mutate DOM or history', () => {
    open()
    select('#title')
    const envelope: DesignCommand = {
      type: 'style',
      values: { color: 'red' },
      sessionId: 'session',
      documentId: peek().documentId,
      commandId: 'once'
    }
    const accepted = controller.studio.command(envelope)
    expect(accepted.error).toBeUndefined()
    expect(accepted.sessionId).toBe(envelope.sessionId)
    expect(accepted.documentId).toBe(envelope.documentId)
    expect(accepted.acknowledged).toContain('once')
    expect(controller.studio.command(envelope).history).toHaveLength(1)
    const before = document.body.innerHTML
    for (const stale of [
      { ...envelope, commandId: 'old-session', sessionId: 'old' },
      { ...envelope, commandId: 'old-document', documentId: 'old' }
    ]) {
      const rejected = controller.studio.command(stale)
      expect(rejected.error).toMatch(/stale/i)
      expect(rejected.acknowledged).toContain(stale.commandId)
      expect(rejected.sessionId).toBe(stale.sessionId)
      expect(rejected.documentId).toBe(stale.documentId)
      expect(rejected.enabled).toBe(false)
      expect(rejected.history).toEqual([])
      expect(document.body.innerHTML).toBe(before)
      expect(peek().revision).toBe(1)
    }
    const invalid = command({
      type: 'style',
      values: { color: 'url(https://example.invalid/track)' }
    })
    expect(invalid.error).toMatch(/unsafe/i)
    expect(invalid.history).toHaveLength(1)
  })

  it('records separate repeated edits, preserves units and !important, and truncates redo only on a new commit', () => {
    open('<div id="box" style="width:50% !important;padding:1.25rem">Box</div>')
    const box = document.getElementById('box')!
    select('#box')
    const first = command({ type: 'style', values: { width: '120px' } })
    const edit = first.history[0].edits[0]
    expect(edit).toMatchObject({
      kind: 'style',
      property: 'width',
      before: { value: '50%', priority: 'important' },
      after: { value: '120px', priority: 'important' }
    })
    expect(edit.before).toHaveProperty('source')
    expect(edit.after).toHaveProperty('context')
    command({ type: 'style', values: { width: '140px' } })
    expect(peek().history).toHaveLength(2)
    expect(command({ type: 'undo' }).cursor).toBe(1)
    expect(box.style.width).toBe('120px')
    command({ type: 'undo' })
    expect(box.style.width).toBe('50%')
    expect(box.style.getPropertyPriority('width')).toBe('important')
    command({ type: 'redo' })
    command({ type: 'style', values: { padding: '2rem' } })
    expect(peek().history).toHaveLength(2)
    expect(peek().cursor).toBe(2)
    expect(command({ type: 'redo' }).cursor).toBe(2)
    expect(JSON.parse(JSON.stringify(peek().history))).toEqual(peek().history)
  })

  it('groups optimistic continuous updates into one undo and cancels without changing revision', () => {
    open('<div id="box" style="opacity:0.75 !important">Box</div>')
    const box = document.getElementById('box')!
    select('#box')
    for (const opacity of ['0.5', '0.4', '0.3']) {
      const result = command({
        type: 'style',
        values: { opacity },
        gestureId: 'scrub',
        phase: 'preview'
      })
      expect(box.style.opacity).toBe(opacity)
      expect(result.revision).toBe(0)
      expect(result.history).toEqual([])
    }
    command({ type: 'style', values: {}, gestureId: 'scrub', phase: 'cancel' })
    expect(box.style.opacity).toBe('0.75')
    expect(box.style.getPropertyPriority('opacity')).toBe('important')
    command({ type: 'style', values: { opacity: '0.6' }, gestureId: 'scrub-2', phase: 'preview' })
    command({ type: 'style', values: { opacity: '0.2' }, gestureId: 'scrub-2', phase: 'commit' })
    expect(peek().history).toHaveLength(1)
    expect(peek().revision).toBe(1)
    command({ type: 'undo' })
    expect(box.style.opacity).toBe('0.75')
  })

  it('applies multi-selection as an atomic transaction and rejects unsupported mixed text edits before touching anything', () => {
    open(
      '<div id="row"><button id="a" style="padding:1rem">A</button><button id="b" style="padding:2em">B</button><img id="image" alt="Picture"></div>'
    )
    select('#a')
    select('#b', true)
    const result = command({ type: 'style', values: { padding: '12px', color: '#008080' } })
    expect(result.history).toHaveLength(1)
    expect(result.history[0].edits).toHaveLength(4)
    command({ type: 'undo' })
    expect(document.getElementById('a')!.style.padding).toBe('1rem')
    expect(document.getElementById('b')!.style.padding).toBe('2em')
    select('#image', true)
    const invalid = command({ type: 'text', value: 'Changed' })
    expect(invalid.error).toMatch(/own text/i)
    expect(document.getElementById('a')!.textContent).toBe('A')
    expect(invalid.cursor).toBe(0)
  })

  it('edits only own text and preserves nested nodes, listeners, and exact whitespace through undo and redo', () => {
    open(
      '<button id="button">  Save <svg id="icon"><path d="M0,0"></path></svg> now <span id="badge">3</span></button>'
    )
    const button = document.getElementById('button')!,
      icon = document.getElementById('icon')!,
      badge = document.getElementById('badge')!
    const listener = vi.fn()
    badge.addEventListener('custom', listener)
    const original = button.innerHTML
    select('#button')
    command({ type: 'text', value: 'Publish' })
    expect(button.textContent).toContain('Publish')
    expect(document.getElementById('icon')).toBe(icon)
    expect(document.getElementById('badge')).toBe(badge)
    command({ type: 'undo' })
    expect(button.innerHTML).toBe(original)
    command({ type: 'redo' })
    badge.dispatchEvent(new Event('custom'))
    expect(listener).toHaveBeenCalledOnce()
    expect(document.getElementById('badge')).toBe(badge)
  })

  it('supports direct text gestures on icon-bearing buttons, with Escape cancelling and Enter committing one transaction', () => {
    open('<button id="button"><svg id="icon"></svg>Save</button>')
    const button = document.getElementById('button')!,
      icon = document.getElementById('icon')!
    document.elementFromPoint = vi.fn(() => button)
    mouse(button, 'dblclick', 10, 10)
    let editable = button.querySelector('[data-rayfin-studio-text]')!
    expect(editable).toBeTruthy()
    editable.textContent = 'Cancel this'
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    )
    expect(button.textContent).toBe('Save')
    expect(peek().history).toEqual([])
    mouse(button, 'dblclick', 10, 10)
    editable = button.querySelector('[data-rayfin-studio-text]')!
    editable.textContent = 'Publish'
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    )
    expect(button.textContent).toBe('Publish')
    expect(peek().history).toHaveLength(1)
    command({ type: 'undo' })
    expect(button.textContent).toBe('Save')
    expect(document.getElementById('icon')).toBe(icon)
  })

  it('commits native text when switching Select to Interact before the host flushes a metadata-advanced revision', () => {
    open('<button id="button"><svg id="icon"></svg>Save</button>', { revision: 42 })
    const button = document.getElementById('button')!
    const icon = document.getElementById('icon')!
    document.elementFromPoint = vi.fn(() => button)
    mouse(button, 'dblclick', 10, 10)
    button.querySelector('[data-rayfin-studio-text]')!.textContent = 'Publish'
    const flushed = command({ type: 'tool', tool: 'interact' })
    expect(flushed.error).toBeUndefined()
    expect(flushed.tool).toBe('interact')
    expect(flushed.revision).toBe(43)
    expect(flushed.history).toHaveLength(1)
    expect(flushed.history[0].edits[0]).toMatchObject({
      kind: 'text',
      before: { value: 'Save' },
      after: { value: 'Publish' }
    })
    expect(button.querySelector('[data-rayfin-studio-text]')).toBeNull()
    expect(document.getElementById('icon')).toBe(icon)
    expect(button.textContent).toBe('Publish')
  })

  it('keeps breakpoint projections scoped to the actual app viewport, preserving authored priorities', () => {
    vi.stubGlobal('innerWidth', 500)
    open('<div id="box" style="width:50% !important">Box</div>')
    select('#box')
    const result = command({
      type: 'style',
      values: { width: '100%' },
      scope: '(max-width: 600px)'
    })
    expect(result.error).toBeUndefined()
    expect(result.history[0].edits[0].scope).toBe('(max-width: 600px)')
    expect(document.getElementById('box')!.style.width).toBe('100%')
    vi.stubGlobal('innerWidth', 900)
    window.dispatchEvent(new Event('resize'))
    expect(document.getElementById('box')!.style.width).toBe('50%')
    expect(peek().viewport.width).toBe(900)
    vi.stubGlobal('innerWidth', 500)
    window.dispatchEvent(new Event('resize'))
    expect(document.getElementById('box')!.style.width).toBe('100%')
    command({ type: 'undo' })
    expect(document.getElementById('box')!.style.getPropertyPriority('width')).toBe('important')
  })

  it('rehydrates a JSON-only journal on fresh DOM, including text changes followed by styles', () => {
    const html = '<main id="app"><h1 id="title">Original title</h1></main>'
    open(html)
    select('#title')
    command({ type: 'text', value: 'Renamed title' })
    command({ type: 'style', values: { 'font-size': '2rem' } })
    const saved = JSON.parse(JSON.stringify(peek())) as DesignSnapshot
    const recovered = open(html, {
      history: saved.history,
      cursor: saved.cursor,
      revision: saved.revision,
      route: saved.route
    })
    expect(recovered.error).toBeUndefined()
    expect(recovered.conflicts).toEqual([])
    expect(recovered.history).toEqual(saved.history)
    expect(recovered.revision).toBe(2)
    expect(document.getElementById('title')!.textContent).toBe('Renamed title')
    expect(document.getElementById('title')!.style.fontSize).toBe('2rem')
    command({ type: 'undo' })
    expect(document.getElementById('title')!.textContent).toBe('Renamed title')
    command({ type: 'undo' })
    expect(document.getElementById('title')!.textContent).toBe('Original title')
  })

  it('reconciles a resolvable HMR replacement and conflicts on different content rather than editing a similar sibling', () => {
    open()
    select('#title')
    command({ type: 'text', value: 'Draft title' })
    const title = document.getElementById('title')!
    const replacement = document.createElement('h1')
    replacement.id = 'title'
    replacement.textContent = 'Original title'
    title.replaceWith(replacement)
    expect(peek().conflicts).toEqual([])
    expect(replacement.textContent).toBe('Draft title')
    expect(peek().selection[0]?.selector).toBe('#title')
    replacement.textContent = 'Different source title'
    expect(peek().conflicts).toHaveLength(1)
    expect(replacement.textContent).toBe('Different source title')
  })

  it('does not recover onto indistinguishable anonymous siblings, and supports explicit visual retargeting', () => {
    const html =
      '<main id="app"><button>Same</button><button>Same</button><button id="other">Other</button></main>'
    open(html)
    const anonymous = peek().layers.filter(
      (layer) => layer.tag === 'button' && layer.text === 'Same'
    )[0]
    command({ type: 'select', target: anonymous })
    command({ type: 'style', values: { color: 'red' } })
    const saved = peek()
    const recovered = open(html, {
      history: saved.history,
      cursor: saved.cursor,
      revision: saved.revision
    })
    expect(recovered.conflicts).toHaveLength(1)
    expect(document.querySelector('button')!.style.color).toBe('')
    const retargeted = command({
      type: 'retarget',
      transactionId: saved.history[0].id,
      target: target('#other')
    })
    expect(retargeted.error).toBeUndefined()
    expect(retargeted.conflicts).toEqual([])
    expect(document.getElementById('other')!.style.color).toBe('red')
  })

  it('preserves a multi-text transaction on fresh anonymous siblings and rolls the whole transaction back when one target is missing', () => {
    const html = '<main id="app"><button>First</button><button>Second</button></main>'
    open(html)
    const buttons = peek().layers.filter((layer) => layer.tag === 'button')
    command({ type: 'select', target: buttons[0] })
    command({ type: 'select', target: buttons[1], toggle: true })
    const changed = command({ type: 'text', value: 'Updated' })
    expect(changed.error).toBeUndefined()
    const recovered = open(html, {
      history: changed.history,
      cursor: 1,
      revision: changed.revision
    })
    expect(recovered.conflicts).toEqual([])
    expect(Array.from(document.querySelectorAll('button')).map((el) => el.textContent)).toEqual([
      'Updated',
      'Updated'
    ])
    open('<main id="app"><button id="a">First</button><button id="b">Second</button></main>')
    select('#a')
    select('#b', true)
    const styles = command({ type: 'style', values: { color: 'red' } })
    const conflict = open('<main id="app"><button id="a">First</button></main>', {
      history: styles.history,
      cursor: 1,
      revision: styles.revision
    })
    expect(conflict.conflicts).toHaveLength(1)
    expect(conflict.history).toEqual(styles.history)
    expect(document.getElementById('a')!.style.color).toBe('')
  })

  it('does not select a stale anonymous layer after a sibling deletion or recover it onto a matching after-text sibling', () => {
    const html = '<main id="app"><button>First</button><button>Updated</button></main>'
    open(html)
    const first = peek().layers.find((layer) => layer.tag === 'button' && layer.text === 'First')!
    command({ type: 'select', target: first })
    const changed = command({ type: 'text', value: 'Updated' })
    const recovered = open('<main id="app"><button>Updated</button></main>', {
      history: changed.history,
      cursor: 1,
      revision: 1
    })
    expect(recovered.conflicts).toHaveLength(1)
    expect(document.querySelector('button')!.textContent).toBe('Updated')
    open(html)
    const stale = peek().layers.find((layer) => layer.tag === 'button' && layer.text === 'First')!
    document.querySelector('button')!.remove()
    expect(command({ type: 'select', target: stale }).error).toMatch(/missing or ambiguous/i)
  })

  it('reverts one transaction without clobbering later changes and resets selected edits', () => {
    open()
    select('#title')
    const first = command({ type: 'style', values: { color: 'red' } }).history[0].id
    command({ type: 'style', values: { color: 'blue' } })
    const reverted = command({ type: 'revert', transactionId: first })
    expect(reverted.error).toBeUndefined()
    expect(reverted.conflicts).toEqual([])
    expect(document.getElementById('title')!.style.color).toBe('blue')
    command({ type: 'undo' })
    expect(document.getElementById('title')!.style.color).toBe('')
    command({ type: 'redo' })
    command({ type: 'reset' })
    expect(peek().history).toEqual([])
    expect(document.getElementById('title')!.style.color).toBe('')
  })

  it('gates drafts by pathname, search and hash and rejects stale document commands after navigation', () => {
    open()
    select('#title')
    command({ type: 'style', values: { color: 'red' } })
    const old = peek()
    window.history.pushState(null, '', '/studio?mode=other#canvas')
    const next = peek()
    expect(next.route).toBe('/studio?mode=other#canvas')
    expect(next.documentId).not.toBe(old.documentId)
    expect(next.conflicts).toHaveLength(1)
    expect(document.getElementById('title')!.style.color).toBe('')
    const rejected = controller.studio.command({
      type: 'text',
      value: 'No',
      sessionId: 'session',
      documentId: old.documentId,
      commandId: 'stale-route'
    })
    expect(rejected.error).toMatch(/stale/i)
    expect(document.getElementById('title')!.textContent).toBe('Original title')
    expect(next.revision).toBe(old.revision)
  })

  it('reorders real sibling nodes without cloning behavior, including multi-select and fresh recovery', () => {
    const html =
      '<div id="row" style="display:flex"><button id="a">A</button><button id="b">B</button><button id="c">C</button></div>'
    open(html)
    const a = document.getElementById('a')!,
      listener = vi.fn()
    a.addEventListener('custom', listener)
    select('#a')
    select('#b', true)
    const moved = command({ type: 'move', direction: 'next' })
    expect(moved.error).toBeUndefined()
    expect(Array.from(document.getElementById('row')!.children).map((el) => el.id)).toEqual([
      'c',
      'a',
      'b'
    ])
    expect(moved.history[0].edits[0].kind).toBe('reorder')
    command({ type: 'undo' })
    expect(document.getElementById('row')!.firstElementChild).toBe(a)
    a.dispatchEvent(new Event('custom'))
    expect(listener).toHaveBeenCalledOnce()
    command({ type: 'redo' })
    const saved = peek()
    const recovered = open(html, {
      history: saved.history,
      cursor: saved.cursor,
      revision: saved.revision
    })
    expect(recovered.conflicts).toEqual([])
    expect(Array.from(document.getElementById('row')!.children).map((el) => el.id)).toEqual([
      'c',
      'a',
      'b'
    ])
  })

  it('drags to reorder by default and cancels pointercancel rather than committing an invalid drag', () => {
    open(
      '<div id="row" style="display:flex"><article id="a">A</article><article id="b">B</article></div>'
    )
    const a = document.getElementById('a')!,
      b = document.getElementById('b')!
    bounds(a, 0, 0, 100, 50)
    bounds(b, 100, 0, 100, 50)
    select('#a')
    document.elementFromPoint = vi.fn((x) => (x < 100 ? a : b))
    mouse(a, 'pointerdown', 10, 10)
    mouse(window, 'pointermove', 180, 10, { buttons: 1 })
    expect(document.getElementById('row')!.lastElementChild).toBe(a)
    expect(a.style.transform).toBe('')
    mouse(window, 'pointercancel', 180, 10)
    expect(document.getElementById('row')!.firstElementChild).toBe(a)
    expect(peek().history).toEqual([])
    mouse(a, 'pointerdown', 10, 10)
    mouse(window, 'pointermove', 180, 10, { buttons: 1 })
    mouse(window, 'pointerup', 180, 10)
    expect(peek().history).toHaveLength(1)
    expect(document.getElementById('row')!.lastElementChild).toBe(a)
  })

  it('retains advanced transform movement and resize handles with gesture-level undo and Escape cancellation', () => {
    open('<div id="box" style="transform:rotate(5deg);width:50% !important">Box</div>')
    const box = document.getElementById('box')!
    bounds(box, 0, 0, 100, 50)
    document.elementFromPoint = vi.fn(() => box)
    select('#box')
    command({ type: 'freeMove', enabled: true })
    mouse(box, 'pointerdown', 10, 10)
    mouse(window, 'pointermove', 50, 30, { buttons: 1, ctrlKey: true })
    expect(box.style.transform).toContain('translate(40px, 20px)')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(box.style.transform).toBe('rotate(5deg)')
    expect(peek().history).toEqual([])
    select('#box')
    const handle = shadow().querySelector('.hnd')!
    mouse(handle, 'pointerdown', 100, 25)
    mouse(window, 'pointermove', 160, 25, { buttons: 1, ctrlKey: true })
    expect(box.style.width).toBe('160px')
    mouse(window, 'pointerup', 160, 25)
    expect(peek().history).toHaveLength(1)
    command({ type: 'undo' })
    expect(box.style.width).toBe('50%')
    expect(box.style.getPropertyPriority('width')).toBe('important')
  })

  it('groups repeated advanced keyboard nudges and cancels an in-progress resize on pointercancel', () => {
    open('<div id="box" style="width:4rem">Box</div>')
    const box = document.getElementById('box')!
    bounds(box, 0, 0, 64, 32)
    select('#box')
    command({ type: 'freeMove', enabled: true })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', repeat: true, bubbles: true })
    )
    expect(box.style.transform).toContain('translate(2px, 0px)')
    expect(peek().history).toEqual([])
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }))
    expect(peek().history).toHaveLength(1)
    command({ type: 'undo' })
    expect(box.style.transform).toBe('')
    mouse(shadow().querySelector('.hnd')!, 'pointerdown', 64, 16)
    mouse(window, 'pointermove', 120, 16, { buttons: 1, ctrlKey: true })
    expect(box.style.width).toBe('120px')
    mouse(window, 'pointercancel', 120, 16)
    expect(box.style.width).toBe('4rem')
    expect(peek().cursor).toBe(0)
  })

  it('cancels a gesture whose element was replaced instead of moving a different DOM node', () => {
    open('<div id="box">Box</div>')
    const box = document.getElementById('box')!
    document.elementFromPoint = vi.fn(() => box)
    select('#box')
    command({ type: 'freeMove', enabled: true })
    mouse(box, 'pointerdown', 10, 10)
    mouse(window, 'pointermove', 40, 20, { buttons: 1, ctrlKey: true })
    const replacement = document.createElement('div')
    replacement.id = 'box'
    replacement.textContent = 'Box'
    box.replaceWith(replacement)
    mouse(window, 'pointermove', 80, 30, { buttons: 1, ctrlKey: true })
    mouse(window, 'pointerup', 80, 30)
    expect(replacement.style.transform).toBe('')
    expect(peek().history).toEqual([])
    expect(peek().revision).toBe(0)
  })

  it('preserves app-written values when an optimistic control is cancelled or committed after a source change', () => {
    open('<div id="box" style="opacity:0.8">Box</div>')
    select('#box')
    command({ type: 'style', values: { opacity: '0.4' }, gestureId: 'opacity', phase: 'preview' })
    document.getElementById('box')!.style.opacity = '0.9'
    const result = command({
      type: 'style',
      values: { opacity: '0.2' },
      gestureId: 'opacity',
      phase: 'commit'
    })
    expect(result.error).toMatch(/app changed/i)
    expect(document.getElementById('box')!.style.opacity).toBe('0.9')
    expect(result.history).toEqual([])
    expect(result.revision).toBe(0)
  })

  it.each(['section', 'row', 'columns', 'card', 'heading', 'text', 'button', 'image'] as const)(
    'inserts the %s preset without AI, undoing and recovering its serialized prototype',
    (block) => {
      const html = '<main id="app"></main>'
      open(html)
      select('#app')
      const inserted = command({ type: 'insert', block, placement: 'inside' })
      expect(inserted.error).toBeUndefined()
      expect(document.getElementById('app')!.children).toHaveLength(1)
      expect(inserted.history[0].edits[0]).toMatchObject({ kind: 'insert', property: block })
      const saved = peek()
      command({ type: 'undo' })
      expect(document.getElementById('app')!.children).toHaveLength(0)
      const recovered = open(html, {
        history: saved.history,
        cursor: saved.cursor,
        revision: saved.revision
      })
      expect(recovered.conflicts).toEqual([])
      expect(document.getElementById('app')!.children).toHaveLength(1)
    }
  )

  it('duplicates only sanitized static prototypes and removes/restores original nodes without losing listeners', () => {
    open(
      '<main id="app"><button id="button" onclick="window.bad=true">Save <span id="badge">1</span></button></main>'
    )
    const button = document.getElementById('button')!,
      listener = vi.fn()
    button.addEventListener('custom', listener)
    select('#button')
    const duplicate = command({ type: 'duplicate' })
    expect(duplicate.error).toBeUndefined()
    expect(duplicate.notice).toMatch(/static visual prototypes/i)
    expect(document.querySelectorAll('#button')).toHaveLength(1)
    const clone = document.querySelector('[data-rayfin-studio-prototype]')!
    expect(clone.getAttribute('onclick')).toBeNull()
    expect(clone.querySelector('[id]')).toBeNull()
    clone.dispatchEvent(new Event('custom'))
    expect(listener).not.toHaveBeenCalled()
    command({ type: 'remove' })
    expect(button.isConnected).toBe(false)
    command({ type: 'undo' })
    expect(document.getElementById('button')).toBe(button)
    button.dispatchEvent(new Event('custom'))
    expect(listener).toHaveBeenCalledOnce()
  })

  it('stages image bytes only at runtime, restores responsive sources, and recovers via asset IDs', () => {
    const html =
      '<picture><source srcset="large.webp 2x"><img id="image" src="small.webp" srcset="small.webp 1x" sizes="50vw" alt="Original"></picture>'
    open(html)
    const image = document.getElementById('image')!
    select('#image')
    const changed = command({
      type: 'image',
      assetId: 'asset-1',
      dataUrl: IMAGE,
      alt: 'Replacement'
    })
    expect(changed.error).toBeUndefined()
    expect(changed.history[0].edits[0].after).toMatchObject({
      assetId: 'asset-1',
      alt: 'Replacement'
    })
    expect(image.getAttribute('src')).toBe(IMAGE)
    expect(image.hasAttribute('srcset')).toBe(false)
    expect(document.querySelector('source')!.hasAttribute('srcset')).toBe(false)
    const serialized = JSON.stringify(changed.history)
    expect(serialized).toContain('asset-1')
    expect(serialized).not.toContain('base64')
    command({ type: 'undo' })
    expect(image.getAttribute('src')).toBe('small.webp')
    expect(image.getAttribute('srcset')).toBe('small.webp 1x')
    expect(document.querySelector('source')!.getAttribute('srcset')).toBe('large.webp 2x')
    const recovered = open(html, {
      history: changed.history,
      cursor: changed.cursor,
      revision: changed.revision,
      assetPreviews: { 'asset-1': IMAGE }
    })
    expect(recovered.conflicts).toEqual([])
    expect(document.getElementById('image')!.getAttribute('src')).toBe(IMAGE)
    select('#image')
    command({ type: 'attribute', name: 'alt', value: 'Detailed description' })
    expect(document.getElementById('image')!.getAttribute('alt')).toBe('Detailed description')
    const missing = open(html, {
      history: changed.history,
      cursor: changed.cursor,
      revision: changed.revision
    })
    expect(missing.conflicts[0].message).toMatch(/asset preview unavailable/i)
    expect(document.getElementById('image')!.getAttribute('src')).toBe('small.webp')
  })

  it('recovers both native asset fields and earlier value-based image journals, rejecting conflicting asset IDs', () => {
    const html = '<img id="image" src="original.png" alt="Original">'
    open(html)
    select('#image')
    const saved = command({
      type: 'image',
      assetId: 'opaque-asset-id',
      dataUrl: IMAGE,
      alt: 'Updated'
    })
    for (const format of ['native', 'earlier']) {
      const history = JSON.parse(JSON.stringify(saved.history)) as DesignTransaction[]
      const after = history[0].edits[0].after as Record<string, DesignJson>
      if (format === 'native') delete after.value
      else {
        delete after.assetId
        delete after.alt
      }
      const restored = open(html, {
        history,
        cursor: 1,
        revision: 1,
        assetPreviews: { 'opaque-asset-id': IMAGE }
      })
      expect(restored.error).toBeUndefined()
      expect(restored.conflicts).toEqual([])
      expect(document.getElementById('image')!.getAttribute('src')).toBe(IMAGE)
      expect(document.getElementById('image')!.getAttribute('alt')).toBe('Updated')
    }
    const conflicting = JSON.parse(JSON.stringify(saved.history)) as DesignTransaction[]
    ;(conflicting[0].edits[0].after as Record<string, DesignJson>).assetId = 'different-asset'
    const rejected = open(html, {
      history: conflicting,
      cursor: 1,
      revision: 1,
      assetPreviews: { 'opaque-asset-id': IMAGE }
    })
    expect(rejected.error).toMatch(/conflicting image asset/i)
    expect(document.getElementById('image')!.getAttribute('src')).toBe('original.png')
  })

  it('recovers image and chart journals after native JSON serialization reorders object keys', () => {
    open(
      '<main id="app"><div id="chart"></div><img id="image" src="original.png" alt="Original"></main>'
    )
    document.getElementById('chart')!.setAttribute(
      'data-graphein-spec',
      JSON.stringify({
        type: 'bar',
        title: 'Sales',
        encoding: { x: { field: 'category' }, y: { field: 'amount' } },
        data: [{ category: 'A', amount: 1 }]
      })
    )
    const source = document.body.innerHTML
    select('#chart')
    command({ type: 'chart', patch: { type: 'pie', title: 'Updated sales' } })
    select('#image')
    const saved = command({
      type: 'image',
      assetId: 'asset-ordered',
      dataUrl: IMAGE,
      alt: 'Updated'
    })
    const sorted = JSON.parse(
      JSON.stringify(saved.history, (_key, value) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
          : value
      )
    ) as DesignTransaction[]
    const recovered = open(source, {
      history: sorted,
      cursor: saved.cursor,
      revision: 50,
      assetPreviews: { 'asset-ordered': IMAGE }
    })
    expect(recovered.error).toBeUndefined()
    expect(recovered.conflicts).toEqual([])
    expect(recovered.revision).toBe(50)
    expect(document.getElementById('image')!.getAttribute('src')).toBe(IMAGE)
    expect(
      JSON.parse(document.getElementById('chart')!.getAttribute('data-graphein-spec')!)
    ).toMatchObject({
      type: 'pie',
      title: 'Updated sales'
    })
  })

  it('does not serialize existing image bytes when clearing an inline background, and restores the original on undo', () => {
    const html = `<div id="box" style="background-image:url('${IMAGE}')">Box</div>`
    open(html)
    const original = document.getElementById('box')!.style.backgroundImage
    select('#box')
    const changed = command({ type: 'style', values: { 'background-image': 'none' } })
    expect(changed.error).toBeUndefined()
    expect(JSON.stringify(changed.history)).not.toContain('base64')
    expect(changed.history[0].edits[0].before).toHaveProperty('valueHash')
    command({ type: 'undo' })
    expect(document.getElementById('box')!.style.backgroundImage).toBe(original)
    const recovered = open(html, { history: changed.history, cursor: 1, revision: 1 })
    expect(recovered.conflicts).toEqual([])
    expect(document.getElementById('box')!.style.backgroundImage).toBe('none')
  })

  it('keeps transient blob image and background URLs out of durable history while preserving undo', () => {
    const blob = 'blob:http://localhost/source-image'
    open(
      `<main id="app"><img id="image" src="${blob}" alt="Original"><div id="box" style="background-image:url('${blob}')">Box</div></main>`
    )
    select('#box')
    command({ type: 'style', values: { 'background-image': 'none' } })
    select('#image')
    const changed = command({
      type: 'image',
      assetId: 'durable-asset',
      dataUrl: IMAGE,
      alt: 'Updated'
    })
    expect(changed.error).toBeUndefined()
    expect(changed.history[1].edits[0].after).toMatchObject({ assetId: 'durable-asset' })
    expect(changed.history[1].edits[0].before).toMatchObject({ value: { src: null } })
    expect(JSON.stringify(changed.history)).not.toContain('blob:')
    expect(JSON.stringify(changed.history)).not.toContain('base64')
    command({ type: 'undo' })
    expect(document.getElementById('image')!.getAttribute('src')).toBe(blob)
    command({ type: 'undo' })
    expect(document.getElementById('box')!.style.backgroundImage).toContain(blob)
  })

  it('rejects transient URI journal values before acknowledging an unpersistable edit', () => {
    open()
    select('#title')
    const result = command({ type: 'text', value: 'blob:http://localhost/not-durable' })
    expect(result.error).toMatch(/transient data\/blob URLs/i)
    expect(result.history).toEqual([])
    expect(result.revision).toBe(0)
    expect(document.getElementById('title')!.textContent).toBe('Original title')
  })

  it('discovers real CSS tokens, scope roots and breakpoints, and rejects invented token mappings', () => {
    const style = document.createElement('style')
    style.setAttribute('data-test-style', '')
    style.textContent =
      ':root{--accent:#008080}.theme{--radius:12px}@media (max-width: 700px){.theme{padding:8px}}'
    document.head.appendChild(style)
    open('<main id="app" class="theme"><button id="button">Save</button></main>')
    const radius = peek().tokens.find((token) => token.name === '--radius')!
    expect(radius.target.selector).toBe('#app')
    expect(peek().breakpoints).toContain('(max-width: 700px)')
    const changed = command({ type: 'theme', values: [{ token: radius, value: '1rem' }] })
    expect(changed.error).toBeUndefined()
    expect(document.getElementById('app')!.style.getPropertyValue('--radius')).toBe('1rem')
    expect(document.documentElement.style.getPropertyValue('--radius')).toBe('')
    expect(
      command({
        type: 'theme',
        values: [{ token: { ...radius, name: '--invented' }, value: 'red' }]
      }).error
    ).toMatch(/not discovered/i)
    command({ type: 'undo' })
    expect(document.getElementById('app')!.style.getPropertyValue('--radius')).toBe('')
  })

  it('uses chart compatibility, omits all data from snapshots/history, and keeps debug transient and clean captures', () => {
    open('<div id="container"><div id="chart"></div></div>')
    const chart = document.getElementById('chart')!
    const spec = {
      type: 'bar',
      title: 'Sales',
      encoding: { x: { field: 'region' }, y: { field: 'sales' } },
      data: [{ region: 'Secret row', sales: 42 }]
    }
    chart.setAttribute('data-graphein-spec', JSON.stringify(spec))
    select('#chart')
    const selected = peek().selection[0].chart!
    expect(selected.spec).not.toHaveProperty('data')
    expect(selected.types.find((type) => type.value === 'pie')?.enabled).toBe(true)
    expect(selected.types.find((type) => type.value === 'sankey')?.enabled).toBe(false)
    const converted = command({ type: 'chart', patch: { type: 'pie', title: 'Revenue' } })
    expect(converted.error).toBeUndefined()
    expect(JSON.stringify(converted.history)).not.toContain('Secret row')
    expect(JSON.parse(chart.getAttribute('data-graphein-spec')!).data).toEqual(spec.data)
    expect(JSON.parse(chart.getAttribute('data-graphein-spec')!).encoding.theta.field).toBe('sales')
    expect(command({ type: 'chart', patch: { type: 'sankey' } }).error).toMatch(/conversion/i)
    command({ type: 'debug', enabled: true })
    expect(JSON.parse(chart.getAttribute('data-graphein-spec')!).debug).toBe(true)
    expect(peek().history).toHaveLength(1)
    command({ type: 'capture', enabled: true })
    expect(JSON.parse(chart.getAttribute('data-graphein-spec')!).debug).toBeUndefined()
    expect(document.getElementById('container')!.style.position).toBe('')
    expect(document.getElementById(HOST)!.style.display).toBe('none')
    command({ type: 'capture', enabled: false })
    expect(document.getElementById(HOST)!.style.display).toBe('')
    expect((shadow().querySelector('.tb') as HTMLElement).style.display).toBe('none')
    command({ type: 'undo' })
    expect(JSON.parse(chart.getAttribute('data-graphein-spec')!)).toEqual(spec)
  })

  it('records sanitized optional restyles and generation in the same journal, with explicit failures', () => {
    open(
      '<main id="app"><h1 id="title">Original title</h1><button id="button">Save</button></main>'
    )
    select('#app')
    const restyled = command({
      type: 'restyle',
      patch: {
        styles: { padding: '2rem', position: 'absolute' },
        rules: [{ selector: 'h1', styles: { color: 'teal' } }]
      }
    })
    expect(restyled.error).toBeUndefined()
    expect(restyled.history[0].edits).toHaveLength(2)
    expect(document.getElementById('app')!.style.position).toBe('')
    const generated = command({
      type: 'generated',
      html: '<div id="unsafe" onclick="window.bad=true"><script>window.bad=true</script><p>Safe</p><img src="https://example.invalid/tracker"></div>'
    })
    expect(generated.error).toBeUndefined()
    const prototype = document.querySelector('[data-rayfin-studio-prototype]')!
    expect(prototype.querySelector('script')).toBeNull()
    expect(prototype.hasAttribute('id')).toBe(false)
    expect(prototype.hasAttribute('onclick')).toBe(false)
    expect(prototype.querySelector('img')!.hasAttribute('src')).toBe(false)
    expect(peek().history).toHaveLength(2)
    expect(command({ type: 'generated', html: '' }).error).toMatch(/nonempty/i)
    expect(peek().history).toHaveLength(2)
  })

  it('keeps comments and drawings undoable, bounded, recoverable, and never automatically verified', () => {
    const html = '<main id="app"><button id="button">Save</button></main>'
    open(html)
    select('#button')
    command({ type: 'comment', value: 'Improve contrast' })
    expect(shadow().querySelectorAll('.pin')).toHaveLength(1)
    command({ type: 'drawOptions', shape: 'rect', color: '#ff0000' })
    command({ type: 'tool', tool: 'draw' })
    const canvas = shadow().querySelector('svg[class="draw"]')!
    expect(canvas).toBeTruthy()
    mouse(canvas, 'pointerdown', 10, 10)
    mouse(window, 'pointermove', 80, 60, { buttons: 1 })
    mouse(window, 'pointerup', 80, 60)
    const saved = peek()
    expect(saved.history).toHaveLength(2)
    expect(saved.history[1].edits[0].kind).toBe('annotation')
    expect(shadow().querySelector('[data-studio-drawing] rect')).toBeTruthy()
    command({ type: 'undo' })
    expect(shadow().querySelector('[data-studio-drawing]')).toBeNull()
    const recovered = open(html, {
      history: saved.history,
      cursor: saved.cursor,
      revision: saved.revision
    })
    expect(recovered.conflicts).toEqual([])
    expect(shadow().querySelector('.pin')).toBeTruthy()
    expect(shadow().querySelector('[data-studio-drawing] rect')).toBeTruthy()
    const verified = command({ type: 'verify', history: saved.history, cursor: saved.cursor })
    expect(verified.verification?.every((item) => !item.ok)).toBe(true)
  })

  it('passes app interaction through Interact, Original and capture, preserving the current DOM when history is cleared', () => {
    open()
    const button = document.getElementById('button')!,
      clicked = vi.fn()
    button.addEventListener('click', clicked)
    select('#button')
    command({ type: 'style', values: { color: 'red' } })
    button.click()
    expect(clicked).not.toHaveBeenCalled()
    command({ type: 'tool', tool: 'interact' })
    button.click()
    expect(clicked).toHaveBeenCalledOnce()
    command({ type: 'tool', tool: 'select' })
    const before = peek()
    command({ type: 'compare', enabled: true })
    expect(button.style.color).toBe('')
    expect(peek().history).toEqual(before.history)
    expect(peek().revision).toBe(before.revision)
    expect(command({ type: 'style', values: { color: 'blue' } }).error).toMatch(/read-only/i)
    button.click()
    expect(clicked).toHaveBeenCalledTimes(2)
    command({ type: 'compare', enabled: false })
    expect(button.style.color).toBe('red')
    command({ type: 'capture', enabled: true })
    button.click()
    expect(clicked).toHaveBeenCalledTimes(3)
    command({ type: 'capture', enabled: false })
    command({ type: 'clear' })
    expect(button.style.color).toBe('red')
    expect(peek().history).toEqual([])
    controller.studio.disconnect('session')
    button.click()
    expect(clicked).toHaveBeenCalledTimes(4)
  })

  it('clears history without reverting accepted DOM, while Discard reverts only subsequent draft edits', () => {
    open()
    const title = document.getElementById('title')!
    const button = document.getElementById('button')!
    select('#title')
    command({ type: 'style', values: { color: 'red' } })
    command({ type: 'comment', value: 'Review this heading' })
    select('#app')
    command({ type: 'insert', block: 'heading', placement: 'inside' })
    const inserted = document.querySelector('[data-rayfin-studio-prototype]')!
    select('#button')
    command({ type: 'remove' })
    const before = peek()
    const cleared = command({ type: 'clear' })
    expect(cleared.history).toEqual([])
    expect(cleared.cursor).toBe(0)
    expect(cleared.revision).toBe(before.revision + 1)
    expect(title.style.color).toBe('red')
    expect(inserted.isConnected).toBe(true)
    expect(button.isConnected).toBe(false)
    expect(shadow().querySelector('.pin')).toBeNull()
    command({ type: 'undo' })
    expect(title.style.color).toBe('red')
    select('#title')
    const next = command({ type: 'style', values: { color: 'blue' } })
    expect(next.history[0].edits[0].before).toMatchObject({ value: 'red' })
    command({ type: 'discard' })
    expect(title.style.color).toBe('red')
    const checked = command({ type: 'verify', history: before.history, cursor: before.cursor })
    expect(checked.verification?.every((item) => !item.ok)).toBe(true)
    controller.studio.disconnect('session')
    expect(title.style.color).toBe('red')
    expect(inserted.isConnected).toBe(true)
    expect(button.isConnected).toBe(false)
  })

  it('verifies actual renamed source without mutating it, never counting projected DOM as persistence', () => {
    const html = '<main id="app"><h1 id="title">Original title</h1></main>'
    open(html)
    select('#title')
    command({ type: 'text', value: 'Source title' })
    command({ type: 'style', values: { color: 'red' } })
    const saved = peek()
    const projected = command({ type: 'verify', history: saved.history, cursor: saved.cursor })
    expect(projected.verification?.every((item) => !item.ok)).toBe(true)
    expect(projected.verification?.[0].message).toMatch(/projected DOM/i)
    open('<main id="app"><h1 id="title" style="color:red">Source title</h1></main>')
    const before = document.documentElement.outerHTML
    const verified = command({ type: 'verify', history: saved.history, cursor: saved.cursor })
    expect(verified.error).toBeUndefined()
    expect(verified.verification).toEqual(
      saved.history.map((tx) => ({ transactionId: tx.id, ok: true }))
    )
    expect(document.documentElement.outerHTML).toBe(before)
    expect(peek().history).toEqual([])
    expect(peek().revision).toBe(0)
  })

  it.each(['insert', 'reorder', 'remove', 'chart', 'theme'] as const)(
    'verifies %s against exact fresh source after-context, not the old overlay',
    (kind) => {
      open(
        '<main id="app" style="--accent:teal"><div id="a">First</div><div id="b">Second</div><div id="chart"></div></main>'
      )
      if (kind === 'insert') {
        select('#app')
        command({ type: 'insert', block: 'heading', placement: 'inside' })
      }
      if (kind === 'reorder') {
        select('#a')
        command({ type: 'move', direction: 'next' })
      }
      if (kind === 'remove') {
        select('#a')
        command({ type: 'remove' })
      }
      if (kind === 'chart') {
        document.getElementById('chart')!.setAttribute(
          'data-graphein-spec',
          JSON.stringify({
            type: 'bar',
            encoding: { x: { field: 'x' }, y: { field: 'y' } },
            data: [{ x: 'a', y: 1 }]
          })
        )
        select('#chart')
        command({ type: 'chart', patch: { type: 'pie', title: 'Updated chart' } })
      }
      if (kind === 'theme')
        command({
          type: 'theme',
          values: [
            { token: peek().tokens.find((token) => token.name === '--accent')!, value: 'red' }
          ]
        })
      const saved = peek()
      expect(saved.error).toBeUndefined()
      expect(saved.history).toHaveLength(1)
      const deployed = document.body.innerHTML.replace(/ data-rayfin-studio-[\w-]+="[^"]*"/g, '')
      open(deployed)
      const before = document.documentElement.outerHTML
      const verified = command({ type: 'verify', history: saved.history, cursor: saved.cursor })
      expect(verified.verification).toEqual([{ transactionId: saved.history[0].id, ok: true }])
      expect(document.documentElement.outerHTML).toBe(before)
    }
  )

  it('never completes or rolls back an active optimistic gesture merely to verify source', () => {
    open()
    select('#title')
    command({ type: 'style', values: { color: 'red' } })
    const saved = peek()
    command({
      type: 'style',
      values: { opacity: '0.3' },
      gestureId: 'unfinished',
      phase: 'preview'
    })
    const before = document.body.innerHTML
    const verified = command({ type: 'verify', history: saved.history, cursor: saved.cursor })
    expect(verified.verification?.every((item) => !item.ok)).toBe(true)
    expect(verified.history).toEqual(saved.history)
    expect(verified.revision).toBe(saved.revision)
    expect(document.body.innerHTML).toBe(before)
    command({ type: 'style', values: {}, gestureId: 'unfinished', phase: 'cancel' })
  })

  it('rejects corrupt recovery data, wrong app origins, and missing controllers with explicit errors rather than empty JSON', () => {
    open()
    controller.studio.disconnect('session')
    const invalid = controller.studio.connect({
      sessionId: 'session',
      appUrl: window.location.href,
      embedded: false,
      history: [{ id: 'bad' } as DesignTransaction],
      cursor: 1,
      revision: 1
    })
    expect(invalid.error).toMatch(/invalid/i)
    expect(invalid.protocol).toBe(1)
    expect(controller.studio.peek('session')).toBeNull()
    const wrong = controller.studio.connect({
      sessionId: 'session',
      appUrl: 'https://wrong.example',
      embedded: false,
      history: [],
      cursor: 0,
      revision: 0
    })
    expect(wrong.error).toMatch(/not the configured app origin/i)
    expect(document.getElementById(HOST)).toBeNull()
    const missing = controller.studio.command({
      type: 'undo',
      sessionId: 'session',
      documentId: 'none',
      commandId: 'missing'
    })
    expect(missing.error).toMatch(/not connected/i)
    expect(missing.acknowledged).toContain('missing')
  })

  it('never returns the previous session as a successful new connection when options are rejected', () => {
    open()
    select('#title')
    command({ type: 'style', values: { color: 'red' } })
    const before = peek()
    const html = document.body.innerHTML
    const rejected = controller.studio.connect({
      sessionId: 'new-session',
      appUrl: 'https://wrong.example',
      embedded: false,
      history: [],
      cursor: 0,
      revision: 0
    })
    expect(rejected).toMatchObject({
      protocol: 1,
      sessionId: 'new-session',
      documentId: '',
      enabled: false,
      history: []
    })
    expect(rejected.error).toMatch(/not the configured app origin/i)
    expect(controller.studio.peek('new-session')).toBeNull()
    expect(peek().sessionId).toBe('session')
    expect(peek().revision).toBe(before.revision)
    expect(document.body.innerHTML).toBe(html)
  })

  it('keeps document identity stable across ephemeral connection sessions and disconnect/reconnect', () => {
    const initial = open()
    select('#title')
    const saved = command({ type: 'style', values: { color: 'red' } })
    const renewed = controller.studio.connect({
      sessionId: 'connection-two',
      appUrl: window.location.href,
      embedded: false,
      history: saved.history,
      cursor: saved.cursor,
      revision: 70,
      route: saved.route
    })
    expect(renewed.error).toBeUndefined()
    expect(renewed.sessionId).toBe('connection-two')
    expect(renewed.documentId).toBe(initial.documentId)
    expect(renewed.revision).toBe(70)
    expect(renewed.history).toEqual(saved.history)
    expect(document.getElementById('title')!.style.color).toBe('red')
    controller.studio.disconnect('connection-two')
    const clean = controller.studio.connect({
      sessionId: 'connection-three',
      appUrl: window.location.href,
      embedded: false,
      history: [],
      cursor: 0,
      revision: 75
    })
    expect(clean.documentId).toBe(initial.documentId)
    expect(clean.sessionId).toBe('connection-three')
    expect(clean.history).toEqual([])
    expect(document.getElementById('title')!.style.color).toBe('')
    expect(controller.studio.peek('connection-two')).toBeNull()
    controller.studio.disconnect('connection-three')
  })

  it('keeps frozen post-Apply Interact review free of draft gestures before nonmutating verification', () => {
    open()
    select('#button')
    const saved = command({ type: 'text', value: 'Published label' })
    const deployed = document.body.innerHTML
    const reviewed = open(deployed, { revision: 100 })
    const button = document.getElementById('button')!
    document.elementFromPoint = vi.fn(() => button)
    const frozen = command({ type: 'tool', tool: 'interact' })
    expect(frozen.documentId).toBe(reviewed.documentId)
    expect(frozen.sessionId).toBe(reviewed.sessionId)
    mouse(button, 'pointerdown', 10, 10)
    mouse(button, 'dblclick', 10, 10)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(button.querySelector('[data-rayfin-studio-text]')).toBeNull()
    expect(peek().history).toEqual([])
    expect(peek().revision).toBe(100)
    const before = document.documentElement.outerHTML
    const verified = command({ type: 'verify', history: saved.history, cursor: saved.cursor })
    expect(verified.verification).toEqual([{ transactionId: saved.history[0].id, ok: true }])
    expect(verified.sessionId).toBe(reviewed.sessionId)
    expect(verified.documentId).toBe(reviewed.documentId)
    expect(verified.history).toEqual([])
    expect(verified.revision).toBe(100)
    expect(document.documentElement.outerHTML).toBe(before)
  })
})
