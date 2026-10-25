import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { DesignCommand, DesignItem, DesignRequest, DesignStatus } from '@shared/design'
import { invalidateCopilotModels } from '../copilotModels'
import { useDesignSession, type DesignSurface } from './useDesignSession'

// jsdom can't decode images, so crops and thumbnails are stubbed.
vi.mock('./capture', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./capture')>()
  return {
    ...actual,
    thumbnail: vi.fn(async (dataUrl: string) => `thumb:${dataUrl}`),
    cropItems: vi.fn(async (_dataUrl: string, layout: { rects: Record<string, unknown> }, ids: string[]) =>
      Object.fromEntries(ids.filter((id) => layout.rects[id]).map((id) => [id, `crop:${id}`]))
    )
  }
})

const SURFACE: DesignSurface = { url: 'https://app.example/', embedded: false, appUrl: 'https://app.example/' }
const FULL = 'data:image/png;base64,FULL'
const LAYOUT = { viewport: { w: 1000, h: 800, dpr: 1 }, frame: { x: 0, y: 0 }, rects: { i1: { x: 10, y: 10, w: 100, h: 40 } } }
const OUTLINE = { route: '/', title: 'Deals', viewport: { w: 1000, h: 800, dpr: 1 }, elements: [{ ref: 'r1' }], findings: [] }

function element(id: string, label: string, extra: Partial<DesignItem> = {}): DesignItem {
  return {
    id,
    kind: 'element',
    tweaks: [],
    instruction: `Change ${label}`,
    createdAt: 1,
    target: { label, role: 'button', tag: 'button', selector: `#${id}`, classes: 'px-4 bg-indigo-600', text: label, route: '/', box: { w: 100, h: 40 } },
    ...extra
  }
}
function theme(id: string): DesignItem {
  return {
    id,
    kind: 'theme',
    tweaks: [],
    createdAt: 2,
    theme: { accent: { from: 'indigo', to: 'emerald' }, tokens: { '--color-indigo-600': 'oklch(0.6 0.15 163)' }, summary: ['Accent: indigo → emerald'] }
  }
}

/** A stand-in for the in-page controller, driven through the mocked host API. */
interface FakePage {
  enabled: boolean
  sessionId: string | null
  version: number
  items: DesignItem[]
  requests: DesignRequest[]
  results: Record<string, unknown>
  panel: 'theme' | 'polish' | null
  commands: DesignCommand[]
}

let page: FakePage
let saved: number
let api: ReturnType<typeof installApi>

function bump(): void {
  page.version += 1
}

function installApi() {
  const design = {
    setEnabled: vi.fn(async (enabled: boolean, _embedded?: boolean, _appUrl?: string, options?: { sessionId: string; items: DesignItem[] }) => {
      page.enabled = enabled
      page.sessionId = enabled ? (options?.sessionId ?? null) : null
      page.items = enabled ? [...(options?.items ?? [])] : []
      page.panel = null
      bump()
    }),
    poll: vi.fn(async (): Promise<DesignStatus | null> => ({
      enabled: page.enabled,
      sessionId: page.sessionId,
      version: page.version,
      hasTheme: true,
      itemCount: page.items.length,
      requests: [...page.requests],
      results: { ...page.results },
      panel: page.panel
    })),
    snapshot: vi.fn(async () =>
      page.enabled
        ? { version: page.version, sessionId: page.sessionId, route: '/', viewport: { w: 1000, h: 800, dpr: 1 }, items: [...page.items] }
        : null
    ),
    command: vi.fn(async (cmd: DesignCommand) => {
      page.commands.push(cmd)
      switch (cmd.op) {
        case 'seed':
          page.sessionId = cmd.sessionId
          page.items = [...cmd.items]
          break
        case 'removeItem':
          page.items = page.items.filter((item) => item.id !== cmd.id)
          break
        case 'clear':
          page.items = []
          break
        case 'openPanel':
          page.panel = cmd.panel
          break
        case 'setBusy':
          if (cmd.message) page.panel = 'polish'
          break
        case 'collectPage':
          page.results[cmd.requestId] = OUTLINE
          break
        case 'prepareCapture':
          // An Options screenshot asks for the selected element alone.
          page.results[cmd.requestId] = cmd.selection ? { ...LAYOUT, rects: { selection: { x: 5, y: 5, w: 80, h: 30 } } } : LAYOUT
          break
        case 'applyVariations':
        case 'failRequest':
          page.requests = page.requests.filter((r) => r.id !== cmd.requestId)
          break
      }
      bump()
    }),
    setTheme: vi.fn(async () => {})
  }
  const installed = {
    preview: { capture: vi.fn(async () => FULL), design },
    screenshot: {
      save: vi.fn(async () => `C:/tmp/${++saved}.png`),
      cleanup: vi.fn(async () => {})
    },
    design: {
      variations: vi.fn(async (): Promise<unknown[]> => [{ name: 'Pill', styles: { 'border-radius': '9999px' } }]),
      onVariation: vi.fn((_cb: (event: unknown) => void) => () => {}),
      polish: vi.fn(async (): Promise<unknown[]> => []),
      locate: vi.fn(async () => ({ targets: [] as unknown[] }) as { entryCss?: string; targets: unknown[] })
    },
    chat: {
      listModels: vi.fn(async () => [
        { id: 'claude-big', name: 'Big model', category: 'powerful', supportedReasoningEfforts: ['low', 'high'] },
        { id: 'claude-haiku-5.5', name: 'Claude Haiku 5.5', category: 'lightweight', priceCategory: 'low', vision: true, supportedReasoningEfforts: ['low', 'medium', 'high'] },
        { id: 'gpt-5-mini', name: 'GPT-5 mini', supportedReasoningEfforts: [] }
      ])
    }
  }
  ;(window as unknown as { api: unknown }).api = installed
  return installed
}

