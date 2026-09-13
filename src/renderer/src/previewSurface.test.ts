import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PreviewBounds, RayfinStudioApi } from '@shared/ipc'
import { deferred } from '../test/deferred'
import { serializePreviewMutations } from './previewSurface'

type Preview = RayfinStudioApi['preview']
const bounds: PreviewBounds = { x: 100, y: 80, width: 900, height: 600, pixelRatio: 1.25 }

function nativeApi() {
  return {
    showUrl: vi.fn<Preview['showUrl']>(async () => {}),
    navigate: vi.fn<Preview['navigate']>(async () => {}),
    setBounds: vi.fn<Preview['setBounds']>(async () => {}),
    hide: vi.fn<Preview['hide']>(async () => {}),
    suppress: vi.fn<Preview['suppress']>(async () => {}),
    reload: vi.fn<Preview['reload']>(async () => {}),
    back: vi.fn<Preview['back']>(async () => {}),
    forward: vi.fn<Preview['forward']>(async () => {})
  }
}

afterEach(() => vi.restoreAllMocks())

describe('native preview command ordering', () => {
  it('waits for creation before applying resize and suppression', async () => {
    const native = nativeApi()
    const created = deferred<void>()
    native.showUrl.mockReturnValueOnce(created.promise)
    const api = serializePreviewMutations(native)
    const show = api.showUrl('https://app.example/', bounds)
    const move = api.setBounds({ ...bounds, x: 250 })
    const suppress = api.suppress(bounds)
    expect(native.showUrl).toHaveBeenCalledOnce()
    expect(native.setBounds).not.toHaveBeenCalled()
    expect(native.suppress).not.toHaveBeenCalled()
    created.resolve(undefined)
    await Promise.all([show, move, suppress])
    expect(native.setBounds).toHaveBeenCalledWith({ ...bounds, x: 250 })
    expect(native.suppress).toHaveBeenCalledOnce()
    expect(native.setBounds.mock.invocationCallOrder[0]).toBeLessThan(
      native.suppress.mock.invocationCallOrder[0]
    )
  })

  it('orders unmount/hide before a later project show', async () => {
    const native = nativeApi()
    const created = deferred<void>()
    native.showUrl.mockReturnValueOnce(created.promise)
    const api = serializePreviewMutations(native)
    const first = api.showUrl('https://first.example/', bounds)
    const hidden = api.hide()
    const second = api.showUrl('https://second.example/', bounds)
    expect(native.showUrl).toHaveBeenCalledTimes(1)
    created.resolve(undefined)
    await Promise.all([first, hidden, second])
    expect(native.hide.mock.invocationCallOrder[0]).toBeLessThan(
      native.showUrl.mock.invocationCallOrder[1]
    )
  })

  it('does not stall live resizing or hiding behind delayed synchronous-command replies', async () => {
    const native = nativeApi()
    const reply = deferred<void>()
    native.setBounds.mockReturnValueOnce(reply.promise)
    const api = serializePreviewMutations(native)
    await api.showUrl('https://app.example/', bounds)
    await Promise.resolve()
    const firstMove = api.setBounds(bounds)
    const nextMove = api.setBounds({ ...bounds, width: 1000 })
    const hidden = api.hide()
    expect(native.setBounds).toHaveBeenCalledTimes(2)
    expect(native.hide).toHaveBeenCalledOnce()
    reply.resolve(undefined)
    await Promise.all([firstMove, nextMove, hidden])
  })

  it('keeps already-queued bounds ahead of newer updates from a show completion', async () => {
    const native = nativeApi()
    const api = serializePreviewMutations(native)
    const show = api.showUrl('https://app.example/', bounds)
    const queuedMove = api.setBounds({ ...bounds, x: 200 })
    await show
    const latestMove = api.setBounds({ ...bounds, x: 300 })
    await Promise.all([queuedMove, latestMove])
    expect(native.setBounds.mock.calls.map(([value]) => value.x)).toEqual([200, 300])
  })

  it.each(['reject', 'throw'])(
    'reports a %s failure without wedging later cleanup',
    async (failure) => {
      const native = nativeApi()
      const error = new Error('Could not create the native view')
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      if (failure === 'reject') native.showUrl.mockRejectedValueOnce(error)
      else
        native.showUrl.mockImplementationOnce(() => {
          throw error
        })
      const api = serializePreviewMutations(native)
      const show = api.showUrl('https://app.example/', bounds)
      const hidden = api.hide()
      await expect(show).rejects.toThrow(error)
      await hidden
      expect(logged).toHaveBeenCalledWith('Native preview command failed', error)
      expect(native.hide).toHaveBeenCalledOnce()
    }
  )
})
