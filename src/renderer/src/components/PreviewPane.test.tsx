import { useState, type JSX } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type {
  LocalLogEvent,
  LocalProblem,
  LocalReady,
  LocalStatus,
  StudioProject
} from '@shared/ipc'
import { OverlayProvider, SuppressPreview } from '../overlay'
import { useDesignSession, type DesignSurface } from '../design/useDesignSession'
import type { LocalBackend } from '../localBackend'
import PreviewPane, {
  type DeployUiState,
  type PreviewView,
  __resetPreviewSurfaceState
} from './PreviewPane'
import { installPreviewEnv, makeProject, type PreviewEnv } from '../../test/harness'
import { deferred } from '../../test/deferred'

/**
 * These tests exercise PreviewPane's native-surface visibility state machine —
 * the show / hide / suppress / navigate handoffs behind the live preview — via a
 * mocked `window.api.preview`. jsdom has no layout, so the harness supplies a
 * host rect and controllable rAF/observers. See src/renderer/test/harness.tsx.
 */

function Harnessed({
  project,
  suppressed,
  deploy,
  localPreviewUrl,
  manualDeploy,
  localReload,
  onRefreshAuth,
  authBusy,
  onDiagnoseDeploy,
  onSettle,
  watching,
  onWatchChange
}: {
  project: StudioProject
  suppressed: boolean
  deploy?: DeployUiState
  localPreviewUrl?: string | null
  manualDeploy?: boolean
  localReload?: number
  onRefreshAuth?: () => void
  authBusy?: boolean
  onDiagnoseDeploy?: () => void
  onSettle?: () => void
  watching?: boolean
  onWatchChange?: (watching: boolean) => void
}): JSX.Element {
  return (
    <OverlayProvider>
      {suppressed && <SuppressPreview />}
      <PreviewPane
        project={project}
        deploy={deploy}
        onRefreshAuth={onRefreshAuth}
        authBusy={authBusy}
        onDiagnoseDeploy={onDiagnoseDeploy}
        localPreviewUrl={localPreviewUrl}
        manualDeploy={manualDeploy}
        localReload={localReload}
        focused={false}
        onToggleFocus={() => {}}
        onSettle={onSettle}
        watching={watching}
        onWatchChange={onWatchChange}
        deploymentName="Production"
      />
    </OverlayProvider>
  )
}

/** Let pending microtasks (awaited capture, promise chains), rAF callbacks, and
 *  the chained min-loading / dissolve / frozen-clear timers run so the reveal
 *  fully settles. Fine-grained so chained awaits resolve across iterations. */
async function settle(e: PreviewEnv): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 30; i++) {
      await Promise.resolve()
      e.flushRaf(2)
      e.advanceTimers(50)
      await Promise.resolve()
    }
  })
}

let e: PreviewEnv

beforeEach(() => {
  // The surface-shown-url tracker is module-scoped (the native surface outlives a
  // PreviewPane mount); reset it so each test starts as a fresh app.
  __resetPreviewSurfaceState()
  vi.stubGlobal('devicePixelRatio', 1)
  vi.stubGlobal('visualViewport', undefined)
  e = installPreviewEnv()
})

afterEach(() => {
  cleanup()
  e.teardown()
  vi.unstubAllGlobals()
})

