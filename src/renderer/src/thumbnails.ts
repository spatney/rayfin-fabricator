/**
 * Project thumbnails: a small picture of each project's app, drawn from the
 * preview once the app's own page has loaded (when the last one is over half
 * an hour old, and again after a publish) and kept by the core
 * (`projects.saveThumbnail`). Home and the app gallery show them in place of a
 * project's letters.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { StudioProject } from '@shared/ipc'

/** Thumbnails are 16:10, this many pixels. */
export const THUMB_WIDTH = 480
export const THUMB_HEIGHT = 300
/** A thumbnail younger than this isn't drawn again (unless a publish asks). */
const FRESH_MS = 30 * 60_000
/** How long the app's page settles after loading before it's drawn: apps fetch their data then. */
export const SETTLE_MS = 2500

type Listener = () => void
type Thumbed = Pick<StudioProject, 'id' | 'thumbnailAt'>

interface Entry {
  /** When the image was saved (RFC 3339). */
  at: string
  url: string
}

/** The latest of two RFC 3339 times, either of which may be missing. */
function later(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b
  if (!b) return a
  return Date.parse(a) >= Date.parse(b) ? a : b
}

/** The thumbnails read so far, by project id, for every view that shows them. */
export class ThumbnailStore {
  private entries = new Map<string, Entry>()
  private reading = new Set<string>()
  private stale = new Set<string>()
  private listeners = new Set<Listener>()
  private version = 0

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Changes whenever a thumbnail does (for `useSyncExternalStore`). */
  snapshot = (): number => this.version

  private emit(): void {
    this.version += 1
    this.listeners.forEach((listener) => listener())
  }

  /** A project's thumbnail as a `data:` URL, once it's been read. */
  get(projectId: string): string | undefined {
    return this.entries.get(projectId)?.url
  }

  private holds(projectId: string, at: string): boolean {
    const entry = this.entries.get(projectId)
    return Boolean(entry && Date.parse(entry.at) >= Date.parse(at))
  }

  /** Read the thumbnails these projects have that aren't here yet, or are newer. */
  async load(projects: readonly Thumbed[]): Promise<void> {
    const wanted = projects.filter(
      (p): p is Thumbed & { thumbnailAt: string } =>
        Boolean(p.thumbnailAt) && !this.reading.has(p.id) && !this.holds(p.id, p.thumbnailAt ?? '')
    )
    if (wanted.length === 0) return
    for (const p of wanted) this.reading.add(p.id)
    let urls: Record<string, string> = {}
    try {
      urls = await window.api.projects.thumbnails(wanted.map((p) => p.id))
    } catch {
      // The letters stay.
    } finally {
      for (const p of wanted) this.reading.delete(p.id)
    }
    let changed = false
    for (const p of wanted) {
      const url = urls[p.id]
      if (url && !this.holds(p.id, p.thumbnailAt)) {
        this.entries.set(p.id, { at: p.thumbnailAt, url })
        changed = true
      }
    }
    if (changed) this.emit()
  }

  /** A thumbnail just drawn and saved. */
  put(projectId: string, at: string, url: string): void {
    this.entries.set(projectId, { at, url })
    this.stale.delete(projectId)
    this.emit()
  }

  /** Draw the project's thumbnail again at the next chance (it was just published). */
  markStale(projectId: string): void {
    this.stale.add(projectId)
  }

  /** Whether the project's thumbnail should be drawn now: it has none, it's old, or a publish asked. */
  due(projectId: string, thumbnailAt: string | undefined, now = Date.now()): boolean {
    if (this.stale.has(projectId)) return true
    const at = later(thumbnailAt, this.entries.get(projectId)?.at)
    const time = at ? Date.parse(at) : NaN
    return !Number.isFinite(time) || now - time > FRESH_MS
  }

  /** Forget everything (tests). */
  clear(): void {
    this.entries.clear()
    this.reading.clear()
    this.stale.clear()
    this.emit()
  }
}

/** The app-wide store Home and the gallery read. */
export const thumbnailStore = new ThumbnailStore()

/**
 * The projects' thumbnails, read as they change (their `thumbnailAt`): a
 * lookup by project id that gives `undefined` until one has been read.
 */
