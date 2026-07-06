import { readFileSync } from 'fs'
import { resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Unit tests for the injected design controller
 * (`src-tauri/src/services/design_agent.js`), exercised in the `direct` frame
 * role (top frame IS the app). Covers the flagship behaviours added here:
 *   - it adopts a host-pushed Fabricator theme (accent) + UI scale,
 *   - AI restyle applies a patch as revertable inline-style changes, and
 *   - descendant `rules` reach children (children-aware edits).
 * The controller is a document-start IIFE; we eval it into the jsdom window.
 */

const SRC = readFileSync(resolve(process.cwd(), 'src-tauri/src/services/design_agent.js'), 'utf8')
const HOST_ID = '__rayfin_design_host'

interface DesignApi {
  __v: number
  enable: (mode?: string, appOrigin?: string) => void
  disable: () => void
  peek: () => Record<string, unknown> | null
  drain: () => Record<string, unknown> | null
  setTheme: (theme: Record<string, unknown>) => void
  setModels: (list: { id: string; name: string; fast?: boolean }[], preferred?: string) => void
  applyRestyle: (id: string, patch: Record<string, unknown>) => void
}

function install(): DesignApi {
  new Function(SRC)()
  return (window as unknown as { __rayfinDesign: DesignApi }).__rayfinDesign
}
function shadow(): ShadowRoot | null | undefined {
  return document.getElementById(HOST_ID)?.shadowRoot
}
function styleText(): string {
  const host = document.getElementById(HOST_ID)
  const style = host?.shadowRoot?.querySelector('style')
  return style?.textContent || ''
}

describe('design controller — theme + AI restyle', () => {
  beforeEach(() => {
    // The controller's rAF loop only positions overlays; make it a no-op so
    // enable() doesn't require a visual jsdom and nothing loops in tests.
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    delete (window as unknown as { __rayfinDesign?: unknown }).__rayfinDesign
    document.body.innerHTML = ''
  })
  afterEach(() => {
    try {
      ;(window as unknown as { __rayfinDesign?: DesignApi }).__rayfinDesign?.disable()
    } catch {
      /* ignore */
    }
    delete (window as unknown as { __rayfinDesign?: unknown }).__rayfinDesign
    vi.unstubAllGlobals()
  })

  it('adopts a host-pushed Fabricator theme accent + UI scale', () => {
    const d = install()
    expect(d.__v).toBe(4)
    d.enable('direct')
    d.setTheme({ accent: '#4f46e5', panel: '#ffffff', txt: '#111111', scale: 1.5 })
    const css = styleText()
    expect(css).toContain('#4f46e5') // accent painted into the chrome
    expect(css).toContain('--fs-base:20px') // base 13px * 1.5 scale
  })

  it('applies an AI restyle patch as revertable inline edits on the tagged element', () => {
    const el = document.createElement('div')
    el.setAttribute('data-rayfin-edit-id', 'x1')
    el.textContent = 'Card'
    document.body.appendChild(el)
    const d = install()
    d.enable('direct')
    d.applyRestyle('x1', { styles: { 'border-radius': '14px', 'background-color': '#0e8187' } })
    expect(el.style.borderRadius).toBe('14px')
    expect(el.style.backgroundColor).toBeTruthy()
    expect(d.peek()).toMatchObject({ changeCount: 2 })
  })

  it('applies descendant rules to children (children-aware edit)', () => {
    const wrap = document.createElement('div')
    wrap.setAttribute('data-rayfin-edit-id', 'c1')
    wrap.innerHTML = '<h1>Title</h1><button class="btn">Go</button>'
    document.body.appendChild(wrap)
    const d = install()
    d.enable('direct')
    d.applyRestyle('c1', {
      styles: {},
      rules: [
        { selector: 'h1', styles: { color: '#22c55e' } },
        { selector: '.btn', styles: { 'border-radius': '999px' } }
      ]
    })
    expect((wrap.querySelector('h1') as HTMLElement).style.color).toBeTruthy()
    expect((wrap.querySelector('.btn') as HTMLElement).style.borderRadius).toBe('999px')
    // two descendant props applied → two change-set entries
    expect(d.peek()).toMatchObject({ changeCount: 2 })
  })

  it('defaults the model to Auto and persists an explicit Auto choice', () => {
    const d = install()
    d.enable('direct')
    expect(d.peek()).toMatchObject({ aiModel: 'auto' }) // default for first-time users
    d.setModels([{ id: 'gpt-x', name: 'GPT-X', fast: true }], undefined)
    expect(d.peek()).toMatchObject({ aiModel: 'auto' }) // stays Auto when nothing persisted
    d.setModels([{ id: 'gpt-x', name: 'GPT-X', fast: true }], 'gpt-x')
    expect(d.peek()).toMatchObject({ aiModel: 'gpt-x' }) // honours a persisted model
    d.setModels([{ id: 'gpt-x', name: 'GPT-X', fast: true }], 'auto')
    expect(d.peek()).toMatchObject({ aiModel: 'auto' }) // honours a persisted Auto (the fix)
  })

  it('ignores non-whitelisted properties in a restyle patch', () => {
    const el = document.createElement('div')
    el.setAttribute('data-rayfin-edit-id', 'x2')
    document.body.appendChild(el)
    const d = install()
    d.enable('direct')
    d.applyRestyle('x2', { styles: { position: 'absolute', color: '#333333' } })
    expect(el.style.position).toBe('') // not whitelisted → dropped
    expect(el.style.color).toBeTruthy()
    expect(d.peek()).toMatchObject({ changeCount: 1 })
  })

  it('strips inserted-placeholder chrome + draws no markers in the handoff capture, then restores', () => {
    // An inserted+generated placeholder keeps its dashed "drop-zone" border + tint;
    // the "Send to chat" screenshot must not capture that (nor an amber numbered
    // marker over the design) — the agent would read them as intended UI. The
    // screenshot should be the clean result; drain() restores the design chrome.
    const ph = document.createElement('div')
    ph.setAttribute('data-rayfin-placeholder', '1')
    ph.setAttribute('data-rayfin-edit-id', 'p1')
    ph.setAttribute('style', 'border:2px dashed rgb(52, 180, 186);background:rgba(52, 180, 186, 0.08);')
    ph.innerHTML = '<div class="generated">Chart</div>'
    document.body.appendChild(ph)
    const d = install()
    d.enable('direct')
    // A recorded change is required for beginHandoff() to proceed.
    d.applyRestyle('p1', { styles: { 'border-radius': '10px' } })
    const before = ph.getAttribute('style') || ''

    // Trigger the handoff via the toolbar Send button (its real code path).
    const send = shadow()?.querySelector('.tb-send') as HTMLElement | null
    expect(send).toBeTruthy()
    send!.click()

    // Capture-time: dashed border + tint neutralized, changes panel hidden, and
    // NO amber marker overlaid on the design.
    expect(ph.style.borderColor).toBe('transparent')
    expect(ph.style.background).toBe('transparent')
    expect((shadow()?.querySelector('.changes') as HTMLElement | null)?.style.display).toBe('none')
    expect(shadow()?.querySelector('.marker')).toBeFalsy()
    expect(d.peek()).toMatchObject({ handoffReady: true })

    // Drain (host captured) restores the placeholder's original inline style.
    d.drain()
    expect(ph.getAttribute('style')).toBe(before)
    expect(ph.style.borderColor).not.toBe('transparent')
  })
})
