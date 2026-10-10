import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ChatDesignSummary,
  DesignCaptureLayout,
  DesignCommand,
  DesignItem,
  DesignLocateResult,
  DesignLocateTarget,
  DesignPageOutline,
  DesignRequest,
  DesignViewport
} from '@shared/design'
import { loadCopilotModels, pickFastModel } from '../copilotModels'
import { cropItems, thumbnail, type StagedShot } from './capture'
import type { DeviceId } from './devices'
import { readFabricatorTheme } from './hostTheme'
import { composeDesignPrompt, summarizeDesign } from './prompt'

/**
 * Design mode ("visual chat") session, owned by the Workbench.
 *
 * While Design is on, the in-preview controller owns the change queue and this
 * hook mirrors its snapshots (polling `preview.design.poll`); while it is off,
 * the hook owns the queue per project and seeds the page when Design comes back
 * on. It also answers the page's requests (AI options), runs Polish reviews,
 * and captures the previews when the queue is sent to chat.
 */

const POLL_MS = 250
/** Minimum gap between re-seeding an unseeded page (after a reload). */
const SEED_RETRY_MS = 1000
/** Minimum gap between re-arming a page that lost Design (a navigation race). */
const REARM_RETRY_MS = 2000
/** Let the page repaint without its chrome before the capture. */
const CAPTURE_SETTLE_MS = 150
/** Element crops attached to one turn (plus the full view). */
const MAX_CROPS = 6
const INTRO_KEY = 'rayfin.design.introSeen'
const EMPTY: DesignItem[] = []

/** The preview surface Design can run on (deployed or manual-deploy local app). */
export interface DesignSurface {
  /** The URL the preview shows; switching it ends the session. */
  url: string
  /** The Fabric-embedded view, where the app runs in a cross-origin iframe. */
  embedded: boolean
  /** The direct app URL (its origin identifies the app iframe when embedded). */
  appUrl?: string
}

/** One design turn, ready for the chat to dispatch. */
export interface DesignTurn {
  /** The project the changes belong to. */
  projectId: string
  /** The queued changes this turn carries (removed from the queue once it's sent). */
  itemIds: string[]
  /** What the transcript shows as the user's words (the composer note). */
  display: string
  /** The full prompt sent to Copilot (it refers to the attached images). */
  prompt: string
  /** The prompt a Retry / Try again re-sends (the images are gone by then). */
  storedPrompt: string
  /** Full view first, then element crops in queue order. */
  shots: StagedShot[]
  summary: ChatDesignSummary
}

export interface DesignSession {
  /** Design can be switched on (a supported app preview is showing). */
  available: boolean
  active: boolean
  /** The active project's queued changes. */
  items: DesignItem[]
  panel: 'theme' | 'polish' | null
  /** When the running Polish review started (`performance.now()`), or null. */
  polishingSince: number | null
  /** Capturing and composing a design turn. */
  sending: boolean
  device: DeviceId
  toggle: () => void
  stop: () => void
  setDevice: (device: DeviceId) => void
  toggleTheme: () => void
  polish: () => void
  removeItem: (id: string) => void
  focusItem: (id: string) => void
  clear: () => void
  /** Capture previews, find source hints and compose the turn (null when nothing is queued). */
  buildTurn: (note: string, options?: { extraImages?: number }) => Promise<DesignTurn | null>
  /** The turn went out: drop its changes from that project's queue and leave Design. */
  finishSend: (turn: Pick<DesignTurn, 'projectId' | 'itemIds'>) => void
}

interface Captured {
  viewport?: DesignViewport
  full: StagedShot | null
  crops: { id: string; shot: StagedShot }[]
}

function newId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function errorText(err: unknown, fallback: string): string {
  if (typeof err === 'string' && err.trim()) return err
  if (err instanceof Error && err.message) return err.message
  return fallback
}

function command(cmd: DesignCommand): Promise<void> {
  return window.api.preview.design.command(cmd).catch(() => {})
}

/** Wait for a data-returning command's result to show up in `poll().results`. */
async function awaitResult<T>(requestId: string, attempts = 50): Promise<T | null> {
  for (let i = 0; i < attempts; i++) {
    const status = await window.api.preview.design.poll().catch(() => null)
    const value = status?.results?.[requestId]
    if (value !== undefined && value !== null) return value as T
    await sleep(80)
  }
  return null
}

