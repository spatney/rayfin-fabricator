import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThumbnailCapture, ThumbnailStore, SETTLE_MS, thumbnailStore } from './thumbnails'

const HOUR = 3_600_000

describe('when a project is drawn again', () => {
  it('draws a project without a picture, or with one over half an hour old, or just published', () => {
    const store = new ThumbnailStore()
    const now = Date.parse('2026-11-03T12:00:00.000Z')
    expect(store.due('p1', undefined, now)).toBe(true)
    expect(store.due('p1', new Date(now - 10 * 60_000).toISOString(), now)).toBe(false)
    expect(store.due('p1', new Date(now - HOUR).toISOString(), now)).toBe(true)
    // One just drawn here counts, even before the project's record says so.
    store.put('p2', new Date(now).toISOString(), 'data:image/webp;base64,AA')
    expect(store.due('p2', new Date(now - HOUR).toISOString(), now)).toBe(false)
    store.markStale('p2')
    expect(store.due('p2', new Date(now).toISOString(), now)).toBe(true)
  })
})

describe('drawing the open project from its preview', () => {
  const capture = vi.fn(async () => 'data:image/png;base64,PNG')
  const saveThumbnail = vi.fn(async () => '2026-11-03T12:00:00.000Z')
  const draw = vi.fn(async () => 'data:image/webp;base64,WEBP')
  let open = 'p1'

  beforeEach(() => {
    vi.useFakeTimers()
    ;(window as unknown as { api: unknown }).api = {
      preview: { capture },
      projects: { saveThumbnail }
    }
    thumbnailStore.clear()
    capture.mockClear()
    saveThumbnail.mockClear()
    open = 'p1'
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (window as unknown as { api?: unknown }).api
  })

  it('waits for the app’s page to settle, then keeps the picture', async () => {
    const thumbs = new ThumbnailCapture((id) => id === open, draw)
    thumbs.appLoaded('p1', undefined)
    await vi.advanceTimersByTimeAsync(SETTLE_MS - 1)
    expect(capture).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(saveThumbnail).toHaveBeenCalledWith('p1', 'data:image/webp;base64,WEBP')
    expect(thumbnailStore.get('p1')).toBe('data:image/webp;base64,WEBP')
  })

  it('doesn’t draw a page the preview has left, another project, or a fresh picture', async () => {
    const thumbs = new ThumbnailCapture((id) => id === open, draw)
    thumbs.appLoaded('p1', undefined)
    thumbs.left()
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    thumbs.appLoaded('p1', undefined)
    open = 'p2'
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    open = 'p1'
    thumbs.appLoaded('p1', new Date().toISOString())
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    expect(capture).not.toHaveBeenCalled()
  })

  it('draws the app again after a publish, at once when its page is on screen', async () => {
    const thumbs = new ThumbnailCapture((id) => id === open, draw)
    thumbs.appLoaded('p1', new Date().toISOString())
    thumbs.published('p1')
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    expect(saveThumbnail).toHaveBeenCalledTimes(1)
  })
})
