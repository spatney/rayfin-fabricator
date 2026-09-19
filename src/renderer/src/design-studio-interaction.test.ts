import { readFileSync } from 'fs'
import { resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DesignCommand,
  DesignCommandBody,
  DesignConnection,
  DesignSnapshot
} from '../../shared/design'

const SOURCE = readFileSync(
  resolve(process.cwd(), 'src-tauri', 'src', 'services', 'design_agent.js'),
  'utf8'
)
const HOST = '__rayfin_design_host'
const originalHit = document.elementFromPoint
const originalCaret = Object.getOwnPropertyDescriptor(document, 'caretRangeFromPoint')
const originalClientWidth = Object.getOwnPropertyDescriptor(document.documentElement, 'clientWidth')

interface Api {
  disable(): void
  setTheme(theme: Record<string, unknown>): void
  studio: {
    connect(options: DesignConnection): DesignSnapshot
    peek(sessionId: string): DesignSnapshot | null
    command(command: DesignCommand): DesignSnapshot
    disconnect(sessionId: string): void
  }
}

let api: Api
let hit: Element | null
let sequence = 0

function open(markup: string): DesignSnapshot {
  document.body.innerHTML = markup
  delete (window as unknown as { __rayfinDesign?: Api }).__rayfinDesign
  new Function(SOURCE)()
  api = (window as unknown as { __rayfinDesign: Api }).__rayfinDesign
  return api.studio.connect({
    sessionId: 'context',
    appUrl: location.href,
    embedded: false,
    history: [],
    cursor: 0,
    revision: 0
  })
}