describe('PreviewPane visibility', () => {
  it('offers a sign-in failure its fix beside the live preview, with the logs folded away', async () => {
    const project = makeProject('p1')
    const onRefreshAuth = vi.fn()
    const onDiagnoseDeploy = vi.fn()
    const log = 'Build succeeded\nError: Could not acquire the token-cache lock\n'
    const deploy: DeployUiState = {
      running: false,
      log: [log],
      result: { ok: false, outcome: 'auth-cache-error', error: 'Refresh is needed' }
    }
    render(
      <Harnessed
        project={project}
        suppressed={false}
        deploy={deploy}
        onRefreshAuth={onRefreshAuth}
        onDiagnoseDeploy={onDiagnoseDeploy}
      />
    )
    await settle(e)
    expect(screen.getByRole('alert').textContent).toBe(
      'Fabric wants you to sign in again before you can publish this app.'
    )
    expect(screen.queryByText(/Build succeeded/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'View logs' }))
    expect(screen.getByText(/Build succeeded/).textContent).toBe(log)
    expect(e.api.showUrl).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Fabric authentication' }))
    expect(onRefreshAuth).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Find out why' }))
    expect(onDiagnoseDeploy).toHaveBeenCalledTimes(1)
  })

  it('shows a first publish’s IPC error even before project state has refreshed', async () => {
    const project = { ...makeProject('p1'), lastDeploy: undefined }
    render(
      <Harnessed
        project={project}
        suppressed={false}
        deploy={{ running: false, log: [], result: { ok: false, outcome: 'error', error: 'Deploy process disconnected' } }}
      />
    )
    expect(screen.getByRole('region', { name: 'Couldn’t publish' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show details' }))
    expect(screen.getByText('Deploy process disconnected')).toBeTruthy()
  })

  it('asks Help why a deploy failed, from Ray or from the button', async () => {
    const onDiagnoseDeploy = vi.fn()
    const onRefreshAuth = vi.fn()
    render(
      <Harnessed
        project={makeProject('p1')}
        suppressed={false}
        onRefreshAuth={onRefreshAuth}
        onDiagnoseDeploy={onDiagnoseDeploy}
        deploy={{
          running: false,
          log: ['❌ Deployment failed: Runtime settings sync failed: 400 Bad Request\n'],
          result: { ok: false, outcome: 'error', error: 'Runtime settings sync failed: 400 Bad Request' }
        }}
      />
    )
    await settle(e)
    expect(screen.getByRole('alert').textContent).toBe(
      'Your app didn’t make it to Fabric. Want me to find out why?'
    )
    // The headline is in the logs, not spelled out over the preview.
    expect(screen.queryByText(/400 Bad Request/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Ray, the Fabricator stingray/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Find out why' }))
    expect(onDiagnoseDeploy).toHaveBeenCalledTimes(2)
    // Signing in again is offered only when that's what went wrong.
    expect(screen.queryByRole('button', { name: 'Refresh Fabric authentication' })).toBeNull()
  })

  it('keeps a dismissed failure away until the next deploy fails', async () => {
    const project = makeProject('p1')
    const failed: DeployUiState = {
      running: false,
      log: ['Deploy failed: no capacity\n'],
      result: { ok: false, outcome: 'error', error: 'no capacity' }
    }
    const { rerender } = render(<Harnessed project={project} suppressed={false} deploy={failed} />)
    await settle(e)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await settle(e)
    expect(screen.queryByRole('region', { name: 'Couldn’t publish' })).toBeNull()

    rerender(<Harnessed project={project} suppressed={false} deploy={{ running: true, log: [] }} />)
    await settle(e)
    rerender(<Harnessed project={project} suppressed={false} deploy={{ ...failed }} />)
    await settle(e)
    expect(screen.getByRole('region', { name: 'Couldn’t publish' })).toBeTruthy()
  })

  it('offers recovery for a persisted failure but disables it during another auth operation', async () => {
    const project = makeProject('p1')
    project.lastDeploy = { ...project.lastDeploy, status: 'error', outcome: 'auth-cache-error', error: 'Token cache is locked' }
    const onRefreshAuth = vi.fn()
    render(<Harnessed project={project} suppressed={false} onRefreshAuth={onRefreshAuth} authBusy />)
    await settle(e)
    const refresh = screen.getByRole('button', { name: 'Refresh Fabric authentication' }) as HTMLButtonElement
    expect(refresh.disabled).toBe(true)
    fireEvent.click(refresh)
    expect(onRefreshAuth).not.toHaveBeenCalled()
  })

  it('does not leave a ghost preview when creation finishes after unmount', async () => {
    const created = deferred<void>()
    let nativeCreated = false
    let nativeVisible = false
    e.api.showUrl.mockImplementationOnce(() => created.promise.then(() => {
      nativeCreated = true
      nativeVisible = true
    }))
    e.api.suppress.mockImplementation(() => {
      if (nativeCreated) nativeVisible = false
      return Promise.resolve()
    })
    const { unmount } = render(<Harnessed project={makeProject('p1')} suppressed={false} />)
    await settle(e)
    unmount()
    expect(e.api.suppress).not.toHaveBeenCalled()
    await act(async () => created.resolve(undefined))
    await settle(e)
    expect(e.api.suppress).toHaveBeenCalledOnce()
    expect(nativeVisible).toBe(false)
  })

  it('applies the latest host bounds even when resize happens during creation', async () => {
    const created = deferred<void>()
    let nativeCreated = false
    let nativeBounds: unknown
    e.api.showUrl.mockImplementationOnce((_url, bounds) => created.promise.then(() => {
      nativeCreated = true
      nativeBounds = bounds
    }))
    e.api.setBounds.mockImplementation((bounds) => {
      if (nativeCreated) nativeBounds = bounds
      return Promise.resolve()
    })
    render(<Harnessed project={makeProject('p1')} suppressed={false} />)
    await settle(e)
    e.setHostRect({ left: 300, top: 100, width: 1000, height: 650 })
    act(() => window.dispatchEvent(new Event('resize')))
    await settle(e)
    expect(e.api.setBounds).not.toHaveBeenCalled()
    await act(async () => created.resolve(undefined))
    await settle(e)
    expect(nativeBounds).toEqual({ x: 300, y: 100, width: 1000, height: 650, pixelRatio: 1 })
  })

  it('repositions on a display-scale change without a CSS resize', async () => {
    const changes: Array<() => void> = []
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      addEventListener: (_type: string, listener: () => void) => changes.push(listener),
      removeEventListener: vi.fn()
    })))
    render(<Harnessed project={makeProject('p1')} suppressed={false} />)
    await settle(e)
    vi.stubGlobal('devicePixelRatio', 1.25)
    act(() => changes[0]())
    await settle(e)
    expect(e.api.setBounds).toHaveBeenLastCalledWith({
      x: 100, y: 80, width: 900, height: 600, pixelRatio: 1.25
    })
  })

  it('tracks visual-viewport zoom and panning, then removes its listeners', async () => {
    const viewport = Object.assign(new EventTarget(), { scale: 1, offsetLeft: 0, offsetTop: 0 })
    vi.stubGlobal('visualViewport', viewport)
    const { unmount } = render(<Harnessed project={makeProject('p1')} suppressed={false} />)
    await settle(e)
    viewport.scale = 1.25
    viewport.offsetLeft = 20
    viewport.offsetTop = 10
    act(() => viewport.dispatchEvent(new Event('resize')))
    await settle(e)
    expect(e.api.setBounds).toHaveBeenLastCalledWith({
      x: 80, y: 70, width: 900, height: 600, pixelRatio: 1.25
    })
    viewport.offsetLeft = 40
    act(() => viewport.dispatchEvent(new Event('scroll')))
    await settle(e)
    expect(e.api.setBounds).toHaveBeenLastCalledWith({
      x: 60, y: 70, width: 900, height: 600, pixelRatio: 1.25
    })
    unmount()
    await settle(e)
    const count = e.api.setBounds.mock.calls.length
    viewport.scale = 2
    act(() => viewport.dispatchEvent(new Event('resize')))
    await settle(e)
    expect(e.api.setBounds.mock.calls.length).toBe(count)
  })

  it('reveals the webview at host bounds on initial deployed mount', async () => {
    render(<Harnessed project={makeProject('p1')} suppressed={false} />)
    await settle(e)

    expect(e.api.showUrl).toHaveBeenCalled()
    const [url, bounds] = e.api.showUrl.mock.calls[0] as [string, { width: number; height: number }]
    expect(url).toBe('https://p1.example.app/')
    expect(bounds.width).toBeGreaterThan(0)
    expect(bounds.height).toBeGreaterThan(0)
  })

  it('screenshots first, then parks, for a partial overlay (no bare-host flash)', async () => {
    const { rerender } = render(<Harnessed project={makeProject('p1')} suppressed={false} />)
    await settle(e)
    const mark = e.calls.length

    // A dropdown/modal opens over the visible preview (host has real bounds).
    rerender(<Harnessed project={makeProject('p1')} suppressed={true} />)
    await settle(e)

    const after = e.methodsAfter(mark)
    expect(after).toContain('capture')
    expect(after).toContain('suppress')
    expect(after).not.toContain('hide')
    // The still must be captured BEFORE the surface parks, so it's painted as a
    // backstop and the pane never flashes bare during the park.
    expect(after.indexOf('capture')).toBeLessThan(after.indexOf('suppress'))
  })

  it('parks immediately without a screenshot for a full-screen overlay (launcher)', async () => {
    const { rerender } = render(<Harnessed project={makeProject('p1')} suppressed={false} />)
    await settle(e)
    const mark = e.calls.length

    // The launcher opens: it sets the pane display:none, so the host is 0×0.
    e.setHostRect(null)
    rerender(<Harnessed project={makeProject('p1')} suppressed={true} />)
    await settle(e)

    const after = e.methodsAfter(mark)
    expect(after).toContain('suppress')
    // No screenshot when the host is hidden — and an instant park keeps the
    // webview from covering the launcher for a beat.
    expect(after, 'no screenshot needed when the host is hidden').not.toContain('capture')
  })

  it('re-reveals the same webview when an overlay closes', async () => {
    const { rerender } = render(<Harnessed project={makeProject('p1')} suppressed={false} />)
    await settle(e)
    rerender(<Harnessed project={makeProject('p1')} suppressed={true} />)
    await settle(e)
    const mark = e.calls.length

    rerender(<Harnessed project={makeProject('p1')} suppressed={false} />)
    await settle(e)

    // Closing the overlay must reveal the surface again (showUrl at host bounds).
    const reveal = lastShowUrl(e)
    expect(reveal).not.toBeNull()
    expect(reveal!.index).toBeGreaterThanOrEqual(mark)
    expect(reveal!.url).toBe('https://p1.example.app/')
    expect(reveal!.bounds.width).toBeGreaterThan(0)
  })

  // The launch screen covers a pane that has never been on screen. There's no
  // frame to keep, so the page loads off-screen under the cover and is stilled
  // there, and the cover lifts onto a finished page rather than a blank one.
  // The cover is up first and the pane mounts under it, as at launch.
  function Covered({ pane, covered = true, project = makeProject('p1'), onSettle }: {
    pane: boolean
    covered?: boolean
    project?: StudioProject
    onSettle?: () => void
  }): JSX.Element {
    return (
      <OverlayProvider>
        {covered && <SuppressPreview />}
        {pane && (
          <PreviewPane
            project={project}
            deploy={undefined}
            focused={false}
            onToggleFocus={() => {}}
            onSettle={onSettle}
          />
        )}
      </OverlayProvider>
    )
  }

  async function mountCovered(onSettle?: () => void): Promise<ReturnType<typeof render>> {
    const view = render(<Covered pane={false} onSettle={onSettle} />)
    await settle(e)
    view.rerender(<Covered pane onSettle={onSettle} />)
    await settle(e)
    return view
  }

  it('loads off-screen under a cover it was never shown before, then stills it', async () => {
    const onSettle = vi.fn()
    await mountCovered(onSettle)

    expect(e.api.preload).toHaveBeenCalledTimes(1)
    const [url, bounds] = e.api.preload.mock.calls[0] as [string, { width: number; height: number }]
    expect(url).toBe('https://p1.example.app/')
    expect(bounds.width).toBeGreaterThan(0)
    expect(e.api.showUrl).not.toHaveBeenCalled()
    expect(e.api.capture, 'nothing to capture before the page loads').not.toHaveBeenCalled()
    expect(onSettle).not.toHaveBeenCalled()

    act(() => e.emitNav({ url: 'https://p1.example.app/', loading: true }))
    act(() => e.emitNav({ url: 'https://p1.example.app/', loading: false }))
    await settle(e)

    expect(e.api.capture).toHaveBeenCalled()
    expect(e.api.preload).toHaveBeenCalledTimes(1)
    expect(e.api.showUrl, 'still covered').not.toHaveBeenCalled()
    expect(onSettle).toHaveBeenCalledTimes(1)
  })

  it('reveals the page it loaded under a cover once the cover lifts', async () => {
    const view = await mountCovered()
    act(() => e.emitNav({ loading: true }))
    act(() => e.emitNav({ loading: false }))
    await settle(e)
    const mark = e.calls.length

    view.rerender(<Covered pane covered={false} />)
    await settle(e)

    const reveal = lastShowUrl(e)
    expect(reveal!.index).toBeGreaterThanOrEqual(mark)
    expect(reveal!.url).toBe('https://p1.example.app/')
    expect(e.methodsAfter(mark)).not.toContain('preload')
  })

  it('keeps a page still loading behind its placeholder when the cover lifts first', async () => {
    const view = await mountCovered()
    act(() => e.emitNav({ loading: true }))
    view.rerender(<Covered pane covered={false} />)
    await settle(e)
    expect(e.api.showUrl, 'never revealed mid-load').not.toHaveBeenCalled()

    act(() => e.emitNav({ loading: false }))
    await settle(e)
    expect(lastShowUrl(e)?.url).toBe('https://p1.example.app/')
  })

  it('settles at once with nothing to load, and once the live page is on screen', async () => {
    const nothing = vi.fn()
    const covered = render(<Covered pane={false} />)
    await settle(e)
    covered.rerender(
      <Covered pane project={makeProject('p1', { lastDeploy: undefined })} onSettle={nothing} />
    )
    await settle(e)
    expect(nothing).toHaveBeenCalledTimes(1)
    expect(e.api.preload).not.toHaveBeenCalled()
    covered.unmount()

    const live = vi.fn()
    render(<Harnessed project={makeProject('p2')} suppressed={false} onSettle={live} />)
    await settle(e)
    expect(live).toHaveBeenCalledTimes(1)
  })

  // Reproduces the reported regression: switching projects via the Home launcher
  // leaves the preview blank. Home opens (suppressed + the pane goes display:none
  // so the host is 0×0), the active project is swapped WHILE still suppressed,
  // then Home closes (suppressed=false) and a load transition runs. During that
  // in-flight load the preview must NOT capture (capturing pumps the UI thread
  // mid-navigation and stalls the load-completion events → blank). It should park
  // OFF-SCREEN but keep rendering (so the new page paints before reveal — avoids
  // the stale old-project frame) and end revealed at the new project's URL.
  it('parks + navigates (never captures) during a Home-mediated switch, then reveals p2', async () => {
    const { rerender } = render(<Harnessed project={makeProject('p1')} suppressed={false} />)
    await settle(e)

    // goHome(): overlay on, pane display:none (host 0×0).
    e.setHostRect(null)
    rerender(<Harnessed project={makeProject('p1')} suppressed={true} />)
    await settle(e)

    // selectProject(p2): active swaps but showHome hasn't flipped yet — a load
    // transition begins for p2 while still suppressed.
    const mark = e.calls.length
    rerender(<Harnessed project={makeProject('p2')} suppressed={true} />)
    await settle(e)

    // [active.id] effect: showHome=false, pane visible again — still transitioning.
    e.setHostRect({ left: 100, top: 80, width: 900, height: 600 })
    rerender(<Harnessed project={makeProject('p2')} suppressed={false} />)
    await settle(e)

    // Contract during the in-flight load: navigate + park (keep rendering), and
    // NEVER capture (would pump the UI thread) nor hard-hide (stops rendering →
    // reveal flashes the stale old-project frame).
    const during = e.methodsAfter(mark)
    expect(during, 'must not capture during a load transition (pumps the UI thread)').not.toContain(
      'capture'
    )
    expect(during, 'must keep rendering off-screen, not hard-hide').not.toContain('hide')
    expect(during).toContain('navigate')
    expect(during).toContain('suppress')

    // The load transition completes (started → finished).
    await act(async () => {
      e.emitNav({ url: 'https://p2.example.app/', loading: true })
    })
    await act(async () => {
      e.emitNav({ url: 'https://p2.example.app/', loading: false })
    })
    await settle(e)

    const reveal = lastShowUrl(e)
    expect(reveal, 'preview was never revealed after project switch (blank)').not.toBeNull()
    expect(reveal!.index).toBeGreaterThanOrEqual(mark)
    expect(reveal!.url).toBe('https://p2.example.app/')
    expect(reveal!.bounds.width).toBeGreaterThan(0)
    expect(reveal!.bounds.height).toBeGreaterThan(0)
  })

  it('parks the surface (not hide) on unmount, so a Build-tab re-entry is a pure move', async () => {
    const { unmount } = render(<Harnessed project={makeProject('p1')} suppressed={false} />)
    await settle(e)
    const mark = e.calls.length

    unmount() // tab switch build → code/model/advisor unmounts PreviewPane

    const after = e.methodsAfter(mark)
    expect(after).toContain('suppress')
    expect(after).not.toContain('hide')
    // Parked at the last on-screen size so the re-entry set_bounds is a pure move.
    const parked = e.calls.slice(mark).find((c) => c.method === 'suppress')
    const bounds = parked!.args[0] as { width: number; height: number }
    expect(bounds.width).toBe(900)
    expect(bounds.height).toBe(600)
  })

  it('re-reveals the webview when the Build tab is re-entered (remount)', async () => {
    const first = render(<Harnessed project={makeProject('p1')} suppressed={false} />)
    await settle(e)
    first.unmount()
    const mark = e.calls.length

    render(<Harnessed project={makeProject('p1')} suppressed={false} />)
    await settle(e)

    const reveal = lastShowUrl(e)
    expect(reveal).not.toBeNull()
    expect(reveal!.index).toBeGreaterThanOrEqual(mark)
    expect(reveal!.url).toBe('https://p1.example.app/')
    expect(reveal!.bounds.width).toBeGreaterThan(0)
  })

  it('runs a load transition (not a bare reveal) when Build is re-entered on a different project', async () => {
    // Show p1, then leave Build — unmounting parks the singleton surface, which
    // keeps rendering p1 off-screen.
    const first = render(<Harnessed project={makeProject('p1')} suppressed={false} />)
    await settle(e)
    first.unmount()

    // Re-enter Build on a DIFFERENT project (a project switch made from another
    // view that jumps back to Build). The surface still shows p1, so p2 must NOT
    // be revealed immediately — it should navigate + park (the "Loading…" overlay
    // shows) and reveal only once p2 has loaded, so the stale p1 frame never
    // flashes.
    const mark = e.calls.length
    render(<Harnessed project={makeProject('p2')} suppressed={false} />)
    await settle(e)

    const during = e.methodsAfter(mark)
    expect(during).toContain('navigate')
    expect(during).toContain('suppress')
    expect(during, 'must not reveal p2 before it has loaded').not.toContain('showUrl')

    // p2 finishes loading → now it reveals at host bounds.
    await act(async () => {
      e.emitNav({ url: 'https://p2.example.app/', loading: true })
    })
    await act(async () => {
      e.emitNav({ url: 'https://p2.example.app/', loading: false })
    })
    await settle(e)

    const reveal = lastShowUrl(e)
    expect(reveal, 'p2 was never revealed after the Build re-entry').not.toBeNull()
    expect(reveal!.index).toBeGreaterThanOrEqual(mark)
    expect(reveal!.url).toBe('https://p2.example.app/')
    expect(reveal!.bounds.width).toBeGreaterThan(0)
  })

  // "Finished" can arrive a frame or two before the parked page has painted; a
  // reveal in that gap shows the previous project's frame for a moment.
  it('gives a page that just finished loading a moment to paint before revealing it', async () => {
    const first = render(<Harnessed project={makeProject('p1')} suppressed={false} />)
    await settle(e)
    first.unmount()
    render(<Harnessed project={makeProject('p2')} suppressed={false} />)
    await settle(e) // long past the minimum "Loading…" beat
    const mark = e.calls.length

    await act(async () => {
      e.emitNav({ url: 'https://p2.example.app/', loading: true })
    })
    await act(async () => {
      e.emitNav({ url: 'https://p2.example.app/', loading: false })
    })
    await act(async () => {
      e.advanceTimers(150)
      e.flushRaf(2)
    })
    expect(e.methodsAfter(mark), 'p1 may still be on the surface').not.toContain('showUrl')

    await settle(e)
    expect(lastShowUrl(e)?.url).toBe('https://p2.example.app/')
  })

  it('hides and shows no webview for an undeployed project', async () => {
    render(
      <Harnessed project={makeProject('p1', { lastDeploy: undefined })} suppressed={false} />
    )
    await settle(e)

    expect(e.api.showUrl).not.toHaveBeenCalled()
    expect(e.api.hide).toHaveBeenCalled()
  })

  it('parks + reloads (never captures) across a redeploy, then reveals', async () => {
    const project = makeProject('p1')
    const { rerender } = render(
      <Harnessed project={project} suppressed={false} deploy={{ running: true, log: [] }} />
    )
    await settle(e)

    // Deploy finishes successfully → a reload transition re-loads the same URL.
    const mark = e.calls.length
    rerender(
      <Harnessed
        project={project}
        suppressed={false}
        deploy={{ running: false, log: [], result: { ok: true, outcome: 'success' } }}
      />
    )
    await settle(e)

    const during = e.methodsAfter(mark)
    expect(during).toContain('reload')
    expect(during).toContain('suppress') // parked off-screen, kept rendering
    expect(during, 'no capture during a reload transition').not.toContain('capture')

    await act(async () => {
      e.emitNav({ url: 'https://p1.example.app/', loading: true })
    })
    await act(async () => {
      e.emitNav({ url: 'https://p1.example.app/', loading: false })
    })
    await settle(e)

    const reveal = lastShowUrl(e)
    expect(reveal).not.toBeNull()
    expect(reveal!.index).toBeGreaterThanOrEqual(mark)
    expect(reveal!.url).toBe('https://p1.example.app/')
  })
})