function ops(): string[] {
  return page.commands.map((c) => c.op)
}

function setup(surface: DesignSurface | null = SURFACE) {
  return renderHook(({ pid, s }: { pid: string | null; s: DesignSurface | null }) => useDesignSession(pid, s), {
    initialProps: { pid: 'p1', s: surface }
  })
}

/** Switch Design on and let the page report our session. */
async function startWith(result: { current: ReturnType<typeof useDesignSession> }, items: DesignItem[] = []): Promise<void> {
  act(() => result.current.toggle())
  await waitFor(() => expect(page.sessionId).toBeTruthy())
  if (items.length) {
    page.items = items
    bump()
    await waitFor(() => expect(result.current.items).toHaveLength(items.length))
  }
}

beforeEach(() => {
  localStorage.clear()
  invalidateCopilotModels()
  saved = 0
  page = { enabled: false, sessionId: null, version: 0, items: [], requests: [], results: {}, panel: null, commands: [] }
  api = installApi()
})

afterEach(() => {
  // Unmount every hook so no stale poll loop drives the next test's page.
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('useDesignSession — lifecycle and sync', () => {
  it('switches on with a seeded session, mirrors the page, and keeps the queue when switched off', async () => {
    const { result } = setup()
    expect(result.current.available).toBe(true)
    act(() => result.current.toggle())
    expect(result.current.active).toBe(true)
    await waitFor(() => expect(api.preview.design.setEnabled).toHaveBeenCalled())
    const [on, embedded, appUrl, options] = api.preview.design.setEnabled.mock.calls[0]
    expect([on, embedded, appUrl]).toEqual([true, false, 'https://app.example/'])
    expect(options).toMatchObject({ items: [], intro: true, sessionId: expect.any(String), hostTheme: expect.any(Object) })

    page.items = [element('i1', 'Button · Save')]
    bump()
    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(['i1']))

    act(() => result.current.toggle())
    await waitFor(() => expect(page.enabled).toBe(false))
    expect(result.current.active).toBe(false)
    expect(result.current.items.map((i) => i.id)).toEqual(['i1'])

    // Coming back seeds the page with the host's copy; the coach mark shows once.
    act(() => result.current.toggle())
    await waitFor(() => expect(api.preview.design.setEnabled).toHaveBeenCalledTimes(3))
    expect(api.preview.design.setEnabled.mock.calls[2][3]).toMatchObject({ items: [expect.objectContaining({ id: 'i1' })], intro: false })
  })

  it('re-seeds a page that reloaded unseeded, and never mirrors a foreign session', async () => {
    const { result } = setup()
    await startWith(result, [element('i1', 'Button · Save')])
    const session = page.sessionId
    // A reload: the page comes back empty and unseeded.
    page.sessionId = null
    page.items = []
    bump()
    await waitFor(() => expect(ops()).toContain('seed'), { timeout: 3000 })
    const seed = page.commands.find((c) => c.op === 'seed') as Extract<DesignCommand, { op: 'seed' }>
    expect(seed.sessionId).toBe(session)
    expect(seed.items.map((i) => i.id)).toEqual(['i1'])
    expect(result.current.items.map((i) => i.id)).toEqual(['i1'])
  })

  it('ends the session when the surface changes but keeps the queue with its project', async () => {
    const { result, rerender } = setup()
    await startWith(result, [element('i1', 'Button · Save')])
    rerender({ pid: 'p1', s: { ...SURFACE, url: 'https://app.fabric.microsoft.com/groups/ws/appbackends/p1', embedded: true } })
    await waitFor(() => expect(result.current.active).toBe(false))
    expect(page.enabled).toBe(false)
    expect(result.current.items).toHaveLength(1)
    rerender({ pid: 'p2', s: SURFACE })
    expect(result.current.items).toEqual([])
    rerender({ pid: 'p1', s: SURFACE })
    expect(result.current.items).toHaveLength(1)
  })

  it('edits the host queue directly while off, and asks the page while on', async () => {
    const { result } = setup()
    await startWith(result, [element('i1', 'Button · Save'), element('i2', 'Heading · Deals')])
    act(() => result.current.removeItem('i1'))
    expect(result.current.items.map((i) => i.id)).toEqual(['i2'])
    expect(page.commands).toContainEqual({ op: 'removeItem', id: 'i1' })
    act(() => result.current.stop())
    await waitFor(() => expect(page.enabled).toBe(false))
    const before = page.commands.length
    act(() => result.current.clear())
    expect(result.current.items).toEqual([])
    expect(page.commands.length).toBe(before)
  })

  it('opens Design to show a chip’s element when it is off', async () => {
    const { result } = setup()
    await startWith(result, [element('i1', 'Button · Save')])
    act(() => result.current.stop())
    await waitFor(() => expect(page.enabled).toBe(false))
    act(() => result.current.focusItem('i1'))
    expect(result.current.active).toBe(true)
    await waitFor(() => expect(page.commands).toContainEqual({ op: 'focusItem', id: 'i1' }))
  })
})

describe('useDesignSession — AI requests', () => {
  const REQUEST: DesignRequest = { id: 'v1', kind: 'variations', itemId: '', context: { tag: 'button', styles: {}, isChart: false }, hint: 'bolder' }

  it('answers an options request once, with the Design model at low effort, and says what is happening', async () => {
    const { result } = setup()
    await startWith(result)
    page.requests = [REQUEST]
    bump()
    await waitFor(() => expect(ops()).toContain('applyVariations'))
    expect(api.design.variations).toHaveBeenCalledOnce()
    // A vision model gets a crop of the selected element to look at.
    expect(api.design.variations).toHaveBeenCalledWith('p1', REQUEST.context, 'bolder', 3, 'claude-haiku-5.5', {
      effort: 'low',
      requestId: 'v1',
      screenshotPath: 'C:/tmp/1.png'
    })
    expect(page.commands).toContainEqual({ op: 'prepareCapture', requestId: expect.any(String), ids: [], selection: true })
    expect(api.screenshot.save).toHaveBeenCalledWith('crop:selection')
    expect(page.commands).toContainEqual({ op: 'requestProgress', requestId: 'v1', message: 'Looking at the element…' })
    expect(page.commands).toContainEqual({ op: 'requestProgress', requestId: 'v1', message: 'Asking Claude Haiku 5.5 for a few looks…' })
    expect(page.commands).toContainEqual({ op: 'applyVariations', requestId: 'v1', options: [{ name: 'Pill', styles: { 'border-radius': '9999px' } }] })
  })

  it('reports a failed options request back to the page', async () => {
    api.design.variations.mockRejectedValueOnce('The model is unavailable right now.')
    const { result } = setup()
    await startWith(result)
    page.requests = [REQUEST]
    bump()
    await waitFor(() => expect(page.commands).toContainEqual({ op: 'failRequest', requestId: 'v1', message: 'The model is unavailable right now.' }))
  })

  it('takes no screenshot for a model that can’t see images', async () => {
    api.chat.listModels.mockResolvedValueOnce([{ id: 'gpt-5-mini', name: 'GPT-5 mini', supportedReasoningEfforts: [] }])
    const { result } = setup()
    await startWith(result)
    page.requests = [REQUEST]
    bump()
    await waitFor(() => expect(ops()).toContain('applyVariations'))
    expect(api.design.variations).toHaveBeenCalledWith('p1', REQUEST.context, 'bolder', 3, 'gpt-5-mini', { effort: undefined, requestId: 'v1', screenshotPath: undefined })
    expect(ops()).not.toContain('prepareCapture')
  })

  it('passes options to the page as they stream in, only for its own request', async () => {
    let deliver: (event: unknown) => void = () => {}
    const stop = vi.fn()
    api.design.onVariation.mockImplementation((cb: (event: unknown) => void) => {
      deliver = cb
      return stop
    })
    const pill = { name: 'Pill', styles: { 'border-radius': '9999px' } }
    api.design.variations.mockImplementationOnce(async () => {
      deliver({ requestId: 'v1', index: 0, variation: pill })
      deliver({ requestId: 'someone-else', index: 0, variation: { name: 'Other', styles: { color: 'red' } } })
      return [pill]
    })
    const { result } = setup()
    await startWith(result)
    page.requests = [REQUEST]
    bump()
    await waitFor(() => expect(ops()).toContain('applyVariations'))
    expect(page.commands.filter((c) => c.op === 'addVariation')).toEqual([{ op: 'addVariation', requestId: 'v1', index: 0, option: pill }])
    expect(stop).toHaveBeenCalled()
  })

  it('runs a Polish review: outline, screenshot, model, then suggestions on the page', async () => {
    const suggestion = { id: 's1', ref: 'r1', title: 'Bigger tap targets', why: 'Hard to hit', instruction: 'Pad the buttons' }
    api.design.polish.mockResolvedValueOnce([suggestion])
    const { result } = setup()
    await startWith(result)
    act(() => result.current.polish())
    expect(result.current.polishingSince).not.toBeNull()
    await waitFor(() => expect(ops()).toContain('showSuggestions'))
    expect(api.design.polish).toHaveBeenCalledWith('p1', OUTLINE, 'C:/tmp/1.png', 'claude-haiku-5.5', 'low')
    expect(page.commands).toContainEqual({ op: 'showSuggestions', suggestions: [suggestion] })
    expect(ops()).toEqual(expect.arrayContaining(['setBusy', 'collectPage', 'prepareCapture', 'endCapture']))
    await waitFor(() => expect(result.current.polishingSince).toBeNull())
  })

  it('drops a Polish result when the panel was closed meanwhile', async () => {
    let finish: (value: unknown[]) => void = () => {}
    api.design.polish.mockImplementationOnce(() => new Promise<unknown[]>((resolve) => (finish = resolve)))
    const { result } = setup()
    await startWith(result)
    act(() => result.current.polish())
    await waitFor(() => expect(api.design.polish).toHaveBeenCalled())
    page.panel = null
    await act(async () => finish([{ id: 's1', ref: 'r1', title: 'x', why: 'y', instruction: 'z' }]))
    await waitFor(() => expect(result.current.polishingSince).toBeNull())
    expect(ops()).not.toContain('showSuggestions')
  })
})

describe('useDesignSession — sending', () => {
  it('builds one turn: previews captured, crops, source hints and a hidden prompt', async () => {
    api.design.locate.mockResolvedValueOnce({
      entryCss: 'src/index.css',
      targets: [{ key: 'i1', candidates: [{ file: 'src/App.tsx', line: 12, reason: 'class + text match', score: 0.9, snippet: '' }] }]
    })
    const { result } = setup()
    await startWith(result, [element('i1', 'Button · Save'), theme('t1')])

    let turn: Awaited<ReturnType<ReturnType<typeof useDesignSession>['buildTurn']>> = null
    await act(async () => {
      turn = await result.current.buildTurn('  make it pop ')
    })
    expect(turn).not.toBeNull()
    const t = turn!
    expect(t.display).toBe('make it pop')
    expect(t.shots).toEqual([
      { path: 'C:/tmp/1.png', thumb: `thumb:${FULL}` },
      { path: 'C:/tmp/2.png', thumb: 'thumb:crop:i1' }
    ])
    expect(t.summary.full).toBe(0)
    expect(t.summary.items.map((i) => [i.n, i.label, i.shot])).toEqual([
      [1, 'Button · Save', 1],
      [2, 'Theme', undefined]
    ])
    expect(t.prompt).toContain('Attached images: #1 is the full view with the changes previewed; #2 is a crop of change 1.')
    expect(t.prompt).toContain('Likely source: src/App.tsx:12 (class + text match)')
    expect(t.prompt).toContain('Tailwind entry stylesheet: src/index.css')
    expect(t.storedPrompt).not.toContain('Attached images')
    expect(t.storedPrompt).toContain('### 2. Theme')
    const prepare = page.commands.find((c) => c.op === 'prepareCapture') as Extract<DesignCommand, { op: 'prepareCapture' }>
    expect(prepare.ids).toEqual(['i1', 't1'])
    expect(ops().lastIndexOf('endCapture')).toBeGreaterThan(ops().indexOf('prepareCapture'))
    expect(api.design.locate).toHaveBeenCalledWith('p1', [expect.objectContaining({ key: 'i1', tag: 'button', text: 'Button · Save' })])
    expect(t.projectId).toBe('p1')
    expect(t.itemIds).toEqual(['i1', 't1'])

    act(() => result.current.finishSend(t))
    expect(result.current.items).toEqual([])
    await waitFor(() => expect(page.enabled).toBe(false))
    expect(result.current.active).toBe(false)
    // The page dropped the sent changes before Design went off.
    expect(page.commands).toEqual(expect.arrayContaining([{ op: 'removeItem', id: 'i1' }, { op: 'removeItem', id: 't1' }]))
  })

  it('keeps changes queued while the turn was being prepared', async () => {
    const { result } = setup()
    await startWith(result, [element('i1', 'Button · Save')])
    let turn: Awaited<ReturnType<ReturnType<typeof useDesignSession>['buildTurn']>> = null
    await act(async () => {
      turn = await result.current.buildTurn('')
    })
    // The user queues another change before the chat dispatches the turn.
    page.items = [...page.items, element('i2', 'Heading · Deals')]
    bump()
    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(['i1', 'i2']))
    act(() => result.current.finishSend(turn!))
    expect(result.current.items.map((i) => i.id)).toEqual(['i2'])
    await waitFor(() => expect(page.enabled).toBe(false))
    expect(result.current.items.map((i) => i.id)).toEqual(['i2'])
  })

  it('clears only the project the turn was built for', async () => {
    const { result, rerender } = setup()
    await startWith(result, [element('i1', 'Button · Save')])
    let turn: Awaited<ReturnType<ReturnType<typeof useDesignSession>['buildTurn']>> = null
    await act(async () => {
      turn = await result.current.buildTurn('')
    })
    // Switch to another project (with its own queued change) before the turn goes out.
    rerender({ pid: 'p2', s: SURFACE })
    await waitFor(() => expect(result.current.active).toBe(false))
    act(() => result.current.toggle())
    await waitFor(() => expect(page.sessionId).toBeTruthy())
    page.items = [element('x1', 'Card · Other')]
    bump()
    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(['x1']))

    act(() => result.current.finishSend(turn!))
    expect(result.current.items.map((i) => i.id)).toEqual(['x1'])
    expect(result.current.active).toBe(true)
    rerender({ pid: 'p1', s: SURFACE })
    expect(result.current.items).toEqual([])
  })

  it('switches Design on just for the capture when it is off', async () => {
    const { result } = setup()
    await startWith(result, [element('i1', 'Button · Save')])
    act(() => result.current.stop())
    await waitFor(() => expect(page.enabled).toBe(false))
    api.preview.design.setEnabled.mockClear()

    let shots = 0
    await act(async () => {
      shots = (await result.current.buildTurn(''))?.shots.length ?? -1
    })
    expect(shots).toBe(2)
    expect(api.preview.design.setEnabled.mock.calls[0][0]).toBe(true)
    expect(api.preview.design.setEnabled.mock.calls[0][3]).toMatchObject({ items: [expect.objectContaining({ id: 'i1' })], intro: false })
    expect(api.preview.design.setEnabled.mock.calls.slice(-1)[0]).toEqual([false])
    expect(result.current.active).toBe(false)
  })

  it('still composes the turn without images when the preview is unavailable', async () => {
    const { result, rerender } = setup()
    await startWith(result, [element('i1', 'Button · Save')])
    rerender({ pid: 'p1', s: null })
    await waitFor(() => expect(result.current.active).toBe(false))
    let turn: Awaited<ReturnType<ReturnType<typeof useDesignSession>['buildTurn']>> = null
    await act(async () => {
      turn = await result.current.buildTurn('')
    })
    expect(turn!.shots).toEqual([])
    expect(turn!.prompt).toContain('Please apply these design changes to my app.')
    expect(turn!.prompt).not.toContain('Attached images')
    expect(api.preview.capture).not.toHaveBeenCalled()
  })

  it('returns nothing to send when the queue is empty', async () => {
    const { result } = setup()
    let turn: unknown = 'unset'
    await act(async () => {
      turn = await result.current.buildTurn('hello')
    })
    expect(turn).toBeNull()
  })
})