function snapshot(): DesignSnapshot {
  return api.studio.peek('context')!
}
function command(body: DesignCommandBody): DesignSnapshot {
  const current = snapshot()
  return api.studio.command({
    ...body,
    sessionId: current.sessionId,
    documentId: current.documentId,
    commandId: `context-command-${++sequence}`
  })
}
function shadow(): ShadowRoot {
  return document.getElementById(HOST)!.shadowRoot!
}
function popup(): HTMLElement {
  return shadow().querySelector<HTMLElement>('.studio-context')!
}
function pointer(
  target: EventTarget,
  type: string,
  x = 230,
  y = 120,
  extras: MouseEventInit = {}
): void {
  target.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      composed: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      ...extras
    })
  )
}
function pick(element: Element): void {
  hit = element
  pointer(element, 'pointerdown')
}
function action(name: string): HTMLButtonElement {
  const button = popup().querySelector<HTMLButtonElement>(`[data-studio-action="${name}"]`)!
  expect(button).toBeTruthy()
  button.click()
  return button
}
function box(element: Element, left: number, top: number, width: number, height: number): void {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
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

describe('Design Studio — point-and-change interactions', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1)
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal('innerWidth', 1000)
    vi.stubGlobal('innerHeight', 800)
    history.replaceState(null, '', '/context')
    document.documentElement.removeAttribute('style')
    document.elementFromPoint = vi.fn(() => hit)
    hit = null
    sequence = 0
  })
  afterEach(() => {
    api?.studio.disconnect('context')
    api?.disable()
    delete (window as unknown as { __rayfinDesign?: Api }).__rayfinDesign
    document.elementFromPoint = originalHit
    if (originalCaret) Object.defineProperty(document, 'caretRangeFromPoint', originalCaret)
    else delete (document as unknown as { caretRangeFromPoint?: unknown }).caretRangeFromPoint
    if (originalClientWidth)
      Object.defineProperty(document.documentElement, 'clientWidth', originalClientWidth)
    else Reflect.deleteProperty(document.documentElement, 'clientWidth')
    window.getSelection()?.removeAllRanges()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it.each([
    [
      'text',
      '<h1 id="item" style="color:#20232a">A clear heading</h1>',
      ['Color', 'Size', 'Weight']
    ],
    [
      'button',
      '<button id="item" style="background:#7066a6;color:white">Save</button>',
      ['Color', 'Shape', 'Look']
    ],
    [
      'card',
      '<article id="item" style="padding:20px;background:#eeedf8"><h2>Card title</h2></article>',
      ['Color', 'Space', 'Look']
    ]
  ] as const)('shows only three relevant actions for a selected %s', (_kind, markup, actions) => {
    open(markup)
    const item = document.getElementById('item')!
    box(item, 200, 100, 300, 50)
    pick(item)
    expect(popup().hidden).toBe(false)
    expect(
      Array.from(popup().querySelectorAll('[data-studio-action]')).map((node) => node.textContent)
    ).toEqual(actions)
    expect(popup().querySelectorAll('[data-studio-action]')).toHaveLength(3)
    expect((shadow().querySelector('.tb') as HTMLElement).style.display).toBe('none')
    expect((shadow().querySelector('.insp') as HTMLElement).style.display).toBe('none')
    expect((shadow().querySelector('.hnd')!.parentElement as HTMLElement).style.display).toBe(
      'none'
    )
    expect(shadow().querySelector('.legend')).toBeNull()
    expect(snapshot().revision).toBe(0)
  })

  it('edits text on the first click at the app caret, preserving nested icons, badges and event-bearing children', () => {
    open(
      '<h1 id="item"> Hello <svg id="icon"><path d="M0,0"></path></svg> world <span id="badge">New</span></h1>'
    )
    const item = document.getElementById('item')!
    const icon = document.getElementById('icon')!
    const badge = document.getElementById('badge')!
    const listener = vi.fn()
    badge.addEventListener('custom', listener)
    const before = item.innerHTML
    const second = item.childNodes[2]
    Object.defineProperty(document, 'caretRangeFromPoint', {
      configurable: true,
      value: vi.fn(() => {
        const caret = document.createRange()
        caret.setStart(second, 3)
        caret.collapse(true)
        return caret
      })
    })
    pick(item)
    const editor = item.querySelector<HTMLElement>('[data-rayfin-studio-text]')!
    expect(editor).toBeTruthy()
    expect(window.getSelection()?.isCollapsed).toBe(true)
    expect(window.getSelection()?.anchorOffset).toBe(8)
    expect(window.getSelection()?.anchorNode?.parentNode).toBe(editor)
    pointer(window, 'pointermove', 350, 180, { buttons: 1 })
    expect(item.style.transform).toBe('')
    editor.textContent = 'A new heading'
    command({ type: 'tool', tool: 'interact' })
    expect(snapshot().history).toHaveLength(1)
    expect(document.getElementById('icon')).toBe(icon)
    expect(document.getElementById('badge')).toBe(badge)
    badge.dispatchEvent(new Event('custom'))
    expect(listener).toHaveBeenCalledOnce()
    command({ type: 'undo' })
    expect(item.innerHTML).toBe(before)
  })

  it('selects a button through its nested icon without activating it or replacing its children', () => {
    open(
      '<button id="button"><svg id="icon"><path id="path" d="M0,0"></path></svg><span>Save</span></button>'
    )
    const button = document.getElementById('button')!
    const icon = document.getElementById('icon')!
    const clicked = vi.fn()
    button.addEventListener('click', clicked)
    pick(document.getElementById('path')!)
    button.click()
    expect(snapshot().selection[0].selector).toBe('#button')
    expect(button.querySelector('[contenteditable]')).toBeNull()
    expect(clicked).not.toHaveBeenCalled()
    expect(document.getElementById('icon')).toBe(icon)
    expect(popup().querySelector('.studio-context-label')?.textContent).toBe('Button')
    command({ type: 'tool', tool: 'interact' })
    button.click()
    expect(clicked).toHaveBeenCalledOnce()
  })

  it.each(['element', 'window'])(
    'commits inline typing when %s focus leaves, so Apply becomes available',
    (where) => {
      open('<h1 id="item">Original <span id="badge">badge</span></h1>')
      const item = document.getElementById('item')!
      const badge = document.getElementById('badge')!
      pick(item)
      const editor = item.querySelector<HTMLElement>('[data-rayfin-studio-text]')!
      editor.textContent = 'Updated'
      ;(where === 'element' ? editor : window).dispatchEvent(new Event('blur'))
      expect(item.querySelector('[data-rayfin-studio-text]')).toBeNull()
      expect(snapshot().cursor).toBe(1)
      expect(snapshot().history).toHaveLength(1)
      expect(document.getElementById('badge')).toBe(badge)
      window.dispatchEvent(new Event('blur'))
      expect(snapshot().history).toHaveLength(1)
      command({ type: 'undo' })
      expect(item.textContent).toBe('Original badge')
    }
  )

  it('styles inputs without editing their values, and keeps chart data out of the text editor', () => {
    open(
      '<main><input id="input" value="Original"><div id="chart" data-graphein-spec=\'{"type":"bar","data":[{"name":"Data"}]}\'><span id="mark">Data</span></div></main>'
    )
    const input = document.getElementById('input') as HTMLInputElement
    pick(input)
    expect(popup().hidden).toBe(false)
    expect(
      Array.from(popup().querySelectorAll('[data-studio-action]')).map((node) => node.textContent)
    ).toEqual(['Color', 'Size', 'Shape'])
    expect(input.hasAttribute('contenteditable')).toBe(false)
    expect(input.value).toBe('Original')
    input.focus()
    const typing = new KeyboardEvent('keydown', { key: 'X', bubbles: true, cancelable: true })
    input.dispatchEvent(typing)
    expect(typing.defaultPrevented).toBe(true)
    pick(document.getElementById('mark')!)
    expect(snapshot().selection[0].selector).toBe('#chart')
    expect(popup().hidden).toBe(true)
    expect(document.querySelector('[data-rayfin-studio-text]')).toBeNull()
    expect(snapshot().history).toEqual([])
  })

  it.each([
    [
      'text',
      '<input id="field" placeholder="Title" value="private-value">',
      ['Color', 'Size', 'Shape']
    ],
    [
      'password',
      '<input id="field" type="password" value="private-value">',
      ['Color', 'Size', 'Shape']
    ],
    ['email', '<input id="field" type="email" value="private-value">', ['Color', 'Size', 'Shape']],
    ['number', '<input id="field" type="number" value="42">', ['Color', 'Size', 'Shape']],
    ['date', '<input id="field" type="date" value="2026-09-15">', ['Color', 'Size', 'Shape']],
    ['file', '<input id="field" type="file">', ['Color', 'Size', 'Shape']],
    [
      'textarea',
      '<textarea id="field" placeholder="Start writing">private-value</textarea>',
      ['Color', 'Size', 'Shape']
    ],
    [
      'select',
      '<select id="field"><option>private-value</option></select>',
      ['Color', 'Size', 'Shape']
    ],
    ['checkbox', '<input id="field" type="checkbox" checked>', ['Color', 'Size']],
    ['radio', '<input id="field" type="radio" checked>', ['Color', 'Size']],
    ['range', '<input id="field" type="range" value="30">', ['Color', 'Size']],
    ['color', '<input id="field" type="color" value="#123456">', ['Size', 'Shape']],
    ['submit', '<input id="field" type="submit" value="Save">', ['Color', 'Shape', 'Look']]
  ] as const)('offers styling-only actions for %s controls', (_kind, markup, actions) => {
    open('<form>' + markup + '</form>')
    const field = document.getElementById('field') as
      | HTMLInputElement
      | HTMLSelectElement
      | HTMLTextAreaElement
    const value = field.value
    box(field, 260, 250, 230, 40)
    pick(field)
    expect(popup().hidden).toBe(false)
    expect(
      Array.from(popup().querySelectorAll('[data-studio-action]')).map((item) => item.textContent)
    ).toEqual(actions)
    expect(field.value).toBe(value)
    expect(field.hasAttribute('contenteditable')).toBe(false)
    expect(document.querySelector('[data-rayfin-studio-text]')).toBeNull()
    expect(snapshot().selection[0].textEditable).toBe(false)
    expect(snapshot().selection[0].ownText).toBe('')
    expect(JSON.stringify(snapshot())).not.toContain('private-value')
  })

  it('keeps form values and handlers intact across style edits, undo, and Use app', () => {
    open(
      '<form id="form"><label for="field">Title</label><input id="field" name="title" placeholder="A title" value="private-value" style="font-size:18px"><input id="submit" type="submit" value="Save"></form>'
    )
    const field = document.getElementById('field') as HTMLInputElement
    const input = vi.fn(),
      change = vi.fn(),
      submit = vi.fn((event: Event) => event.preventDefault())
    field.addEventListener('input', input)
    field.addEventListener('change', change)
    document.getElementById('form')!.addEventListener('submit', submit)
    box(field, 200, 220, 240, 40)
    pick(field)
    expect(popup().querySelector('.studio-context-label')?.textContent).toBe('Input')
    action('Size')
    const slider = popup().querySelector<HTMLInputElement>('input[type="range"]')!
    pointer(slider, 'pointerdown')
    slider.value = '28'
    slider.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    pointer(slider, 'pointerup')
    expect(field.style.fontSize).toBe('28px')
    expect(field.value).toBe('private-value')
    expect(input).not.toHaveBeenCalled()
    expect(change).not.toHaveBeenCalled()
    expect(JSON.stringify(snapshot().history)).not.toContain('private-value')
    expect(snapshot().history[0].edits[0].before).toMatchObject({
      context: { key: { name: 'title', placeholder: 'A title' }, own: '', text: '' }
    })
    command({ type: 'undo' })
    expect(field.style.fontSize).toBe('18px')
    pick(document.getElementById('submit')!)
    document.getElementById('submit')!.click()
    expect(submit).not.toHaveBeenCalled()
    command({ type: 'tool', tool: 'interact' })
    document.getElementById('submit')!.click()
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('styles checkbox accent and size without toggling its checked state', () => {
    open('<input id="field" type="checkbox" checked style="width:16px;height:16px">')
    const field = document.getElementById('field') as HTMLInputElement
    box(field, 250, 250, 16, 16)
    const change = vi.fn()
    field.addEventListener('change', change)
    pick(field)
    field.click()
    expect(field.checked).toBe(true)
    action('Color')
    popup().querySelector<HTMLButtonElement>('[data-studio-color]')!.click()
    expect(field.style.getPropertyValue('accent-color')).toBeTruthy()
    action('Size')
    const input = popup().querySelector<HTMLInputElement>('input[type="range"]')!
    pointer(input, 'pointerdown')
    input.value = '24'
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    pointer(input, 'pointerup')
    expect(field.style.width).toBe('24px')
    expect(field.style.height).toBe('24px')
    expect(field.checked).toBe(true)
    expect(change).not.toHaveBeenCalled()
    command({ type: 'undo' })
    expect(field.style.width).toBe('16px')
    command({ type: 'tool', tool: 'interact' })
    field.click()
    expect(field.checked).toBe(false)
    expect(change).toHaveBeenCalledTimes(1)
  })

  it('reconciles styled dropdowns without recording or depending on changing option data', () => {
    open(
      '<select id="field" aria-label="Notebook"><option value="one">private-one</option><option value="two">private-two</option></select>'
    )
    const field = document.getElementById('field') as HTMLSelectElement
    field.value = 'two'
    pick(field)
    command({ type: 'style', values: { 'border-radius': '12px' } })
    field.options[1].textContent = 'new-private-label'
    field.add(new Option('another-private-label', 'three'))
    field.value = 'three'
    const state = snapshot()
    expect(state.conflicts).toEqual([])
    expect(field.style.borderRadius).toBe('12px')
    expect(field.value).toBe('three')
    expect(JSON.stringify(state)).not.toMatch(
      /private-one|private-two|new-private-label|another-private-label/
    )
    command({ type: 'undo' })
    expect(field.value).toBe('three')
    expect(field.options).toHaveLength(3)
  })

  it('keeps form data out of discovery and ancestor identities even for large option lists', () => {
    open(
      '<article id="card"><label>Notebook<select id="field"><optgroup label="private-group">' +
        Array.from({ length: 100 }, (_, i) => `<option>private-option-${i}</option>`).join('') +
        '</optgroup></select></label><textarea>private-default</textarea><input list="suggestions" value="private-value"><datalist id="suggestions"><option>private-suggestion</option></datalist></article>'
    )
    const card = document.getElementById('card')!
    pick(card)
    const styled = command({ type: 'style', values: { 'border-radius': '12px' } })
    expect(styled.error).toBeUndefined()
    expect(styled.selection[0].text).toBe('Notebook')
    expect(styled.layers.some((item) => /^(option|optgroup|datalist)$/.test(item.tag))).toBe(false)
    expect(JSON.stringify(styled)).not.toContain('private-')
    document.getElementById('field')!.replaceChildren(new Option('private-replacement'))
    const refreshed = snapshot()
    expect(refreshed.conflicts).toEqual([])
    expect(card.style.borderRadius).toBe('12px')
    expect(JSON.stringify(refreshed)).not.toContain('private-')
  })

  it.each(['disabled', 'readonly'])(
    'preserves a field’s %s state and selection while styling',
    (attribute) => {
      open(`<input id="field" ${attribute} value="private-value" style="font-size:18px">`)
      const field = document.getElementById('field') as HTMLInputElement
      field.setSelectionRange(2, 6, 'backward')
      const disabled = field.disabled,
        readOnly = field.readOnly
      pick(field)
      command({ type: 'style', values: { 'font-size': '24px' } })
      command({ type: 'undo' })
      command({ type: 'redo' })
      expect(field.value).toBe('private-value')
      expect([field.selectionStart, field.selectionEnd, field.selectionDirection]).toEqual([
        2,
        6,
        'backward'
      ])
      expect(field.disabled).toBe(disabled)
      expect(field.readOnly).toBe(readOnly)
      expect(field.style.fontSize).toBe('24px')
    }
  )

  it('does not expose hidden inputs as editable controls', () => {
    open('<input id="field" type="hidden" value="private-value">')
    pick(document.getElementById('field')!)
    expect(popup().hidden).toBe(true)
    expect(JSON.stringify(snapshot())).not.toContain('private-value')
  })

  it.each([
    ['list', '<ul id="container"><li>First</li><li>Second</li></ul>', 'List'],
    [
      'stack',
      '<div id="container" style="display:flex;gap:12px"><button>One</button><button>Two</button></div>',
      'Stack'
    ],
    [
      'grid',
      '<div id="container" style="display:grid;grid-template-columns:repeat(2,1fr);gap:12px"><article>One</article><article>Two</article></div>',
      'Grid'
    ]
  ] as const)('offers contextual spacing and layout for a %s', (_kind, markup, label) => {
    open(markup)
    const container = document.getElementById('container')!
    box(container, 200, 300, 400, 180)
    pick(container)
    expect(popup().querySelector('.studio-context-label')?.textContent).toBe(label)
    expect(
      Array.from(popup().querySelectorAll('[data-studio-action]')).map((item) => item.textContent)
    ).toEqual(['Color', 'Space', 'Layout'])
  })

  it('keeps icon-bearing flex headings directly editable instead of turning them into stacks', () => {
    open(
      '<h2 id="heading" style="display:flex;gap:8px"><svg id="icon" aria-hidden="true"></svg>My notebook</h2>'
    )
    const heading = document.getElementById('heading')!,
      icon = document.getElementById('icon')!
    pick(heading)
    expect(
      Array.from(popup().querySelectorAll('[data-studio-action]')).map((node) => node.textContent)
    ).toEqual(['Color', 'Size', 'Weight'])
    const editor = heading.querySelector<HTMLElement>('[data-rayfin-studio-text]')!
    expect(editor).not.toBeNull()
    editor.textContent = 'My ideas'
    editor.dispatchEvent(new Event('blur'))
    expect(heading.textContent).toBe('My ideas')
    expect(document.getElementById('icon')).toBe(icon)
    command({ type: 'undo' })
    expect(heading.textContent).toBe('My notebook')
    expect(document.getElementById('icon')).toBe(icon)
  })

  it('adjusts list spacing as one reversible gesture without replacing items or their listeners', () => {
    open('<ul id="list"><li id="first">First</li><li id="second">Second</li></ul>')
    const list = document.getElementById('list')!,
      first = document.getElementById('first')!
    const event = vi.fn()
    first.addEventListener('custom', event)
    pick(list)
    action('Space')
    const input = popup().querySelector<HTMLInputElement>('input[type="range"]')!
    pointer(input, 'pointerdown')
    input.value = '20'
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    expect(list.style.gap).toBe('20px')
    expect(list.style.display).toBe('flex')
    expect(list.style.flexDirection).toBe('column')
    input.value = '28'
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    expect(list.style.gap).toBe('28px')
    expect(list.style.display).toBe('flex')
    expect(list.style.flexDirection).toBe('column')
    pointer(input, 'pointerup')
    expect(snapshot().history).toHaveLength(1)
    expect(snapshot().history[0].edits).toHaveLength(3)
    expect(document.getElementById('first')).toBe(first)
    first.dispatchEvent(new Event('custom'))
    expect(event).toHaveBeenCalledTimes(1)
    command({ type: 'undo' })
    expect(list.style.gap).toBe('')
    expect(list.style.display).toBe('')
    expect(list.tagName).toBe('UL')
    expect(first.tagName).toBe('LI')
  })

  it('keeps the chosen list direction when adjusting alignment and cancelling previews', () => {
    open('<ul id="list"><li>One</li><li>Two</li></ul>')
    const list = document.getElementById('list')!
    pick(list)
    action('Layout')
    const horizontal = popup().querySelector<HTMLButtonElement>(
      '[data-studio-layout="horizontal"]'
    )!
    const center = popup().querySelector<HTMLButtonElement>('[data-studio-layout="align-center"]')!
    pointer(horizontal, 'pointerenter')
    pointer(center, 'pointerenter')
    expect(list.style.flexDirection).toBe('column')
    expect(list.style.alignItems).toBe('center')
    pointer(center, 'pointerleave')
    expect(list.style.display).toBe('')
    horizontal.click()
    center.click()
    expect(list.style.flexDirection).toBe('row')
    expect(list.style.alignItems).toBe('center')
    expect(center.getAttribute('aria-pressed')).toBe('true')
    expect(horizontal.getAttribute('aria-pressed')).toBe('true')
    expect(snapshot().cursor).toBe(2)
    command({ type: 'undo' })
    expect(list.style.flexDirection).toBe('row')
    expect(list.style.alignItems).toBe('')
    command({ type: 'undo' })
    expect(list.style.display).toBe('')
  })

  it('previews stack direction and commits alignment/wrapping without changing child order', () => {
    open(
      '<div id="stack" style="display:flex;flex-direction:row;gap:12px"><button id="a">One</button><button id="b">Two</button></div>'
    )
    const stack = document.getElementById('stack')!
    const children = Array.from(stack.children)
    pick(stack)
    action('Layout')
    const vertical = popup().querySelector<HTMLButtonElement>('[data-studio-layout="vertical"]')!
    pointer(vertical, 'pointerenter')
    expect(stack.style.flexDirection).toBe('column')
    expect(snapshot().cursor).toBe(0)
    pointer(vertical, 'pointerleave')
    expect(stack.style.flexDirection).toBe('row')
    vertical.click()
    expect(stack.style.flexDirection).toBe('column')
    popup().querySelector<HTMLButtonElement>('[data-studio-layout="align-center"]')!.click()
    expect(stack.style.alignItems).toBe('center')
    popup().querySelector<HTMLButtonElement>('[data-studio-layout="wrap"]')!.click()
    expect(stack.style.flexWrap).toBe('wrap')
    expect(Array.from(stack.children)).toEqual(children)
    expect(snapshot().cursor).toBe(3)
    command({ type: 'undo' })
    expect(stack.style.flexWrap).toBe('')
  })

  it('changes list markers and grid columns using existing style transactions', () => {
    open(
      '<ol id="list"><li>First</li><li>Second</li></ol><div id="grid" style="display:grid;grid-template-columns:repeat(2,1fr)"><div>One</div><div>Two</div></div>'
    )
    const list = document.getElementById('list')!,
      grid = document.getElementById('grid')!
    pick(list)
    action('Layout')
    popup().querySelector<HTMLButtonElement>('[data-studio-layout="bullets"]')!.click()
    expect(list.style.listStyleType).toBe('disc')
    expect(list.tagName).toBe('OL')
    pick(grid)
    action('Layout')
    popup().querySelector<HTMLButtonElement>('[data-studio-layout="columns-3"]')!.click()
    expect(grid.style.gridTemplateColumns).toBe('repeat(3, minmax(0, 1fr))')
    expect(grid.children).toHaveLength(2)
    command({ type: 'undo' })
    expect(grid.style.gridTemplateColumns).toBe('repeat(2,1fr)')
  })

  it('preserves grid-based lists and avoids marker controls on non-list-item stacks', () => {
    open(
      '<ul id="list" style="display:grid;grid-template-columns:repeat(2,1fr)"><li>One</li><li>Two</li></ul><div id="stack" role="list" style="display:flex"><div role="listitem">One</div><div role="listitem">Two</div></div>'
    )
    const list = document.getElementById('list')!
    pick(list)
    action('Layout')
    expect(popup().querySelector('[data-studio-layout="horizontal"]')).toBeNull()
    expect(
      popup().querySelector('[data-studio-layout="columns-2"]')?.getAttribute('aria-pressed')
    ).toBe('true')
    popup().querySelector<HTMLButtonElement>('[data-studio-layout="columns-3"]')!.click()
    expect(list.style.display).toBe('grid')
    expect(list.style.gridTemplateColumns).toBe('repeat(3, minmax(0, 1fr))')
    pick(document.getElementById('stack')!)
    action('Layout')
    expect(popup().querySelector('[data-studio-layout="bullets"]')).toBeNull()
    expect(popup().querySelector('[data-studio-layout="wrap"]')).not.toBeNull()
  })

  it('does not mislabel complex grid repeats as a known column count', () => {
    open(
      '<div id="grid" style="display:grid;grid-template-columns:repeat(2,10px 1fr)"><div>One</div><div>Two</div></div>'
    )
    pick(document.getElementById('grid')!)
    action('Layout')
    expect(popup().querySelector('[data-studio-columns][aria-pressed="true"]')).toBeNull()
  })

  it('hovers only the innermost meaningful target and never shows framework component labels', () => {
    open(
      '<main><article id="card" style="padding:20px"><div><h2 id="title">The note</h2></div><div aria-hidden="true"><i id="decoration"></i></div></article></main>'
    )
    const title = document.getElementById('title')!
    Object.defineProperty(title, '__reactFiber$test', {
      value: { type: { displayName: 'RenderedRoute' } }
    })
    hit = title
    pointer(title, 'pointermove')
    expect(shadow().querySelector('.label')?.textContent).toBe('Heading · The note')
    expect(shadow().querySelector('.label')?.textContent).not.toContain('RenderedRoute')
    hit = document.getElementById('decoration')!
    pointer(hit, 'pointermove')
    expect(shadow().querySelector('.label')?.textContent).toBe('Card')
    expect(shadow().querySelectorAll('.hover')).toHaveLength(1)
  })

  it('previews source-aware colors transiently and commits a clicked color as one undoable transaction', () => {
    open(
      '<main style="--app-ink:#203040"><h1 id="title" style="color:var(--app-ink)">Heading</h1></main>'
    )
    const title = document.getElementById('title')!
    pick(title)
    action('Color')
    const current = popup().querySelector<HTMLElement>('[data-studio-color="#203040"]')
    expect(current).toBeTruthy()
    const swatch = Array.from(
      popup().querySelectorAll<HTMLButtonElement>('[data-studio-color]')
    ).find((node) => node !== current)!
    const original = title.style.color
    pointer(swatch, 'pointerenter')
    expect(title.style.color).not.toBe(original)
    expect(snapshot().history).toEqual([])
    pointer(swatch, 'pointerleave')
    expect(title.style.color).toBe(original)
    pointer(swatch, 'pointerenter')
    swatch.click()
    const committed = title.style.color
    expect(committed).not.toBe(original)
    expect(snapshot().history).toHaveLength(1)
    pointer(swatch, 'pointerleave')
    expect(title.style.color).toBe(committed)
    command({ type: 'undo' })
    expect(title.style.color).toBe(original)
  })

  it('shows the committed swatch selection, reversible preview feedback, and decorative action icons', () => {
    open('<h1 id="title" style="color:#20232a">Heading</h1>')
    pick(document.getElementById('title')!)
    const colorAction = action('Color')
    expect(colorAction.querySelector('.studio-action-icon')?.getAttribute('aria-hidden')).toBe(
      'true'
    )
    expect(colorAction.textContent).toBe('Color')
    const current = popup().querySelector<HTMLButtonElement>(
      '[data-studio-color][title="Current"]'
    )!
    const other = Array.from(
      popup().querySelectorAll<HTMLButtonElement>('[data-studio-color]')
    ).find((item) => item !== current)!
    expect(current.getAttribute('aria-pressed')).toBe('true')
    expect(current.querySelector('.studio-swatch-check')?.getAttribute('aria-hidden')).toBe('true')
    pointer(other, 'pointerenter')
    expect(popup().querySelector('.studio-context-feedback')?.textContent).toMatch(/^Previewing /)
    expect(current.getAttribute('aria-pressed')).toBe('true')
    expect(snapshot().cursor).toBe(0)
    pointer(other, 'pointerleave')
    expect(popup().querySelector('.studio-context-feedback')?.textContent).toContain(
      'Hover to preview'
    )
    other.click()
    expect(other.getAttribute('aria-pressed')).toBe('true')
    expect(current.getAttribute('aria-pressed')).toBe('false')
    command({ type: 'undo' })
    expect(current.getAttribute('aria-pressed')).toBe('true')
    expect(other.getAttribute('aria-pressed')).toBe('false')
  })

  it('gives Look choices miniature content and an accurate selected state', () => {
    open('<article id="card" style="background:#eeedf8;color:#20232a">Card</article>')
    pick(document.getElementById('card')!)
    action('Look')
    const soft = popup().querySelector<HTMLButtonElement>('[data-studio-look="Soft"]')!
    expect(soft.querySelectorAll('.studio-look-line')).toHaveLength(2)
    expect(soft.querySelector('.studio-look-sample')?.getAttribute('aria-hidden')).toBe('true')
    soft.click()
    expect(soft.getAttribute('aria-pressed')).toBe('true')
    expect(popup().querySelector('.studio-context-feedback')?.textContent).toBe('Soft selected')
    command({ type: 'undo' })
    expect(soft.getAttribute('aria-pressed')).toBe('false')
  })

  it('keeps the slider fill, value badge, and accessible value in sync during scrub and undo', () => {
    open('<button id="button" style="border-top-left-radius:8px">Save</button>')
    pick(document.getElementById('button')!)
    action('Shape')
    const input = popup().querySelector<HTMLInputElement>('input[type="range"]')!
    expect(popup().querySelector('.studio-range-heading')?.textContent).toContain('Corner radius')
    expect(input.style.getPropertyValue('--studio-progress')).toBe('12.50%')
    pointer(input, 'pointerdown')
    input.value = '32'
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    expect(input.style.getPropertyValue('--studio-progress')).toBe('50.00%')
    expect(input.getAttribute('aria-valuetext')).toBe('32 px')
    expect(popup().querySelector('output')?.textContent).toBe('32 px')
    expect(snapshot().cursor).toBe(0)
    pointer(input, 'pointerup')
    command({ type: 'undo' })
    expect(input.style.getPropertyValue('--studio-progress')).toBe('12.50%')
    expect(input.getAttribute('aria-valuetext')).toBe('8 px')
  })

  it('includes restrained motion and removes thumb/pseudo-element motion for reduced-motion users', () => {
    open('<button id="button">Save</button>')
    pick(document.getElementById('button')!)
    const css = shadow().querySelector('style')!.textContent!
    expect(css).toContain('@keyframes studio-context-enter')
    expect(css).toContain('@media (prefers-reduced-motion:reduce)')
    expect(css).toContain('.studio-context *::before')
    expect(css).toContain(
      '.studio-context input::-webkit-slider-thumb{animation:none!important;transition:none!important}'
    )
  })

  it('keeps dark card colors and explicit child ink intact while previewing modest Looks', () => {
    open(
      '<article id="card" style="background-color:#20232a;color:#eeeeee;padding:1rem;border-top-width:3px!important"><h2 id="title" style="color:#eeeeee">Title</h2><p id="copy" style="color:#cccccc">Copy</p></article>'
    )
    const card = document.getElementById('card')!
    const title = document.getElementById('title')!
    const copy = document.getElementById('copy')!
    const before = {
      background: card.style.backgroundColor,
      color: card.style.color,
      title: title.getAttribute('style'),
      copy: copy.getAttribute('style')
    }
    pick(card)
    action('Look')
    expect(
      Array.from(popup().querySelectorAll('[data-studio-look]')).map((node) =>
        node.getAttribute('data-studio-look')
      )
    ).toEqual(['Clean', 'Soft', 'Bold'])
    const soft = popup().querySelector<HTMLButtonElement>('[data-studio-look="Soft"]')!
    pointer(soft, 'pointerenter')
    expect(card.style.boxShadow).not.toBe('')
    expect(card.style.backgroundColor).toBe(before.background)
    expect(card.style.color).toBe(before.color)
    expect(title.getAttribute('style')).toBe(before.title)
    expect(copy.getAttribute('style')).toBe(before.copy)
    pointer(soft, 'pointerleave')
    expect(card.style.boxShadow).toBe('')
    expect(card.style.getPropertyValue('border-top-width')).toBe('3px')
    expect(card.style.getPropertyPriority('border-top-width')).toBe('important')
    soft.click()
    expect(snapshot().history).toHaveLength(1)
    command({ type: 'undo' })
    expect(card.style.boxShadow).toBe('')
    expect(card.style.backgroundColor).toBe(before.background)
    expect(title.getAttribute('style')).toBe(before.title)
  })

  it('keeps slider controls stable and focused, commits once, and restores mixed units/priorities on undo', () => {
    open(
      '<article id="card" style="padding-top:1rem!important;padding-right:2em;padding-bottom:12px;padding-left:5%">Card</article>'
    )
    const card = document.getElementById('card')!
    box(card, 300, 240, 320, 160)
    pick(card)
    action('Space')
    const input = popup().querySelector<HTMLInputElement>('input[type="range"]')!
    input.focus()
    const position = { left: popup().style.left, top: popup().style.top }
    pointer(input, 'pointerdown')
    for (const value of ['22', '25', '28']) {
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
      expect(card.style.paddingTop).toBe(value + 'px')
      expect(popup().querySelector('input')).toBe(input)
      expect(shadow().activeElement).toBe(input)
      expect(popup().style.left).toBe(position.left)
      expect(popup().style.top).toBe(position.top)
      expect(snapshot().revision).toBe(0)
    }
    pointer(input, 'pointerup')
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
    expect(snapshot().history).toHaveLength(1)
    expect(snapshot().history[0].edits).toHaveLength(4)
    expect(snapshot().revision).toBe(1)
    command({ type: 'undo' })
    expect(card.style.paddingTop).toBe('1rem')
    expect(card.style.getPropertyPriority('padding-top')).toBe('important')
    expect(card.style.paddingRight).toBe('2em')
    expect(card.style.paddingBottom).toBe('12px')
    expect(card.style.paddingLeft).toBe('5%')
  })

  it('cancels shape scrubbing on pointercancel and ignores late input/change events after cancellation', () => {
    open('<button id="button" style="border-radius:0.5rem!important">Save</button>')
    const button = document.getElementById('button')!
    const originalStyle = button.style.cssText
    pick(button)
    action('Shape')
    const input = popup().querySelector<HTMLInputElement>('input')!
    pointer(input, 'pointerdown')
    input.value = '30'
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    expect(button.style.borderTopLeftRadius).toBe('30px')
    pointer(input, 'pointercancel')
    expect(button.style.cssText).toBe(originalStyle)
    expect(button.style.borderRadius).toBe('0.5rem')
    expect(button.style.getPropertyPriority('border-radius')).toBe('important')
    input.value = '40'
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
    expect(button.style.cssText).toBe(originalStyle)
    expect(input.value).toBe('8')
    expect(snapshot().history).toEqual([])
  })

  it('groups keyboard slider repeats into one undo and supports Ctrl/Cmd+Z plus redo while controls stay focused', () => {
    open('<h1 id="title" style="font-weight:400">Heading</h1>')
    const title = document.getElementById('title')!
    pick(title)
    action('Weight')
    const input = popup().querySelector<HTMLInputElement>('input')!
    input.focus()
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
        composed: true,
        cancelable: true
      })
    )
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        repeat: true,
        bubbles: true,
        composed: true,
        cancelable: true
      })
    )
    expect(title.style.fontWeight).toBe('600')
    expect(snapshot().history).toEqual([])
    input.dispatchEvent(
      new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true, composed: true })
    )
    expect(snapshot().history).toHaveLength(1)
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'z',
        ctrlKey: true,
        bubbles: true,
        composed: true,
        cancelable: true
      })
    )
    expect(title.style.fontWeight).toBe('400')
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'z',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        composed: true,
        cancelable: true
      })
    )
    expect(title.style.fontWeight).toBe('600')
    expect(popup().querySelector('input')).toBe(input)
  })

  it('Escape cancels a live edit and closes controls; clicking outside commits text and closes them', () => {
    open('<h1 id="title">Original</h1>')
    const title = document.getElementById('title')!
    pick(title)
    title.querySelector('[data-rayfin-studio-text]')!.textContent = 'Cancelled'
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    )
    expect(title.textContent).toBe('Original')
    expect(popup().hidden).toBe(true)
    expect(snapshot().selection).toEqual([])
    pick(title)
    title.querySelector('[data-rayfin-studio-text]')!.textContent = 'Kept'
    hit = document.body
    pointer(document.body, 'pointerdown', 5, 5)
    expect(title.textContent).toBe('Kept')
    expect(popup().hidden).toBe(true)
    expect(snapshot().history).toHaveLength(1)
  })

  it('undoes an active text gesture as one unit without undoing the previous style change', () => {
    open('<h1 id="title">Original</h1>')
    const title = document.getElementById('title')!
    pick(title)
    action('Color')
    command({ type: 'style', values: { color: 'red' } })
    pick(title)
    title.querySelector('[data-rayfin-studio-text]')!.textContent = 'Typed label'
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })
    )
    expect(title.textContent).toBe('Original')
    expect(title.style.color).toBe('red')
    expect(snapshot().cursor).toBe(1)
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'z',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true
      })
    )
    expect(title.textContent).toBe('Typed label')
    expect(title.style.color).toBe('red')
    expect(snapshot().cursor).toBe(2)
  })

  it('Escape restores a hovered Look and prevents detached old controls from editing a new target', () => {
    open('<article id="a">A</article><article id="b">B</article>')
    const a = document.getElementById('a')!,
      b = document.getElementById('b')!
    pick(a)
    action('Look')
    const look = popup().querySelector<HTMLButtonElement>('[data-studio-look="Soft"]')!
    pointer(look, 'pointerenter')
    expect(a.style.boxShadow).not.toBe('')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(a.style.boxShadow).toBe('')
    pick(b)
    pointer(look, 'pointerenter')
    look.click()
    expect(b.style.boxShadow).toBe('')
    expect(snapshot().history).toEqual([])
  })

  it('flips and clamps the popover outside its target and repositions on scroll/resize', () => {
    open('<button id="button">Save</button>')
    const button = document.getElementById('button')!
    box(button, 800, 700, 190, 40)
    pick(button)
    expect(popup().getAttribute('data-placement')).toBe('above')
    expect(parseFloat(popup().style.left)).toBeLessThanOrEqual(742)
    expect(parseFloat(popup().style.top) + 44).toBeLessThan(700)
    vi.mocked(button.getBoundingClientRect).mockReturnValue({
      left: 0,
      top: 2,
      width: 100,
      height: 35,
      right: 100,
      bottom: 37
    } as DOMRect)
    window.dispatchEvent(new Event('scroll'))
    expect(popup().getAttribute('data-placement')).toBe('below')
    expect(parseFloat(popup().style.left)).toBeGreaterThanOrEqual(8)
    expect(parseFloat(popup().style.top)).toBeGreaterThan(37)
    vi.stubGlobal('innerWidth', 320)
    window.dispatchEvent(new Event('resize'))
    expect(parseFloat(popup().style.left)).toBeLessThanOrEqual(62)
  })

  it('keeps tall layout options scrollable outside the target on a narrow canvas', () => {
    vi.stubGlobal('innerWidth', 320)
    vi.stubGlobal('innerHeight', 740)
    open('<ul id="list"><li>One</li><li>Two</li></ul>')
    api.setTheme({ scale: 1.5 })
    const list = document.getElementById('list')!
    box(list, 24, 266, 257, 180)
    pick(list)
    action('Layout')
    const panel = popup(),
      options = panel.querySelector<HTMLElement>('.studio-options')!
    options.style.padding = '21px 18px 17px'
    box(options.firstElementChild!, 0, 0, 260, 86)
    const contentHeight = () => Math.min(423, parseFloat(options.style.maxHeight) || 423)
    vi.spyOn(options, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, 0, 280, contentHeight())
    )
    vi.spyOn(panel, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, 0, 300, 135 + contentHeight())
    )
    Object.defineProperty(options, 'scrollHeight', { configurable: true, get: () => 423 })
    Object.defineProperty(options, 'clientHeight', { configurable: true, get: contentHeight })
    window.dispatchEvent(new Event('scroll'))
    expect(panel.hidden).toBe(false)
    expect(panel.getAttribute('data-placement')).toBe('below')
    expect(panel.style.top).toBe('464px')
    expect(options.style.maxHeight).toBe('132px')
    options.scrollTop = 80
    window.dispatchEvent(new Event('scroll'))
    expect(options.scrollTop).toBe(80)
    expect(options.style.maxHeight).toBe('132px')
    expect(shadow().querySelector('style')!.textContent).toContain('overscroll-behavior:contain')
    vi.stubGlobal('innerHeight', 1200)
    window.dispatchEvent(new Event('resize'))
    expect(panel.hidden).toBe(false)
    expect(options.style.maxHeight).toBe('')
  })

  it('keeps popovers inside the usable viewport when the app has a scrollbar', () => {
    vi.stubGlobal('innerWidth', 320)
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      value: 305
    })
    open('<button id="button">Save</button>')
    const button = document.getElementById('button')!
    box(button, 240, 300, 40, 32)
    pick(button)
    expect(popup().hidden).toBe(false)
    expect(popup().style.maxWidth).toBe('289px')
    expect(parseFloat(popup().style.left)).toBeLessThanOrEqual(47)
  })

  it('allows for CSSOM rounding when fitting a scrollable panel beside fractional target bounds', () => {
    vi.stubGlobal('innerWidth', 390)
    vi.stubGlobal('innerHeight', 844)
    open('<ul id="list"><li>One</li><li>Two</li></ul>')
    api.setTheme({ scale: 1.5 })
    const list = document.getElementById('list')!
    box(list, 24, 303.828125, 327, 156.5)
    pick(list)
    action('Layout')
    const panel = popup(),
      options = panel.querySelector<HTMLElement>('.studio-options')!
    options.style.padding = '21px 18px 17px'
    box(panel, 0, 0, 359, 502)
    box(options, 0, 0, 339, 422.5)
    box(options.firstElementChild!, 0, 0, 300, 86)
    const contentHeight = () => Math.min(422.5, parseFloat(options.style.maxHeight) || 422.5)
    Object.defineProperties(options, {
      offsetHeight: { configurable: true, get: () => Math.round(contentHeight()) },
      clientHeight: { configurable: true, get: () => Math.round(contentHeight()) },
      scrollHeight: { configurable: true, get: () => 423 }
    })
    Object.defineProperty(panel, 'offsetHeight', {
      configurable: true,
      get: () => Math.round(79.5 + contentHeight())
    })
    window.dispatchEvent(new Event('scroll'))
    expect(panel.hidden).toBe(false)
    expect(panel.style.top).toBe('478px')
    expect(options.style.maxHeight).toBe('277px')
  })

  it.each(['compare', 'capture', 'interact'] as const)(
    'suppresses controls and cancels hover previews during %s',
    (mode) => {
      open('<article id="card" style="background:#eeedf8;color:#20232a">Card</article>')
      const card = document.getElementById('card')!
      pick(card)
      action('Look')
      const look = popup().querySelector<HTMLButtonElement>('[data-studio-look="Soft"]')!
      pointer(look, 'pointerenter')
      expect(card.style.boxShadow).not.toBe('')
      command(
        mode === 'interact' ? { type: 'tool', tool: 'interact' } : { type: mode, enabled: true }
      )
      expect(card.style.boxShadow).toBe('')
      expect(popup().hidden).toBe(true)
      expect(document.getElementById(HOST)!.style.display).toBe('none')
      expect(snapshot().history).toEqual([])
      pointer(look, 'pointerenter')
      look.click()
      expect(card.style.boxShadow).toBe('')
    }
  )

  it('adopts host colors/scale without rebuilding focused controls, changing app colors, or reviving the legacy inspector', () => {
    open('<h1 id="title" style="font-size:20px;color:#203040">Title</h1>')
    const title = document.getElementById('title')!
    pick(title)
    action('Size')
    const input = popup().querySelector<HTMLInputElement>('input')!
    input.focus()
    const before = title.getAttribute('style')
    api.setTheme({ accent: '#4f46e5', panel: '#ffffff', txt: '#111111', scale: 1.5 })
    expect(popup().querySelector('input')).toBe(input)
    expect(shadow().activeElement).toBe(input)
    expect(shadow().querySelector('style')!.textContent).toContain('.studio-context')
    expect(shadow().querySelector('style')!.textContent).toContain('--fs-base:20px')
    expect(shadow().querySelector('style')!.textContent).toContain('#4f46e5')
    expect(title.getAttribute('style')).toBe(before)
    expect((shadow().querySelector('.insp') as HTMLElement).style.display).toBe('none')
    expect(snapshot().revision).toBe(0)
  })

  it('rejects late public previews for an already committed or cancelled gesture', () => {
    open('<article id="card">Card</article>')
    pick(document.getElementById('card')!)
    command({ type: 'style', values: { opacity: '0.7' }, gestureId: 'final', phase: 'commit' })
    const late = command({
      type: 'style',
      values: { opacity: '0.2' },
      gestureId: 'final',
      phase: 'preview'
    })
    expect(late.error).toMatch(/gesture has ended/i)
    expect(document.getElementById('card')!.style.opacity).toBe('0.7')
    command({ type: 'style', values: { opacity: '0.4' }, gestureId: 'cancelled', phase: 'preview' })
    command({ type: 'style', values: {}, gestureId: 'cancelled', phase: 'cancel' })
    expect(
      command({
        type: 'style',
        values: { opacity: '0.1' },
        gestureId: 'cancelled',
        phase: 'preview'
      }).error
    ).toMatch(/gesture has ended/i)
    expect(snapshot().history).toHaveLength(1)
  })

  it('disconnect restores only owned draft effects and removes contextual controls/listeners', () => {
    open('<article id="card" style="padding:1rem">Card</article>')
    const card = document.getElementById('card')!
    const clicked = vi.fn()
    card.addEventListener('click', clicked)
    pick(card)
    action('Look')
    pointer(popup().querySelector('[data-studio-look="Soft"]')!, 'pointerenter')
    api.studio.disconnect('context')
    expect(card.style.boxShadow).toBe('')
    expect(card.style.padding).toBe('1rem')
    expect(document.getElementById(HOST)).toBeNull()
    card.click()
    expect(clicked).toHaveBeenCalledOnce()
  })
})