/** What `design.locate` should look up for each queued element. */
export function locateTargets(items: DesignItem[]): DesignLocateTarget[] {
  return items
    .filter((item) => item.target)
    .map((item) => {
      const t = item.target!
      return {
        key: item.id,
        tag: t.tag,
        classes: t.classes,
        text: t.text,
        chartTitle: t.chart?.title,
        chartType: t.chart?.type
      }
    })
}

export function useDesignSession(projectId: string | null, surface: DesignSurface | null): DesignSession {
  const [queues, setQueues] = useState<Record<string, DesignItem[]>>({})
  const queuesRef = useRef(queues)
  const [active, setActive] = useState(false)
  const activeRef = useRef(false)
  const [panel, setPanelState] = useState<'theme' | 'polish' | null>(null)
  const panelRef = useRef<'theme' | 'polish' | null>(null)
  const setPanel = useCallback((next: 'theme' | 'polish' | null): void => {
    panelRef.current = next
    setPanelState(next)
  }, [])
  const [polishingSince, setPolishingSince] = useState<number | null>(null)
  const [sending, setSending] = useState(false)
  const [device, setDevice] = useState<DeviceId>('desktop')

  const projectRef = useRef(projectId)
  projectRef.current = projectId
  const surfaceRef = useRef(surface)
  surfaceRef.current = surface
  const sessionRef = useRef<string | null>(null)
  const versionRef = useRef(-1)
  const routeRef = useRef<string | undefined>(undefined)
  const viewportRef = useRef<DesignViewport | undefined>(undefined)
  const lastSeedRef = useRef(0)
  const lastArmRef = useRef(0)
  const themeSigRef = useRef('')
  const answeredRef = useRef(new Set<string>())
  const pendingFocusRef = useRef<string | null>(null)
  const polishRef = useRef<string | null>(null)
  const modelRef = useRef<Promise<{ id?: string; name?: string }> | null>(null)
  /** Changes already sent to chat; a page snapshot taken before the page dropped
   *  them must not bring them back. */
  const sentRef = useRef(new Set<string>())

  const writeQueue = useCallback((pid: string, items: DesignItem[]): void => {
    queuesRef.current = { ...queuesRef.current, [pid]: items }
    setQueues(queuesRef.current)
  }, [])
  const mirror = useCallback(
    (pid: string, items: DesignItem[]): void => writeQueue(pid, items.filter((item) => !sentRef.current.has(item.id))),
    [writeQueue]
  )

  const fastModel = useCallback((): Promise<{ id?: string; name?: string }> => {
    modelRef.current ??= loadCopilotModels()
      .then((models) => {
        const id = pickFastModel(models)
        return { id, name: models.find((m) => m.id === id)?.name }
      })
      .catch(() => ({}))
    return modelRef.current
  }, [])

  /** Switch the page's controller on with a fresh session seeded from our queue. */
  const arm = useCallback(async (intro: boolean): Promise<boolean> => {
    const pid = projectRef.current
    const s = surfaceRef.current
    if (!pid || !s) return false
    const sessionId = newId()
    sessionRef.current = sessionId
    versionRef.current = -1
    lastSeedRef.current = performance.now()
    lastArmRef.current = performance.now()
    const hostTheme = readFabricatorTheme()
    themeSigRef.current = JSON.stringify(hostTheme)
    let showIntro = false
    if (intro) {
      try {
        showIntro = !localStorage.getItem(INTRO_KEY)
        if (showIntro) localStorage.setItem(INTRO_KEY, '1')
      } catch {
        showIntro = false
      }
    }
    try {
      await window.api.preview.design.setEnabled(true, s.embedded, s.appUrl, {
        sessionId,
        items: queuesRef.current[pid] ?? [],
        hostTheme,
        intro: showIntro
      })
      return true
    } catch {
      return false
    }
  }, [])

  const stop = useCallback(
    async (sync: boolean): Promise<void> => {
      if (!activeRef.current) return
      activeRef.current = false
      setActive(false)
      setPanel(null)
      setDevice('desktop')
      const pid = projectRef.current
      const session = sessionRef.current
      sessionRef.current = null
      pendingFocusRef.current = null
      polishRef.current = null
      setPolishingSince(null)
      if (sync && pid && session) {
        const snap = await window.api.preview.design.snapshot().catch(() => null)
        if (snap && snap.sessionId === session) mirror(pid, snap.items)
      }
      await window.api.preview.design.setEnabled(false).catch(() => {})
    },
    [mirror, setPanel]
  )

  const start = useCallback((): void => {
    if (activeRef.current || !projectRef.current || !surfaceRef.current) return
    activeRef.current = true
    answeredRef.current = new Set()
    setActive(true)
    void arm(true)
  }, [arm])

  /** Answer one of the page's requests (AI options for an element). */
  const answer = useCallback(
    async (req: DesignRequest): Promise<void> => {
      const pid = projectRef.current
      if (req.kind !== 'variations' || !pid) return
      answeredRef.current.add(req.id)
      try {
        const model = await fastModel()
        void command({
          op: 'requestProgress',
          requestId: req.id,
          message: `Asking ${model.name ?? 'Copilot'} for a few looks…`
        })
        const options = await window.api.design.variations(pid, req.context, req.hint, 3, model.id)
        if (!activeRef.current) return
        await command(
          options.length
            ? { op: 'applyVariations', requestId: req.id, options }
            : { op: 'failRequest', requestId: req.id, message: 'No usable options came back — try describing the change instead.' }
        )
      } catch (err) {
        if (activeRef.current) {
          await command({ op: 'failRequest', requestId: req.id, message: errorText(err, 'Couldn’t design options right now.') })
        }
      }
    },
    [fastModel]
  )

  /** Mirror the page's latest queue (only from our own, seeded session). */
  const pullSnapshot = useCallback(async (): Promise<void> => {
    const pid = projectRef.current
    const session = sessionRef.current
    if (!pid || !session) return
    const snap = await window.api.preview.design.snapshot().catch(() => null)
    if (!snap || !activeRef.current || sessionRef.current !== session || snap.sessionId !== session) return
    versionRef.current = snap.version
    routeRef.current = snap.route
    viewportRef.current = snap.viewport
    mirror(pid, snap.items)
  }, [mirror])

  const syncOnce = useCallback(async (): Promise<void> => {
    const api = window.api.preview.design
    const status = await api.poll()
    const pid = projectRef.current
    const session = sessionRef.current
    if (!activeRef.current || !status || !pid || !session) return
    const now = performance.now()
    if (!status.enabled) {
      // The page lost Design (a navigation raced the host's re-arm): arm it again.
      if (now - lastArmRef.current > REARM_RETRY_MS) void arm(false)
      return
    }
    if (status.sessionId !== session) {
      // A reload re-armed the page unseeded: hand it our copy of the queue.
      if (now - lastSeedRef.current > SEED_RETRY_MS) {
        lastSeedRef.current = now
        versionRef.current = -1
        await command({ op: 'seed', sessionId: session, items: queuesRef.current[pid] ?? [] })
      }
      return
    }
    const theme = readFabricatorTheme()
    const sig = JSON.stringify(theme)
    if (!status.hasTheme || sig !== themeSigRef.current) {
      themeSigRef.current = sig
      void api.setTheme(theme).catch(() => {})
    }
    setPanel(status.panel ?? null)
    if (status.version !== versionRef.current) await pullSnapshot()
    const focus = pendingFocusRef.current
    if (focus) {
      pendingFocusRef.current = null
      void command({ op: 'focusItem', id: focus })
    }
    for (const req of status.requests ?? []) {
      if (!answeredRef.current.has(req.id)) void answer(req)
    }
  }, [answer, arm, pullSnapshot, setPanel])

  // Poll the page while Design is on.
  useEffect(() => {
    if (!active) return
    let cancelled = false
    let timer = 0
    const tick = async (): Promise<void> => {
      try {
        await syncOnce()
      } catch {
        // transient — the next tick retries
      }
      if (!cancelled) timer = window.setTimeout(() => void tick(), POLL_MS)
    }
    timer = window.setTimeout(() => void tick(), POLL_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [active, syncOnce])

  // A different project or preview surface (project switch, Fabric toggle,
  // deploy, local preview) ends the session; the queue stays with its project.
  const surfaceKey = surface ? `${surface.url}|${surface.embedded ? 1 : 0}` : ''
  useEffect(() => {
    if (activeRef.current) void stop(false)
  }, [surfaceKey, projectId, stop])

  useEffect(
    () => () => {
      if (activeRef.current) void window.api.preview.design.setEnabled(false).catch(() => {})
    },
    []
  )

  const polish = useCallback((): void => {
    const pid = projectRef.current
    if (!pid || !activeRef.current || polishRef.current) return
    const run = newId()
    polishRef.current = run
    setPolishingSince(performance.now())
    const current = (): boolean => polishRef.current === run && activeRef.current
    // The review ends quietly if the user closed the Polish panel meanwhile.
    const stillOpen = async (): Promise<boolean> => {
      if (!current()) return false
      const status = await window.api.preview.design.poll().catch(() => null)
      return current() && status?.panel === 'polish'
    }
    void (async () => {
      let shotPath: string | undefined
      try {
        await command({ op: 'setBusy', message: 'Reading the page…' })
        const outlineId = newId()
        await command({ op: 'collectPage', requestId: outlineId })
        const page = await awaitResult<DesignPageOutline>(outlineId)
        if (!page) throw new Error('The page didn’t answer — try again.')
        if (!(await stillOpen())) return
        await command({ op: 'setBusy', message: 'Taking a screenshot…' })
        const captureId = newId()
        try {
          await command({ op: 'prepareCapture', requestId: captureId, ids: [] })
          if (await awaitResult<DesignCaptureLayout>(captureId)) {
            await sleep(CAPTURE_SETTLE_MS)
            const dataUrl = await window.api.preview.capture()
            shotPath = await window.api.screenshot.save(dataUrl)
          }
        } catch {
          // Review the outline alone.
        } finally {
          await command({ op: 'endCapture' })
        }
        if (!(await stillOpen())) return
        const model = await fastModel()
        await command({ op: 'setBusy', message: `Asking ${model.name ?? 'Copilot'} to review this page…` })
        const path = shotPath
        shotPath = undefined // design.polish deletes it
        const suggestions = await window.api.design.polish(pid, page, path, model.id)
        if (!(await stillOpen())) return
        await command({ op: 'showSuggestions', suggestions })
      } catch (err) {
        if (await stillOpen()) {
          await command({ op: 'showSuggestions', suggestions: [], message: errorText(err, 'The review didn’t finish — try again.') })
        }
      } finally {
        if (shotPath) void window.api.screenshot.cleanup([shotPath]).catch(() => {})
        if (polishRef.current === run) {
          polishRef.current = null
          setPolishingSince(null)
        }
      }
    })()
  }, [fastModel])

  /** Screenshot the previewed changes: one full view plus a crop per element. */
  const captureItems = useCallback(
    async (pid: string, items: DesignItem[]): Promise<Captured> => {
      const out: Captured = { full: null, crops: [] }
      const current = (): boolean => projectRef.current === pid
      if (!surfaceRef.current || !current()) return out
      const api = window.api.preview.design
      const wasActive = activeRef.current
      let tempSession: string | null = null
      if (!wasActive) {
        // The previews only exist while Design is on: switch it on for the capture.
        if (!(await arm(false))) return out
        tempSession = sessionRef.current
        let ready = false
        for (let i = 0; i < 25 && !ready && current(); i++) {
          const status = await api.poll().catch(() => null)
          ready = Boolean(status?.enabled && status.sessionId === tempSession)
          if (!ready) await sleep(80)
        }
        if (!ready) {
          if (!activeRef.current && sessionRef.current === tempSession) {
            sessionRef.current = null
            await api.setEnabled(false).catch(() => {})
          }
          return out
        }
      }
      const ids = items.map((item) => item.id)
      try {
        const requestId = newId()
        await command({ op: 'prepareCapture', requestId, ids })
        const layout = await awaitResult<DesignCaptureLayout>(requestId)
        if (!layout || !current()) return out
        await sleep(CAPTURE_SETTLE_MS)
        const dataUrl = await window.api.preview.capture()
        await command({ op: 'endCapture' })
        // A project switch mid-capture means the screenshot shows another app.
        if (!current()) return out
        out.viewport = layout.viewport
        const [path, thumb] = await Promise.all([window.api.screenshot.save(dataUrl), thumbnail(dataUrl)])
        out.full = { path, thumb }
        const crops = await cropItems(dataUrl, layout, ids).catch(() => ({}) as Record<string, string>)
        for (const id of ids) {
          const crop = crops[id]
          if (!crop || out.crops.length >= MAX_CROPS) continue
          const [cropPath, cropThumb] = await Promise.all([window.api.screenshot.save(crop), thumbnail(crop)])
          out.crops.push({ id, shot: { path: cropPath, thumb: cropThumb } })
        }
      } catch {
        // The turn still goes out, with whatever images were captured.
      } finally {
        await command({ op: 'endCapture' })
        // Leave the temporary session, unless the user switched Design on meanwhile.
        if (tempSession && !activeRef.current && sessionRef.current === tempSession) {
          sessionRef.current = null
          await api.setEnabled(false).catch(() => {})
        }
      }
      return out
    },
    [arm]
  )

  const buildTurn = useCallback(
    async (note: string, options?: { extraImages?: number }): Promise<DesignTurn | null> => {
      const pid = projectRef.current
      if (!pid) return null
      if (activeRef.current) await pullSnapshot()
      const items = queuesRef.current[pid] ?? []
      if (!items.length) return null
      setSending(true)
      try {
        const captured = await captureItems(pid, items)
        let locate: DesignLocateResult | null = null
        try {
          locate = await window.api.design.locate(pid, locateTargets(items))
        } catch {
          locate = null
        }
        const base = {
          note,
          items,
          locate,
          route: routeRef.current ?? items.find((item) => item.target)?.target?.route,
          viewport: captured.viewport ?? viewportRef.current
        }
        const shots = [...(captured.full ? [captured.full] : []), ...captured.crops.map((c) => c.shot)]
        const summary = summarizeDesign(items)
        if (captured.full) summary.full = 0
        captured.crops.forEach((crop, i) => {
          const index = items.findIndex((item) => item.id === crop.id)
          if (index >= 0) summary.items[index].shot = (captured.full ? 1 : 0) + i
        })
        return {
          projectId: pid,
          itemIds: items.map((item) => item.id),
          display: note.trim(),
          prompt: composeDesignPrompt({
            ...base,
            fullView: Boolean(captured.full),
            crops: captured.crops.map((c) => c.id),
            extraImages: options?.extraImages
          }),
          storedPrompt: composeDesignPrompt(base),
          shots,
          summary
        }
      } finally {
        setSending(false)
      }
    },
    [captureItems, pullSnapshot]
  )

  const finishSend = useCallback(
    (turn: Pick<DesignTurn, 'projectId' | 'itemIds'>): void => {
      const pid = turn.projectId
      const sent = new Set(turn.itemIds)
      sent.forEach((id) => sentRef.current.add(id))
      // Anything queued while the turn was being prepared stays for next time.
      writeQueue(pid, (queuesRef.current[pid] ?? []).filter((item) => !sent.has(item.id)))
      if (!activeRef.current || projectRef.current !== pid) return
      // While Design is on the page owns the queue: drop the sent changes there
      // too, then leave Design keeping whatever is left.
      void (async () => {
        for (const id of sent) await command({ op: 'removeItem', id })
        await stop(true)
      })()
    },
    [stop, writeQueue]
  )

  const removeItem = useCallback(
    (id: string): void => {
      const pid = projectRef.current
      if (!pid) return
      writeQueue(pid, (queuesRef.current[pid] ?? []).filter((item) => item.id !== id))
      if (activeRef.current) void command({ op: 'removeItem', id })
    },
    [writeQueue]
  )

  const clear = useCallback((): void => {
    const pid = projectRef.current
    if (!pid) return
    writeQueue(pid, [])
    if (activeRef.current) void command({ op: 'clear' })
  }, [writeQueue])

  const focusItem = useCallback(
    (id: string): void => {
      if (activeRef.current) {
        void command({ op: 'focusItem', id })
        return
      }
      if (!projectRef.current || !surfaceRef.current) return
      pendingFocusRef.current = id
      start()
    },
    [start]
  )

  const toggleTheme = useCallback((): void => {
    if (!activeRef.current) return
    const next = panelRef.current === 'theme' ? null : 'theme'
    setPanel(next)
    void command({ op: 'openPanel', panel: next })
  }, [setPanel])

  const toggle = useCallback((): void => {
    if (activeRef.current) void stop(true)
    else start()
  }, [start, stop])

  const items = projectId ? (queues[projectId] ?? EMPTY) : EMPTY
  return useMemo(
    () => ({
      available: Boolean(projectId && surface),
      active,
      items,
      panel,
      polishingSince,
      sending,
      device,
      toggle,
      stop: () => void stop(true),
      setDevice,
      toggleTheme,
      polish,
      removeItem,
      focusItem,
      clear,
      buildTurn,
      finishSend
    }),
    [
      projectId,
      surface,
      active,
      items,
      panel,
      polishingSince,
      sending,
      device,
      toggle,
      stop,
      toggleTheme,
      polish,
      removeItem,
      focusItem,
      clear,
      buildTurn,
      finishSend
    ]
  )
}
