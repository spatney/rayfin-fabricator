import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DeployResult,
  DevServerResult,
  PreviewBounds,
  PreviewMode,
  StudioProject,
  TeamRunStatus
} from '@shared/ipc'
import { usePreviewSuppressed } from '../overlay'
import { measurePreviewBounds, watchPreviewPixelRatio } from '../previewBounds'
import { DEVICES, deviceHostWidth, type DeviceId } from '../design/devices'
import { readFabricatorTheme } from '../design/hostTheme'
import type { DesignSession, DesignSurface } from '../design/useDesignSession'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ReloadIcon,
  FabricIcon,
  DesignIcon,
  ExpandIcon,
  CollapseIcon,
  PaletteIcon,
  SparkleIcon,
  DesktopIcon,
  TabletIcon,
  PhoneIcon
} from './icons'
import DeployStage from './DeployStage'
import DeployFailedNotice from './DeployFailedNotice'
import TeamDeployCard from './team/TeamDeployCard'
import TeamRunStrip from './team/TeamRunStrip'

export interface DeployUiState {
  running: boolean
  log: string[]
  result?: DeployResult
}

/**
 * A screenshot pending attachment to the next chat message — one the user
 * added to the composer, or a Design capture — consumed by the chat composer.
 */
export interface PendingShot {
  /** Absolute temp-file path passed to copilot as `--attachment`. */
  path: string
  /** Data URL used only to render a thumbnail in the UI. */
  thumb: string
}

const DEVICE_ICONS: Record<DeviceId, (props: { className?: string }) => JSX.Element> = {
  desktop: DesktopIcon,
  tablet: TabletIcon,
  phone: PhoneIcon
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
  /** Offer an explicit credential reset without automatically replaying a deploy. */
  onRefreshAuth?: () => void
  authBusy?: boolean
  /** Open Help and ask it why the last deploy failed. */
  onDiagnoseDeploy?: () => void
  /** True when the preview pane is expanded to fill the build view (chat hidden). */
  focused: boolean
  /** Toggle preview focus (full-width preview ⇄ split with chat). */
  onToggleFocus: () => void
  /** Notify the parent that the persisted preview mode changed (so it can refresh
   *  project state — the selection lives on the project, store-backed). */
  onPreviewModeChanged?: () => void
  /** Design mode ("visual chat"). The session lives in the Workbench, which
   *  shares its queue with the chat composer. */
  design?: DesignSession
  /** Why sending the queued design changes is blocked right now (a turn is
   *  running, the first deploy is pending…), or null when it can go. */
  designSendBlocked?: string | null
  /** Send the queued design changes to chat (the composer text is the note). */
  onDesignSend?: () => void
  /** Report the surface Design can run on — the deployed app, directly or
   *  embedded in Fabric, or the manual-deploy local preview — or null while unavailable. */
  onDesignSurface?: (surface: DesignSurface | null) => void
  /** Report the project-load overlay state so the parent can render a centered
   *  "Loading <name>…" over the whole build view (a project switch reloads the
   *  chat + preview, so the indicator belongs at the content level, not the
   *  preview pane). `null` when not loading. */
  onLoadingChange?: (state: { name: string; fading: boolean } | null) => void
  /** Live local preview: the `localhost` URL of the project's running
   *  Vite dev server, or null/undefined when none. When set (and no deploy is
   *  running), the preview surface shows this instead of the deployed app, with a
   *  "Local" badge. See {@link RayfinStudioApi.dev}. */
  localPreviewUrl?: string | null
  /** Deploy manually (experimental): the local preview runs whenever the app is
   *  open, instead of only during turns. */
  manualDeploy?: boolean
  /** A team app (experimental): its pipeline deploys it, so there's no Deploy here. */
  team?: boolean
  /** Team apps: the deployment the local preview's data comes from. */
  localBackend?: DevServerResult['backend']
  /** Team apps: the pipeline run deploying this app right now, if any. */
  teamRun?: TeamRunStatus
  /** Team apps: which deployment the preview shows — your own preview or the
   *  published app (the team menu's "Preview shows"). */
  teamView?: 'preview' | 'production'
  /** Team apps: open the workspace overview. */
  onOpenTeamMap?: () => void
}

/** What the status says once the deployed app is up: solo apps have one
 *  deployment, so it's simply Live; team apps name the one they show. */
function liveLabel(team: boolean, teamView: Props['teamView']): string {
  if (!team) return 'Live'
  return teamView === 'production' ? 'Published' : 'My preview'
}

