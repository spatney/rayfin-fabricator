import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PickCaptureLayout,
  PickCommand,
  PickEvent,
  PickStatus,
  PickTarget
} from '@shared/pick'
import { cropItems } from './capture'
import { useTouchUp, type PickSurface } from './useTouchUp'

// jsdom has no canvas: each crop is named after the element it's of.
vi.mock('./capture', () => ({
  cropItems: vi.fn(async (_shot: string, layout: PickCaptureLayout, ids: string[]) =>
    Object.fromEntries(ids.filter((id) => layout.rects[id]).map((id) => [id, `data:crop/${id}`]))
  )
}))
vi.mock('../components/chat/images', () => ({
  viewCopy: vi.fn(async (image: string) => `${image}#thumb`)
}))

const SURFACE: PickSurface = {
  url: 'https://p1.example.app/',
  embedded: false,
  appUrl: 'https://p1.example.app/'
}
const SAVE: PickTarget = {
  label: 'Button · Save',
  role: 'button',
  tag: 'button',
  selector: '#save',
  route: '/',
  box: { w: 80, h: 32 },
  text: 'Save'
}
const RECT = { x: 10, y: 20, w: 80, h: 32 }

/** The page in the preview: what it reports, and what the host asked of it. */
function installPage() {
  const page = {
    events: [] as PickEvent[],
    results: {} as Record<string, unknown>,
    commands: [] as PickCommand[]
  }
  const status = (): PickStatus => ({
    v: 1,
    page: 'page-1',
    armed: true,
    on: true,
    seq: page.events.length,
    events: page.events,
    results: page.results,
    route: '/',
    viewport: { w: 900, h: 600, dpr: 1 }
  })
  let saved = 0
  const api = {
    preview: {
      capture: vi.fn(async () => 'data:image/png;base64,FULL'),
      pick: {
        set: vi.fn(async () => {}),
        poll: vi.fn(async () => status()),
        command: vi.fn(async (cmd: PickCommand) => {
          page.commands.push(cmd)
          if (cmd.op === 'prepareCapture') {
            page.results = {
              ...page.results,
              [cmd.requestId]: {
                viewport: { w: 900, h: 600, dpr: 1 },
                frame: { x: 0, y: 0 },
                rects: Object.fromEntries(cmd.ids.map((id) => [id, RECT]))
              }
            }
          }
        })
      }
    },
    screenshot: {
      save: vi.fn(async () => `C:/tmp/shot-${++saved}.png`),
      cleanup: vi.fn(async () => {})
    },
    pick: {
      locate: vi.fn(async () => ({
        targets: [
          {
            key: 'k1',
            candidates: [
              { file: 'src/Deals.tsx', line: 12, reason: 'text “Save”', score: 0.9, snippet: '' }
            ]
          }
        ]
      }))
    }
  }
  ;(window as unknown as { api: unknown }).api = api
  const emit = (event: Unsequenced): void => {
    page.events = [...page.events, { ...event, seq: page.events.length + 1 } as PickEvent]
  }
  return { page, api, emit }
}

/** A page event before the page numbers it. */
type Unsequenced<E = PickEvent> = E extends unknown ? Omit<E, 'seq'> : never

async function run(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  delete (window as unknown as { api?: unknown }).api
})

