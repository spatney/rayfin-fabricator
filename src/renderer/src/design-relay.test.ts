import { readFileSync } from 'fs'
import { resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * Unit tests for the cross-frame relay in the injected design controller
 * (`src-tauri/src/services/design_agent.js`). The controller is a document-start
 * IIFE injected into every preview frame; in the Fabric-embedded view the top
 * (Fabric shell) frame runs as a `relay` that bridges the host API to the app
 * iframe over `postMessage`. Here we eval the controller into the jsdom window
 * (which behaves as the top frame) and exercise the relay role directly. These
 * assertions fail on the pre-relay controller (v2): it had no role dispatch, no
 * `message` listener, and always built the in-page editor UI on `enable()`.
 */

const SRC = readFileSync(
  resolve(process.cwd(), 'src-tauri/src/services/design_agent.js'),
  'utf8'
)

interface DesignApi {
  __v: number
  enable: (mode?: string, appOrigin?: string) => void
  disable: () => void
  peek: () => Record<string, unknown> | null
  drain: () => { instruction: string; changeCount: number } | null
  drainAi: () => Record<string, unknown> | null
}

/** Eval the controller IIFE into the current jsdom window and return its API. */
function installController(): DesignApi {
  // The file is an IIFE that attaches `window.__rayfinDesign`; run it in global scope.
  new Function(SRC)()
  return (window as unknown as { __rayfinDesign: DesignApi }).__rayfinDesign
}

function mirrorStatus(origin: string, status: Record<string, unknown>, handoff: unknown): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      origin,
      data: { ns: 'rayfin-design', evt: 'status', status, handoff, aiRequest: null }
    })
  )
}

const APP_ORIGIN = 'https://p1.example.app'
const HOST_ID = '__rayfin_design_host'

describe('design controller cross-frame relay', () => {
  beforeEach(() => {
    delete (window as unknown as { __rayfinDesign?: unknown }).__rayfinDesign
  })
  afterEach(() => {
    try {
      ;(window as unknown as { __rayfinDesign?: DesignApi }).__rayfinDesign?.disable()
    } catch {
      /* ignore */
    }
    delete (window as unknown as { __rayfinDesign?: unknown }).__rayfinDesign
  })

  it('is v3 and runs the top frame as a relay (no local editor UI)', () => {
    const d = installController()
    expect(d.__v).toBe(5)

    d.enable('relay', APP_ORIGIN)
    // The relay (Fabric shell) must NOT build the in-page editor chrome — that
    // lives in the app iframe. On the old controller enable() always built it.
    expect(document.getElementById(HOST_ID)).toBeNull()
    expect(d.peek()).toMatchObject({ enabled: true, changeCount: 0, handoffReady: false })
  })

  it('mirrors the app-frame status into peek()', () => {
    const d = installController()
    d.enable('relay', APP_ORIGIN)

    mirrorStatus(
      APP_ORIGIN,
      {
        enabled: true,
        version: 5,
        changeCount: 3,
        handoffReady: true,
        aiPending: false,
        hasModels: true,
        aiModel: 'm1'
      },
      { instruction: 'Make the header teal', changeCount: 3 }
    )

    expect(d.peek()).toMatchObject({ changeCount: 3, handoffReady: true, aiModel: 'm1' })
  })

  it('drains the mirrored hand-off exactly once', () => {
    const d = installController()
    d.enable('relay', APP_ORIGIN)
    mirrorStatus(
      APP_ORIGIN,
      { enabled: true, changeCount: 2, handoffReady: true, hasModels: false, aiModel: null },
      { instruction: 'Tweak spacing', changeCount: 2 }
    )

    expect(d.drain()).toEqual({ instruction: 'Tweak spacing', changeCount: 2 })
    // The cached hand-off is consumed — a second drain returns null.
    expect(d.drain()).toBeNull()
  })

  it('ignores status mirrored before enable (no relay session)', () => {
    const d = installController()
    // No enable() yet → not a relay; a stray status must not populate the cache.
    mirrorStatus(APP_ORIGIN, { enabled: true, changeCount: 9, handoffReady: true }, null)
    expect(d.peek()).toMatchObject({ changeCount: 0 })
  })
})
