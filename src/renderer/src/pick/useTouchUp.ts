import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatPickRef } from '@shared/ipc'
import type {
  PickCaptureLayout,
  PickCommand,
  PickEvent,
  PickLocateResult,
  PickRef,
  PickTarget
} from '@shared/pick'
import { viewCopy } from '../components/chat/images'
import { isMac } from '../platform'
import { cropItems, type StagedShot } from './capture'
import { readFabricatorTheme } from './hostTheme'
import { composePickPrompt, picksDisplay } from './prompt'

/**
 * Touch Up, owned by the Workbench: point at elements in the app in the
 * preview and hand them to the chat.
 *
 * While the app shows in the preview, the page is armed, so Ctrl+Shift+C works
 * there too, and this hook polls it: quickly while picking, slowly otherwise to
 * notice the page's own shortcut. The page reports what the user does as
 * events; the hook keeps the picks per project (with a crop of each) for the
 * chat composer, and sends them with the next message.
 */

/** While picking, the page is polled this often… */
const FAST_MS = 120
/** …and otherwise this often, so its own Ctrl+Shift+C is noticed quickly. */
const SLOW_MS = 400
/** A capture waits this long for the page to say where the elements are… */
const RESULT_TRIES = 25
const RESULT_GAP_MS = 40
/** …then lets it repaint without the highlight. */
const SETTLE_MS = 60
/** Widest a pick's or a clip's picture is kept, in pixels: sharp to enlarge and draw on. */
const CROP_WIDTH = 1600
/** The most a message waits for crops still being taken, and for source hints. */
const CROPS_WAIT_MS = 2500
const LOCATE_WAIT_MS = 2500
/** A page that lost its arming (a navigation raced the host) is armed again after this. */
const REARM_MS = 1500

/** The preview surface Touch Up runs on: the app on this computer, or the published one. */
export interface PickSurface {
  /** The URL the preview shows; switching it ends picking. */
  url: string
  /** The Fabric-embedded view, where the app runs in a cross-origin iframe. */
  embedded: boolean
  /** The direct app URL (its origin identifies the app iframe when embedded). */
  appUrl?: string
}

/** An element picked in the preview, waiting in the composer. */
export interface PickedElement {
  id: string
  /** Its number, as the preview shows it. */
  n: number
  target: PickTarget
  /** Its picture, once taken. */
  shot?: StagedShot
  /** Its picture is being taken. */
  capturing?: boolean
}

/** A message's picks, ready for the chat to send. */
export interface PickTurn {
  projectId: string
  ids: string[]
  /** What the transcript shows as the user's words. */
  display: string
  /** What Copilot receives (it refers to the attached pictures). */
  prompt: string
  /** What a Retry or Try again sends (the pictures are gone by then). */
  storedPrompt: string
  /** The picks' pictures, in pick order; attached before any other images. */
  shots: StagedShot[]
  picks: ChatPickRef[]
}

export interface TouchUp {
  /** Touch Up can run: the app shows in the preview. */
  available: boolean
  /** Picking is on. */
  on: boolean
  /** The active project's picks, in order. */
  picks: PickedElement[]
  toggle: () => void
  stop: () => void
  remove: (id: string) => void
  /** Outline a pick in the preview while its chip is hovered; `null` stops. */
  focus: (id: string | null) => void
  /** A pick's picture was drawn on: `shot` takes its place. */
  setShot: (id: string, shot: StagedShot) => void
  /** Compose the message for `note` (null when nothing is picked). */
  buildTurn: (note: string) => Promise<PickTurn | null>
  /** The message went out: its picks leave the composer and picking ends. */
  finishSend: (turn: Pick<PickTurn, 'projectId' | 'ids'>) => void
}

const NONE: PickedElement[] = []

function newId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

/** `promise`, or null once `ms` pass. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, sleep(ms).then(() => null)])
}

function command(cmd: PickCommand): Promise<void> {
  return window.api.preview.pick.command(cmd).catch(() => {})
}

function refs(list: PickedElement[]): PickRef[] {
  return list.map((p) => ({ id: p.id, n: p.n, selector: p.target.selector, route: p.target.route }))
}

function isShortcut(event: KeyboardEvent): boolean {
  const mod = isMac() ? event.metaKey : event.ctrlKey
  return mod && event.shiftKey && !event.altKey && event.code === 'KeyC'
}

/**
 * Touch Up for the active project. `onCapture` takes a screenshot of a region
 * clipped in the page (Shift+drag), to attach to the project's next message.
 */