export function useThumbnails(
  projects: readonly Thumbed[]
): (projectId: string) => string | undefined {
  useSyncExternalStore(thumbnailStore.subscribe, thumbnailStore.snapshot)
  const latest = useRef(projects)
  latest.current = projects
  const key = projects.map((p) => `${p.id}@${p.thumbnailAt ?? ''}`).join('|')
  useEffect(() => {
    void thumbnailStore.load(latest.current)
  }, [key])
  return (projectId) => thumbnailStore.get(projectId)
}

/** Whether a drawn picture is all one colour, as a page that hasn't painted yet is. */
function blank(context: CanvasRenderingContext2D): boolean {
  const { data } = context.getImageData(0, 0, THUMB_WIDTH, THUMB_HEIGHT)
  const [r, g, b] = [data[0], data[1], data[2]]
  let differing = 0
  let sampled = 0
  // Every 8th pixel of every 8th row is plenty to tell.
  for (let y = 0; y < THUMB_HEIGHT; y += 8) {
    for (let x = 0; x < THUMB_WIDTH; x += 8) {
      const i = (y * THUMB_WIDTH + x) * 4
      sampled += 1
      if (Math.abs(data[i] - r) + Math.abs(data[i + 1] - g) + Math.abs(data[i + 2] - b) > 24)
        differing += 1
    }
  }
  return differing / sampled < 0.01
}

/**
 * Draw a captured preview (a PNG `data:` URL, at the preview's full size) as a
 * thumbnail: 16:10, the top of the page, as WebP. `null` when it can't be
 * drawn, or the page hadn't painted anything yet.
 */
export async function drawThumbnail(png: string): Promise<string | null> {
  const image = new Image()
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('The capture couldn’t be read.'))
    image.src = png
  })
  const { naturalWidth: width, naturalHeight: height } = image
  if (!width || !height) return null
  const canvas = document.createElement('canvas')
  canvas.width = THUMB_WIDTH
  canvas.height = THUMB_HEIGHT
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return null
  const scale = Math.max(THUMB_WIDTH / width, THUMB_HEIGHT / height)
  const [sw, sh] = [THUMB_WIDTH / scale, THUMB_HEIGHT / scale]
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, (width - sw) / 2, 0, sw, sh, 0, 0, THUMB_WIDTH, THUMB_HEIGHT)
  if (blank(context)) return null
  const url = canvas.toDataURL('image/webp', 0.82)
  return url.startsWith('data:image/webp') ? url : null
}

/**
 * Draws the open project's thumbnail from the preview: told when the app's own
 * page finishes loading (and when the preview moves on), and when a publish
 * ends, it waits for the page to settle, then captures and keeps it.
 */
export class ThumbnailCapture {
  private timer: number | null = null
  private shown: string | null = null
  private busy = false

  /**
   * `isOpen` says whether a project is still the one the preview shows;
   * `draw` turns a capture into a thumbnail.
   */
  constructor(
    private readonly isOpen: (projectId: string) => boolean,
    private readonly draw: (png: string) => Promise<string | null> = drawThumbnail
  ) {}

  /** The project's own page finished loading in the preview. */
  appLoaded(projectId: string, thumbnailAt: string | undefined): void {
    this.shown = projectId
    this.cancel()
    if (thumbnailStore.due(projectId, thumbnailAt)) this.schedule(projectId)
  }

  /** The preview is loading another page, or shows something else than the app. */
  left(): void {
    this.shown = null
    this.cancel()
  }

  /** A publish finished: draw the project again, now when its page is on screen. */
  published(projectId: string): void {
    thumbnailStore.markStale(projectId)
    if (this.shown === projectId) this.schedule(projectId)
  }

  cancel(): void {
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(projectId: string): void {
    this.cancel()
    this.timer = window.setTimeout(() => {
      this.timer = null
      void this.capture(projectId)
    }, SETTLE_MS)
  }

  private still(projectId: string): boolean {
    return this.shown === projectId && this.isOpen(projectId)
  }

  private async capture(projectId: string): Promise<void> {
    if (this.busy || !this.still(projectId)) return
    this.busy = true
    try {
      const png = await window.api.preview.capture()
      if (!this.still(projectId)) return
      const image = await this.draw(png)
      if (!image) return
      const at = await window.api.projects.saveThumbnail(projectId, image)
      thumbnailStore.put(projectId, at, image)
    } catch {
      // Best-effort: a hidden preview can't be captured, and the letters stay.
    } finally {
      this.busy = false
    }
  }
}