describe('PreviewPane status label', () => {
  function pane(over: Partial<Parameters<typeof PreviewPane>[0]> = {}): JSX.Element {
    return (
      <OverlayProvider>
        <PreviewPane
          project={makeProject('p1')}
          deploy={undefined}
          focused={false}
          onToggleFocus={() => {}}
          {...over}
        />
      </OverlayProvider>
    )
  }

  it('has no status for a solo app (the app bar shows its deployment), and names which deployment a team app shows', async () => {
    const { rerender, container } = render(pane())
    await settle(e)
    expect(container.querySelector('.preview-status')).toBeNull()
    expect(screen.queryByText('Live')).toBeNull()

    rerender(pane({ team: true, teamView: 'preview' }))
    expect(screen.getByText('My preview')).toBeTruthy()
    expect(screen.queryByText('Live')).toBeNull()

    rerender(pane({ team: true, teamView: 'production' }))
    expect(screen.getByText('Published')).toBeTruthy()
  })

  it('keeps the team deployment’s name while the pipeline updates it', async () => {
    render(
      pane({
        team: true,
        teamView: 'production',
        teamRun: { id: 1, kind: 'production', status: 'in_progress', url: '', sha: '', steps: [] }
      })
    )
    await settle(e)
    expect(screen.getByText('Published · updating')).toBeTruthy()
  })
})

