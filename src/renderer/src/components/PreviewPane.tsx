import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  DeployResult,
  PreviewBounds,
  PreviewDesignAiRequest,
  PreviewDesignAiEditRequest,
  PreviewDesignHandoff,
  PreviewDesignRestylePatch,
  PreviewDesignTheme,
  PreviewMode,
  StudioProject
} from '@shared/ipc'
import { loadCopilotModels, pickFastModel, isFastModel } from '../copilotModels'
import { usePreviewSuppressed, useSuppressPreview } from '../overlay'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  ReloadIcon,
  FabricIcon,
  GlobeIcon,
  CheckIcon,
  OpenExternalIcon,
  DesignIcon,
  ExpandIcon,
  CollapseIcon
} from './icons'
import DeployStage from './DeployStage'

export interface DeployUiState {
  running: boolean
  log: string[]
  result?: DeployResult
}

/**
 * A highlighted screenshot pending attachment to the next chat message. Produced
 * by design mode's "Send to chat" hand-off (a capture of the preview with the
 * changed elements ringed), and consumed by the chat composer.
 */
export interface PendingShot {
  /** Absolute temp-file path passed to copilot as `--attachment`. */
  path: string
  /** Data URL used only to render a thumbnail in the UI. */
  thumb: string
}

/** localStorage key persisting the design-mode AI model choice across sessions. */
const DESIGN_MODEL_KEY = 'rayfin.design.aiModel'

/**
 * Read Fabricator's own theme (accent / surfaces / text / border) + UI zoom from
 * the renderer's CSS tokens so the in-preview design tools can match the host
 * app's look and scale (the tools are Fabricator UI, not the previewed app's).
 * Falls back to the dark-teal defaults if a token is missing.
 */
function readFabricatorTheme(): PreviewDesignTheme {
  const cs = getComputedStyle(document.documentElement)
  const v = (n: string): string => cs.getPropertyValue(n).trim()
  const scale = Number(v('--ui-scale') || document.documentElement.style.zoom) || 1
  return {
    accent: v('--accent') || '#34b4ba',
    accentHi: v('--accent-2') || undefined,
    panel: v('--bg-elev') || '#12161f',
    panel2: v('--bg-elev-2') || undefined,
    border: v('--border') || undefined,
    txt: v('--text') || '#eceff5',
    txtDim: v('--text-dim') || undefined,
    scale
  }
}

/** How long the frozen still-frame lingers as a backstop after the native preview
 *  is revealed again (an overlay closed). The live surface is opaque and paints
 *  above the HTML, so an identical still underneath is invisible — this only has
 *  to outlast the surface's on-screen reposition/present so the HTML→native
 *  handoff never flashes a bare host. */
const FROZEN_CLEAR_MS = 150

/** Duration of the project-load overlay's fade-out. MUST match the CSS opacity
 *  transition on `.project-loading`. */
const FADE_MS = 260

/** Minimum time the "Loading <project>…" overlay stays up (from the start of a
 *  transition to the reveal), so a fast switch doesn't blink it in and out. */
const MIN_LOADING_MS = 400

/** The URL the singleton native preview surface was last revealed at. Tracked at
 *  MODULE scope because the surface persists (parked, still rendering) across
 *  PreviewPane unmounts — a Build→Code/Model/Advisor tab switch unmounts the pane
 *  but keeps the OS webview alive. So a *fresh mount* can face a surface still
 *  showing a different project. Used to decide the first-load path:
 *    • `null`            → no surface yet (true first load)   → direct show.
 *    • same as previewUrl → Build-tab re-entry, same project  → pure re-show.
 *    • different url      → switched project while on another → run a load
 *      transition (park + navigate + reveal-on-load) so the "Loading…" overlay
 *      shows and the previous project's frame never flashes. */
let surfaceShownUrl: string | null = null

/** Test-only: clear the module-scoped surface tracking so each test starts as a
 *  fresh app with no preview surface shown. */
export function __resetPreviewSurfaceState(): void {
  surfaceShownUrl = null
}

interface Props {
  project: StudioProject
  deploy: DeployUiState | undefined
  /** True when the preview pane is expanded to fill the build view (chat hidden). */
  focused: boolean
  /** Toggle preview focus (full-width preview ⇄ split with chat). */
  onToggleFocus: () => void
  /** Notify the parent that the persisted preview mode changed (so it can refresh
   *  project state — the selection lives on the project, store-backed). */
  onPreviewModeChanged?: () => void
  /** Hand a composed design-mode instruction (+ optional highlighted screenshot)
   *  to the chat composer for review. Fired when the user hits "Send to chat". */
  onDesignHandoff?: (instruction: string, shot?: PendingShot) => void
  /** Report the project-load overlay state so the parent can render a centered
   *  "Loading <name>…" over the whole build view (a project switch reloads the
   *  chat + preview, so the indicator belongs at the content level, not the
   *  preview pane). `null` when not loading. */
  onLoadingChange?: (state: { name: string; fading: boolean } | null) => void
  /** Live local preview (experiment): the `localhost` URL of the project's running
   *  Vite dev server, or null/undefined when none. When set (and no deploy is
   *  running), the preview surface shows this instead of the deployed app, with a
   *  "Local" badge. See {@link RayfinStudioApi.dev}. */
  localPreviewUrl?: string | null
}

function statusLabel(running: boolean, status: string | undefined): string {
  if (running) return 'Deploying…'
  switch (status) {
    case 'success':
      return 'Live'
    case 'error':
      return 'Deploy failed'
    case 'deploying':
      return 'Deploying…'
    default:
      return 'Not deployed'
  }
}

/** This project's persisted preview view (defaults to the direct app URL). The
 *  selection lives on the project (store-backed) — not just renderer state — so
 *  the Fabricator agent's screenshot/navigate tools honour the same view. */
