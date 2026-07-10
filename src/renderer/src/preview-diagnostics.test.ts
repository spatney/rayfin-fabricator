import { readFileSync } from 'fs'
import { resolve } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const SRC = readFileSync(
  resolve(process.cwd(), 'src-tauri/src/services/preview_diagnostics.js'),
  'utf8'
)

interface DiagnosticsApi {
  readConsole: (options?: Record<string, unknown>) => Record<string, unknown>[]
  readNetwork: (options?: Record<string, unknown>) => Record<string, unknown>[]
  errors: () => Record<string, unknown>[]
  snapshot: (options?: string | Record<string, unknown>) => Record<string, unknown>
  interact: (options: Record<string, unknown>) => Record<string, unknown>
}

const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
  debug: console.debug
}
const originalFetch = window.fetch
const originalXhrOpen = XMLHttpRequest.prototype.open
const originalXhrSend = XMLHttpRequest.prototype.send

function diagnostics(): DiagnosticsApi {
  new Function(SRC)()
  return (window as unknown as { __fabricatorDiagnostics: DiagnosticsApi }).__fabricatorDiagnostics
}

afterEach(() => {
  Object.assign(console, originalConsole)
  if (originalFetch) window.fetch = originalFetch
  else delete (window as unknown as { fetch?: unknown }).fetch
  XMLHttpRequest.prototype.open = originalXhrOpen
  XMLHttpRequest.prototype.send = originalXhrSend
  delete (window as unknown as { __fabricatorConsole?: unknown }).__fabricatorConsole
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('preview diagnostics bridge', () => {
  it('captures safe console/network diagnostics and supports bounded DOM operations', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 10,
      y: 20,
      top: 20,
      left: 10,
      right: 210,
      bottom: 60,
      width: 200,
      height: 40,
      toJSON: () => ({})
    })
    window.fetch = vi.fn(() =>
      Promise.resolve({
        status: 500,
        ok: false,
        statusText: 'Internal Server Error'
      } as Response)
    )
    document.body.innerHTML = `
      <main>
        <h1>Revenue overview</h1>
        <input id="name" value="must-not-leak" placeholder="Name" />
        <input id="password" type="password" />
        <textarea id="notes">textarea-secret</textarea>
        <section style="display: none">hidden-secret</section>
        <button data-testid="refresh">Refresh</button>
        <a id="external" href="https://other.test/private">External</a>
      </main>
    `

    const api = diagnostics()
    const capturedAfter = Date.now()
    console.warn('layout warning')
    console.error('render failed')
    await window.fetch('https://example.test/data?token=secret&view=main', { method: 'POST' })

    const consoleEntries = api.readConsole({ level: 'error' })
    expect(consoleEntries).toHaveLength(1)
    expect(consoleEntries[0]).toMatchObject({ level: 'error', text: 'render failed' })
    expect(api.readConsole({ query: 'render', since: capturedAfter })).toHaveLength(1)
    expect(api.readConsole({ query: 'does-not-exist' })).toHaveLength(0)

    const requests = api.readNetwork({ errorsOnly: true })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ type: 'fetch', method: 'POST', status: 500, ok: false })
    expect(String(requests[0].url)).not.toContain('secret')
    expect(api.readNetwork({ method: 'GET' })).toHaveLength(0)
    expect(api.readNetwork({ urlIncludes: '/data', statusMin: 500, statusMax: 599 })).toHaveLength(
      1
    )
    expect(api.errors()).toHaveLength(2)

    const snapshot = api.snapshot()
    expect(snapshot.ok).toBe(true)
    expect(JSON.stringify(snapshot)).toContain('Revenue overview')
    expect(JSON.stringify(snapshot)).not.toContain('must-not-leak')
    expect(JSON.stringify(snapshot)).not.toContain('textarea-secret')
    expect(JSON.stringify(snapshot)).not.toContain('hidden-secret')
    const filteredSnapshot = api.snapshot({
      query: 'refresh',
      limit: 1,
      includeBodyText: false
    })
    expect(filteredSnapshot.elements).toHaveLength(1)
    expect(filteredSnapshot.bodyText).toBeUndefined()

    const filled = api.interact({ action: 'fill', selector: '#name', value: 'Chris' })
    expect(filled.ok).toBe(true)
    expect((document.querySelector('#name') as HTMLInputElement).value).toBe('Chris')
    expect(JSON.stringify(filled)).not.toContain('Chris')

    const password = api.interact({ action: 'fill', selector: '#password', value: 'secret' })
    expect(password).toMatchObject({ ok: false })

    const external = api.interact({
      action: 'click',
      selector: '#external',
      allowedBase: 'https://example.test/appbackends/item-1/'
    })
    expect(external).toMatchObject({ ok: false })
  })
})
