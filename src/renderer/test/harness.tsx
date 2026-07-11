import { vi } from 'vitest'
import type { DevServerStatus, PreviewNavState, StudioProject } from '@shared/ipc'

/**
 * Test harness for {@link PreviewPane}. jsdom has no layout engine and no
 * ResizeObserver/IntersectionObserver/rAF, and the component drives a native
 * preview surface entirely through `window.api.preview.*`. This installs
 * controllable stand-ins for all of that so a test can assert the exact
 * sequence of preview IPC calls (show / hide / suppress / navigate …) that a
 * given interaction produces — the behaviours we care about protecting.
 */

export interface PreviewCall {
  method: string
  args: unknown[]
}

interface Rect {
  left: number
  top: number
  width: number
  height: number
}

export interface PreviewEnv {
  /** Ordered log of every `window.api.preview.*` call (method + args). */
  calls: PreviewCall[]
  /** The mocked preview API (vi.fn per method) for direct assertions. */
  api: ReturnType<typeof makeApi>['preview']
  /** Push a nav-state event to the subscriber (as the native side would). */
  emitNav: (state: Partial<PreviewNavState>) => void
  /** Set the (mocked) host bounding rect; `null` ⇒ 0×0 (a `display:none` pane). */
  setHostRect: (rect: Rect | null) => void
  /** Result the mocked `capture()` resolves with. */
  setCaptureResult: (dataUrl: string) => void
  /** Override the local-dev result returned for subsequent `ensure()` calls. */
  setDevServerResult: (result: DevServerStatus) => void
  /** Run queued requestAnimationFrame callbacks `rounds` times (default 4). */
  flushRaf: (rounds?: number) => void
  /** Advance fake timers by `ms` (drives the dissolve + frozen-clear timeouts). */
  advanceTimers: (ms: number) => void
  /** Method names of calls made at/after the given call index. */
  methodsAfter: (index: number) => string[]
  /** Restore all globals patched by {@link installPreviewEnv}. */
  teardown: () => void
}

let currentEnv: PreviewEnv | null = null

/** The active env — for helpers that run inside a test body. */
export function env(): PreviewEnv {
  if (!currentEnv) throw new Error('installPreviewEnv() was not called')
  return currentEnv
}

function makeApi(
  calls: PreviewCall[],
  getCaptureResult: () => string,
  getDevServerResult: (projectId: string) => DevServerStatus
) {
  let navCb: ((s: PreviewNavState) => void) | null = null

  const rec =
    (method: string, ret: () => unknown = () => undefined) =>
    (...args: unknown[]) => {
      calls.push({ method, args })
      return Promise.resolve(ret())
    }

  const preview = {
    capture: vi.fn(rec('capture', getCaptureResult)),
    hide: vi.fn(rec('hide')),
    suppress: vi.fn(rec('suppress')),
    showUrl: vi.fn(rec('showUrl')),
    navigate: vi.fn(rec('navigate')),
    setBounds: vi.fn(rec('setBounds')),
    reload: vi.fn(rec('reload')),
    back: vi.fn(rec('back')),
    forward: vi.fn(rec('forward')),
    onNavState: vi.fn((cb: (s: PreviewNavState) => void) => {
      navCb = cb
      return () => {
        if (navCb === cb) navCb = null
      }
    }),
    design: {
      setEnabled: vi.fn(rec('design.setEnabled')),
      setModels: vi.fn(rec('design.setModels')),
      poll: vi.fn(() => Promise.resolve(null)),
      drain: vi.fn(() => Promise.resolve(null)),
      drainAi: vi.fn(() => Promise.resolve(null)),
      generateHtml: vi.fn(() => Promise.resolve('')),
      applyGenerated: vi.fn(rec('design.applyGenerated'))
    }
  }

  const api = {
    preview,
    devServer: {
      ensure: vi.fn((projectId: string) => Promise.resolve(getDevServerResult(projectId))),
      status: vi.fn((projectId: string) => Promise.resolve(getDevServerResult(projectId))),
      stop: vi.fn(() => Promise.resolve(true))
    },
    openExternal: vi.fn(),
    screenshot: { save: vi.fn(() => Promise.resolve('C:/tmp/shot.png')) },
    projects: { setPreviewMode: vi.fn(() => Promise.resolve(undefined)) },
    chat: { listModels: vi.fn(() => Promise.resolve([])) }
  }

  return { api, preview, getNavCb: () => navCb }
}