function readPreviewMode(project: StudioProject): PreviewMode {
  return project.previewMode === 'fabric' ? 'fabric' : 'direct'
}

/** Host-only label for the toolbar URL (the full URL stays in the tooltip). */
function prettyUrl(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/** Downscale a PNG `data:` URL to a small thumbnail data URL for a chat chip.
 *  Falls back to the original URL if the image can't be decoded. */
function makeThumbFromDataUrl(dataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const maxW = 176
      const scale = Math.min(1, maxW / (img.naturalWidth || maxW))
      const w = Math.max(1, Math.round((img.naturalWidth || maxW) * scale))
      const hgt = Math.max(1, Math.round((img.naturalHeight || maxW) * scale))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = hgt
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve(dataUrl)
        return
      }
      ctx.drawImage(img, 0, 0, w, hgt)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => resolve(dataUrl)
    img.src = dataUrl
  })
}

export default function PreviewPane({
  project,
  deploy,
  focused,
  onToggleFocus,
  onPreviewModeChanged,
  onDesignHandoff,
  onLoadingChange,
  localPreviewUrl
}: Props): JSX.Element {
  const suppressed = usePreviewSuppressed()
  const running = deploy?.running ?? false
  const deployedUrl = project.lastDeploy?.url
  // The deployed item can also be viewed embedded in the Fabric portal shell
  // (`…/groups/{workspace}/appbackends/{item}`). The CLI hands us that deep link
  // as `lastDeploy.portalUrl`; a toolbar toggle switches the webview between the
  // direct app URL and this Fabric-hosted view.
  const fabricUrl = project.lastDeploy?.portalUrl
  const status = running ? 'deploying' : project.lastDeploy?.status
  const error = project.lastDeploy?.error
  // The first deploy of a project has no recorded Fabric workspace — surface a
  // prompt instead of a dead error so the user can pick a target and retry.
  const outcome = deploy?.result?.outcome ?? project.lastDeploy?.outcome
  const needsWorkspace = !running && outcome === 'needs-workspace'

  const hostRef = useRef<HTMLDivElement>(null)
  const prevRunningRef = useRef(running)
  const [displayUrl, setDisplayUrl] = useState(deployedUrl ?? '')
  const [loading, setLoading] = useState(false)
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)
  // While an HTML overlay suppresses the native preview, `frozen` holds a PNG of
  // the last visible frame so the placeholder shows that still image, not black.
  const [frozen, setFrozen] = useState<string | null>(null)
  // While a load transition is in flight, `loaderVisible` keeps the (Workbench-
  // level, centered) loading overlay mounted; `loaderOut` fades it out over the
  // reveal. Reported to the parent via `onLoadingChange`.
  const [loaderVisible, setLoaderVisible] = useState(false)
  const [loaderOut, setLoaderOut] = useState(false)

  // While a fresh page load is in flight (a redeploy, a deployment / project
  // switch, or the Fabric toggle) we hide the native webview and show a spinner,
  // so the user never sees the stale old app flash before the new one paints.
  //   • `transitioning` (state) drives the re-render / spinner / hide gate.
  //   • `transitioningRef` is the synchronous truth the positioning effect reads,
  //     so it never shows during the same commit a switch begins.
  //   • `pendingUrlRef` is the URL currently loading; `loadedUrlRef` is the URL
  //     the webview already has revealed — a re-show at the same URL (e.g. after
  //     an overlay closes) is then a pure show, never a reload.
  //   • `sawLoadingRef` gates the reveal on the new load actually starting.
  const [transitioning, setTransitioning] = useState(false)
  const transitioningRef = useRef(false)
  const pendingUrlRef = useRef<string | null>(null)
  const loadedUrlRef = useRef<string | null>(null)
  const sawLoadingRef = useRef(false)
  // The last real (on-screen) bounds the surface was shown at. On unmount (a tab
  // switch to Code/Model/Advisor, or teardown) we park it off-screen at this size
  // — keeping it rendering — so returning to Build is a flash-free pure move
  // rather than a hide→show repaint. `null` until first shown (hard-hide then).
  const lastBoundsRef = useRef<PreviewBounds | null>(null)
  const watchdogRef = useRef<number | null>(null)
  // Bumped whenever a new transition starts; a running reveal/dissolve sequence
  // checks it after each await and bails if a newer transition superseded it.
  const revealTokenRef = useRef(0)
  // Timestamp (ms) the current transition started, so the reveal can enforce a
  // minimum "Loading…" beat (see MIN_LOADING_MS) and not blink the overlay away.
  const transitionStartRef = useRef(0)

  const clearWatchdog = useCallback((): void => {
    if (watchdogRef.current !== null) {
      window.clearTimeout(watchdogRef.current)
      watchdogRef.current = null
    }
  }, [])

  // Reveal sequence for a finished load. The new page rendered OFF-SCREEN (parked)
  // while the loading overlay was up; a project switch / redeploy needs no
  // screenshot of the old page — we keep the loading overlay up for a minimum beat,
  // then reveal the live webview (now painted) and fade the overlay out over it.
  // `revealTokenRef` aborts the sequence if a newer transition supersedes it.
  const revealSeq = useCallback(async (): Promise<void> => {
    const token = revealTokenRef.current
    // Keep the "Loading <project>…" overlay up for a minimum beat so a fast switch
    // doesn't blink it in and out — a deliberate loading moment reads smoother.
    const elapsed = performance.now() - transitionStartRef.current
    if (elapsed < MIN_LOADING_MS) {
      await new Promise<void>((r) => window.setTimeout(r, MIN_LOADING_MS - elapsed))
      if (token !== revealTokenRef.current) return
    }
    // Reveal the live webview (positioning effect) and fade the loading overlay out
    // over it; the overlay stays mounted through the fade to cover the handoff.
    transitioningRef.current = false
    setTransitioning(false)
    setLoaderOut(true)
    await new Promise<void>((r) => window.setTimeout(r, FADE_MS))
    if (token !== revealTokenRef.current) return
    setLoaderVisible(false)
    setLoaderOut(false)
  }, [])

  // A finished load reveals the webview via the sequence above. Records the loaded
  // URL and clears the pending/loading bookkeeping first.
  const endTransition = useCallback((): void => {
    if (pendingUrlRef.current) loadedUrlRef.current = pendingUrlRef.current
    pendingUrlRef.current = null
    sawLoadingRef.current = false
    clearWatchdog()
    void revealSeq()
  }, [clearWatchdog, revealSeq])

  // Begin hiding the preview for a fresh load of `url`; the caller then triggers
  // the actual load (reload() for a redeploy, navigate() for a switch). A watchdog
  // reveals anyway if the load never reports completion, so we never stay blank.
  const beginTransition = useCallback(
    (url: string): void => {
      revealTokenRef.current += 1 // cancel any in-flight reveal/dissolve sequence
      transitionStartRef.current = performance.now()
      pendingUrlRef.current = url
      sawLoadingRef.current = false
      transitioningRef.current = true
      setTransitioning(true)
      setLoaderVisible(true)
      setLoaderOut(false)
      clearWatchdog()
      watchdogRef.current = window.setTimeout(() => {
        watchdogRef.current = null
        endTransition()
      }, 12000)
    },
    [clearWatchdog, endTransition]
  )

  const measureHost = useCallback((): PreviewBounds | null => {
    const host = hostRef.current
    if (!host) return null
    const r = host.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return null
    return { x: r.left, y: r.top, width: r.width, height: r.height }
  }, [])

  // Which URL the embedded webview actually loads. Falls back to the direct URL
  // whenever the Fabric link is unavailable or the toggle is off.
  const [previewMode, setPreviewMode] = useState<PreviewMode>(() => readPreviewMode(project))
  // Toolbar URL dropdown (switch between the Fabric portal view and the direct
  // app URL). It's an HTML overlay, so it must freeze the native preview to show.
  const [urlMenuOpen, setUrlMenuOpen] = useState(false)
  useSuppressPreview(urlMenuOpen)
  const deployedPreviewUrl = previewMode === 'fabric' && fabricUrl ? fabricUrl : deployedUrl
  // Live local preview (experiment): while a Vite dev server is running for this
  // project, the surface shows its localhost URL instead of the deployed app. A
  // running deploy still wins (DeployStage), so this only applies mid-turn.
  const isLocal = Boolean(localPreviewUrl) && !running
  const previewUrl = isLocal ? (localPreviewUrl as string) : deployedPreviewUrl
  const showWebview = !running && Boolean(previewUrl)

  // Re-init from the persisted project on project switch (don't carry a prior
  // project's Fabric view over). Within a project this component's toggle handler
  // is the only writer, so local state stays authoritative — no need to re-sync
  // from the prop (which avoids a flicker on a rapid double-toggle).
  useEffect(() => {
    setPreviewMode(readPreviewMode(project))
  }, [project.id])

  // After a successful (re)deploy the URL is usually unchanged but the server
  // code changed, so force a reload — hidden behind the spinner so the previous
  // build never flashes. Revealed once the fresh page finishes loading (onNavState).
  useEffect(() => {
    const wasRunning = prevRunningRef.current
    prevRunningRef.current = running
    if (wasRunning && !running && deploy?.result?.ok && previewUrl) {
      beginTransition(previewUrl)
      void window.api.preview.reload()
    }
  }, [running, deploy?.result, previewUrl, beginTransition])

  useEffect(() => {
    if (deployedUrl) setDisplayUrl(deployedUrl)
  }, [deployedUrl])

  // Subscribe to navigation state pushed from the native webview (Rust side).
  useEffect(() => {
    return window.api.preview.onNavState((s) => {
      if (s.url) setDisplayUrl(s.url)
      setLoading(s.loading)
      setCanBack(s.canGoBack)
      setCanForward(s.canGoForward)
      // Reveal a hidden transition once its fresh load finishes (after it began).
      if (s.loading) sawLoadingRef.current = true
      else if (pendingUrlRef.current && sawLoadingRef.current) endTransition()
    })
  }, [endTransition])

  // Load a new target (a deployment / project switch or the Fabric toggle) while
  // the native surface stays hidden, so the stale page never shows. We navigate
  // the hidden webview here; the positioning effect re-reveals it once the load
  // completes. The first load (no webview yet) is skipped — the positioning effect
  // builds it via showUrl; `loadedUrlRef` stays null until then.
  useEffect(() => {
    if (!showWebview || !previewUrl) return
    if (loadedUrlRef.current === previewUrl) return // already revealed (this mount)
    if (pendingUrlRef.current === previewUrl) return // already loading it
    if (loadedUrlRef.current === null) {
      // Fresh mount (a Build-tab re-entry, or a project switch made from another
      // view that jumped back to Build). The native surface is a singleton that
      // survives unmounts, so it may still be showing a *different* project — run
      // a load transition so the "Loading…" overlay shows and that stale frame
      // never flashes. A same-url re-entry (pure re-show) or a never-shown
      // surface (true first load) falls through to the positioning effect's
      // direct showUrl.
      if (surfaceShownUrl !== null && surfaceShownUrl !== previewUrl) {
        beginTransition(previewUrl)
        const b = measureHost()
        void window.api.preview.navigate(previewUrl, b ?? { x: 0, y: 0, width: 1, height: 1 })
      }
      return
    }
    beginTransition(previewUrl)
    const b = measureHost()
    void window.api.preview.navigate(previewUrl, b ?? { x: 0, y: 0, width: 1, height: 1 })
  }, [previewUrl, showWebview, beginTransition, measureHost])

  // Position the native webview over its host placeholder and keep it tracking
  // the host's bounds. The webview is a real OS surface that paints above all
  // HTML, so when it is not meant to be visible (deploying, no deployment, a
  // covering modal, the pane collapsed to 0×0) we hide it instead.
  useEffect(() => {
    const visible =
      showWebview && !suppressed && !transitioningRef.current && Boolean(previewUrl)
    const host = hostRef.current
    if (!visible || !host || !previewUrl) {
      // An HTML overlay covering a live preview suppresses the native webview,
      // which paints above ALL HTML and would otherwise cover the overlay. Two
      // cases, handled differently (only while the preview is otherwise STABLE —
      // during a load `transitioningRef` we skip this and use the transition park
      // further below, so we never capture/park mid-navigation):
      //
      //   • FULL-SCREEN overlay (the launcher hides the whole pane → host is 0×0):
      //     park OFF-SCREEN immediately. No screenshot — the host isn't visible —
      //     and instant park stops the webview covering the launcher for a beat.
      //   • PARTIAL overlay (dropdown/menu/modal over the visible preview): SNAPSHOT
      //     the live frame FIRST and paint it as a backstop, THEN park — so the
      //     overlay floats over a still preview and the pane never flashes bare.
      if (suppressed && showWebview && previewUrl && !transitioningRef.current) {
        const hostBounds = measureHost()
        if (!hostBounds) {
          void window.api.preview.suppress(
            lastBoundsRef.current ?? { x: 0, y: 0, width: 1, height: 1 }
          )
          return
        }
        let cancelled = false
        let rafId = 0
        void (async () => {
          let frame: string | null = null
          try {
            frame = await window.api.preview.capture()
          } catch {
            // Capture can fail (e.g. no surface yet) — fall back to a blank pane.
          }
          if (cancelled) return
          if (frame) {
            // Pre-decode so painting the <img> is instant (no half-drawn still).
            try {
              const probe = new Image()
              probe.src = frame
              if (probe.decode) await probe.decode()
            } catch {
              /* decode unsupported/failed — the raw set still works */
            }
            if (cancelled) return
            setFrozen(frame)
          }
          // Park only AFTER the still has painted (double rAF ⇒ past a paint) so the
          // overlay floats over the still, never a bare host. Skip if the overlay
          // closed mid-capture (the visible branch already re-showed the webview).
          rafId = requestAnimationFrame(() => {
            if (cancelled) return
            rafId = requestAnimationFrame(() => {
              if (cancelled) return
              void window.api.preview.suppress(measureHost() ?? hostBounds)
            })
          })
        })()
        return () => {
          cancelled = true
          if (rafId !== 0) cancelAnimationFrame(rafId)
        }
      }
      setFrozen(null)
      if (transitioningRef.current && previewUrl) {
        // A fresh page is loading (project switch / redeploy / Fabric toggle): park
        // the surface OFF-SCREEN but keep it RENDERING (at host size) so it paints
        // the new page before we reveal it. A hard-hidden (IsVisible=false) webview
        // stops rendering and, when re-shown, flashes its stale last frame — the
        // OLD project — for a beat. The host shows the spinner meanwhile; the reveal
        // (showUrl) is then a pure move onto the freshly-painted page.
        const b = measureHost() ?? lastBoundsRef.current
        if (b) void window.api.preview.suppress(b)
        else void window.api.preview.hide()
      } else {
        // Not loading — a covering modal (handled above), a collapsed (0×0) pane, or
        // an undeployed project: a plain hide is correct.
        void window.api.preview.hide()
      }
      return
    }

    // Becoming visible again — record that this URL is the one now revealed (so a
    // later re-show after an overlay is a pure show, never a reload). Also record
    // it at module scope so a later fresh mount (Build-tab re-entry / cross-view
    // project switch) knows what the singleton surface is currently showing. The
    // frozen still frame is deliberately NOT dropped here: it stays as a backstop
    // until the native surface has repainted on-screen (the deferred clear after
    // showUrl below), so the HTML→native handoff never exposes a bare host.
    loadedUrlRef.current = previewUrl
    surfaceShownUrl = previewUrl

    let raf = 0
    let clearFrozenTimer = 0
    // `shownKey` is the bounds key the webview is currently shown at; '' means
    // the webview is hidden. The webview is a separate OS surface, so after it
    // has been hidden (e.g. the pane collapsed to 0×0 when chat is focused) it
    // must be re-`show()`n — not merely repositioned — once its host reappears.
    let shownKey = ''
    const measure = (): PreviewBounds | null => {
      const r = host.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) return null
      return { x: r.left, y: r.top, width: r.width, height: r.height }
    }
    // The native side flips the y-origin using the window height, so a window
    // resize that leaves the host's CSS rect unchanged still needs a re-push;
    // fold the window size into the key so any resize repositions the surface.
    const keyOf = (b: PreviewBounds): string =>
      `${b.x}|${b.y}|${b.width}|${b.height}|${window.innerWidth}|${window.innerHeight}`

    // Coalesce reposition IPC to ~30Hz: per-frame `setBounds` calls during a drag
    // are pure cost on a software-rendered VM. Show/hide stay immediate; only the
    // setBounds spam is throttled. A throttled frame still reports "moved" so the
    // burst keeps tracking and lands the final position.
    const MIN_BOUNDS_INTERVAL_MS = 33
    let lastBoundsAt = 0
    // Reconcile the native surface to the host's current rect. Returns true when
    // it actually moved/showed/hid, so the tracking loop knows it isn't settled yet.
    const reconcile = (): boolean => {
      const b = measure()
      if (!b) {
        if (shownKey !== '') {
          shownKey = ''
          void window.api.preview.hide()
          return true
        }
        return false
      }
      const key = keyOf(b)
      lastBoundsRef.current = b
      if (shownKey === '') {
        // Was hidden → show + position (showUrl re-shows the surface).
        shownKey = key
        void window.api.preview.showUrl(previewUrl, b)
        return true
      }
      if (key !== shownKey) {
        const now = performance.now()
        if (now - lastBoundsAt < MIN_BOUNDS_INTERVAL_MS) return true // defer, keep tracking
        lastBoundsAt = now
        shownKey = key
        void window.api.preview.setBounds(b)
        return true
      }
      return false
    }

    // Replace the old "rAF forever" poll (which read layout 60×/s even when idle —
    // a constant drain that's especially costly under a VM's software renderer)
    // with a self-limiting burst: track frame-by-frame only while the host is
    // actually moving (CSS transitions, splitter drags), then stop once it has
    // been stable for a short spell. Observers below restart a burst on demand.
    const STABLE_LIMIT = 8
    let stableFrames = 0
    const track = (): void => {
      const moved = reconcile()
      stableFrames = moved ? 0 : stableFrames + 1
      if (stableFrames >= STABLE_LIMIT) {
        raf = 0
        return
      }
      raf = requestAnimationFrame(track)
    }
    const startTracking = (): void => {
      stableFrames = 0
      if (raf === 0) raf = requestAnimationFrame(track)
    }

    // Host resize (splitter drag, pane collapse/expand) and viewport-intersection
    // changes (visibility) each kick off a tracking burst. Observing the host's
    // parent too catches layout shifts that move the host without resizing it.
    const ro = new ResizeObserver(() => startTracking())
    ro.observe(host)
    if (host.parentElement) ro.observe(host.parentElement)
    const io = new IntersectionObserver(() => startTracking(), { threshold: [0, 0.01, 1] })
    io.observe(host)

    // During a macOS live-resize, AppKit runs a modal event loop that pauses
    // `requestAnimationFrame`, so the burst above can't track the host while the
    // window is being dragged — the native child's autoresize mask drifts and can
    // momentarily cover the toolbar. Re-push synchronously on every resize event
    // (these fire during the modal loop) so the surface stays glued to its host.
    const onResize = (): void => {
      reconcile()
      startTracking()
    }
    window.addEventListener('resize', onResize)

    const initial = measure()
    if (initial) {
      shownKey = keyOf(initial)
      lastBoundsRef.current = initial
      void window.api.preview.showUrl(previewUrl, initial)
    }
    startTracking()

    // The native surface has been repositioned on-screen; clear the frozen
    // backstop after a short delay. The surface is opaque and paints above the
    // HTML, so an identical still lingering underneath is invisible — clearing it
    // too early (before the surface presents) is what would flash the bare host.
    // setFrozen(null) is a no-op when there was no backstop.
    clearFrozenTimer = window.setTimeout(() => setFrozen(null), FROZEN_CLEAR_MS)

    return () => {
      window.removeEventListener('resize', onResize)
      ro.disconnect()
      io.disconnect()
      if (raf !== 0) cancelAnimationFrame(raf)
      if (clearFrozenTimer !== 0) window.clearTimeout(clearFrozenTimer)
    }
  }, [deployedUrl, previewUrl, showWebview, suppressed, transitioning, measureHost])

  // The positioning effect hides the webview whenever a dependency change makes it
  // not-visible (and its rAF loop hides it when the host collapses to 0×0). On the
  // pane's own unmount (a tab switch to Code/Model/Advisor, or teardown) park the
  // surface off-screen at its last bounds but keep it rendering, so returning to
  // Build is a flash-free pure move; hard-hide only if it was never shown.
  useEffect(
    () => () => {
      const b = lastBoundsRef.current
      if (b) void window.api.preview.suppress(b)
      else void window.api.preview.hide()
    },
    []
  )

  // Cancel a pending reveal watchdog on unmount.
  useEffect(() => clearWatchdog, [clearWatchdog])

  // Report the loading-overlay state up so the parent renders a centered
  // "Loading <name>…" over the whole build view (see Props.onLoadingChange).
  useEffect(() => {
    onLoadingChange?.(loaderVisible ? { name: project.name, fading: loaderOut } : null)
  }, [loaderVisible, loaderOut, project.name, onLoadingChange])

  // Ensure the parent clears the overlay if the pane unmounts mid-load.
  useEffect(() => () => onLoadingChange?.(null), [onLoadingChange])

  // Warm the WebView2 CapturePreview pipeline once, shortly after the preview is
  // first shown. Its cold first use is slow and pumps the UI thread, which is what
  // made the FIRST overlay (dropdown/modal) laggy — the live surface sat over the
  // overlay until that slow capture finished. Warming off the critical path (and
  // never mid-load) makes the first real overlay screenshot fast.
  const warmedRef = useRef(false)
  useEffect(() => {
    if (warmedRef.current || !showWebview) return
    const t = window.setTimeout(() => {
      if (transitioningRef.current || suppressed) return // don't capture mid-load / while parked
      warmedRef.current = true
      void window.api.preview.capture().catch(() => {})
    }, 600)
    return () => window.clearTimeout(t)
  }, [showWebview, suppressed])

  const reload = useCallback((): void => {
    void window.api.preview.reload()
  }, [])
  const goBack = useCallback((): void => {
    void window.api.preview.back()
  }, [])
  const goForward = useCallback((): void => {
    void window.api.preview.forward()
  }, [])
  const openExternal = (): void => {
    const u = displayUrl || deployedUrl
    if (u) void window.api.openExternal(u)
  }
  // Switch the preview between the Fabric portal shell and the direct app URL.
  // Persist on the project so the agent's screenshot/navigate tools target the
  // same view, then refresh project state so the choice survives a remount.
  const selectMode = (next: PreviewMode): void => {
    if (next === previewMode) return
    setPreviewMode(next)
    void window.api.projects.setPreviewMode(project.id, next).then(() => onPreviewModeChanged?.())
  }

  // ── In-preview design mode ────────────────────────────────────────────────
  // A click-to-edit controller injected into the preview webview lets the user
  // tweak live elements (move/resize/recolor/text + a Graphein spec editor); the
  // collected changes are handed to the chat composer. See `preview.design.*`
  // and the injected `design_agent.js`.
  const [designActive, setDesignActive] = useState(false)
  const [designBusy, setDesignBusy] = useState(false)
  const [designCount, setDesignCount] = useState(0)
  const handoffRef = useRef(false)
  // AI placeholder generation: a re-entrancy guard + the resolved fast model id
  // (picked once from the model list; `undefined` → engine default).
  const aiRef = useRef(false)
  const fastModelRef = useRef<string | undefined>(undefined)
  // The resolved model list for the placeholder AI picker, cached so the poll can
  // re-push it if the controller is re-injected empty (preview reload).
  const designModelsRef = useRef<{ id: string; name: string; fast: boolean }[] | null>(null)
  // The user's chosen AI model id, persisted across sessions (localStorage) so the
  // picker preselects it. Seeded from storage; updated when the poll sees a change.
  const designModelRef = useRef<string | null>(
    typeof localStorage !== 'undefined' ? localStorage.getItem(DESIGN_MODEL_KEY) : null
  )
  // Signature of the last Fabricator theme pushed to the controller, so the poll
  // re-pushes only when the theme/zoom actually changes (or after a reload).
  const lastThemeSigRef = useRef('')

  // Resolve a fast model once design mode is on, and push the model list to the
  // controller's placeholder AI picker (fast models first), preselecting the
  // persisted choice when present. Also push Fabricator's theme so the tools
  // match the host look + zoom. Best-effort.
  useEffect(() => {
    if (!designActive) return
    // Push the current Fabricator theme (accent/surfaces/text/border + UI scale).
    try {
      const theme = readFabricatorTheme()
      lastThemeSigRef.current = JSON.stringify(theme)
      void window.api.preview.design.setTheme(theme)
    } catch {
      /* non-fatal — the controller falls back to its default palette */
    }
    let cancelled = false
    void loadCopilotModels()
      .then((models) => {
        if (cancelled) return
        fastModelRef.current = pickFastModel(models)
        const list = models
          .map((m) => ({ id: m.id, name: m.name, fast: isFastModel(m) }))
          .sort((a, b) => (a.fast === b.fast ? 0 : a.fast ? -1 : 1))
        if (list.length) {
          designModelsRef.current = list
          void window.api.preview.design.setModels(list, designModelRef.current ?? undefined)
        }
      })
      .catch(() => {
        /* leave undefined → engine default */
      })
    return () => {
      cancelled = true
    }
  }, [designActive])

  // Generate an HTML/CSS component for a placeholder and inject it. Best-effort:
  // on any failure, `applyGenerated(id, '')` tells the controller to restore the
  // describe state, so the poll's `aiRef` guard is always cleared.
  const runAiGenerate = useCallback(async (): Promise<void> => {
    let req: PreviewDesignAiRequest | null = null
    try {
      req = await window.api.preview.design.drainAi()
    } catch {
      req = null
    }
    if (!req) return
    let html = ''
    try {
      html = await window.api.preview.design.generateHtml(
        project.id,
        req.description,
        req.width,
        req.height,
        req.model || undefined
      )
    } catch {
      html = ''
    }
    try {
      await window.api.preview.design.applyGenerated(req.id, html)
    } catch {
      // ignore — the controller self-heals its generating state on next select
    }
  }, [project.id])
  const aiGenRef = useRef(runAiGenerate)
  useEffect(() => {
    aiGenRef.current = runAiGenerate
  }, [runAiGenerate])

  // Restyle a selected element from a natural-language change and apply it live.
  // Best-effort: on any failure, `applyRestyle(id, empty)` clears the controller's
  // "Applying…" busy state, and the poll's `aiEditRef` guard is always released.
  const runAiEdit = useCallback(async (): Promise<void> => {
    let req: PreviewDesignAiEditRequest | null = null
    try {
      req = await window.api.preview.design.drainAiEdit()
    } catch {
      req = null
    }
    if (!req) return
    let patch: PreviewDesignRestylePatch = { styles: {} }
    try {
      patch = await window.api.preview.design.restyleElement(
        project.id,
        req.description,
        req.context,
        req.model || undefined
      )
    } catch {
      patch = { styles: {} }
    }
    try {
      const ids = req.ids && req.ids.length ? req.ids : [req.id]
      // One patch, applied to every selected element (consistent multi-select edit).
      for (const id of ids) {
        await window.api.preview.design.applyRestyle(id, patch)
      }
    } catch {
      // ignore — the controller clears its busy state on the next select
    }
  }, [project.id])
  const aiEditRef = useRef(false)
  const runAiEditRef = useRef(runAiEdit)
  useEffect(() => {
    runAiEditRef.current = runAiEdit
  }, [runAiEdit])

  const toggleDesign = useCallback((): void => {
    setDesignActive((prev) => {
      const next = !prev
      // In the Fabric-embedded view the app runs in a cross-origin iframe; tell
      // the host to drive the controller through the top-frame relay by passing
      // the embedded flag + the direct app URL (its origin identifies the iframe).
      void window.api.preview.design.setEnabled(next, previewMode === 'fabric', deployedUrl)
      if (!next) setDesignCount(0)
      return next
    })
  }, [previewMode, deployedUrl])

  // Capture the highlighted screenshot, drain the composed instruction, hand it
  // to chat, then leave design mode. Fired when the poll sees `handoffReady`.
  // Every step is best-effort so this never rejects — a rejection would strand
  // the poll's `handoffRef` guard and wedge design mode.
  const finishDesignHandoff = useCallback(async (): Promise<void> => {
    setDesignBusy(true)
    try {
      // The controller has drawn highlight rings + hidden its chrome, so a
      // capture now shows exactly what changed. Screenshot is best-effort.
      let shot: PendingShot | undefined
      try {
        const dataUrl = await window.api.preview.capture()
        const path = await window.api.screenshot.save(dataUrl)
        const thumb = await makeThumbFromDataUrl(dataUrl)
        shot = { path, thumb }
      } catch {
        // no screenshot — still hand off the instruction
      }
      let handoff: PreviewDesignHandoff | null = null
      try {
        handoff = await window.api.preview.design.drain()
      } catch {
        // drain failed — still leave design mode cleanly below
      }
      try {
        await window.api.preview.design.setEnabled(false)
      } catch {
        // ignore — local state is reset regardless
      }
      setDesignActive(false)
      setDesignCount(0)
      if (handoff) onDesignHandoff?.(handoff.instruction, shot)
    } finally {
      setDesignBusy(false)
    }
  }, [onDesignHandoff])

  // Poll the controller while design mode is on: track the change count and
  // trigger the hand-off once the user hits "Send to chat". `finishDesignHandoff`
  // is read through a ref so frequent parent re-renders don't restart the timer
  // (which could otherwise starve the 250ms poll and miss the handoff).
  const finishRef = useRef(finishDesignHandoff)
  useEffect(() => {
    finishRef.current = finishDesignHandoff
  }, [finishDesignHandoff])
  useEffect(() => {
    if (!designActive) return
    let cancelled = false
    let timer: number | null = null
    const tick = async (): Promise<void> => {
      try {
        const status = await window.api.preview.design.poll()
        if (cancelled) return
        if (status) setDesignCount(status.changeCount)
        // Persist the AI model choice when the user changes it in the picker.
        if (status?.aiModel && status.aiModel !== designModelRef.current) {
          designModelRef.current = status.aiModel
          try {
            localStorage.setItem(DESIGN_MODEL_KEY, status.aiModel)
          } catch {
            /* storage unavailable — keep the in-memory ref */
          }
        }
        // Re-push the model list if the controller was re-injected empty (a
        // preview reload drops its in-page state), preselecting the saved choice.
        if (status && status.hasModels === false && designModelsRef.current) {
          void window.api.preview.design.setModels(
            designModelsRef.current,
            designModelRef.current ?? undefined
          )
        }
        // Keep the tools on Fabricator's theme: re-push after a reload (the
        // controller lost it) or whenever the theme/UI-zoom changed live.
        if (status) {
          const theme = readFabricatorTheme()
          const sig = JSON.stringify(theme)
          if (status.hasTheme === false || sig !== lastThemeSigRef.current) {
            lastThemeSigRef.current = sig
            void window.api.preview.design.setTheme(theme)
          }
        }
        if (status?.aiPending && !aiRef.current) {
          aiRef.current = true
          try {
            await aiGenRef.current()
          } finally {
            aiRef.current = false
          }
        }
        if (status?.aiEditPending && !aiEditRef.current) {
          aiEditRef.current = true
          try {
            await runAiEditRef.current()
          } finally {
            aiEditRef.current = false
          }
        }
        if (status?.handoffReady && !handoffRef.current) {
          handoffRef.current = true
          try {
            await finishRef.current()
          } finally {
            // Always clear the guard, even if the handoff threw, so a transient
            // failure doesn't permanently wedge design mode.
            handoffRef.current = false
          }
          return
        }
      } catch {
        // ignore transient poll errors
      }
      if (!cancelled) timer = window.setTimeout(() => void tick(), 250)
    }
    timer = window.setTimeout(() => void tick(), 250)
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [designActive])

  // Leave design mode if the preview goes away (project switch / undeploy), and
  // always disable on unmount.
  useEffect(() => {
    if (designActive && !showWebview) {
      setDesignActive(false)
      setDesignCount(0)
      void window.api.preview.design.setEnabled(false)
    }
  }, [designActive, showWebview])
  useEffect(() => () => void window.api.preview.design.setEnabled(false), [])

  // End the design session whenever the preview navigates to a different URL — a
  // project switch, the Fabric-view toggle, or a redeploy to a new URL. Rust's
  // `reset_to` clears `design_active` on the new root URL (so the controller
  // isn't re-injected); this keeps the renderer's toggle + count in sync (this
  // component isn't remounted per project, so an effect is needed). Keyed on
  // `previewUrl` rather than `project.id` so the Fabric toggle — a URL change
  // with the same project — doesn't leave a lit-but-dead Design button.
  const prevPreviewUrlRef = useRef(previewUrl)
  useEffect(() => {
    if (prevPreviewUrlRef.current === previewUrl) return
    prevPreviewUrlRef.current = previewUrl
    setDesignActive(false)
    setDesignCount(0)
    void window.api.preview.design.setEnabled(false)
  }, [previewUrl])

  const dotClass =
    status === 'success'
      ? 'ok'
      : status === 'error'
        ? 'err'
        : running || status === 'deploying'
          ? 'busy'
          : 'idle'

  return (
    <div className="preview">
      <div className="preview-toolbar">
        <div className="preview-toolbar-left">
          <div className="preview-nav">
            <button
              className="icon-btn"
              onClick={goBack}
              disabled={!showWebview || !canBack || transitioning}
              aria-label="Back"
              title="Back"
            >
              <ChevronLeftIcon />
            </button>
            <button
              className="icon-btn"
              onClick={goForward}
              disabled={!showWebview || !canForward || transitioning}
              aria-label="Forward"
              title="Forward"
            >
              <ChevronRightIcon />
            </button>
            <button
              className="icon-btn"
              onClick={reload}
              disabled={!showWebview || transitioning}
              aria-label="Reload"
              title="Reload"
            >
              <ReloadIcon />
            </button>
          </div>
          <span className={`preview-status preview-status--${dotClass}`}>
            <span className="preview-dot" />
            <span className="preview-status-label">{statusLabel(running, status)}</span>
          </span>
          {isLocal && (
            <span className="preview-local-badge" title="Live local preview — your app is running from a local Vite dev server for this turn">
              Local
            </span>
          )}
          {(displayUrl || deployedUrl) &&
            (fabricUrl && !isLocal ? (
              <div className="preview-url-select">
                <button
                  className="preview-url preview-url--select"
                  title={displayUrl || deployedUrl}
                  onClick={() => setUrlMenuOpen((v) => !v)}
                  disabled={transitioning}
                  aria-haspopup="menu"
                  aria-expanded={urlMenuOpen}
                >
                  <span className="preview-url-text">
                    {prettyUrl(displayUrl || deployedUrl || '')}
                  </span>
                  <ChevronDownIcon className="preview-url-caret" />
                </button>
                {urlMenuOpen && (
                  <>
                    <div className="preview-url-scrim" onClick={() => setUrlMenuOpen(false)} />
                    <div className="preview-url-menu" role="menu">
                      <button
                        className={`preview-url-option${previewMode === 'fabric' ? ' preview-url-option--on' : ''}`}
                        role="menuitemradio"
                        aria-checked={previewMode === 'fabric'}
                        onClick={() => {
                          selectMode('fabric')
                          setUrlMenuOpen(false)
                        }}
                      >
                        <FabricIcon className="preview-url-option-ico" />
                        <span className="preview-url-option-body">
                          <span className="preview-url-option-label">Fabric</span>
                          <span className="preview-url-option-sub">{prettyUrl(fabricUrl)}</span>
                        </span>
                        {previewMode === 'fabric' && (
                          <CheckIcon className="preview-url-option-check" />
                        )}
                      </button>
                      <button
                        className={`preview-url-option${previewMode === 'direct' ? ' preview-url-option--on' : ''}`}
                        role="menuitemradio"
                        aria-checked={previewMode === 'direct'}
                        onClick={() => {
                          selectMode('direct')
                          setUrlMenuOpen(false)
                        }}
                      >
                        <GlobeIcon className="preview-url-option-ico" />
                        <span className="preview-url-option-body">
                          <span className="preview-url-option-label">External URL</span>
                          <span className="preview-url-option-sub">
                            {prettyUrl(deployedUrl || '')}
                          </span>
                        </span>
                        {previewMode === 'direct' && (
                          <CheckIcon className="preview-url-option-check" />
                        )}
                      </button>
                      <div className="preview-url-menu-divider" />
                      <button
                        className="preview-url-option"
                        role="menuitem"
                        onClick={() => {
                          openExternal()
                          setUrlMenuOpen(false)
                        }}
                      >
                        <OpenExternalIcon className="preview-url-option-ico" />
                        <span className="preview-url-option-body">
                          <span className="preview-url-option-label">Open in browser</span>
                        </span>
                      </button>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <button
                className="preview-url"
                title={displayUrl || deployedUrl}
                onClick={openExternal}
              >
                {prettyUrl(displayUrl || deployedUrl || '')}
              </button>
            ))}
        </div>
        <div className="preview-toolbar-right">
          {loading && showWebview && <span className="preview-loading">Loading…</span>}
          <button
            className={`design-btn ${designActive ? 'design-btn--on' : ''}`}
            onClick={toggleDesign}
            disabled={!showWebview || transitioning || designBusy || isLocal}
            title={
              previewMode === 'fabric'
                ? 'Design mode — click elements in the embedded app to tweak them (move, resize, color, text, chart specs), then send the changes to chat'
                : 'Design mode — click elements in the preview to tweak them (move, resize, color, text, chart specs), then send the changes to chat'
            }
          >
            <DesignIcon />
            <span className="seg-btn-label">
              {designBusy
                ? 'Sending…'
                : designActive
                  ? `Design${designCount ? ` · ${designCount}` : ''}`
                  : 'Design'}
            </span>
          </button>
          <button
            className={`icon-btn ${focused ? 'icon-btn--on' : ''}`}
            onClick={onToggleFocus}
            aria-label={focused ? 'Exit focus' : 'Focus'}
            title={
              focused ? 'Exit focus — show the chat again' : 'Focus the preview — hide the chat'
            }
          >
            {focused ? <CollapseIcon /> : <ExpandIcon />}
          </button>
        </div>
      </div>

      {status === 'error' && error && !running && !needsWorkspace && (
        <div className="preview-error-banner" title={error}>
          ⚠ {error}
        </div>
      )}

      <div className="preview-body">
        {running ? (
          <DeployStage log={deploy?.log ?? []} name={project.name} />
        ) : showWebview ? (
          <div className="preview-canvas">
            <div className="preview-stage">
              {/* Placeholder the native WebView2 child is positioned over. When an
                  overlay suppresses the native child, `frozen` paints the last frame
                  here so the overlay floats over a still preview instead of black.
                  The project-load overlay is rendered at the Workbench level (so it
                  centers over the whole build view), not here. */}
              <div className="preview-webview-host" ref={hostRef}>
                {frozen && <img className="preview-frozen" src={frozen} alt="" draggable={false} />}
              </div>
            </div>
          </div>
        ) : needsWorkspace ? (
          <div className="preview-placeholder">
            <div className="ws-prompt">
              <h3 className="ws-prompt-title">Choose where to deploy</h3>
              <p className="ws-prompt-sub">
                <strong>{project.name}</strong> hasn’t been deployed yet. Hit{' '}
                <strong>Deploy</strong> in the header above to name a deployment and pick the Fabric
                workspace to publish it into.
              </p>
              {error && <div className="alert alert--error ws-prompt-err">{error}</div>}
            </div>
          </div>
        ) : (
          <div className="preview-placeholder">
            {error ? (
              <>
                <div className="alert alert--error">{error}</div>
                {deploy?.log.length ? (
                  <pre className="deploy-log deploy-log--static">{deploy.log.join('')}</pre>
                ) : null}
              </>
            ) : (
              <p>
                Your deployed app will render here after a full <code>rayfin up</code>. Ask Copilot
                to build something, or hit <strong>Deploy</strong>.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