function statusLabel(running: boolean, status: string | undefined, live: string): string {
  if (running) return 'Deploying…'
  switch (status) {
    case 'success':
      return live
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

/** Fabricator's UI zoom, tracked while `enabled` (device widths divide it out). */
function useUiScale(enabled: boolean): number {
  const [scale, setScale] = useState(1)
  useEffect(() => {
    if (!enabled) return
    const update = (): void => setScale(readFabricatorTheme().scale ?? 1)
    update()
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
    return () => observer.disconnect()
  }, [enabled])
  return scale
}

/** Whole seconds since `since` (a `performance.now()` stamp), ticking while set. */
function useElapsed(since: number | null): number {
  const [now, setNow] = useState(() => performance.now())
  useEffect(() => {
    if (since == null) return
    setNow(performance.now())
    const timer = window.setInterval(() => setNow(performance.now()), 1000)
    return () => window.clearInterval(timer)
  }, [since])
  return since == null ? 0 : Math.max(0, Math.floor((now - since) / 1000))
}

export default function PreviewPane({
  project,
  deploy,
  onRefreshAuth,
  authBusy = false,
  onDiagnoseDeploy,
  focused,
  onToggleFocus,
  onPreviewModeChanged,
  design,
  designSendBlocked = null,
  onDesignSend,
  onDesignSurface,
  onLoadingChange,
  localPreviewUrl,
  manualDeploy = false,
  team = false,
  localBackend,
  teamRun,
  teamView,
  onOpenTeamMap
}: Props): JSX.Element {
  const suppressed = usePreviewSuppressed()
  const running = deploy?.running ?? false
  const deployedUrl = project.lastDeploy?.url
  // The deployed item can also be viewed embedded in the Fabric portal shell
  // (`…/groups/{workspace}/appbackends/{item}`). The CLI hands us that deep link
  // as `lastDeploy.portalUrl`; a toolbar toggle switches the webview between the
  // direct app URL and this Fabric-hosted view.
  const fabricUrl = project.lastDeploy?.portalUrl
  const status = running
    ? 'deploying'
    : deploy?.result
      ? deploy.result.ok
        ? 'success'
        : 'error'
      : project.lastDeploy?.status
  const error = deploy?.result ? deploy.result.error : project.lastDeploy?.error
  // Team apps: the pipeline is deploying this app (its preview, or a publish).
  const teamDeploying = Boolean(team && teamRun && teamRun.status !== 'completed')
  // The first deploy of a project has no recorded Fabric workspace — surface a
  // prompt instead of a dead error so the user can pick a target and retry.
  const outcome = deploy?.result?.outcome ?? project.lastDeploy?.outcome
  const needsWorkspace = !running && outcome === 'needs-workspace'
  // A failed deploy's notice can be put away until the next deploy, or another
  // app, comes along.
  const [failureDismissed, setFailureDismissed] = useState(false)
  useEffect(() => {
    if (running) setFailureDismissed(false)
  }, [running])
  useEffect(() => setFailureDismissed(false), [project.id])

  const hostRef = useRef<HTMLDivElement>(null)
  const prevRunningRef = useRef(running)
  const [displayUrl, setDisplayUrl] = useState(deployedUrl ?? '')
  const [loading, setLoading] = useState(false)
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)
  const [nativeShown, setNativeShown] = useState(false)
  const [surfaceError, setSurfaceError] = useState<string | null>(null)
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
    return host ? measurePreviewBounds(host) : null
  }, [])

  // Which URL the embedded webview actually loads. Falls back to the direct URL
  // whenever the Fabric link is unavailable or the toggle is off.
  const [previewMode, setPreviewMode] = useState<PreviewMode>(() => readPreviewMode(project))
  const deployedPreviewUrl = previewMode === 'fabric' && fabricUrl ? fabricUrl : deployedUrl
  // Live local preview: while a Vite dev server is running for this
  // project, the surface shows its localhost URL instead of the deployed app. A
  // running deploy still wins (DeployStage).
  const isLocal = Boolean(localPreviewUrl) && !running
  const previewUrl = isLocal ? (localPreviewUrl ?? undefined) : deployedPreviewUrl
  const showWebview = !running && Boolean(previewUrl)

  // Re-init from the persisted project on project switch (don't carry a prior
  // project's Fabric view over) and whenever the persisted mode changes underneath
  // us — notably the after-deploy default that flips a newly semantic-model-backed
  // app to the embedded Fabric view (see `run_deploy`). The manual toggle sets local
  // state optimistically and persists the same value, so this resync is a no-op for
  // it (bar a transient, self-correcting echo on a rapid double-toggle).
  useEffect(() => {
    setPreviewMode(readPreviewMode(project))
  }, [project.id, project.previewMode])

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
      setNativeShown(false)
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
    let cancelled = false
    const show = (bounds: PreviewBounds): void => {
      void window.api.preview.showUrl(previewUrl, bounds).then(() => {
        if (!cancelled) {
          setSurfaceError(null)
          setNativeShown(true)
        }
      }).catch((reason: unknown) => {
        if (!cancelled) {
          setNativeShown(false)
          setSurfaceError(reason instanceof Error ? reason.message : String(reason))
        }
      })
    }
    // `shownKey` is the bounds key the webview is currently shown at; '' means
    // the webview is hidden. The webview is a separate OS surface, so after it
    // has been hidden (e.g. the pane collapsed to 0×0 when chat is focused) it
    // must be re-`show()`n — not merely repositioned — once its host reappears.
    let shownKey = ''
    const measure = (): PreviewBounds | null => measurePreviewBounds(host)
    // The native side flips the y-origin using the window height, so a window
    // resize that leaves the host's CSS rect unchanged still needs a re-push;
    // fold the window size into the key so any resize repositions the surface.
    const keyOf = (b: PreviewBounds): string =>
      `${b.x}|${b.y}|${b.width}|${b.height}|${b.pixelRatio}|${window.innerWidth}|${window.innerHeight}`

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
          setNativeShown(false)
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
        show(b)
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
    window.addEventListener('scroll', onResize)
    const viewport = window.visualViewport
    viewport?.addEventListener('resize', onResize)
    viewport?.addEventListener('scroll', onResize)
    const stopWatchingPixelRatio = watchPreviewPixelRatio(onResize)

    const initial = measure()
    if (initial) {
      shownKey = keyOf(initial)
      lastBoundsRef.current = initial
      show(initial)
    }
    startTracking()

    // The native surface has been repositioned on-screen; clear the frozen
    // backstop after a short delay. The surface is opaque and paints above the
    // HTML, so an identical still lingering underneath is invisible — clearing it
    // too early (before the surface presents) is what would flash the bare host.
    // setFrozen(null) is a no-op when there was no backstop.
    clearFrozenTimer = window.setTimeout(() => setFrozen(null), FROZEN_CLEAR_MS)

    return () => {
      cancelled = true
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onResize)
      viewport?.removeEventListener('resize', onResize)
      viewport?.removeEventListener('scroll', onResize)
      stopWatchingPixelRatio()
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

  // ── Design mode ("visual chat") ───────────────────────────────────────────
  // The session (queue, polling, AI requests, capture) lives in the Workbench so
  // the chat composer can show and send the queue; this pane reports the surface
  // Design can run on — the deployed app or the manual-deploy local preview — and
  // renders the design toolbar + device width. See `useDesignSession` and the
  // injected `design_agent.js`.
  const designActive = Boolean(design?.active)
  const embedded = !isLocal && previewMode === 'fabric' && Boolean(fabricUrl)
  const designAppUrl = isLocal ? previewUrl : deployedUrl
  const designSurface = useMemo<DesignSurface | null>(
    () =>
      showWebview && !transitioning && (!isLocal || manualDeploy) && previewUrl && designAppUrl
        ? { url: previewUrl, embedded, appUrl: designAppUrl }
        : null,
    [showWebview, transitioning, isLocal, manualDeploy, previewUrl, designAppUrl, embedded]
  )
  useEffect(() => {
    onDesignSurface?.(designSurface)
  }, [designSurface, onDesignSurface])
  useEffect(() => () => onDesignSurface?.(null), [onDesignSurface])
  const uiScale = useUiScale(designActive)
  const hostWidth = designActive && design ? deviceHostWidth(design.device, uiScale) : null
  const polishSeconds = useElapsed(designActive ? (design?.polishingSince ?? null) : null)
  const designCount = design?.items.length ?? 0
  const dotClass =
    running || status === 'deploying' || teamDeploying
      ? 'busy'
      : status === 'success'
        ? 'ok'
        : status === 'error'
          ? 'err'
          : 'idle'
  const live = liveLabel(team, teamView)
  const statusText = teamDeploying
    ? status === 'success'
      ? `${live} · updating`
      : 'Deploying…'
    : statusLabel(running, status, live)
  const statusTitle = team
    ? teamView === 'production'
      ? 'Showing the published app — what everyone sees. Switch in the team menu.'
      : 'Showing your own preview of your changes. Switch to the published app in the team menu.'
    : undefined

  return (
    <div className="preview">
      <div className="preview-toolbar">
        <div className="preview-toolbar-left">
          <div className="seg seg--toolbar preview-nav">
            <button
              className="seg-btn seg-btn--icon"
              onClick={goBack}
              disabled={!showWebview || !canBack || transitioning}
              aria-label="Back"
              title="Back"
            >
              <ChevronLeftIcon />
            </button>
            <button
              className="seg-btn seg-btn--icon"
              onClick={goForward}
              disabled={!showWebview || !canForward || transitioning}
              aria-label="Forward"
              title="Forward"
            >
              <ChevronRightIcon />
            </button>
            <button
              className="seg-btn seg-btn--icon"
              onClick={reload}
              disabled={!showWebview || transitioning}
              aria-label="Reload"
              title="Reload"
            >
              <ReloadIcon />
            </button>
          </div>
          <span className={`preview-status preview-status--${dotClass}`} title={statusTitle}>
            <span className="preview-dot" />
            <span className="preview-status-label">{statusText}</span>
          </span>
          {isLocal && (
            <span
              className={`preview-local-badge${team && localBackend === 'production' ? ' preview-local-badge--warn' : ''}`}
              title={
                team
                  ? `Live local preview at ${localPreviewUrl}: Copilot's changes show here as it makes them. ${
                      localBackend === 'production'
                        ? "It uses the published app's data until your own preview is deployed, so changes you make in it are real."
                        : localBackend === 'none'
                          ? 'Nothing is deployed yet, so it runs without data.'
                          : "It uses your preview's data."
                    } It stays until the team pipeline has deployed your latest change.`
                  : manualDeploy
                    ? `Live local preview — your app is running from a local Vite dev server at ${localPreviewUrl}. With Deploy manually on, it shows your latest changes whenever the app is open.`
                    : `Live local preview — your app is running from a local Vite dev server at ${localPreviewUrl} for this turn`
              }
            >
              {team
                ? localBackend === 'production'
                  ? 'Local · published data'
                  : localBackend === 'none'
                    ? 'Local · no data yet'
                    : 'Local'
                : 'Local'}
            </span>
          )}
          {(displayUrl || deployedUrl) && (
            <button
              className="preview-url"
              title={displayUrl || deployedUrl}
              onClick={openExternal}
            >
              {prettyUrl(displayUrl || deployedUrl || '')}
            </button>
          )}
        </div>
        <div className="preview-toolbar-right">
          {loading && showWebview && <span className="preview-loading">Loading…</span>}
          <div className="seg seg--toolbar">
            <button
              className={`seg-btn ${previewMode === 'fabric' ? 'seg-btn--on' : ''}`}
              onClick={() => {
                const next: PreviewMode = previewMode === 'fabric' ? 'direct' : 'fabric'
                setPreviewMode(next)
                // Persist on the project (store-backed) so the Fabricator agent's
                // screenshot/navigate tools target the same view, not just the UI;
                // then refresh project state so the choice survives a remount.
                void window.api.projects
                  .setPreviewMode(project.id, next)
                  .then(() => onPreviewModeChanged?.())
              }}
              disabled={!showWebview || !fabricUrl || transitioning || isLocal || designActive}
              title={
                !fabricUrl
                  ? 'The Fabric portal view is unavailable for this deployment'
                  : designActive
                    ? 'Finish designing (Done) to switch views'
                    : previewMode === 'fabric'
                      ? 'Viewing inside the Fabric portal shell — click to return to the direct app view'
                      : 'View the app embedded in the Fabric portal shell'
              }
            >
              <FabricIcon />
              <span className="seg-btn-label">Fabric</span>
            </button>
            <button
              className={`seg-btn ${designActive ? 'seg-btn--on' : ''}`}
              onClick={design?.toggle}
              aria-pressed={designActive}
              disabled={!design || (!designActive && (!design.available || !nativeShown))}
              title={
                designActive
                  ? 'Leave Design — your queued changes stay in the chat composer'
                  : isLocal && !manualDeploy
                    ? 'Design works on the deployed app — available once this turn finishes'
                    : 'Design — click anything in your app to change it, preview the result live, then send it all to Copilot at once'
              }
            >
              <DesignIcon />
              <span className="seg-btn-label">{designCount ? `Design · ${designCount}` : 'Design'}</span>
            </button>
            <button
              className={`seg-btn seg-btn--icon ${focused ? 'seg-btn--on' : ''}`}
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
      </div>

      {designActive && design && (
        <div className="design-bar" role="toolbar" aria-label="Design tools">
          <span className="design-bar-status" aria-live="polite">
            <span className="design-bar-dot" aria-hidden="true" />
            {designCount
              ? `${designCount} change${designCount === 1 ? '' : 's'} ready`
              : 'Click anything in your app to change it'}
          </span>
          <div className="design-bar-actions">
            <div className="seg seg--toolbar" role="group" aria-label="Preview width">
              {DEVICES.map((d) => {
                const Glyph = DEVICE_ICONS[d.id]
                const on = design.device === d.id
                return (
                  <button
                    key={d.id}
                    type="button"
                    className={`seg-btn seg-btn--icon ${on ? 'seg-btn--on' : ''}`}
                    aria-pressed={on}
                    aria-label={`${d.label} width`}
                    title={d.width ? `${d.label} — ${d.width}px wide` : `${d.label} — fill the pane`}
                    onClick={() => design.setDevice(d.id)}
                  >
                    <Glyph className="btn-ico" />
                  </button>
                )
              })}
            </div>
            <div className="seg seg--toolbar">
              <button
                type="button"
                className={`seg-btn ${design.panel === 'theme' ? 'seg-btn--on' : ''}`}
                aria-pressed={design.panel === 'theme'}
                onClick={design.toggleTheme}
                title="Theme — try a new accent, neutrals, corners, density or font across the whole app"
              >
                <PaletteIcon />
                <span className="seg-btn-label">Theme</span>
              </button>
              <button
                type="button"
                className={`seg-btn ${design.panel === 'polish' ? 'seg-btn--on' : ''}`}
                onClick={design.polish}
                disabled={design.polishingSince != null}
                title="Polish — a quick design review of this page with fixes you can preview and add"
              >
                <SparkleIcon />
                <span className="seg-btn-label">
                  {design.polishingSince != null ? `Reviewing… ${polishSeconds}s` : 'Polish'}
                </span>
              </button>
            </div>
            <div className="seg seg--toolbar">
              <button
                type="button"
                className="seg-btn seg-btn--primary"
                onClick={onDesignSend}
                disabled={!onDesignSend || !designCount || design.sending || Boolean(designSendBlocked)}
                title={designSendBlocked ?? (designCount ? 'Send these changes to Copilot as one request' : 'Queue a change first')}
              >
                {design.sending ? 'Sending…' : designCount ? `Send ${designCount}` : 'Send'}
              </button>
              <button
                type="button"
                className="seg-btn"
                onClick={design.stop}
                title="Leave Design — your queued changes stay in the chat composer"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {teamDeploying && teamRun && showWebview && <TeamRunStrip run={teamRun} onOpenMap={onOpenTeamMap} />}

      {surfaceError && <div className="preview-error-banner" role="alert">{surfaceError}</div>}

      {status === 'error' && !running && !needsWorkspace && !failureDismissed && (
        <DeployFailedNotice
          key={project.id}
          outcome={outcome}
          log={deploy?.log}
          error={error || 'The deployment did not complete.'}
          onDiagnose={onDiagnoseDeploy}
          onRefreshAuth={onRefreshAuth}
          authBusy={authBusy}
          onDismiss={() => setFailureDismissed(true)}
        />
      )}

      <div className="preview-body">
        {running ? (
          <DeployStage
            log={deploy?.log ?? []}
            name={project.name}
            firstDeploy={!project.lastDeploy?.url}
          />
        ) : showWebview ? (
          <div className="preview-canvas">
            <div className="preview-stage">
              {/* Placeholder the native WebView2 child is positioned over. When an
                  overlay suppresses the native child, `frozen` paints the last frame
                  here so the overlay floats over a still preview instead of black.
                  The project-load overlay is rendered at the Workbench level (so it
                  centers over the whole build view), not here. */}
              <div
                className={`preview-webview-host${hostWidth ? ' preview-webview-host--device' : ''}`}
                ref={hostRef}
                style={hostWidth ? { width: `${hostWidth}px` } : undefined}
              >
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
        ) : teamDeploying && teamRun ? (
          <div className="preview-placeholder">
            <TeamDeployCard run={teamRun} first={!deployedUrl} onOpenMap={onOpenTeamMap} />
          </div>
        ) : (
          <div className="preview-placeholder">
            {status === 'error' && team ? (
              <p>
                The team pipeline couldn&apos;t deploy this version. Open the team menu in the
                header to see what happened.
              </p>
            ) : status === 'error' ? (
              <p>
                Review the deployment error and logs above, then use <strong>Redeploy</strong> to
                try again.
              </p>
            ) : team ? (
              <p>
                Your preview appears here after Copilot makes a change: Fabricator saves it to
                GitHub and the team pipeline deploys your own preview. The first one takes a few
                minutes.
              </p>
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