export function useTouchUp(
  projectId: string | null,
  surface: PickSurface | null,
  onCapture: (projectId: string, shot: StagedShot) => void
): TouchUp {
  const [lists, setLists] = useState<Record<string, PickedElement[]>>({})
  const listsRef = useRef(lists)
  const [on, setOnState] = useState(false)
  const onRef = useRef(false)

  const projectRef = useRef(projectId)
  projectRef.current = projectId
  const surfaceRef = useRef(surface)
  surfaceRef.current = surface
  const onCaptureRef = useRef(onCapture)
  onCaptureRef.current = onCapture
  /** The page load the events come from, and the last event handled there. */
  const pageRef = useRef<string | null>(null)
  const seqRef = useRef(0)
  const themeRef = useRef('')
  const lastArmRef = useRef(0)
  /** Pictures are taken one at a time. */
  const queueRef = useRef<Promise<void>>(Promise.resolve())
  const available = Boolean(projectId && surface)

  const writeList = useCallback((pid: string, list: PickedElement[]): void => {
    listsRef.current = { ...listsRef.current, [pid]: list }
    setLists(listsRef.current)
  }, [])
  const listFor = useCallback(
    (pid: string | null): PickedElement[] => (pid ? (listsRef.current[pid] ?? NONE) : NONE),
    []
  )
  const updatePick = useCallback(
    (pid: string, id: string, patch: Partial<PickedElement>): void => {
      writeList(
        pid,
        listFor(pid).map((p) => (p.id === id ? { ...p, ...patch } : p))
      )
    },
    [listFor, writeList]
  )

  /** Hand the page our state: armed, on or off, our picks and Fabricator's theme. */
  const apply = useCallback(async (): Promise<void> => {
    const s = surfaceRef.current
    if (!s || !projectRef.current) return
    const theme = readFabricatorTheme()
    themeRef.current = JSON.stringify(theme)
    lastArmRef.current = performance.now()
    await window.api.preview.pick
      .set(true, onRef.current, s.embedded, s.appUrl, {
        theme,
        picks: refs(listFor(projectRef.current))
      })
      .catch(() => {})
  }, [listFor])

  const setOn = useCallback(
    (next: boolean): void => {
      onRef.current = next
      setOnState(next)
      void apply()
    },
    [apply]
  )

  /** Wait for a data-returning command's result to show up in `poll().results`. */
  const awaitResult = useCallback(async <T>(requestId: string): Promise<T | null> => {
    for (let i = 0; i < RESULT_TRIES; i++) {
      const status = await window.api.preview.pick
        .poll(pageRef.current, seqRef.current)
        .catch(() => null)
      const value = status?.results?.[requestId]
      if (value !== undefined && value !== null) return value as T
      await sleep(RESULT_GAP_MS)
    }
    return null
  }, [])

  /**
   * Take a picture of the preview with the highlight hidden, and cut out each
   * of `ids`. `flash` makes the page flash the element afterwards, as a
   * screenshot does.
   */
  const crop = useCallback(
    async (ids: string[], flash?: string): Promise<Record<string, string>> => {
      const requestId = newId()
      let ended = false
      try {
        await command({ op: 'prepareCapture', requestId, ids })
        const layout = await awaitResult<PickCaptureLayout>(requestId)
        if (!layout || !Object.keys(layout.rects).length) return {}
        await sleep(SETTLE_MS)
        const dataUrl = await window.api.preview.capture()
        ended = true
        await command({ op: 'endCapture', flash })
        return await cropItems(dataUrl, layout, ids, CROP_WIDTH, 6)
      } catch {
        return {}
      } finally {
        if (!ended) await command({ op: 'endCapture' })
      }
    },
    [awaitResult]
  )

  const enqueue = useCallback((job: () => Promise<void>): Promise<void> => {
    const next = queueRef.current.then(job, job)
    queueRef.current = next.catch(() => {})
    return next
  }, [])

  /** Take a pick's picture for its chip and for Copilot. */
  const shootPick = useCallback(
    (pid: string, id: string): void => {
      void enqueue(async () => {
        if (!listFor(pid).some((p) => p.id === id)) return
        const crops = await crop([id])
        const image = crops[id]
        let shot: StagedShot | undefined
        if (image) {
          try {
            const [path, thumb] = await Promise.all([
              window.api.screenshot.save(image),
              viewCopy(image)
            ])
            shot = { path, thumb }
          } catch {
            shot = undefined
          }
        }
        // It may have been dropped while its picture was being taken.
        if (!listFor(pid).some((p) => p.id === id)) {
          if (shot) void window.api.screenshot.cleanup([shot.path]).catch(() => {})
          return
        }
        updatePick(pid, id, { shot, capturing: false })
      })
    },
    [crop, enqueue, listFor, updatePick]
  )

  /** A clip (Shift+drag): attach a screenshot of the region to the next message. */
  const shootClip = useCallback(
    (pid: string, id: string): void => {
      void enqueue(async () => {
        const crops = await crop([id], id)
        const image = crops[id]
        if (!image || projectRef.current !== pid) return
        try {
          const [path, thumb] = await Promise.all([
            window.api.screenshot.save(image),
            viewCopy(image)
          ])
          onCaptureRef.current(pid, { path, thumb })
        } catch {
          // Nothing to attach.
        }
      })
    },
    [crop, enqueue]
  )

  /**
   * Follow one event from the page. True when the page needs our state back:
   * picking came on or went off there, or its numbering differs from ours. The
   * caller hands it over once the whole batch is followed, because handing over
   * our picks before a pick later in the batch is added makes the page drop it.
   */
  const handle = useCallback(
    (pid: string, event: PickEvent): boolean => {
      switch (event.type) {
        case 'enter':
        case 'exit': {
          const next = event.type === 'enter'
          if (onRef.current === next) return false
          onRef.current = next
          setOnState(next)
          return true
        }
        case 'pick': {
          const list = listFor(pid)
          if (list.some((p) => p.id === event.pick.id)) return false
          const picked: PickedElement = {
            id: event.pick.id,
            n: list.length + 1,
            target: event.pick.target,
            capturing: Boolean(event.pick.rect)
          }
          writeList(pid, [...list, picked])
          if (event.pick.rect) shootPick(pid, picked.id)
          return picked.n !== event.pick.n
        }
        case 'unpick': {
          const list = listFor(pid)
          const gone = list.find((p) => p.id === event.id)
          if (!gone) break
          if (gone.shot) void window.api.screenshot.cleanup([gone.shot.path]).catch(() => {})
          writeList(
            pid,
            list.filter((p) => p.id !== event.id).map((p, i) => ({ ...p, n: i + 1 }))
          )
          break
        }
        case 'capture':
          if (event.capture.rect) shootClip(pid, event.capture.id)
          break
      }
      return false
    },
    [listFor, shootClip, shootPick, writeList]
  )

  const syncOnce = useCallback(async (): Promise<void> => {
    const pid = projectRef.current
    if (!pid || !surfaceRef.current) return
    const status = await window.api.preview.pick.poll(pageRef.current, seqRef.current)
    if (!status || !status.page || projectRef.current !== pid || !surfaceRef.current) return
    // A new page load starts from its first event, and gets our picks and theme back.
    let reapply = status.page !== pageRef.current
    if (reapply) {
      pageRef.current = status.page
      seqRef.current = 0
    } else if (
      (!status.armed || JSON.stringify(readFabricatorTheme()) !== themeRef.current) &&
      performance.now() - lastArmRef.current > REARM_MS
    ) {
      reapply = true
    }
    for (const event of status.events) {
      if (event.seq <= seqRef.current) continue
      seqRef.current = event.seq
      if (handle(pid, event)) reapply = true
    }
    if (reapply) void apply()
  }, [apply, handle])

  // Arm the page while the app shows; a new project or surface ends picking.
  // The host keeps its place in the page's events: the preview keeps the same
  // page when the Build view comes back, and its events from before were
  // followed then. A page that loads afresh starts its events again.
  const surfaceKey = surface
    ? `${surface.url}|${surface.embedded ? 1 : 0}|${surface.appUrl ?? ''}`
    : ''
  useEffect(() => {
    onRef.current = false
    setOnState(false)
    if (!projectId || !surfaceKey) {
      void window.api.preview.pick.set(false, false).catch(() => {})
      return
    }
    void apply()
  }, [projectId, surfaceKey, apply])
  useEffect(() => () => void window.api.preview.pick.set(false, false).catch(() => {}), [])

  // Poll the page while it's armed.
  useEffect(() => {
    if (!available) return
    let cancelled = false
    let timer = 0
    const tick = async (): Promise<void> => {
      if (document.visibilityState !== 'hidden') {
        try {
          await syncOnce()
        } catch {
          // transient: the next tick tries again
        }
      }
      if (!cancelled)
        timer = window.setTimeout(() => void tick(), onRef.current ? FAST_MS : SLOW_MS)
    }
    timer = window.setTimeout(() => void tick(), FAST_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [available, syncOnce])

  const toggle = useCallback((): void => {
    if (!projectRef.current || !surfaceRef.current) return
    setOn(!onRef.current)
  }, [setOn])

  // Ctrl+Shift+C (Cmd+Shift+C on macOS) toggles picking while Fabricator has the
  // keyboard; the page catches it while the preview does.
  useEffect(() => {
    if (!available) return
    const onKey = (event: KeyboardEvent): void => {
      if (!isShortcut(event) || event.repeat) return
      event.preventDefault()
      event.stopPropagation()
      toggle()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [available, toggle])

  const stop = useCallback((): void => {
    if (onRef.current) setOn(false)
  }, [setOn])

  const remove = useCallback(
    (id: string): void => {
      const pid = projectRef.current
      if (!pid) return
      const list = listFor(pid)
      const gone = list.find((p) => p.id === id)
      if (!gone) return
      if (gone.shot) void window.api.screenshot.cleanup([gone.shot.path]).catch(() => {})
      const next = list.filter((p) => p.id !== id).map((p, i) => ({ ...p, n: i + 1 }))
      writeList(pid, next)
      if (surfaceRef.current) void command({ op: 'sync', picks: refs(next) })
    },
    [listFor, writeList]
  )

  const focus = useCallback((id: string | null): void => {
    if (surfaceRef.current) void command({ op: 'focus', id })
  }, [])

  const setShot = useCallback(
    (id: string, shot: StagedShot): void => {
      const pid = projectRef.current
      const pick = pid ? listFor(pid).find((p) => p.id === id) : undefined
      if (!pid || !pick) {
        // It went out with a message, or was dropped, while the drawing was saved.
        void window.api.screenshot.cleanup([shot.path]).catch(() => {})
        return
      }
      if (pick.shot) void window.api.screenshot.cleanup([pick.shot.path]).catch(() => {})
      updatePick(pid, id, { shot, capturing: false })
    },
    [listFor, updatePick]
  )

  const buildTurn = useCallback(
    async (note: string): Promise<PickTurn | null> => {
      const pid = projectRef.current
      if (!pid || !listFor(pid).length) return null
      // Pictures still being taken go out with the message when they're ready soon.
      await within(queueRef.current, CROPS_WAIT_MS)
      const picks = listFor(pid)
      if (!picks.length) return null
      const locate: PickLocateResult | null = await within(
        window.api.pick
          .locate(
            pid,
            picks.map((p) => ({
              key: p.id,
              tag: p.target.tag,
              classes: p.target.classes,
              text: p.target.text,
              chartTitle: p.target.chart?.title,
              chartType: p.target.chart?.type
            }))
          )
          .catch(() => null),
        LOCATE_WAIT_MS
      )
      const pictured = picks.filter((p) => p.shot)
      const images: Record<string, number> = {}
      pictured.forEach((p, i) => (images[p.id] = i + 1))
      const base = { note, picks, locate }
      return {
        projectId: pid,
        ids: picks.map((p) => p.id),
        display: picksDisplay(note, picks.length),
        prompt: composePickPrompt({ ...base, images }),
        storedPrompt: composePickPrompt(base),
        shots: pictured.map((p) => p.shot!),
        picks: picks.map((p) => ({
          n: p.n,
          label: p.target.label,
          shot: p.shot ? pictured.indexOf(p) : undefined
        }))
      }
    },
    [listFor]
  )

  const finishSend = useCallback(
    (turn: Pick<PickTurn, 'projectId' | 'ids'>): void => {
      const sent = new Set(turn.ids)
      // Anything picked while the message was being composed stays for the next one.
      const left = listFor(turn.projectId)
        .filter((p) => !sent.has(p.id))
        .map((p, i) => ({ ...p, n: i + 1 }))
      writeList(turn.projectId, left)
      if (projectRef.current !== turn.projectId || !surfaceRef.current) return
      if (onRef.current) setOn(false)
      else void apply()
    },
    [apply, listFor, setOn, writeList]
  )

  return {
    available,
    on,
    picks: projectId ? (lists[projectId] ?? NONE) : NONE,
    toggle,
    stop,
    remove,
    focus,
    setShot,
    buildTurn,
    finishSend
  }
}
