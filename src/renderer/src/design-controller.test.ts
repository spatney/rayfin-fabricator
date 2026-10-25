/// <reference types="node" />
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesignItem, DesignSnapshot, DesignStatus, DesignSystemSummary } from '@shared/design'

/**
 * Unit tests for the injected Design mode controller (v6,
 * `src-tauri/src/services/design_agent.js`) in the `direct` frame role (the top
 * frame IS the app). The controller is a document-start IIFE; we eval it into
 * the jsdom window and drive it through its public API and real DOM events.
 */

const SRC = readFileSync(resolve(process.cwd(), 'src-tauri/src/services/design_agent.js'), 'utf8')
const HOST_ID = '__rayfin_design_host'

interface Api {
  __v: number
  enable: (mode?: string, origin?: string | null, options?: unknown) => void
  disable: () => void
  peek: () => DesignStatus | null
  snapshot: () => DesignSnapshot | null
  command: (cmd: Record<string, unknown>) => { accepted: boolean }
  setTheme: (theme: Record<string, unknown>) => void
  __test: {
    labelOf: (el: Element) => string
    pick: (el: Element) => Element | null
    detectTheme: () => { tailwind: boolean; accent: string | null; neutral: string | null; dark: boolean }
    designSystem: () => DesignSystemSummary | undefined
    parseColor: (c: string) => { r: number; g: number; b: number; a: number } | null
    contrastRatio: (a: unknown, b: unknown) => number
    openCard: (el: Element, tool?: string) => void
  }
}

let frames: FrameRequestCallback[] = []
function raf(): void {
  const run = frames
  frames = []
  run.forEach((cb) => cb(0))
}
function install(): Api {
  new Function(SRC)()
  return (window as unknown as { __rayfinDesign: Api }).__rayfinDesign
}
function shadow(): ShadowRoot {
  return document.getElementById(HOST_ID)!.shadowRoot!
}
function card(): HTMLElement {
  return shadow().querySelector('.card') as HTMLElement
}
function panel(): HTMLElement {
  return shadow().querySelector('.panel') as HTMLElement
}
function button(scope: ParentNode, name: string | RegExp): HTMLButtonElement {
  const all = Array.from(scope.querySelectorAll('button')) as HTMLButtonElement[]
  const match = all.find((b) => {
    const label = (b.getAttribute('aria-label') || b.textContent || '').trim()
    return typeof name === 'string' ? label === name : name.test(label)
  })
  if (!match) throw new Error(`no button ${String(name)} in: ${all.map((b) => b.getAttribute('aria-label') || b.textContent).join(' | ')}`)
  return match
}
function items(api: Api): DesignItem[] {
  return api.snapshot()?.items ?? []
}
function add(html: string): HTMLElement {
  const wrap = document.createElement('div')
  wrap.innerHTML = html.trim()
  const el = wrap.firstElementChild as HTMLElement
  document.body.appendChild(el)
  return el
}
function pointerDown(el: Element, init: MouseEventInit = {}): void {
  el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, button: 0, ...init }))
}
function rect(el: Element, r: { x: number; y: number; w: number; h: number }): void {
  ;(el as HTMLElement).getBoundingClientRect = () =>
    ({ left: r.x, top: r.y, right: r.x + r.w, bottom: r.y + r.h, width: r.w, height: r.h, x: r.x, y: r.y, toJSON() {} }) as DOMRect
}
function addInstruction(text: string): void {
  ;(card().querySelector('textarea') as HTMLTextAreaElement).value = text
  button(card(), /^(Add|Update)$/).click()
}

let d: Api
beforeEach(() => {
  frames = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.push(cb)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  delete (window as unknown as { __rayfinDesign?: unknown }).__rayfinDesign
  document.head.innerHTML = ''
  document.body.innerHTML = ''
  document.documentElement.className = ''
  d = install()
})
afterEach(() => {
  try {
    d.disable()
  } catch {
    /* ignore */
  }
  delete (window as unknown as { __rayfinDesign?: unknown }).__rayfinDesign
  vi.unstubAllGlobals()
})

describe('design controller v6 — lifecycle', () => {
  it('stays dormant until enabled and tears everything down on disable', () => {
    expect(d.__v).toBe(6)
    expect(document.getElementById(HOST_ID)).toBeNull()
    expect(d.peek()).toMatchObject({ enabled: false, sessionId: null })

    d.enable('direct', null, { sessionId: 's1', items: [] })
    expect(document.getElementById(HOST_ID)).not.toBeNull()
    expect(d.peek()).toMatchObject({ enabled: true, sessionId: 's1', itemCount: 0, requests: [], panel: null })
    expect(d.snapshot()).toMatchObject({ items: [], route: '/' })

    d.disable()
    expect(document.getElementById(HOST_ID)).toBeNull()
    expect(d.peek()).toMatchObject({ enabled: false })
    expect(d.snapshot()).toBeNull()
  })

  it('comes back unseeded after a re-arm, then re-projects the host’s items', () => {
    const el = add('<p class="lead">Hello there</p>')
    d.enable('direct', null, null)
    expect(d.peek()).toMatchObject({ enabled: true, sessionId: null })
    const item: DesignItem = {
      id: 'i1', kind: 'element', createdAt: 1, instruction: 'Warmer copy',
      target: { label: 'Text · Hello there', role: 'text', tag: 'p', selector: 'p.lead', text: 'Hello there', route: '/', box: { w: 10, h: 10 } },
      tweaks: [{ kind: 'color', summary: 'Text color', tailwind: { to: 'text-red-600' }, css: [{ property: 'color', to: 'rgb(220, 38, 38)' }] }]
    }
    d.command({ op: 'seed', sessionId: 's2', items: [item] })
    expect(d.peek()).toMatchObject({ sessionId: 's2', itemCount: 1 })
    expect(el.style.color).toBe('rgb(220, 38, 38)')
    d.command({ op: 'removeItem', id: 'i1' })
    expect(el.style.color).toBe('')
    expect(items(d)).toEqual([])
  })

  it('adopts the host theme and scale for its own chrome', () => {
    d.enable('direct', null, { sessionId: 's', items: [], hostTheme: { accent: '#4f46e5', panel: '#ffffff', txt: '#111111', scale: 1.25 } })
    const host = document.getElementById(HOST_ID)!
    expect(host.style.getPropertyValue('--rf-accent')).toBe('#4f46e5')
    expect(host.style.getPropertyValue('--rf-scale')).toBe('1.25')
    expect(d.peek()?.hasTheme).toBe(true)
  })
})