describe('PreviewPane local preview', () => {
  const LOCAL = 'http://localhost:5173/'

  // Live local preview: while a Vite dev server is running for the
  // project, the surface swaps from the deployed app to the local URL and a
  // "Local" badge is shown. The swap goes through the normal load transition
  // (navigate hidden → reveal on load), so it's flash-free.
  it('swaps to the local dev URL (with a Local badge) when a dev server is running', async () => {
    const { rerender } = render(<Harnessed project={makeProject('p1')} suppressed={false} />)
    await settle(e)
    const mark = e.calls.length

    // Turn starts → the dev server comes up and its URL is handed in.
    rerender(<Harnessed project={makeProject('p1')} suppressed={false} localPreviewUrl={LOCAL} />)
    await settle(e)

    const during = e.methodsAfter(mark)
    expect(during, 'must navigate the hidden surface to the local URL').toContain('navigate')
    const navCall = e.calls.slice(mark).find((c) => c.method === 'navigate')
    expect(navCall!.args[0]).toBe(LOCAL)

    // The local page finishes loading → revealed at the local URL, badge visible.
    await act(async () => {
      e.emitNav({ url: LOCAL, loading: true })
    })
    await act(async () => {
      e.emitNav({ url: LOCAL, loading: false })
    })
    await settle(e)

    const reveal = lastShowUrl(e)
    expect(reveal, 'the local preview was never revealed').not.toBeNull()
    expect(reveal!.index).toBeGreaterThanOrEqual(mark)
    expect(reveal!.url).toBe(LOCAL)
    expect(screen.getByText('localhost:5173')).toBeTruthy()
    expect(screen.queryByText('Local'), 'the address says it is local').toBeNull()
  })

  it('shows the local dev server even for a never-deployed project', async () => {
    render(
      <Harnessed
        project={makeProject('p1', { lastDeploy: undefined })}
        suppressed={false}
        localPreviewUrl={LOCAL}
      />
    )
    await settle(e)

    // No deployment, yet the surface still shows the local URL (not the empty
    // "not deployed" state) so edits are visible on the very first turn.
    const reveal = lastShowUrl(e)
    expect(reveal, 'the local preview should show without a deployment').not.toBeNull()
    expect(reveal!.url).toBe(LOCAL)
    // Its address shows straight away, before the page reports where it is.
    expect(screen.getByText('localhost:5173')).toBeTruthy()
  })

  it('reloads the local preview once, hidden, when a turn that changed files ends', async () => {
    const project = makeProject('p1')
    const pane = (localReload: number): JSX.Element => (
      <Harnessed project={project} suppressed={false} localPreviewUrl={LOCAL} manualDeploy localReload={localReload} />
    )
    const { rerender } = render(pane(0))
    await settle(e)
    expect(e.api.reload).not.toHaveBeenCalled()

    const mark = e.calls.length
    rerender(pane(1))
    await settle(e)
    expect(e.api.reload).toHaveBeenCalledTimes(1)
    expect(e.methodsAfter(mark), 'parked while the fresh page loads').toContain('suppress')

    // Rendering again with the same value doesn't reload again.
    rerender(pane(1))
    await settle(e)
    expect(e.api.reload).toHaveBeenCalledTimes(1)
  })

  it('leaves the deployed app alone when asked to reload the local preview', async () => {
    const project = makeProject('p1')
    const { rerender } = render(<Harnessed project={project} suppressed={false} localReload={0} />)
    await settle(e)
    rerender(<Harnessed project={project} suppressed={false} localReload={1} />)
    await settle(e)
    expect(e.api.reload).not.toHaveBeenCalled()
  })

  it('says whose data a team app’s local preview uses only when it isn’t its own', async () => {
    const props = {
      project: makeProject('p1'),
      deploy: undefined,
      focused: false,
      onToggleFocus: () => {},
      localPreviewUrl: LOCAL,
      team: true
    }
    const { rerender } = render(
      <OverlayProvider>
        <PreviewPane {...props} localBackend="production" />
      </OverlayProvider>
    )
    await settle(e)
    expect(screen.getByText('Published data').className).toContain('preview-local-badge--warn')

    rerender(
      <OverlayProvider>
        <PreviewPane {...props} localBackend="none" />
      </OverlayProvider>
    )
    expect(screen.getByText('No data yet')).toBeTruthy()

    rerender(
      <OverlayProvider>
        <PreviewPane {...props} localBackend="preview" />
      </OverlayProvider>
    )
    expect(screen.queryByText('Published data')).toBeNull()
    expect(screen.queryByText('No data yet')).toBeNull()
    expect(screen.getByText('localhost:5173')).toBeTruthy()
  })

  it('keeps the local preview on screen through a redeploy, under a strip saying how it goes', async () => {
    render(
      <Harnessed
        project={makeProject('p1')}
        suppressed={false}
        deploy={{ running: true, log: ['Deploying Project p1 to Fabric…\n'], startedAt: Date.now() }}
        localPreviewUrl={LOCAL}
      />
    )
    await settle(e)

    expect(screen.getByText('Publishing to Production')).toBeTruthy()
    expect(
      screen.queryByText(/Fabricating/i),
      'the publish screen waits to be asked for'
    ).toBeNull()
    expect(screen.getByText('localhost:5173')).toBeTruthy()
    expect(lastShowUrl(e)?.url).toBe(LOCAL)
  })

  it('shows a redeploy on the deploy screen to watch it, and goes back to the app', async () => {
    const onWatchChange = vi.fn()
    const deploy: DeployUiState = { running: true, log: [], startedAt: Date.now() }
    const { rerender } = render(
      <Harnessed project={makeProject('p1')} suppressed={false} deploy={deploy} onWatchChange={onWatchChange} />
    )
    await settle(e)
    fireEvent.click(screen.getByRole('button', { name: 'Watch' }))
    expect(onWatchChange).toHaveBeenCalledWith(true)

    const mark = e.calls.length
    rerender(
      <Harnessed project={makeProject('p1')} suppressed={false} deploy={deploy} watching onWatchChange={onWatchChange} />
    )
    await settle(e)
    expect(screen.getByText(/Fabricating/i)).toBeTruthy()
    expect(e.methodsAfter(mark)).toContain('hide')
    fireEvent.click(screen.getByRole('button', { name: 'Back to your app' }))
    expect(onWatchChange).toHaveBeenLastCalledWith(false)
  })

  it('takes the stage for a first deploy, with nothing to go back to', async () => {
    render(
      <Harnessed
        project={makeProject('p1', { lastDeploy: undefined })}
        suppressed={false}
        deploy={{ running: true, log: [], startedAt: Date.now() }}
        localPreviewUrl={LOCAL}
        onWatchChange={() => {}}
      />
    )
    await settle(e)

    // The deploy screen takes the surface; the local URL is never shown.
    expect(screen.getByText(/Fabricating/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Back to your app' })).toBeNull()
    expect(screen.queryByText('Local')).toBeNull()
    const shownLocal = e.calls.some((c) => c.method === 'showUrl' && c.args[0] === LOCAL)
    expect(shownLocal, 'the local URL must not be shown under the deploy screen').toBe(false)
  })

  it('loads the deployed app when a redeploy watched on the deploy screen ends and its local preview closes', async () => {
    const project = makeProject('p1')
    const deploy: DeployUiState = { running: true, log: [], startedAt: Date.now() }
    const { rerender } = render(
      <Harnessed project={project} suppressed={false} deploy={deploy} localPreviewUrl={LOCAL} />
    )
    await settle(e)
    await act(async () => {
      e.emitNav({ url: LOCAL, loading: false })
    })
    await settle(e)

    // Watched on the deploy screen: the surface is hidden, still holding the local page.
    rerender(<Harnessed project={project} suppressed={false} deploy={deploy} localPreviewUrl={LOCAL} watching />)
    await settle(e)
    const mark = e.calls.length

    rerender(
      <Harnessed
        project={project}
        suppressed={false}
        deploy={{ running: false, log: [], result: { ok: true, outcome: 'success' } }}
        localPreviewUrl={null}
      />
    )
    await settle(e)

    expect(e.methodsAfter(mark), 'the stopped local page is not reloaded').not.toContain('reload')
    const nav = e.calls.slice(mark).find((c) => c.method === 'navigate')
    expect(nav?.args[0]).toBe('https://p1.example.app/')
  })

  it('loads the deployed app, without reloading the closed local preview, when a redeploy ends', async () => {
    const project = makeProject('p1')
    const { rerender } = render(
      <Harnessed
        project={project}
        suppressed={false}
        deploy={{ running: true, log: [], startedAt: Date.now() }}
        localPreviewUrl={LOCAL}
      />
    )
    await settle(e)
    await act(async () => {
      e.emitNav({ url: LOCAL, loading: false })
    })
    await settle(e)
    const mark = e.calls.length

    // The deploy succeeds and the local preview kept through it closes with it.
    rerender(
      <Harnessed
        project={project}
        suppressed={false}
        deploy={{ running: false, log: [], result: { ok: true, outcome: 'success' } }}
        localPreviewUrl={null}
      />
    )
    await settle(e)

    const after = e.methodsAfter(mark)
    expect(after, 'the stopped local page is not reloaded').not.toContain('reload')
    const nav = e.calls.slice(mark).find((c) => c.method === 'navigate')
    expect(nav?.args[0]).toBe('https://p1.example.app/')
    expect(screen.queryByText('Publishing to Production')).toBeNull()
  })

  it('returns to the deployed app when the dev server stops (turn ends)', async () => {
    // Dev server running → local shown.
    const { rerender } = render(
      <Harnessed project={makeProject('p1')} suppressed={false} localPreviewUrl={LOCAL} />
    )
    await settle(e)
    await act(async () => {
      e.emitNav({ url: LOCAL, loading: false })
    })
    await settle(e)
    const mark = e.calls.length

    // Turn ends → the dev server is stopped (localPreviewUrl cleared).
    rerender(<Harnessed project={makeProject('p1')} suppressed={false} localPreviewUrl={null} />)
    await settle(e)
    await act(async () => {
      e.emitNav({ url: 'https://p1.example.app/', loading: true })
    })
    await act(async () => {
      e.emitNav({ url: 'https://p1.example.app/', loading: false })
    })
    await settle(e)

    // Back on the deployed app, no more Local badge.
    const reveal = lastShowUrl(e)
    expect(reveal!.index).toBeGreaterThanOrEqual(mark)
    expect(reveal!.url).toBe('https://p1.example.app/')
    expect(screen.queryByText('Local')).toBeNull()
  })

  it('reloads a live preview kept through a publish, as its published backend changed', async () => {
    const project = makeProject('p1')
    const pane = (deploy: DeployUiState): JSX.Element => (
      <Harnessed
        project={project}
        suppressed={false}
        deploy={deploy}
        localPreviewUrl={LOCAL}
        manualDeploy
      />
    )
    const { rerender } = render(pane({ running: true, log: [], startedAt: Date.now() }))
    await settle(e)
    await act(async () => {
      e.emitNav({ url: LOCAL, loading: false })
    })
    await settle(e)
    const mark = e.calls.length

    rerender(pane({ running: false, log: [], result: { ok: true, outcome: 'success' } }))
    await settle(e)
    expect(e.methodsAfter(mark)).toContain('reload')
  })
})

/** Without the app on this computer, the preview shows the published app (or a live preview on its backend). */
describe('PreviewPane before an app is published', () => {
  it('asks where to publish an app a turn tried to publish before it ever was', async () => {
    render(
      <Harnessed
        project={makeProject('p1', { name: 'Trip Logger', lastDeploy: undefined })}
        suppressed={false}
        deploy={{
          running: false,
          log: [],
          result: {
            ok: false,
            outcome: 'needs-workspace',
            error: 'This project has no Fabric workspace yet — choose one to publish to.'
          }
        }}
      />
    )
    await settle(e)
    expect(screen.getByRole('heading', { name: 'Choose where to publish' })).toBeTruthy()
    expect(screen.getByText(/hasn’t been published yet/).textContent).toBe(
      'Trip Logger hasn’t been published yet. Select Publish in the header above to name it and pick the Fabric workspace to publish it to.'
    )
    // It isn't a failure to look into.
    expect(screen.queryByRole('region', { name: 'Couldn’t publish' })).toBeNull()
  })

  it('says where the published app will show', async () => {
    render(<Harnessed project={makeProject('p1', { lastDeploy: undefined })} suppressed={false} />)
    await settle(e)
    expect(screen.getByText(/Your published app will render here/).textContent).toBe(
      'Your published app will render here after a full rayfin up. Ask Copilot to build something, or select Publish.'
    )
  })
})

/** A Fabric-view project fixture: an app that works only inside the Fabric portal
 *  (the only kind offered the Fabric view), its direct app
 *  URL plus the portal deep link. */
function fabricProject(id = 'p1'): StudioProject {
  return makeProject(id, {
    previewMode: 'fabric',
    needsFabricPortal: true,
    lastDeploy: {
      url: `https://${id}.example.app/`,
      status: 'success',
      portalUrl: `https://app.fabric.microsoft.com/groups/ws/appbackends/${id}`
    }
  })
}

describe('PreviewPane Fabric view', () => {
  it('offers the Fabric portal view only to an app that works only inside the portal', async () => {
    // Any other app shows itself, even with the Fabric view still stored from before.
    const other = { ...fabricProject('p1'), needsFabricPortal: false }
    const { unmount } = render(<Harnessed project={other} suppressed={false} />)
    await settle(e)
    expect(lastShowUrl(e)?.url).toBe('https://p1.example.app/')
    expect(screen.queryByRole('button', { name: 'Fabric' })).toBeNull()
    unmount()

    __resetPreviewSurfaceState()
    render(<Harnessed project={fabricProject('p2')} suppressed={false} />)
    await settle(e)
    expect(lastShowUrl(e)?.url).toBe('https://app.fabric.microsoft.com/groups/ws/appbackends/p2')
    const fabric = screen.getByRole<HTMLButtonElement>('button', { name: 'Fabric' })
    expect(fabric.disabled).toBe(false)
    expect(fabric.className).toContain('seg-btn--on')
  })
})

describe('PreviewPane design mode', () => {
  it.each(['fabric', 'local'] as const)('does not reload a retained %s document when native re-show replays navigation', async (source) => {
    const project = fabricProject()
    const localPreviewUrl = 'http://localhost:5173'
    const url = source === 'fabric' ? project.lastDeploy!.portalUrl! : localPreviewUrl
    const actualUrl = source === 'fabric' ? `${url}?experience=power-bi` : `${url}/dashboard`
    const pane = (
      <Harnessed project={project} suppressed={false}
        localPreviewUrl={source === 'local' ? localPreviewUrl : undefined} />
    )
    const { unmount } = render(pane)
    await settle(e)
    await act(async () => e.emitNav({ url: actualUrl, loading: false }))
    await settle(e)
    unmount()
    await settle(e)
    e.api.navigate.mockClear()
    e.api.showUrl.mockImplementation(async () => {
      e.emitNav({ url: actualUrl, loading: false })
    })

    render(pane)
    await settle(e)
    expect(e.api.navigate).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: new URL(actualUrl).host })).toBeTruthy()
  })

  // Regression: design mode used to be hard-disabled in the Fabric portal view
  // (the app runs in a cross-origin iframe the top-frame editor couldn't reach).
  // It must now be enabled and drive the app iframe through the top-frame relay.
  it('enables the Design button in the Fabric-embedded view and drives the relay', async () => {
    render(<DesignHarnessed project={fabricProject('p1')} />)
    await settle(e)

    const designBtn = screen.getByRole('button', { name: /^design/i }) as HTMLButtonElement
    expect(designBtn.disabled).toBe(false)

    fireEvent.click(designBtn)
    await settle(e)

    // Toggling on passes embedded=true + the direct app URL so the host can find
    // and drive the cross-origin app iframe from the top-frame relay, plus a
    // fresh session seeded with the (empty) queue.
    const call = e.calls.find((c) => c.method === 'design.setEnabled')
    expect(call, 'design.setEnabled was not called').toBeTruthy()
    expect(call!.args.slice(0, 3)).toEqual([true, true, 'https://p1.example.app/'])
    expect(call!.args[3]).toMatchObject({ items: [], intro: true, sessionId: expect.any(String) })
  })

  it('drives the direct view with embedded=false', async () => {
    render(<DesignHarnessed project={makeProject('p1')} />)
    await settle(e)

    const designBtn = screen.getByRole('button', { name: /^design/i }) as HTMLButtonElement
    expect(designBtn.disabled).toBe(false)
    fireEvent.click(designBtn)
    await settle(e)

    const call = e.calls.find((c) => c.method === 'design.setEnabled')
    expect(call!.args.slice(0, 3)).toEqual([true, false, 'https://p1.example.app/'])
  })

  it('shows the design bar while designing: device widths, Theme, Polish, Send and Done', async () => {
    const onSend = vi.fn()
    render(<DesignHarnessed project={fabricProject('p1')} onSend={onSend} />)
    await settle(e)
    fireEvent.click(screen.getByRole('button', { name: /^design/i }))
    await settle(e)

    const bar = screen.getByRole('toolbar', { name: 'Design tools' })
    expect(bar.textContent).toContain('Click anything in your app to change it')
    // Switching views mid-session would reload the page, so the toggle is locked.
    expect((screen.getByRole('button', { name: 'Fabric' }) as HTMLButtonElement).disabled).toBe(
      true
    )
    // Nothing queued yet → nothing to send.
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)

    // A device width constrains the preview host (the native surface follows it).
    fireEvent.click(screen.getByRole('button', { name: 'Phone width' }))
    const host = document.querySelector('.preview-webview-host') as HTMLElement
    expect(host.style.width).toBe('390px')
    expect(host.classList.contains('preview-webview-host--device')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Desktop width' }))
    expect(host.style.width).toBe('')

    fireEvent.click(screen.getByRole('button', { name: /theme/i }))
    await settle(e)
    const openTheme = e.calls.find((c) => c.method === 'design.command' && (c.args[0] as { op: string }).op === 'openPanel')
    expect(openTheme?.args[0]).toEqual({ op: 'openPanel', panel: 'theme' })

    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await settle(e)
    expect(screen.queryByRole('toolbar', { name: 'Design tools' })).toBeNull()
    expect(e.calls.filter((c) => c.method === 'design.setEnabled').slice(-1)[0].args).toEqual([false])
    expect(onSend).not.toHaveBeenCalled()
  })

  it('mirrors the page’s queue into the toolbar and sends it from the bar', async () => {
    const onSend = vi.fn()
    render(<DesignHarnessed project={makeProject('p1')} onSend={onSend} />)
    await settle(e)
    fireEvent.click(screen.getByRole('button', { name: /^design/i }))
    await settle(e)
    const session = (e.calls.find((c) => c.method === 'design.setEnabled')!.args[3] as { sessionId: string }).sessionId
    const item = {
      id: 'i1', kind: 'element', tweaks: [], instruction: 'Make it the primary action', createdAt: 1,
      target: { label: 'Button · Save', role: 'button', tag: 'button', selector: 'button', route: '/', box: { w: 80, h: 32 } }
    }
    e.api.design.poll.mockResolvedValue({ enabled: true, sessionId: session, version: 3, hasTheme: true, itemCount: 1, requests: [], results: {}, panel: null })
    e.api.design.snapshot.mockResolvedValue({ version: 3, sessionId: session, route: '/', viewport: { w: 900, h: 600, dpr: 1 }, items: [item] })
    await settle(e)

    expect(screen.getByRole('toolbar', { name: 'Design tools' }).textContent).toContain('1 change ready')
    expect(screen.getByRole('button', { name: /^design · 1/i })).toBeTruthy()
    const send = screen.getByRole('button', { name: 'Send 1' }) as HTMLButtonElement
    expect(send.disabled).toBe(false)
    fireEvent.click(send)
    expect(onSend).toHaveBeenCalledOnce()
  })

  it('re-seeds a page that came back unseeded after a reload', async () => {
    render(<DesignHarnessed project={makeProject('p1')} />)
    await settle(e)
    fireEvent.click(screen.getByRole('button', { name: /^design/i }))
    await settle(e)
    const session = (e.calls.find((c) => c.method === 'design.setEnabled')!.args[3] as { sessionId: string }).sessionId
    e.api.design.poll.mockResolvedValue({ enabled: true, sessionId: null, version: 0, hasTheme: false, itemCount: 0, requests: [], results: {}, panel: null })
    await settle(e)
    const seed = e.calls.find((c) => c.method === 'design.command' && (c.args[0] as { op: string }).op === 'seed')
    expect(seed?.args[0]).toEqual({ op: 'seed', sessionId: session, items: [] })
    // An unseeded page's snapshot must never replace the host's queue.
    expect(e.api.design.snapshot).not.toHaveBeenCalled()
  })

  it('ends the session when a deploy takes the preview away', async () => {
    const project = makeProject('p1')
    const { rerender } = render(<DesignHarnessed project={project} />)
    await settle(e)
    fireEvent.click(screen.getByRole('button', { name: /^design/i }))
    await settle(e)
    expect(screen.getByRole('toolbar', { name: 'Design tools' })).toBeTruthy()

    rerender(<DesignHarnessed project={project} deploy={{ running: true, log: [] }} />)
    await settle(e)
    expect(screen.queryByRole('toolbar', { name: 'Design tools' })).toBeNull()
    expect(e.calls.filter((c) => c.method === 'design.setEnabled').slice(-1)[0].args).toEqual([false])
  })

  it('keeps Design off during a temporary auto-deploy local preview', async () => {
    render(<DesignHarnessed project={makeProject('p1')} localPreviewUrl="http://localhost:5173" />)
    await settle(e)
    expect((screen.getByRole('button', { name: /^design/i }) as HTMLButtonElement).disabled).toBe(true)
  })

  it.each(['direct', 'fabric'] as const)(
    'enables Design on the manual-deploy local preview with %s selected',
    async (mode) => {
      const project =
        mode === 'fabric' ? fabricProject('p1') : makeProject('p1', { needsFabricPortal: true })
      const localPreviewUrl = 'http://localhost:5173'
      render(<DesignHarnessed project={project} localPreviewUrl={localPreviewUrl} manualDeploy />)
      await settle(e)

      const designBtn = screen.getByRole<HTMLButtonElement>('button', { name: /^design/i })
      expect(designBtn.disabled).toBe(false)
      expect(designBtn.title).not.toContain('unavailable')
      fireEvent.click(designBtn)
      await settle(e)

      const call = e.calls.find((c) => c.method === 'design.setEnabled')
      expect(call!.args.slice(0, 3)).toEqual([true, false, localPreviewUrl])
      expect(call!.args[3]).toMatchObject({ items: [], sessionId: expect.any(String) })
      expect(screen.getByRole('toolbar', { name: 'Design tools' })).toBeTruthy()
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Fabric' }).disabled).toBe(true)
    }
  )

  it('ends local Design when a manual redeploy starts', async () => {
    const props = {
      project: makeProject('p1'),
      localPreviewUrl: 'http://localhost:5173',
      manualDeploy: true
    }
    const { rerender } = render(<DesignHarnessed {...props} />)
    await settle(e)
    fireEvent.click(screen.getByRole('button', { name: /^design/i }))
    await settle(e)
    expect(screen.getByRole('toolbar', { name: 'Design tools' })).toBeTruthy()

    rerender(<DesignHarnessed {...props} deploy={{ running: true, log: [] }} />)
    await settle(e)
    expect(screen.queryByRole('toolbar', { name: 'Design tools' })).toBeNull()
    expect(e.calls.filter((c) => c.method === 'design.setEnabled').slice(-1)[0].args).toEqual([false])
  })

  it('ends local Design when a turn starts and offers it again once the turn finishes', async () => {
    const props = {
      project: makeProject('p1'),
      localPreviewUrl: 'http://localhost:5173',
      manualDeploy: true
    }
    const { rerender } = render(<DesignHarnessed {...props} />)
    await settle(e)
    fireEvent.click(screen.getByRole('button', { name: /^design/i }))
    await settle(e)
    expect(screen.getByRole('toolbar', { name: 'Design tools' })).toBeTruthy()

    // Copilot's edits change the local page mid-turn, so Design waits for the turn.
    rerender(<DesignHarnessed {...props} turnRunning />)
    await settle(e)
    expect(screen.queryByRole('toolbar', { name: 'Design tools' })).toBeNull()
    expect(e.calls.filter((c) => c.method === 'design.setEnabled').slice(-1)[0].args).toEqual([false])
    const designBtn = screen.getByRole<HTMLButtonElement>('button', { name: /^design/i })
    expect(designBtn.disabled).toBe(true)
    expect(designBtn.title).toContain('once this turn finishes')

    rerender(<DesignHarnessed {...props} />)
    await settle(e)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /^design/i }).disabled).toBe(false)
  })

  it('no longer renders an Annotate button (design mode replaced it)', async () => {
    render(<Harnessed project={makeProject('p1')} suppressed={false} />)
    await settle(e)
    expect(screen.queryByRole('button', { name: /annotate/i })).toBeNull()
  })
})

