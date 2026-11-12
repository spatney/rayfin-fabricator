import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalView } from './session'

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    unicode = { activeVersion: '6' }
    rows = 24
    cols = 80
    open = vi.fn()
    clearTextureAtlas = vi.fn()
    refresh = vi.fn()
    dispose = vi.fn()
    loadAddon(): void {}
    registerLinkProvider(): void {}
    attachCustomKeyEventHandler(): void {}
  }
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    proposeDimensions(): undefined {}
  }
}))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }))
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss(): void {}
    dispose(): void {}
  }
}))

class View extends TerminalView {}

const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts')
let loaded: Promise<FontFace[]>
let resolveFont: (faces: FontFace[]) => void
let rejectFont: (error: Error) => void
let load: ReturnType<typeof vi.fn>
let view: View
let container: HTMLDivElement

beforeEach(() => {
  loaded = new Promise((resolve, reject) => {
    resolveFont = resolve
    rejectFont = reject
  })
  load = vi.fn(() => loaded)
  Object.defineProperty(document, 'fonts', { configurable: true, value: { load } })
  container = document.createElement('div')
  document.body.appendChild(container)
  view = new View('test', 'project', 'C:\\app')
})

afterEach(() => {
  view.dispose()
  container.remove()
  if (originalFonts) Object.defineProperty(document, 'fonts', originalFonts)
  else Reflect.deleteProperty(document, 'fonts')
})

describe('terminal prompt fonts', () => {
  it('invalidates cached missing glyphs and redraws after the bundled font loads', async () => {
    view.attach(container)
    const fit = vi.spyOn(view, 'fit')
    expect(view.term.refresh).not.toHaveBeenCalled()

    resolveFont([])
    await loaded

    expect(view.term.clearTextureAtlas).toHaveBeenCalledOnce()
    expect(fit).toHaveBeenCalledOnce()
    expect(view.term.refresh).toHaveBeenCalledWith(0, 23)
  })

  it('does not reload the font when a terminal is reattached', async () => {
    view.attach(container)
    view.detach()
    view.attach(container)
    resolveFont([])
    await loaded

    expect(load).toHaveBeenCalledOnce()
    expect(view.term.clearTextureAtlas).toHaveBeenCalledOnce()
  })

  it('does not redraw a terminal disposed while the font was loading', async () => {
    view.attach(container)
    view.dispose()
    resolveFont([])
    await loaded

    expect(view.term.clearTextureAtlas).not.toHaveBeenCalled()
    expect(view.term.refresh).not.toHaveBeenCalled()
  })

  it('reports a font loading failure without taking down the terminal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    view.attach(container)
    const error = new Error('Font could not be decoded')
    rejectFont(error)
    await loaded.catch(() => {})

    expect(warn).toHaveBeenCalledWith('Could not load terminal prompt symbols', error)
    expect(view.term.refresh).not.toHaveBeenCalled()
    expect(view.term.dispose).not.toHaveBeenCalled()
  })
})