describe('useTouchUp', () => {
  it('takes a picture of each pick, and sends the picks with the next message', async () => {
    const { page, api, emit } = installPage()
    const { result } = renderHook(() => useTouchUp('p1', SURFACE, () => {}))
    await run(200)
    emit({ type: 'enter' })
    emit({ type: 'pick', pick: { id: 'k1', n: 1, target: SAVE, rect: RECT } })
    await run(1000)

    expect(result.current.on).toBe(true)
    expect(result.current.picks).toEqual([
      {
        id: 'k1',
        n: 1,
        target: SAVE,
        capturing: false,
        shot: { path: 'C:/tmp/shot-1.png', thumb: 'data:crop/k1#thumb' }
      }
    ])
    // The highlight is hidden for the picture, and shown again after it.
    const ops = page.commands.map((c) => c.op)
    expect(ops.slice(0, 2)).toEqual(['prepareCapture', 'endCapture'])
    expect(api.preview.capture).toHaveBeenCalledOnce()

    let turn: Awaited<ReturnType<typeof result.current.buildTurn>> = null
    await act(async () => {
      turn = await result.current.buildTurn('make it the primary action')
    })
    expect(turn).toMatchObject({
      projectId: 'p1',
      ids: ['k1'],
      display: 'make it the primary action',
      shots: [{ path: 'C:/tmp/shot-1.png' }],
      picks: [{ n: 1, label: 'Button · Save', shot: 0 }]
    })
    expect(turn!.prompt).toContain('- Likely source: src/Deals.tsx:12 (text “Save”)')
    expect(turn!.prompt).toContain('- Picture: attached image 1')
    expect(turn!.storedPrompt).not.toContain('Picture:')

    // Sent: the picks leave the composer and picking ends.
    act(() => result.current.finishSend(turn!))
    expect(result.current.picks).toEqual([])
    expect(result.current.on).toBe(false)
    expect(api.preview.pick.set).toHaveBeenLastCalledWith(true, false, false, SURFACE.appUrl, {
      theme: expect.any(Object),
      picks: []
    })
  })

  it('keeps its place in the page’s events, so nothing sent comes back when the app shows again', async () => {
    const { emit } = installPage()
    const { result, rerender } = renderHook(
      ({ surface }: { surface: PickSurface | null }) => useTouchUp('p1', surface, () => {}),
      { initialProps: { surface: SURFACE as PickSurface | null } }
    )
    await run(200)
    emit({ type: 'enter' })
    emit({ type: 'pick', pick: { id: 'k1', n: 1, target: SAVE, rect: null } })
    await run(400)
    expect(result.current.picks).toHaveLength(1)
    act(() => result.current.finishSend({ projectId: 'p1', ids: ['k1'] }))

    // Code, then Build again: the preview keeps the same page, and its events.
    rerender({ surface: null })
    await run(400)
    rerender({ surface: SURFACE })
    await run(1000)
    expect(result.current.picks).toEqual([])
    expect(result.current.on).toBe(false)
  })

  it('hands the page its state only once a pick made as picking came on there is ours too', async () => {
    const { api, emit } = installPage()
    renderHook(() => useTouchUp('p1', SURFACE, () => {}))
    await run(200)
    const before = api.preview.pick.set.mock.calls.length
    emit({ type: 'enter' })
    emit({ type: 'pick', pick: { id: 'k1', n: 1, target: SAVE, rect: RECT } })
    await run(1000)
    // The page keeps only the picks it's handed: one handed over too early drops k1.
    const handed = (api.preview.pick.set.mock.calls as unknown[][])
      .slice(before)
      .map((args) => (args[4] as { picks: { id: string }[] }).picks.map((p) => p.id))
    expect(handed).toEqual([['k1']])
  })

  it('renumbers the picks when one is dropped, in the composer or in the page', async () => {
    const { page, emit } = installPage()
    const { result } = renderHook(() => useTouchUp('p1', SURFACE, () => {}))
    await run(200)
    emit({ type: 'enter' })
    for (const id of ['k1', 'k2', 'k3'])
      emit({ type: 'pick', pick: { id, n: Number(id[1]), target: SAVE, rect: null } })
    await run(400)
    expect(result.current.picks.map((p) => p.n)).toEqual([1, 2, 3])

    act(() => result.current.remove('k1'))
    expect(result.current.picks.map((p) => [p.id, p.n])).toEqual([
      ['k2', 1],
      ['k3', 2]
    ])
    expect(page.commands.slice(-1)[0]).toEqual({
      op: 'sync',
      picks: [
        { id: 'k2', n: 1, selector: '#save', route: '/' },
        { id: 'k3', n: 2, selector: '#save', route: '/' }
      ]
    })

    emit({ type: 'unpick', id: 'k2' })
    await run(400)
    expect(result.current.picks.map((p) => [p.id, p.n])).toEqual([['k3', 1]])
  })

  it('attaches a screenshot of a region clipped in the page to the next message', async () => {
    const { page, emit } = installPage()
    const onCapture = vi.fn()
    renderHook(() => useTouchUp('p1', SURFACE, onCapture))
    await run(200)
    emit({
      type: 'capture',
      capture: { id: 'c1', label: 'Clip', rect: { x: 0, y: 0, w: 900, h: 600 } }
    })
    await run(1000)
    expect(onCapture).toHaveBeenCalledWith('p1', {
      path: 'C:/tmp/shot-1.png',
      thumb: 'data:crop/c1#thumb'
    })
    // The page flashes the region, as a screenshot does.
    expect(page.commands).toContainEqual({ op: 'endCapture', flash: 'c1' })
    // Kept sharp enough to enlarge and draw on.
    expect(vi.mocked(cropItems).mock.lastCall?.[3]).toBe(1600)
  })

  it('swaps a pick’s picture for one drawn on, and lets go of the old one', async () => {
    const { api, emit } = installPage()
    const { result } = renderHook(() => useTouchUp('p1', SURFACE, () => {}))
    await run(200)
    emit({ type: 'pick', pick: { id: 'k1', n: 1, target: SAVE, rect: RECT } })
    await run(1000)
    expect(result.current.picks[0].shot?.path).toBe('C:/tmp/shot-1.png')

    act(() => result.current.setShot('k1', { path: 'C:/tmp/drawn.png', thumb: 'data:drawn' }))
    expect(result.current.picks[0].shot).toEqual({ path: 'C:/tmp/drawn.png', thumb: 'data:drawn' })
    expect(api.screenshot.cleanup).toHaveBeenCalledWith(['C:/tmp/shot-1.png'])
    // A drawing for a pick that's gone isn't kept.
    act(() => result.current.setShot('gone', { path: 'C:/tmp/stray.png', thumb: 'data:stray' }))
    expect(api.screenshot.cleanup).toHaveBeenCalledWith(['C:/tmp/stray.png'])
  })
})