/** PreviewPane wired to a real Design session, the way the Workbench does it. */
function DesignHarnessed({
  project,
  deploy,
  localPreviewUrl,
  manualDeploy,
  turnRunning,
  local,
  onSend
}: {
  project: StudioProject
  deploy?: DeployUiState
  localPreviewUrl?: string | null
  manualDeploy?: boolean
  turnRunning?: boolean
  local?: LocalBackend
  onSend?: () => void
}): JSX.Element {
  const [surface, setSurface] = useState<DesignSurface | null>(null)
  const design = useDesignSession(project.id, surface)
  return (
    <OverlayProvider>
      <PreviewPane
        project={project}
        deploy={deploy}
        localPreviewUrl={localPreviewUrl}
        manualDeploy={manualDeploy}
        turnRunning={turnRunning}
        local={local}
        focused={false}
        onToggleFocus={() => {}}
        design={design}
        onDesignSend={onSend}
        onDesignSurface={setSurface}
      />
    </OverlayProvider>
  )
}

/** The last `showUrl(url, bounds)` call, with its position in the call log. */
function lastShowUrl(
  e: PreviewEnv
): { index: number; url: string; bounds: { width: number; height: number } } | null {
  for (let i = e.calls.length - 1; i >= 0; i--) {
    if (e.calls[i].method === 'showUrl') {
      const [url, bounds] = e.calls[i].args as [string, { width: number; height: number }]
      return { index: i, url, bounds }
    }
  }
  return null
}