describe('design controller v6 — pointing', () => {
  it('labels elements the way a person would name them', () => {
    const btn = add('<button class="rounded-lg"><svg><path d="M0 0"/></svg> Add deal</button>')
    const heading = add('<h2>Pipeline value</h2>')
    const chart = add(`<div data-graphein-spec='{"type":"bar","title":"Revenue by month"}'><span>x</span></div>`)
    // A card without a heading tag is named by its first line, not run-together text.
    const deck = add('<div style="border-top-width:1px;border-top-left-radius:12px;background-color:#ffffff"><div>Northwind</div><p>The power plant hiding in every garage</p></div>')
    expect(d.__test.labelOf(btn)).toBe('Button · Add deal')
    expect(d.__test.labelOf(heading)).toBe('Heading · Pipeline value')
    expect(d.__test.labelOf(chart)).toBe('Chart · Revenue by month')
    expect(d.__test.labelOf(deck)).toBe('Card · Northwind')
    // An icon inside a button means the button; anything inside a chart means the chart.
    expect(d.__test.pick(btn.querySelector('path')!)).toBe(btn)
    expect(d.__test.pick(chart.querySelector('span')!)).toBe(chart)
  })

  it('blocks app clicks while designing, but Alt lets the app work normally', () => {
    const onClick = vi.fn()
    const btn = add('<button>Save</button>')
    btn.addEventListener('click', onClick)
    d.enable('direct', null, { sessionId: 's', items: [] })
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(onClick).not.toHaveBeenCalled()
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, altKey: true }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('opens a card on click and queues the instruction as one numbered item', () => {
    const btn = add('<button class="bg-indigo-600 text-white px-4 py-2">Add deal</button>')
    d.enable('direct', null, { sessionId: 's', items: [] })
    pointerDown(btn)
    expect(card()).not.toBeNull()
    expect(card().querySelector('.title')?.textContent).toBe('Button · Add deal')
    // Element-aware suggestion chips fill the instruction box.
    const ta = card().querySelector('textarea') as HTMLTextAreaElement
    button(card(), 'Make it the primary action').click()
    expect(ta.value).toBe('Make it the primary action')
    ta.value = 'Make it a secondary outline button'
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    const [item] = items(d)
    expect(item).toMatchObject({
      kind: 'element',
      instruction: 'Make it a secondary outline button',
      target: { label: 'Button · Add deal', role: 'button', tag: 'button', text: 'Add deal', classes: 'bg-indigo-600 text-white px-4 py-2' }
    })
    expect(card().querySelector('.num')?.textContent).toBe('1')
    // Clicking the same element keeps one item.
    pointerDown(btn)
    expect(items(d)).toHaveLength(1)
  })

  it('draws a numbered pin on queued elements that reopens their card', () => {
    const el = add('<p>Pin me please</p>')
    rect(el, { x: 40, y: 60, w: 120, h: 20 })
    d.enable('direct', null, { sessionId: 's', items: [] })
    d.__test.openCard(el)
    addInstruction('Bigger')
    button(card(), 'Close (Esc)').click()
    raf()
    const pin = shadow().querySelector('.pin') as HTMLElement
    expect(pin.textContent).toBe('1')
    expect(pin.style.left).toBe('40px')
    pin.click()
    expect(card().querySelector('.title')?.textContent).toBe('Text · Pin me please')
  })

  it('closes the card on Escape and undoes the last change with Ctrl+Z', () => {
    const p = add('<p class="text-sm">Undo me</p>')
    d.enable('direct', null, { sessionId: 's', items: [] })
    d.__test.openCard(p, 'size')
    button(card(), 'More size').click()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(card()).toBeNull()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
    expect(items(d)).toEqual([])
  })
})

describe('design controller v6 — quick tweaks', () => {
  it('steps text size along the Tailwind scale and keeps the original class as "from"', () => {
    const p = add('<p class="text-sm text-slate-700">Quarterly summary</p>')
    d.enable('direct', null, { sessionId: 's', items: [] })
    d.__test.openCard(p, 'size')
    button(card(), 'More size').click()
    button(card(), 'More size').click()
    const [item] = items(d)
    expect(item.tweaks).toHaveLength(1)
    expect(item.tweaks[0]).toMatchObject({ kind: 'size', tailwind: { from: 'text-sm', to: 'text-lg' }, summary: 'Size: text-sm → text-lg' })
    expect(p.getAttribute('style')).toContain('font-size')
    button(card(), 'Undo (Ctrl+Z)').click()
    expect(items(d)[0].tweaks[0].tailwind).toEqual({ from: 'text-sm', to: 'text-base' })
  })

  it('maps color swatches to the app palette utilities', () => {
    const btn = add('<button class="bg-indigo-600 text-white rounded-md">Save</button>')
    add('<div class="text-slate-900 border-slate-200">Neutral</div>')
    d.enable('direct', null, { sessionId: 's', items: [] })
    d.__test.openCard(btn, 'color')
    // Buttons default to the Background target.
    button(card(), 'bg-indigo-700').click()
    const tweak = items(d)[0].tweaks[0]
    expect(tweak).toMatchObject({ kind: 'background', tailwind: { from: 'bg-indigo-600', to: 'bg-indigo-700' }, summary: 'Background: bg-indigo-600 → bg-indigo-700' })
    expect(tweak.css?.[0]).toMatchObject({ property: 'background-color' })
    expect(tweak.css?.[0].to).toContain('--color-indigo-700')
    button(card(), 'Text color').click()
    button(card(), 'White').click()
    expect(items(d)[0].tweaks.map((t) => t.kind)).toEqual(['background', 'color'])
    expect(items(d)[0].tweaks[1]).toMatchObject({ tailwind: { from: 'text-white', to: 'text-white' } })
  })

  it('edits only the element’s own text and restores it when removed', () => {
    const btn = add('<button><svg id="icon"></svg> Add deal</button>')
    d.enable('direct', null, { sessionId: 's', items: [] })
    d.__test.openCard(btn, 'text')
    const input = card().querySelector('.sub textarea') as HTMLTextAreaElement
    input.value = 'New deal'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(btn.textContent?.trim()).toBe('New deal')
    expect(btn.querySelector('#icon')).not.toBeNull()
    const [item] = items(d)
    expect(item.tweaks[0]).toMatchObject({ kind: 'text', text: { from: 'Add deal', to: 'New deal' } })
    d.command({ op: 'removeItem', id: item.id })
    expect(btn.textContent?.trim()).toBe('Add deal')
  })

  it('applies to every element like this one when asked, and hides as a preview', () => {
    const chips = [add('<span class="chip px-2">One</span>'), add('<span class="chip px-2">Two</span>'), add('<span class="chip px-2">Three</span>')]
    d.enable('direct', null, { sessionId: 's', items: [] })
    d.__test.openCard(chips[0], 'hide')
    expect(card().querySelector('.check')?.textContent).toContain('Also 2 more like this')
    const scope = card().querySelector('.check input') as HTMLInputElement
    scope.checked = true
    scope.dispatchEvent(new Event('change'))
    button(card(), 'Remove it').click()
    expect(chips.every((c) => c.style.display === 'none')).toBe(true)
    const [item] = items(d)
    expect(item).toMatchObject({ similar: 2, tweaks: [{ kind: 'hide', summary: 'Remove this element' }] })
    d.command({ op: 'clear' })
    expect(chips.every((c) => c.style.display === '')).toBe(true)
  })

  it('previews a reorder with CSS order inside flex parents', () => {
    const row = add('<div style="display:flex"><button>A</button><button>B</button><button>C</button></div>')
    const [a, b, c] = Array.from(row.children) as HTMLElement[]
    d.enable('direct', null, { sessionId: 's', items: [] })
    d.__test.openCard(c, 'move')
    button(card(), /Earlier/).click()
    expect([a.style.order, c.style.order, b.style.order]).toEqual(['0', '1', '2'])
    expect(items(d)[0].tweaks[0]).toMatchObject({ kind: 'order', order: { direction: 'up', steps: -1, relativeTo: 'Button · B' } })
  })
})

describe('design controller v6 — charts, options, theme, polish, capture', () => {
  const SPEC = { type: 'bar', title: 'Revenue', encoding: { x: { field: 'month' }, y: { field: 'revenue' } }, data: [{ month: 'Jan', revenue: 3 }] }

  it('changes a Graphein chart live and records the spec diff without data', () => {
    const chart = add(`<div data-graphein-spec='${JSON.stringify(SPEC)}'></div>`)
    d.enable('direct', null, { sessionId: 's', items: [] })
    d.__test.openCard(chart)
    const type = card().querySelector('select[aria-label="Type"]') as HTMLSelectElement
    type.value = 'line'
    type.dispatchEvent(new Event('change'))
    expect(JSON.parse(chart.getAttribute('data-graphein-spec')!)).toMatchObject({ type: 'line', data: SPEC.data })
    const [item] = items(d)
    expect(item.chart?.summary).toContain('type: bar → line')
    expect(item.chart?.before).not.toHaveProperty('data')
    expect(item.chart?.after).toMatchObject({ type: 'line' })
    d.command({ op: 'removeItem', id: item.id })
    expect(JSON.parse(chart.getAttribute('data-graphein-spec')!)).toMatchObject({ type: 'bar' })
  })

  it('asks the host for AI options, previews them on hover, and applies one on click', () => {
    const box = add('<div class="rounded-md border p-4"><h3>Deals</h3><p>12 open</p></div>')
    d.enable('direct', null, { sessionId: 's', items: [] })
    d.__test.openCard(box)
    ;(card().querySelector('textarea') as HTMLTextAreaElement).value = 'make it feel premium'
    button(card(), /Options/).click()
    const [req] = d.peek()!.requests
    expect(req).toMatchObject({ kind: 'variations', hint: 'make it feel premium', context: { tag: 'div', isChart: false } })
    d.command({
      op: 'applyVariations', requestId: req.id,
      options: [
        { name: 'Elevated', description: 'Soft shadow', styles: { 'box-shadow': '0 8px 24px rgba(0,0,0,.2)' }, classes: 'shadow-lg' },
        { name: 'Tinted', styles: { 'background-color': 'rgb(238, 242, 255)' } }
      ]
    })
    expect(d.peek()!.requests).toEqual([])
    const option = (name: string): HTMLElement =>
      Array.from(card().querySelectorAll('.option')).find((o) => o.textContent?.includes(name)) as HTMLElement
    // Hovering previews without queueing anything; leaving restores the page.
    option('Tinted').dispatchEvent(new MouseEvent('mouseenter'))
    expect(box.style.backgroundColor).toBe('rgb(238, 242, 255)')
    expect(items(d)).toEqual([])
    option('Tinted').dispatchEvent(new MouseEvent('mouseleave'))
    expect(box.style.backgroundColor).toBe('')
    option('Elevated').dispatchEvent(new MouseEvent('mouseenter'))
    expect(box.style.boxShadow).toContain('24px')
    option('Elevated').dispatchEvent(new MouseEvent('mouseleave'))
    // Clicking applies right away.
    option('Tinted').click()
    const [item] = items(d)
    expect(item.instruction).toBe('make it feel premium')
    expect(item.tweaks[0]).toMatchObject({ kind: 'variation', summary: 'Look: Tinted', css: [{ property: 'background-color', to: 'rgb(238, 242, 255)' }] })
    expect(box.style.backgroundColor).toBe('rgb(238, 242, 255)')
    expect(option('Tinted').getAttribute('aria-pressed')).toBe('true')
    // Hovering another option previews it in place of the applied one, then goes back.
    option('Elevated').dispatchEvent(new MouseEvent('mouseenter'))
    expect(box.style.backgroundColor).toBe('')
    expect(box.style.boxShadow).toContain('24px')
    option('Elevated').dispatchEvent(new MouseEvent('mouseleave'))
    expect(box.style.backgroundColor).toBe('rgb(238, 242, 255)')
    expect(box.style.boxShadow).toBe('')
    // Picking another option swaps the look on the same item.
    option('Elevated').click()
    expect(items(d)).toHaveLength(1)
    expect(items(d)[0].tweaks).toHaveLength(1)
    expect(items(d)[0].tweaks[0]).toMatchObject({ summary: 'Look: Elevated — Soft shadow', classes: 'shadow-lg' })
    expect(box.style.backgroundColor).toBe('')
    button(card(), 'Done').click()
    expect(card().querySelector('.option')).toBeNull()
  })

  it('previews quick-tweak choices on hover before anything is recorded', () => {
    const btn = add('<button class="bg-indigo-600 text-white rounded-md">Save</button>')
    d.enable('direct', null, { sessionId: 's', items: [] })
    d.__test.openCard(btn, 'color')
    const swatch = button(card(), 'bg-indigo-800')
    swatch.dispatchEvent(new MouseEvent('mouseenter'))
    expect(btn.style.backgroundColor).toContain('--color-indigo-800')
    expect(items(d)).toEqual([])
    swatch.dispatchEvent(new MouseEvent('mouseleave'))
    expect(btn.getAttribute('style')).toBeNull()
    button(card(), 'bg-indigo-700').click()
    expect(btn.style.backgroundColor).toContain('--color-indigo-700')
    // Hovering a different swatch shows it instead, and leaving goes back to the recorded one.
    button(card(), 'bg-indigo-800').dispatchEvent(new MouseEvent('mouseenter'))
    expect(btn.style.backgroundColor).toContain('--color-indigo-800')
    button(card(), 'bg-indigo-800').dispatchEvent(new MouseEvent('mouseleave'))
    expect(btn.style.backgroundColor).toContain('--color-indigo-700')
    // Segmented choices preview the same way.
    button(card(), 'Color').click()
    button(card(), 'Corners').click()
    const pill = button(card(), 'Pill')
    pill.dispatchEvent(new MouseEvent('mouseenter'))
    expect(btn.style.borderRadius).toBe('9999px')
    pill.dispatchEvent(new MouseEvent('mouseleave'))
    expect(btn.style.borderRadius).toBe('')
    expect(items(d)[0].tweaks.map((t) => t.kind)).toEqual(['background'])
  })

  it('shows options as they stream in, and a hovered one keeps its preview when the rest arrive', () => {
    const box = add('<div class="rounded-md border p-4"><h3>Deals</h3></div>')
    d.enable('direct', null, { sessionId: 's', items: [] })
    d.__test.openCard(box)
    button(card(), /Options/).click()
    const [req] = d.peek()!.requests
    const tinted = { name: 'Tinted', styles: { 'background-color': 'rgb(238, 242, 255)' } }
    const elevated = { name: 'Elevated', styles: { 'box-shadow': '0 8px 24px rgba(0,0,0,.2)' } }
    d.command({ op: 'addVariation', requestId: req.id, index: 0, option: tinted })
    expect(card().textContent).toContain('Designing more…')
    const first = card().querySelector('.option') as HTMLElement
    first.dispatchEvent(new MouseEvent('mouseenter'))
    expect(box.style.backgroundColor).toBe('rgb(238, 242, 255)')
    // A repeated name and another request's option are ignored; a new one is appended in place.
    d.command({ op: 'addVariation', requestId: req.id, index: 1, option: { ...tinted } })
    d.command({ op: 'addVariation', requestId: 'other', index: 0, option: elevated })
    d.command({ op: 'addVariation', requestId: req.id, index: 1, option: elevated })
    expect(Array.from(card().querySelectorAll('.option b')).map((b) => b.textContent)).toEqual(['Tinted', 'Elevated'])
    expect(card().querySelector('.option')).toBe(first)
    expect(box.style.backgroundColor).toBe('rgb(238, 242, 255)')
    expect(d.peek()!.requests).toHaveLength(1)
    d.command({ op: 'applyVariations', requestId: req.id, options: [tinted, elevated] })
    expect(d.peek()!.requests).toEqual([])
    expect(card().textContent).not.toContain('Designing more…')
    expect(button(card(), /More options/)).toBeTruthy()
    expect(button(card(), 'Options').disabled).toBe(false)
    expect(card().querySelector('.option')).toBe(first)
    expect(box.style.backgroundColor).toBe('rgb(238, 242, 255)')
  })

  it('keeps streamed options when the request fails afterwards', () => {
    const box = add('<div class="p-4">Box</div>')
    d.enable('direct', null, { sessionId: 's', items: [] })
    d.__test.openCard(box)
    button(card(), /Options/).click()
    const [req] = d.peek()!.requests
    expect(button(card(), 'Options').disabled).toBe(true)
    d.command({ op: 'addVariation', requestId: req.id, index: 0, option: { name: 'Soft', styles: { 'border-radius': '12px' } } })
    d.command({ op: 'failRequest', requestId: req.id, message: 'The reply was cut off.' })
    expect(Array.from(card().querySelectorAll('.option b')).map((b) => b.textContent)).toEqual(['Soft'])
    expect(card().textContent).not.toContain('The reply was cut off.')
    expect(button(card(), 'Options').disabled).toBe(false)
  })

  it('keeps the options that already arrived when Stop ends the request', () => {
    const box = add('<div class="p-4">Box</div>')
    d.enable('direct', null, { sessionId: 's', items: [] })
    d.__test.openCard(box)
    button(card(), /Options/).click()
    const [req] = d.peek()!.requests
    d.command({ op: 'addVariation', requestId: req.id, index: 0, option: { name: 'Soft', styles: { 'border-radius': '12px' } } })
    button(card(), 'Stop').click()
    expect(d.peek()!.requests).toEqual([])
    expect(card().querySelectorAll('.option')).toHaveLength(1)
    expect(button(card(), /More options/)).toBeTruthy()
    // A late final answer for the stopped request changes nothing.
    d.command({ op: 'applyVariations', requestId: req.id, options: [{ name: 'Late', styles: { color: 'red' } }] })
    expect(Array.from(card().querySelectorAll('.option b')).map((b) => b.textContent)).toEqual(['Soft'])
  })

  it('reports a failed options request in the card', () => {
    const el = add('<div class="p-4">Box</div>')
    d.enable('direct', null, { sessionId: 's', items: [] })
    d.__test.openCard(el)
    button(card(), /Options/).click()
    const [req] = d.peek()!.requests
    d.command({ op: 'failRequest', requestId: req.id, message: 'Couldn’t reach the model.' })
    expect(card().textContent).toContain('Couldn’t reach the model.')
    expect(d.peek()!.requests).toEqual([])
    // The error offers a retry that sends a fresh request.
    button(card(), /Try again/).click()
    expect(d.peek()!.requests).toHaveLength(1)
  })

  it('explains what is happening while options take a while, and can cancel', () => {
    // Fake timers and Date only: animation frames stay manual (raf()), as the controller's
    // frame loop is what refreshes the elapsed labels.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    try {
      const el = add('<div class="p-4">Box</div>')
      d.enable('direct', null, { sessionId: 's', items: [] })
      d.__test.openCard(el)
      button(card(), /Options/).click()
      const [req] = d.peek()!.requests
      const note = (): string => card().querySelector('[role="status"]')?.textContent ?? ''
      const elapsed = (): string => card().querySelector('.elapsed')?.textContent ?? ''
      expect(card().textContent).toContain('Designing a few options…')
      expect(elapsed()).toBe('0s')
      vi.advanceTimersByTime(5000)
      raf()
      expect(elapsed()).toBe('5s')
      expect(note()).toContain('Waiting for Fabricator')
      d.command({ op: 'requestProgress', requestId: req.id, message: 'Asking GPT-5 mini for three looks…' })
      expect(note()).toBe('Asking GPT-5 mini for three looks…')
      vi.advanceTimersByTime(11000)
      raf()
      expect(note()).toContain('Still working')
      vi.advanceTimersByTime(30000)
      raf()
      expect(note()).toContain('Taking longer than usual')
      button(card(), 'Cancel').click()
      expect(d.peek()!.requests).toEqual([])
      expect(card().textContent).not.toContain('Designing a few options…')
      // A request nobody answers times out with a clear next step.
      button(card(), /Options/).click()
      vi.advanceTimersByTime(91000)
      d.peek()
      expect(card().textContent).toContain('No options after 90 seconds')
      expect(button(card(), /Try again/)).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows elapsed time and slow-run hints while a Polish review runs', () => {
    // Fake timers and Date only: animation frames stay manual (raf()), as the controller's
    // frame loop is what refreshes the elapsed labels.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    try {
      d.enable('direct', null, { sessionId: 's', items: [] })
      d.command({ op: 'setBusy', message: 'Asking GPT-5 mini to review this page…' })
      expect(d.peek()?.panel).toBe('polish')
      expect(panel().textContent).toContain('Asking GPT-5 mini to review this page…')
      vi.advanceTimersByTime(25000)
      raf()
      expect(panel().querySelector('.elapsed')?.textContent).toBe('25s')
      expect(panel().textContent).toContain('Reviews usually take 20–60 seconds.')
      // Closing the panel cancels the review.
      button(panel(), 'Close').click()
      expect(d.peek()?.panel).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('previews an app-wide theme through CSS variables and resets it', () => {
    add('<style>:root{--spacing:0.25rem;--color-indigo-600:oklch(0.51 0.26 277);--radius-lg:0.5rem}.dark .x{color:white}</style>')
    add('<button class="bg-indigo-600 text-white">A</button>')
    add('<p class="text-slate-900">B</p>')
    d.enable('direct', null, { sessionId: 's', items: [] })
    expect(d.__test.detectTheme()).toMatchObject({ tailwind: true, accent: 'indigo', neutral: 'slate', dark: true })
    d.command({ op: 'openPanel', panel: 'theme' })
    expect(d.peek()?.panel).toBe('theme')
    button(panel(), 'emerald').click()
    button(panel(), 'Round').click()
    const theme = items(d).find((i) => i.kind === 'theme')!
    expect(theme.theme?.accent).toEqual({ from: 'indigo', to: 'emerald' })
    expect(theme.theme?.tokens['--color-indigo-600']).toMatch(/^oklch\(/)
    expect(theme.theme?.tokens['--radius-lg']).toBe('0.8rem')
    expect(theme.theme?.summary).toEqual(['Accent: indigo → emerald', 'Corners: ×1.6'])
    expect(document.getElementById('__rayfin_design_theme')?.textContent).toContain('--color-indigo-600')
    button(panel(), 'Reset').click()
    expect(document.getElementById('__rayfin_design_theme')).toBeNull()
    expect(items(d)).toEqual([])
  })

  it('previews a hovered theme choice across the app without queueing it', () => {
    add('<style>:root{--spacing:0.25rem;--color-indigo-600:oklch(0.51 0.26 277);--radius-lg:0.5rem}</style>')
    add('<button class="bg-indigo-600 text-white rounded-lg">A</button>')
    d.enable('direct', null, { sessionId: 's', items: [] })
    d.command({ op: 'openPanel', panel: 'theme' })
    const style = (): string | null => document.getElementById('__rayfin_design_theme')?.textContent ?? null
    button(panel(), 'rose').dispatchEvent(new MouseEvent('mouseenter'))
    expect(style()).toContain('--color-indigo-600')
    expect(items(d)).toEqual([])
    button(panel(), 'rose').dispatchEvent(new MouseEvent('mouseleave'))
    expect(style()).toBeNull()
    // With a theme applied, hovering another choice previews on top of it and leaving goes back.
    button(panel(), 'Round').click()
    const applied = style()
    expect(applied).toContain('--radius-lg')
    button(panel(), 'Extra').dispatchEvent(new MouseEvent('mouseenter'))
    expect(style()).not.toBe(applied)
    button(panel(), 'Extra').dispatchEvent(new MouseEvent('mouseleave'))
    expect(style()).toBe(applied)
    expect(items(d).filter((i) => i.kind === 'theme')).toHaveLength(1)
  })

  it('collects a page outline with findings and turns suggestions into items', () => {
    const faint = add('<p style="color:#bbbbbb;background:#ffffff">This sentence is hard to read on white.</p>')
    const btn = add('<button>Go</button>')
    ;[faint, btn].forEach((el, i) => rect(el, { x: 10, y: 10 + i * 40, w: 300, h: 30 }))
    d.enable('direct', null, { sessionId: 's', items: [] })
    d.command({ op: 'collectPage', requestId: 'r1' })
    const outline = d.peek()!.results.r1 as { elements: { ref: string; label: string }[]; findings: { kind: string; ref?: string }[] }
    const faintRef = outline.elements.find((e) => e.label.startsWith('Text'))!.ref
    expect(outline.findings).toContainEqual(expect.objectContaining({ kind: 'contrast', ref: faintRef }))
    d.command({
      op: 'showSuggestions',
      suggestions: [{ id: 's1', ref: faintRef, title: 'Darken the body text', why: 'Readable contrast', instruction: 'Use text-slate-700 for body copy.', styles: { color: 'rgb(51, 65, 85)' } }]
    })
    button(panel(), 'Preview').click()
    expect(faint.style.color).toBe('rgb(51, 65, 85)')
    button(panel(), 'Add').click()
    const [item] = items(d)
    expect(item).toMatchObject({ kind: 'suggestion', instruction: 'Use text-slate-700 for body copy.', why: 'Readable contrast' })
    expect(faint.style.color).toBe('rgb(51, 65, 85)')
  })

  it('hides its chrome for a capture and reports where each item sits', () => {
    const a = add('<p>First paragraph</p>')
    rect(a, { x: -20, y: 30, w: 200, h: 40 })
    d.enable('direct', null, { sessionId: 's', items: [] })
    d.__test.openCard(a)
    addInstruction('x')
    const id = items(d)[0].id
    d.command({ op: 'prepareCapture', requestId: 'cap', ids: [id] })
    expect(shadow().querySelector('.layer')?.classList.contains('capturing')).toBe(true)
    expect(d.peek()!.results.cap).toMatchObject({ frame: { x: 0, y: 0 }, rects: { [id]: { x: 0, y: 30, w: 180, h: 40 } } })
    d.command({ op: 'endCapture' })
    expect(shadow().querySelector('.layer')?.classList.contains('capturing')).toBe(false)
  })

  it('reports only the selected element for an Options screenshot', () => {
    const queued = add('<p>Queued paragraph</p>')
    const picked = add('<button>Save</button>')
    rect(queued, { x: 10, y: 10, w: 200, h: 40 })
    rect(picked, { x: 30, y: 80, w: 90, h: 36 })
    d.enable('direct', null, { sessionId: 's', items: [] })
    d.__test.openCard(queued)
    addInstruction('x')
    d.__test.openCard(picked)
    d.command({ op: 'prepareCapture', requestId: 'sel', ids: [], selection: true })
    expect(d.peek()!.results.sel).toMatchObject({ rects: { selection: { x: 30, y: 80, w: 90, h: 36 } } })
    expect(Object.keys((d.peek()!.results.sel as { rects: object }).rects)).toEqual(['selection'])
    expect(shadow().querySelector('.layer')?.classList.contains('capturing')).toBe(true)
    d.command({ op: 'endCapture' })
  })

  it('computes WCAG contrast from computed colors, including oklch', () => {
    const t = d.__test
    expect(t.contrastRatio(t.parseColor('#000'), t.parseColor('#fff'))).toBeCloseTo(21, 0)
    expect(t.parseColor('rgb(10 20 30 / 50%)')).toMatchObject({ r: 10, g: 20, b: 30, a: 0.5 })
    const white = t.parseColor('oklch(1 0 0)')!
    expect([white.r, white.g, white.b]).toEqual([255, 255, 255])
  })
})

/** A queued item for an element already on the page (seeded as the host would). */
function seeded(id: string, selector: string, tweaks: DesignItem['tweaks'], extra: Partial<DesignItem> = {}): DesignItem {
  const el = document.querySelector(selector)!
  return {
    id,
    kind: 'element',
    tweaks,
    createdAt: 1,
    target: { label: id, role: 'element', tag: el.tagName.toLowerCase(), selector, route: location.pathname + location.search + location.hash, box: { w: 0, h: 0 } },
    ...extra
  }
}
const bg = (color: string): DesignItem['tweaks'][number] => ({ kind: 'background', summary: `bg ${color}`, css: [{ property: 'background-color', to: color }] })

describe('design controller v6 — overlapping previews', () => {
  it('restores a move and a neighbour’s tweak independently, whichever goes first', () => {
    add('<div style="display:flex"><span id="c1">A</span><span id="c2">B</span><span id="c3">C</span></div>')
    const [c1, c2, c3] = ['c1', 'c2', 'c3'].map((id) => document.getElementById(id)!)
    d.enable('direct', null, {
      sessionId: 's',
      items: [
        seeded('bg2', '#c2', [bg('blue')]),
        seeded('move', '#c3', [{ kind: 'order', summary: 'Move earlier', order: { direction: 'up', steps: -2 } }]),
        seeded('bg1', '#c1', [bg('red')])
      ]
    })
    expect([c3.style.order, c1.style.order, c2.style.order]).toEqual(['0', '1', '2'])
    expect([c1.style.backgroundColor, c2.style.backgroundColor]).toEqual(['red', 'blue'])
    d.command({ op: 'removeItem', id: 'move' })
    expect([c1.style.order, c2.style.order, c3.style.order]).toEqual(['', '', ''])
    expect([c1.style.backgroundColor, c2.style.backgroundColor]).toEqual(['red', 'blue'])
    d.disable()
    expect([c1, c2, c3].map((el) => el.getAttribute('style'))).toEqual([null, null, null])
  })

  it('keeps one change’s preview when another change on the same element goes away', () => {
    const btn = add('<button id="b" style="margin: 2px">Go</button>')
    d.enable('direct', null, {
      sessionId: 's',
      items: [
        seeded('s1', '#b', [{ kind: 'variation', summary: 'white', css: [{ property: 'color', to: 'white' }] }], { kind: 'suggestion' }),
        seeded('s2', '#b', [{ kind: 'variation', summary: 'big', css: [{ property: 'font-size', to: '20px' }] }], { kind: 'suggestion' })
      ]
    })
    expect([btn.style.color, btn.style.fontSize]).toEqual(['white', '20px'])
    d.command({ op: 'removeItem', id: 's1' })
    expect([btn.style.color, btn.style.fontSize, btn.style.margin]).toEqual(['', '20px', '2px'])
    d.disable()
    expect(btn.getAttribute('style')).toBe('margin: 2px')
  })

  it('keeps the app’s own inline-style changes made while a preview is showing', () => {
    const bar = add('<div id="bar" style="width: 10%">x</div>')
    d.enable('direct', null, { sessionId: 's', items: [seeded('c', '#bar', [bg('blue')])] })
    expect(bar.style.backgroundColor).toBe('blue')
    bar.style.width = '55%'
    d.command({ op: 'removeItem', id: 'c' })
    expect([bar.style.width, bar.style.backgroundColor]).toEqual(['55%', ''])
  })

  it('keeps an edited label intact while other previews come and go', () => {
    const btn = add('<button class="bg-indigo-600 text-white">Add <b>new</b> deal</button>')
    d.enable('direct', null, { sessionId: 's', items: [] })
    d.__test.openCard(btn, 'text')
    const input = card().querySelector('.sub textarea') as HTMLTextAreaElement
    expect(input.value).toBe('Add deal')
    input.value = 'Create'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(btn.textContent).toBe('Create new')
    button(card(), 'Color').click()
    const swatch = button(card(), 'bg-indigo-800')
    swatch.dispatchEvent(new MouseEvent('mouseenter'))
    swatch.dispatchEvent(new MouseEvent('mouseleave'))
    expect(btn.textContent).toBe('Create new')
    d.command({ op: 'clear' })
    expect(btn.textContent).toBe('Add new deal')
  })

  it('records a picked choice against the element’s real look, not the hovered preview', () => {
    const btn = add('<button class="bg-indigo-600 text-white rounded-md">Save</button>')
    d.enable('direct', null, { sessionId: 's', items: [] })
    d.__test.openCard(btn, 'color')
    const swatch = button(card(), 'bg-indigo-800')
    swatch.dispatchEvent(new MouseEvent('mouseenter'))
    expect(getComputedStyle(btn).backgroundColor).toContain('indigo-800')
    swatch.click()
    const tweak = items(d)[0].tweaks[0]
    expect(tweak.tailwind).toEqual({ from: 'bg-indigo-600', to: 'bg-indigo-800' })
    expect(tweak.css?.[0].from ?? '').not.toContain('indigo-800')
  })

  it('leaves Polish previews and the dark-mode preview out of captures', () => {
    add('<style>:root{--color-indigo-600:oklch(0.51 0.26 277)}.dark .x{color:white}</style>')
    const btn = add('<button class="bg-indigo-600 x">Go</button>')
    rect(btn, { x: 10, y: 10, w: 120, h: 36 })
    d.enable('direct', null, { sessionId: 's', items: [] })
    d.command({ op: 'collectPage', requestId: 'r1' })
    const outline = d.peek()!.results.r1 as { elements: { ref: string; role: string }[] }
    const ref = outline.elements.find((e) => e.role === 'button')!.ref
    d.command({
      op: 'showSuggestions',
      // Only whitelisted, safe properties survive.
      suggestions: [{ id: 's1', ref, title: 'Bolder', why: '', instruction: 'Bolder label', styles: { 'font-weight': '700', position: 'fixed', color: 'url(https://x.example/a)' } }]
    })
    button(panel(), 'Preview').click()
    expect([btn.style.fontWeight, btn.style.position, btn.style.color]).toEqual(['700', '', ''])
    d.command({ op: 'openPanel', panel: 'theme' })
    button(panel(), 'Dark').click()
    const dark = (): boolean => document.documentElement.classList.contains('dark')
    expect(dark()).toBe(true)
    d.command({ op: 'prepareCapture', requestId: 'cap', ids: [] })
    expect(dark()).toBe(false)
    d.command({ op: 'endCapture' })
    expect(dark()).toBe(true)
    // A Polish review looks at the real app, not the dark preview.
    d.command({ op: 'openPanel', panel: 'polish' })
    expect(dark()).toBe(false)
  })

  it('keeps suggestion previews out of a capture and brings them back after', () => {
    const btn = add('<button>Go</button>')
    rect(btn, { x: 10, y: 10, w: 120, h: 36 })
    d.enable('direct', null, { sessionId: 's', items: [] })
    d.command({ op: 'collectPage', requestId: 'r1' })
    const ref = (d.peek()!.results.r1 as { elements: { ref: string; role: string }[] }).elements.find((e) => e.role === 'button')!.ref
    d.command({ op: 'showSuggestions', suggestions: [{ id: 's1', ref, title: 'Bolder', why: '', instruction: 'x', styles: { 'font-weight': '700' } }] })
    button(panel(), 'Preview').click()
    expect(btn.style.fontWeight).toBe('700')
    d.command({ op: 'prepareCapture', requestId: 'cap', ids: [] })
    expect(btn.style.fontWeight).toBe('')
    d.command({ op: 'endCapture' })
    expect(btn.style.fontWeight).toBe('700')
  })

  it('drops unsafe properties from AI options', () => {
    const box = add('<div class="p-4">Box</div>')
    d.enable('direct', null, { sessionId: 's', items: [] })
    d.__test.openCard(box)
    button(card(), /Options/).click()
    const [req] = d.peek()!.requests
    d.command({
      op: 'applyVariations', requestId: req.id,
      options: [
        { name: 'Sneaky', styles: { position: 'fixed', 'background-image': 'url(https://x.example/t.png)' } },
        { name: 'Soft', styles: { 'border-radius': '12px', position: 'fixed' } }
      ]
    })
    const names = Array.from(card().querySelectorAll('.option b')).map((b) => b.textContent)
    expect(names).toEqual(['Soft'])
    ;(card().querySelector('.option') as HTMLElement).click()
    expect(items(d)[0].tweaks[0].css).toEqual([{ property: 'border-radius', to: '12px' }])
    expect(box.style.position).toBe('')
  })
})

/** An app themed like the Rayfin templates: semantic colors and its own scales. */
const TOKEN_THEME = `<style>:root{--spacing:0.25rem;--color-primary:#1d4ed8;--color-primary-foreground:#ffffff;--color-card:#ffffff;
--color-muted:#e5edf9;--color-muted-foreground:#475467;--color-border:#d8e1ef;--text-200:12px;--text-300:14px;--text-400:16px;--text-500:20px;
--spacing-200:8px;--spacing-300:12px;--spacing-400:16px;--spacing-500:20px;--spacing-dashboard:1320px;--radius-lg:6px;--radius-2xl:12px;
--radius-4xl:24px;--radius-5xl:32px;--font-base:Manrope, sans-serif;--font-weight-regular:400}.dark{--color-primary:#60a5fa}</style>`

function tokenApp(): { tile: HTMLElement; label: HTMLElement; go: HTMLElement } {
  add(TOKEN_THEME)
  const tile = add('<div class="rounded-4xl bg-card p-500 text-primary"><p class="text-300 text-muted-foreground">Total</p><button class="bg-primary text-primary-foreground">Go</button></div>')
  return { tile, label: tile.querySelector('p')!, go: tile.querySelector('button')! }
}

describe('design controller v6 — the app’s own design system', () => {
  it('summarizes the app’s colors and scales and sends them with an Options request', () => {
    const { tile } = tokenApp()
    d.enable('direct', null, { sessionId: 's', items: [] })
    const sys = d.__test.designSystem()!
    // Most-used colors first; spacing ignores layout sizes like --spacing-dashboard.
    expect(sys.colors?.[0]).toEqual(['primary', '#1d4ed8'])
    expect(sys.colors?.map(([name]) => name)).toEqual(expect.arrayContaining(['card', 'muted-foreground', 'border']))
    expect(sys.text).toEqual([['200', '12px'], ['300', '14px'], ['400', '16px'], ['500', '20px']])
    expect(sys.spacing).toEqual([['200', '8px'], ['300', '12px'], ['400', '16px'], ['500', '20px']])
    expect(sys.radius).toContainEqual(['4xl', '24px'])
    // jsdom drops the space after the comma in custom-property values; browsers keep it.
    expect(sys.fonts?.map(([name, value]) => [name, value.replace(/,\s*/g, ', ')])).toEqual([
      ['base', 'Manrope, sans-serif']
    ])
    expect(sys.dark).toBe(true)
    d.__test.openCard(tile)
    button(card(), /Options/).click()
    expect(d.peek()!.requests[0].context.system).toEqual(sys)
  })

  it('offers the app’s own colors first and records them as its utilities', () => {
    const { go } = tokenApp()
    d.enable('direct', null, { sessionId: 's', items: [] })
    d.__test.openCard(go, 'color')
    expect(card().textContent).toContain('Your colors')
    // No made-up palette rows for an app that only uses its own colors.
    expect(card().querySelector('[aria-label="bg-slate-500"]')).toBeNull()
    button(card(), 'bg-card').click()
    expect(items(d)[0].tweaks[0]).toMatchObject({
      kind: 'background',
      tailwind: { from: 'bg-primary', to: 'bg-card' },
      css: [{ property: 'background-color', to: 'var(--color-card)' }]
    })
    button(card(), 'Text color').click()
    button(card(), 'text-muted-foreground').click()
    expect(items(d)[0].tweaks[1]).toMatchObject({ kind: 'color', tailwind: { from: 'text-primary-foreground', to: 'text-muted-foreground' } })
  })

  it('steps size, padding, corners and weight along the app’s own scales', () => {
    const { tile, label } = tokenApp()
    d.enable('direct', null, { sessionId: 's', items: [] })
    d.__test.openCard(label, 'size')
    button(card(), 'More size').click()
    expect(items(d)[0].tweaks[0]).toMatchObject({ tailwind: { from: 'text-300', to: 'text-400' }, css: [{ property: 'font-size', to: 'var(--text-400)' }] })
    expect(items(d)[0].tweaks[0].css).toHaveLength(1)
    button(card(), 'Regular').click()
    expect(items(d)[0].tweaks[1]).toMatchObject({ kind: 'weight', tailwind: { to: 'font-regular' } })
    d.__test.openCard(tile, 'spacing')
    button(card(), 'Less padding').click()
    const spacing = items(d).find((i) => i.tweaks.some((t) => t.kind === 'spacing'))!.tweaks[0]
    expect(spacing).toMatchObject({ tailwind: { from: 'p-500', to: 'p-400' }, css: [{ property: 'padding', to: 'var(--spacing-400) var(--spacing-400)' }] })
    button(card(), 'Corners').click()
    expect(button(card(), 'Extra').getAttribute('aria-pressed')).toBe('true')
    button(card(), 'Round').click()
    const corners = items(d).flatMap((i) => i.tweaks).find((t) => t.kind === 'corners')!
    expect(corners).toMatchObject({ tailwind: { from: 'rounded-4xl', to: 'rounded-2xl' }, css: [{ property: 'border-radius', to: 'var(--radius-2xl)' }] })
  })

  it('recolors a semantic accent in light and dark, and scales named spacing and font tokens', () => {
    tokenApp()
    d.enable('direct', null, { sessionId: 's', items: [] })
    d.command({ op: 'openPanel', panel: 'theme' })
    expect(panel().textContent).toContain('Accent color · now primary')
    button(panel(), 'emerald').click()
    let theme = items(d).find((i) => i.kind === 'theme')!.theme!
    expect(theme.accent).toEqual({ from: 'primary', to: 'emerald', token: true })
    expect(theme.tokens['--color-primary']).toContain('--color-emerald-600')
    expect(theme.darkTokens?.['--color-primary']).toContain('--color-emerald-400')
    expect(theme.summary).toEqual(['Accent: primary → emerald'])
    const css = document.getElementById('__rayfin_design_theme')!.textContent!
    expect(css.indexOf(':root{')).toBeLessThan(css.indexOf('.dark{'))
    button(panel(), 'Compact').click()
    const font = panel().querySelector('select[aria-label="Font"]') as HTMLSelectElement
    font.value = font.options[5].value
    font.dispatchEvent(new Event('change'))
    theme = items(d).find((i) => i.kind === 'theme')!.theme!
    expect(theme.tokens['--spacing']).toBe('0.22rem')
    expect(theme.tokens['--spacing-400']).toBe('14.08px')
    expect(theme.tokens['--font-base']).toBe(font.value)
  })
})