import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { StudioProject } from '@shared/ipc'
import { OverlayProvider, SuppressPreview } from '../overlay'
import { useDesignSession, type DesignSurface } from '../design/useDesignSession'
import PreviewPane, { type DeployUiState, __resetPreviewSurfaceState } from './PreviewPane'
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
  onRefreshAuth,
  authBusy
}: {
  project: StudioProject
  suppressed: boolean
  deploy?: DeployUiState
  localPreviewUrl?: string | null
  onRefreshAuth?: () => void
  authBusy?: boolean
}): JSX.Element {
  return (
    <OverlayProvider>
      {suppressed && <SuppressPreview />}
      <PreviewPane
        project={project}
        deploy={deploy}
        onRefreshAuth={onRefreshAuth}
        authBusy={authBusy}
        localPreviewUrl={localPreviewUrl}
        focused={false}
        onToggleFocus={() => {}}
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
  it('keeps failed redeploy diagnostics and recovery accessible beside a live preview', async () => {
    const project = makeProject('p1')
    const onRefreshAuth = vi.fn()
    const log = 'Build succeeded\nError: Could not acquire the token-cache lock\n'
    const deploy: DeployUiState = {
      running: false,
      log: [log],
      result: { ok: false, outcome: 'auth-cache-error', error: 'Refresh is needed' }
    }
    render(<Harnessed project={project} suppressed={false} deploy={deploy} onRefreshAuth={onRefreshAuth} />)
    await settle(e)
    expect(screen.getByRole('alert').textContent).toBe('Refresh is needed')
    expect(screen.getByText('View deploy logs')).toBeTruthy()
    fireEvent.click(screen.getByText('View deploy logs'))
    expect(screen.getByText(/Build succeeded/).textContent).toBe(log)
    expect(e.api.showUrl).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Fabric authentication' }))
    expect(onRefreshAuth).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Troubleshoot deploys' }))
    const { openExternal } = (window as unknown as { api: { openExternal: ReturnType<typeof vi.fn> } }).api
    expect(openExternal).toHaveBeenCalledWith(
      'https://spatney.github.io/rayfin-fabricator/docs/troubleshooting/deploy#a-deploy-failed'
    )
  })

  it('shows a first-deploy IPC error even before project state has refreshed', async () => {
    const project = { ...makeProject('p1'), lastDeploy: undefined }
    render(
      <Harnessed
        project={project}
        suppressed={false}
        deploy={{ running: false, log: [], result: { ok: false, outcome: 'error', error: 'Deploy process disconnected' } }}
      />
    )
    expect(screen.getByRole('alert').textContent).toBe('Deploy process disconnected')
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

  it('says Live for a solo app, and names which deployment a team app shows', async () => {
    const { rerender } = render(pane())
    await settle(e)
    expect(screen.getByText('Live')).toBeTruthy()

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
    expect(screen.getByText('Local')).toBeTruthy()
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
    expect(screen.getByText('Local')).toBeTruthy()
  })

  it('lets a running deploy override the local preview (DeployStage wins)', async () => {
    render(
      <Harnessed
        project={makeProject('p1')}
        suppressed={false}
        deploy={{ running: true, log: [] }}
        localPreviewUrl={LOCAL}
      />
    )
    await settle(e)

    // The deploy stage takes the surface; the local URL is never shown, and no
    // "Local" badge appears while deploying.
    expect(screen.getByText(/Fabricating/i)).toBeTruthy()
    expect(screen.queryByText('Local')).toBeNull()
    const shownLocal = e.calls.some((c) => c.method === 'showUrl' && c.args[0] === LOCAL)
    expect(shownLocal, 'the local URL must not be shown while a deploy is running').toBe(false)
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
})

/** A Fabric-view project fixture: a direct app URL plus the portal deep link. */
function fabricProject(id = 'p1'): StudioProject {
  return makeProject(id, {
    previewMode: 'fabric',
    lastDeploy: {
      url: `https://${id}.example.app/`,
      status: 'success',
      portalUrl: `https://app.fabric.microsoft.com/groups/ws/appbackends/${id}`
    }
  })
}

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
    expect((screen.getByRole('button', { name: /fabric/i }) as HTMLButtonElement).disabled).toBe(true)
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
    expect(e.calls.filter((c) => c.method === 'design.setEnabled').at(-1)!.args).toEqual([false])
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
    expect(e.calls.filter((c) => c.method === 'design.setEnabled').at(-1)!.args).toEqual([false])
  })

  it('keeps Design off while the live local preview is showing', async () => {
    render(<DesignHarnessed project={makeProject('p1')} localPreviewUrl="http://localhost:5173" />)
    await settle(e)
    expect((screen.getByRole('button', { name: /^design/i }) as HTMLButtonElement).disabled).toBe(true)
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
  onSend
}: {
  project: StudioProject
  deploy?: DeployUiState
  localPreviewUrl?: string | null
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