const LOCAL_APP = 'http://localhost:5173/'
const LOCAL_EMBED = 'http://localhost:7171/.rayfin-local/portal/embed'

const localReady: LocalReady = {
  appUrl: LOCAL_APP,
  apiUrl: 'http://localhost:7171',
  embedUrl: LOCAL_EMBED,
  portalUrl: 'http://localhost:7171/.rayfin-local/portal',
  dataDir: null,
  signInAs: { kind: 'developer' },
  sdk: { version: '1.36.2', supported: true },
  features: {
    data: { enabled: true, entities: ['Note'] },
    functions: { enabled: false, names: [] },
    storage: { enabled: false, folders: [] },
    auth: { enabled: true, fabric: true, password: false },
    connectors: []
  },
  time: '2026-10-30T03:12:09.512Z'
}

function localProblem(code: string, details: LocalProblem['details'] = null): LocalProblem {
  return { code, message: `${code} happened.`, hint: null, fatal: true, details, time: null }
}

/** A project's local backend in the given state, its actions recorded. */
function localBackend(patch: Partial<LocalStatus>): LocalBackend {
  const status: LocalStatus = {
    projectId: 'p1',
    state: 'stopped',
    revision: 1,
    phase: null,
    pid: null,
    version: null,
    projectRoot: null,
    signInAs: null,
    ready: null,
    analysis: null,
    schema: null,
    functions: null,
    vite: null,
    config: null,
    warnings: [],
    error: null,
    stopped: null,
    crashes: 0,
    startedAt: null,
    updatedAt: null,
    ...patch
  }
  const action = (): LocalBackend['start'] => vi.fn(async () => status)
  return {
    status,
    state: status.state,
    ready: status.ready,
    error: status.state === 'error' ? status.error : null,
    busy: false,
    actionError: null,
    start: action(),
    stop: action(),
    restart: action(),
    refresh: action(),
    applySchemaChange: action(),
    resetData: action(),
    stopOtherServe: action(),
    installPackages: action()
  }
}