/** Install all stand-ins on the global/window. Call in `beforeEach`. */
export function installPreviewEnv(): PreviewEnv {
  const calls: PreviewCall[] = []
  let captureResult = 'data:image/png;base64,AAAA'
  let devServerResult: DevServerStatus | null = null
  let hostRect: Rect | null = { left: 100, top: 80, width: 900, height: 600 }

  // Fake only the timer functions (not rAF/Date/performance — we install our own
  // controllable rAF below) so tests can advance the dissolve + frozen-clear.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })

  const { api, preview, getNavCb } = makeApi(
    calls,
    () => captureResult,
    (projectId) =>
      devServerResult ?? {
        ok: true,
        status: 'ready',
        dataProxy: false,
        url: `https://${projectId}.example.app/`,
        devUri: `https://${projectId}.example.app/`,
        instanceId: `${projectId}-server-1`
      }
  )
  ;(window as unknown as { api: unknown }).api = api

  // Controllable requestAnimationFrame (jsdom has none / it's uncontrolled).
  const rafQueue = new Map<number, FrameRequestCallback>()
  let rafId = 0
  const origRaf = globalThis.requestAnimationFrame
  const origCancelRaf = globalThis.cancelAnimationFrame
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    rafId += 1
    rafQueue.set(rafId, cb)
    return rafId
  }) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = ((id: number) => {
    rafQueue.delete(id)
  }) as typeof cancelAnimationFrame

  // No-op ResizeObserver / IntersectionObserver (the initial reveal is
  // synchronous; observers only drive repositioning bursts we don't assert on).
  class NoopObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] {
      return []
    }
  }
  const origRO = (globalThis as Record<string, unknown>).ResizeObserver
  const origIO = (globalThis as Record<string, unknown>).IntersectionObserver
  ;(globalThis as Record<string, unknown>).ResizeObserver = NoopObserver
  ;(globalThis as Record<string, unknown>).IntersectionObserver = NoopObserver

  // jsdom returns an all-zero rect (no layout); back it with a controllable one.
  const origGBCR = Element.prototype.getBoundingClientRect
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    const r = hostRect ?? { left: 0, top: 0, width: 0, height: 0 }
    return {
      x: r.left,
      y: r.top,
      left: r.left,
      top: r.top,
      right: r.left + r.width,
      bottom: r.top + r.height,
      width: r.width,
      height: r.height,
      toJSON: () => ({})
    } as DOMRect
  }

  const e: PreviewEnv = {
    calls,
    api: preview,
    emitNav: (state) => {
      const cb = getNavCb()
      if (!cb) return
      cb({
        url: state.url ?? 'https://app.example/',
        loading: state.loading ?? false,
        canGoBack: state.canGoBack ?? false,
        canGoForward: state.canGoForward ?? false
      })
    },
    setHostRect: (rect) => {
      hostRect = rect
    },
    setCaptureResult: (dataUrl) => {
      captureResult = dataUrl
    },
    setDevServerResult: (result) => {
      devServerResult = result
    },
    flushRaf: (rounds = 4) => {
      for (let i = 0; i < rounds; i++) {
        const batch = Array.from(rafQueue.entries())
        rafQueue.clear()
        for (const [, cb] of batch) cb(performance.now())
      }
    },
    advanceTimers: (ms) => {
      vi.advanceTimersByTime(ms)
    },
    methodsAfter: (index) => calls.slice(index).map((c) => c.method),
    teardown: () => {
      vi.useRealTimers()
      globalThis.requestAnimationFrame = origRaf
      globalThis.cancelAnimationFrame = origCancelRaf
      ;(globalThis as Record<string, unknown>).ResizeObserver = origRO
      ;(globalThis as Record<string, unknown>).IntersectionObserver = origIO
      Element.prototype.getBoundingClientRect = origGBCR
      delete (window as unknown as { api?: unknown }).api
      currentEnv = null
    }
  }
  currentEnv = e
  return e
}

/** Build a StudioProject fixture. Deployed by default. */
export function makeProject(id: string, over: Partial<StudioProject> = {}): StudioProject {
  return {
    id,
    name: `Project ${id}`,
    path: `C:/projects/${id}`,
    addedAt: '2024-01-01T00:00:00.000Z',
    lastDeploy: { url: `https://${id}.example.app/`, status: 'success' },
    ...over
  }
}