const runningLocally = (patch: Partial<LocalStatus> = {}): LocalBackend =>
  localBackend({ state: 'running', ready: localReady, ...patch })

/** PreviewPane for a personal app on its local backend, the way the Workbench wires it. */
function OnThisComputer({
  project,
  local,
  view,
  onViewChange,
  deploy,
  onDiagnoseLocal,
  onOpenSetup,
  onReviewSchema,
  turnRunning
}: {
  project: StudioProject
  /** Absent once the app no longer runs on this computer. */
  local?: LocalBackend
  view?: PreviewView
  onViewChange?: (view: PreviewView) => void
  deploy?: DeployUiState
  onDiagnoseLocal?: () => void
  onOpenSetup?: () => void
  onReviewSchema?: () => void
  turnRunning?: boolean
}): JSX.Element {
  return (
    <OverlayProvider>
      <PreviewPane
        project={project}
        deploy={deploy}
        local={local}
        view={view}
        onViewChange={onViewChange}
        onDiagnoseLocal={onDiagnoseLocal}
        onOpenSetup={onOpenSetup}
        onReviewSchema={onReviewSchema}
        turnRunning={turnRunning}
        focused={false}
        onToggleFocus={() => {}}
        onWatchChange={() => {}}
        deploymentName="Production"
      />
    </OverlayProvider>
  )
}

describe('PreviewPane on this computer', () => {
  const INFO = 'About Local and Published'
  const outputLine: LocalLogEvent = {
    projectId: 'p1',
    seq: 1,
    source: 'vite',
    level: 'info',
    line: 'page reload src/App.tsx',
    time: '2026-10-30T03:12:09.512Z'
  }

  beforeEach(() => {
    localStorage.clear()
    Object.assign(window.api, {
      local: {
        logs: vi.fn(async () => [outputLine]),
        onLog: vi.fn(() => () => {}),
        // Preview as, in the toolbar while the app runs here.
        onState: vi.fn(() => () => {}),
        identity: vi.fn(async () => ({ kind: 'developer', user: null })),
        users: vi.fn(async () => [])
      }
    })
  })

  it('shows a new app running on this computer, with nothing published to switch to', async () => {
    render(
      <OnThisComputer
        project={makeProject('p1', { lastDeploy: undefined })}
        local={runningLocally()}
      />
    )
    await settle(e)
    expect(lastShowUrl(e)?.url).toBe(LOCAL_APP)
    expect(screen.getByRole('button', { name: 'localhost:5173' })).toBeTruthy()
    expect(screen.queryByRole('group', { name: 'App to show' })).toBeNull()
    expect(screen.queryByText(/Choose where to deploy/)).toBeNull()
    expect(screen.queryByRole('button', { name: INFO })).toBeNull()
    // Running fine, the app on screen says so: no Fabric view and no status words.
    expect(screen.queryByRole('button', { name: 'Fabric' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Output: Running' }).textContent).toBe('')
  })

  it('shows a starting app, not a stopped one, until its backend reports in', async () => {
    const project = makeProject('p1', { lastDeploy: undefined })
    const unknown: LocalBackend = { ...localBackend({ state: 'stopped' }), status: null }
    const { rerender } = render(<OnThisComputer project={project} local={unknown} />)
    await settle(e)
    expect(screen.getByRole('status').textContent).toContain('Starting…')
    expect(screen.getByRole('button', { name: 'Output: Starting…' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull()

    const stopped = localBackend({ state: 'stopped' })
    rerender(<OnThisComputer project={project} local={stopped} />)
    expect(screen.getByRole('button', { name: 'Output: Stopped' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await act(async () => {})
    expect(stopped.start).toHaveBeenCalledTimes(1)
  })

  it('says what the app is doing while it starts, and loads its page again after a restart', async () => {
    const project = makeProject('p1', { lastDeploy: undefined })
    const pane = (local: LocalBackend): JSX.Element => (
      <OnThisComputer project={project} local={local} />
    )
    const { rerender } = render(pane(localBackend({ state: 'starting', phase: 'analysis' })))
    await settle(e)
    expect(screen.getByRole('status').textContent).toContain('Reading your app’s data model')
    expect(screen.getByRole('button', { name: 'Output: Starting…' })).toBeTruthy()
    expect(e.api.showUrl).not.toHaveBeenCalled()

    rerender(pane(runningLocally()))
    await settle(e)
    expect(lastShowUrl(e)?.url).toBe(LOCAL_APP)

    rerender(pane(localBackend({ state: 'restarting', error: localProblem('exited') })))
    await settle(e)
    expect(screen.getByRole('status').textContent).toContain(
      'It stopped unexpectedly, so Fabricator is starting it again.'
    )
    const mark = e.calls.length
    rerender(pane(runningLocally()))
    await settle(e)
    const nav = e.calls.slice(mark).find((c) => c.method === 'navigate')
    expect(nav?.args[0], 'its dev server restarted under it').toBe(LOCAL_APP)
  })

  it.each([
    ['packages-missing', 'Install dependencies', 'installPackages', { dir: 'rayfin/functions' }],
    ['already-serving', 'Stop the other one', 'stopOtherServe', { pid: 4242 }]
  ] as const)(
    'offers what %s needs, beside Try again, View output and Find out why',
    async (code, label, action, details) => {
      const local = localBackend({ state: 'error', error: localProblem(code, details) })
      const onDiagnoseLocal = vi.fn()
      render(
        <OnThisComputer
          project={makeProject('p1')}
          local={local}
          onDiagnoseLocal={onDiagnoseLocal}
        />
      )
      await settle(e)
      const card = screen.getByRole('alert')
      fireEvent.click(within(card).getByRole('button', { name: label }))
      await act(async () => {})
      expect(local[action]).toHaveBeenCalledTimes(1)
      fireEvent.click(within(card).getByRole('button', { name: 'Try again' }))
      await act(async () => {})
      expect(local.restart).toHaveBeenCalledTimes(1)
      fireEvent.click(within(card).getByRole('button', { name: 'Find out why' }))
      expect(onDiagnoseLocal).toHaveBeenCalledTimes(1)
      fireEvent.click(within(card).getByRole('button', { name: 'View output' }))
      await act(async () => {})
      expect(
        within(screen.getByRole('region', { name: 'Output' })).getByText(outputLine.line)
      ).toBeTruthy()
    }
  )

  it('sends a refused data model change to its dialog, and Node.js problems to setup', async () => {
    const onReviewSchema = vi.fn()
    const onOpenSetup = vi.fn()
    const pane = (local: LocalBackend): JSX.Element => (
      <OnThisComputer
        project={makeProject('p1', { lastDeploy: undefined })}
        local={local}
        onReviewSchema={onReviewSchema}
        onOpenSetup={onOpenSetup}
      />
    )
    const losses = ['Note.title (3 values)']
    const { rerender } = render(
      pane(localBackend({ state: 'error', error: localProblem('schema-refused', { losses }) }))
    )
    await settle(e)
    expect(screen.getByRole('alert', { name: 'This change would delete local data' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Review the change' }))
    expect(onReviewSchema).toHaveBeenCalledTimes(1)

    rerender(
      pane(
        localBackend({
          state: 'error',
          error: localProblem('node-too-old', { version: 'v18.19.0' })
        })
      )
    )
    expect(screen.getByRole('alert', { name: 'Node.js needs an update' }).textContent).toContain(
      'this computer has v18.19.0'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Set up Node.js' }))
    expect(onOpenSetup).toHaveBeenCalledTimes(1)

    // Refused while running, the change leaves the app on screen, and a note to decide.
    const schema = {
      result: 'refused' as const,
      changes: [],
      losses,
      message: null,
      live: true,
      time: null
    }
    rerender(pane(runningLocally({ schema })))
    await settle(e)
    expect(lastShowUrl(e)?.url).toBe(LOCAL_APP)
    const note = screen.getByRole('region', { name: 'Data model change waiting' })
    fireEvent.click(within(note).getByRole('button', { name: 'Review the change' }))
    expect(onReviewSchema).toHaveBeenCalledTimes(2)
  })

  it('offers Preview as while the app runs here, but not during a turn', async () => {
    const project = makeProject('p1', { lastDeploy: undefined })
    const view = render(<OnThisComputer project={project} local={runningLocally()} />)
    await settle(e)
    await act(async () => {})
    expect(screen.getByRole('button', { name: /^Preview as/ })).toBeTruthy()
    view.rerender(<OnThisComputer project={project} local={runningLocally()} turnRunning />)
    expect(screen.queryByRole('button', { name: /^Preview as/ })).toBeNull()
  })

  it('opens and closes the output from the Output button', async () => {
    render(
      <OnThisComputer
        project={makeProject('p1', { lastDeploy: undefined })}
        local={runningLocally()}
      />
    )
    await settle(e)
    const output = screen.getByRole('button', { name: 'Output: Running' })
    fireEvent.click(output)
    await act(async () => {})
    expect(output.getAttribute('aria-pressed')).toBe('true')
    expect(
      within(screen.getByRole('region', { name: 'Output' })).getByText(outputLine.line)
    ).toBeTruthy()
    expect(window.api.local.logs).toHaveBeenCalledWith('p1', 500)
    fireEvent.click(output)
    expect(screen.queryByRole('region', { name: 'Output' })).toBeNull()
  })

  it('says when the app runs with a problem, and restarts it from its output', async () => {
    const project = makeProject('p1', { lastDeploy: undefined })
    const healthy = runningLocally()
    const { rerender } = render(<OnThisComputer project={project} local={healthy} />)
    await settle(e)
    fireEvent.click(screen.getByRole('button', { name: 'Output: Running' }))
    await act(async () => {})
    const output = (): HTMLElement => screen.getByRole('region', { name: 'Output' })
    expect(within(output()).queryByRole('list', { name: 'Problems' })).toBeNull()
    expect(within(output()).getByRole('button', { name: 'Restart' })).toBeTruthy()

    // A rayfin.yml change turned data on before the data package was built.
    const stuck = runningLocally({
      analysis: {
        ok: false,
        sdk: null,
        entities: [],
        storageFolders: [],
        message: 'The data package packages/data has not been built',
        time: null
      }
    })
    rerender(<OnThisComputer project={project} local={stuck} />)
    const button = screen.getByRole('button', { name: 'Output: 1 problem' })
    expect(button.className).toContain('local-output-btn--warn')
    expect(button.textContent).toBe('1 problem')
    expect(button.title).toBe(
      'Your app’s latest data model change couldn’t be read, so it still uses the previous data model. The data package packages/data has not been built. Select to hide its output.'
    )
    const problems = within(output()).getByRole('list', { name: 'Problems' })
    expect(problems.textContent).toContain(
      'Your app’s latest data model change couldn’t be read, so it still uses the previous data model.'
    )
    expect(problems.textContent).toContain('The data package packages/data has not been built')

    fireEvent.click(within(output()).getByRole('button', { name: 'Restart' }))
    await act(async () => {})
    expect(stuck.restart).toHaveBeenCalledTimes(1)
    expect(healthy.restart).not.toHaveBeenCalled()
  })

  it('drops the app’s local address once it no longer runs on this computer', async () => {
    const project = makeProject('p1', { lastDeploy: undefined })
    const { rerender } = render(<OnThisComputer project={project} local={runningLocally()} />)
    await settle(e)
    expect(screen.getByRole('button', { name: 'localhost:5173' })).toBeTruthy()

    rerender(<OnThisComputer project={project} />)
    await settle(e)
    expect(screen.getByText(/Your published app will render here/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'localhost:5173' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Output/ })).toBeNull()
  })

  it('switches between the app on this computer and the published one, in Fabric only there', async () => {
    const onViewChange = vi.fn()
    // An app that offers the Fabric view, with it on: only its published app has it.
    const project = fabricProject('p1')
    const pane = (view: PreviewView): JSX.Element => (
      <OnThisComputer
        project={project}
        local={runningLocally()}
        view={view}
        onViewChange={onViewChange}
      />
    )
    const { rerender } = render(pane('local'))
    await settle(e)
    expect(lastShowUrl(e)?.url, 'the app on this computer, never a Fabric host').toBe(LOCAL_APP)
    expect(e.calls.some((c) => c.args.includes(LOCAL_EMBED))).toBe(false)
    expect(screen.queryByRole('button', { name: 'Fabric' })).toBeNull()
    expect(screen.getByRole('button', { name: /^Preview as/ })).toBeTruthy()
    const views = screen.getByRole('group', { name: 'App to show' })
    expect(within(views).getByRole('button', { name: 'Local' }).getAttribute('aria-pressed')).toBe(
      'true'
    )
    fireEvent.click(within(views).getByRole('button', { name: 'Published' }))
    expect(onViewChange).toHaveBeenCalledWith('published')

    const mark = e.calls.length
    rerender(pane('published'))
    await settle(e)
    const nav = e.calls.slice(mark).find((c) => c.method === 'navigate')
    expect(nav?.args[0]).toBe(project.lastDeploy?.portalUrl)
    expect(screen.getByRole('button', { name: 'Fabric' }).className).toContain('seg-btn--on')
    expect(screen.queryByRole('button', { name: /^Output/ })).toBeNull()
  })

  it.each([
    ['a new app', makeProject('p1', { lastDeploy: undefined })],
    ['one in the Fabric view when published', fabricProject('p1')]
  ] as const)(
    'offers Design on the app on this computer (%s) whenever no turn runs, even while publishing',
    async (_, project) => {
      const design = (): HTMLButtonElement => screen.getByRole('button', { name: /^design/i })
      const { rerender } = render(
        <DesignHarnessed project={project} local={runningLocally()} turnRunning />
      )
      await settle(e)
      expect(design().disabled).toBe(true)
      expect(design().title).toContain('once this turn finishes')

      const publishing = { running: true, log: [], startedAt: Date.now() }
      rerender(<DesignHarnessed project={project} local={runningLocally()} deploy={publishing} />)
      await settle(e)
      expect(design().disabled).toBe(false)
      fireEvent.click(design())
      await settle(e)
      const call = e.calls.find((c) => c.method === 'design.setEnabled')
      expect(call?.args.slice(0, 3)).toEqual([true, false, LOCAL_APP])
    }
  )

  it('points out, beside Local and Published, that a previously published app’s local data starts empty', async () => {
    const onViewChange = vi.fn()
    const first = render(
      <OnThisComputer
        project={makeProject('p1')}
        local={runningLocally()}
        view="local"
        onViewChange={onViewChange}
      />
    )
    await settle(e)
    // No banner over the app: the info button stands out instead.
    expect(document.querySelector('.local-note')).toBeNull()
    const info = screen.getByRole('button', { name: INFO })
    expect(info.className).toContain('is-fresh')
    fireEvent.click(info)
    const note = screen.getByRole('dialog', { name: 'Project p1 runs in two places' })
    expect(note.textContent).toContain(
      'Local is your app on this computer, with its own data, apart from the published app’s. That data starts empty.'
    )
    expect(note.textContent).toContain(
      'Published is your app on Microsoft Fabric, with its data. Your changes reach it when you publish them.'
    )
    expect(info.className).not.toContain('is-fresh')
    // A press elsewhere puts it away.
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
    first.unmount()

    const again = render(
      <OnThisComputer
        project={makeProject('p1')}
        local={runningLocally()}
        view="local"
        onViewChange={onViewChange}
      />
    )
    expect(screen.getByRole('button', { name: INFO }).className, 'seen for this app').not.toContain(
      'is-fresh'
    )
    fireEvent.click(screen.getByRole('button', { name: INFO }))
    expect(screen.getByRole('dialog').textContent).not.toContain('starts empty')
    again.unmount()

    // Looking at the published app is as good as reading the note.
    render(
      <OnThisComputer
        project={makeProject('p2')}
        local={runningLocally({ projectId: 'p2' })}
        view="local"
        onViewChange={onViewChange}
      />
    )
    expect(screen.getByRole('button', { name: INFO }).className).toContain('is-fresh')
    fireEvent.click(screen.getByRole('button', { name: 'Published' }))
    expect(onViewChange).toHaveBeenLastCalledWith('published')
    expect(screen.getByRole('button', { name: INFO }).className).not.toContain('is-fresh')
  })

  it('never points it out for an app that ran here before it was published', async () => {
    const pane = (project: StudioProject): JSX.Element => (
      <OnThisComputer project={project} local={runningLocally()} view="local" />
    )
    const { rerender } = render(pane(makeProject('p1', { lastDeploy: undefined })))
    await settle(e)
    rerender(pane(makeProject('p1')))
    await settle(e)
    expect(screen.getByRole('group', { name: 'App to show' })).toBeTruthy()
    expect(screen.getByRole('button', { name: INFO }).className).not.toContain('is-fresh')
  })

  it('keeps the app on this computer through a first publish, and leaves it be after', async () => {
    const project = makeProject('p1', { lastDeploy: undefined })
    const pane = (deploy: DeployUiState): JSX.Element => (
      <OnThisComputer project={project} local={runningLocally()} deploy={deploy} />
    )
    const { rerender } = render(pane({ running: true, log: [], startedAt: Date.now() }))
    await settle(e)
    expect(screen.getByText('Publishing to Production')).toBeTruthy()
    expect(screen.queryByText(/Fabricating/i), 'no full screen for a first publish').toBeNull()
    expect(lastShowUrl(e)?.url).toBe(LOCAL_APP)

    const mark = e.calls.length
    rerender(pane({ running: false, log: [], result: { ok: true, outcome: 'success' } }))
    await settle(e)
    expect(e.methodsAfter(mark)).not.toContain('reload')
    expect(e.methodsAfter(mark)).not.toContain('navigate')
  })

  it('says why a published app previews on its published backend', async () => {
    const reason =
      'The logs connector runs only on Fabric, so the preview uses your published app’s backend.'
    render(
      <OverlayProvider>
        <PreviewPane
          project={makeProject('p1')}
          deploy={undefined}
          fallbackReason={reason}
          focused={false}
          onToggleFocus={() => {}}
        />
      </OverlayProvider>
    )
    await settle(e)
    expect(screen.getByRole('region', { name: 'Preview backend' }).textContent).toBe(reason)
    expect(lastShowUrl(e)?.url).toBe('https://p1.example.app/')
    expect(screen.queryByRole('group', { name: 'App to show' })).toBeNull()
  })
})
