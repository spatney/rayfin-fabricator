/**
 * The app gallery's memory of what's been opened, and of the apps it last
 * read: the Recently opened order and Search (Ctrl+K) both use it, so an app
 * opened from either counts, and Search can find apps without the gallery open.
 */
import type { GalleryApp, GalleryResult, GalleryStatus } from '@shared/ipc'
import { pinKey } from './model'

const OPENED_KEY = 'rayfin.gallery.opened'
/** Apps remembered as opened; the oldest are forgotten past this. */
const OPENED_MAX = 200

/** When each app was last opened from Fabricator (ms), by `pinKey`. */
export function openedTimes(): Record<string, number> {
  try {
    const saved = JSON.parse(localStorage.getItem(OPENED_KEY) ?? '{}') as unknown
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {}
    return Object.fromEntries(
      Object.entries(saved).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === 'number' && Number.isFinite(entry[1])
      )
    )
  } catch {
    return {}
  }
}

/** Note that an app was opened (its page, its Fabric page, or its project). */
export function noteOpened(app: Pick<GalleryApp, 'id'>, at = Date.now()): void {
  const times = { ...openedTimes(), [pinKey(app)]: at }
  const kept = Object.entries(times)
    .sort((a, b) => b[1] - a[1])
    .slice(0, OPENED_MAX)
  try {
    localStorage.setItem(OPENED_KEY, JSON.stringify(Object.fromEntries(kept)))
  } catch {
    // Storage is full or off: the order just won't remember it.
  }
}

/** The apps last read, so the gallery opens on them at once while it checks Fabric again. */
export interface GallerySnapshot {
  result: GalleryResult
  statuses: Record<string, GalleryStatus>
}

let snapshot: GallerySnapshot | null = null
let reading: Promise<GallerySnapshot | null> | null = null
const listeners = new Set<() => void>()

export function gallerySnapshot(): GallerySnapshot | null {
  return snapshot
}

/** The apps last read, with their own addresses once known: what Search lists. */
export function searchableApps(): Array<{ app: GalleryApp; address?: string }> {
  const current = snapshot
  if (!current) return []
  return current.result.apps.map((app) => ({
    app,
    address: current.statuses[app.id]?.hostingUrl ?? app.hostingUrl
  }))
}

export function setGallerySnapshot(next: GallerySnapshot | null): void {
  const listChanged = next?.result !== snapshot?.result
  snapshot = next
  // Statuses arrive in many small batches; listeners hear only of new lists.
  if (listChanged) listeners.forEach((listener) => listener())
}

/** Hear when the apps read change (Search lists them). */
export function onGallerySnapshot(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Read the apps once, for Search, when the gallery hasn't yet this session.
 * Quietly nothing when Azure isn't signed in or Fabric can't be reached.
 */
export function readGalleryOnce(): Promise<GallerySnapshot | null> {
  if (snapshot) return Promise.resolve(snapshot)
  reading ??= Promise.resolve()
    .then(() => window.api.gallery.list(false))
    .then((result) => {
      if (!result.ok) return null
      // The gallery may have read them meanwhile, with statuses: keep those.
      if (!snapshot) setGallerySnapshot({ result, statuses: {} })
      return snapshot
    })
    .catch(() => null)
  return reading
}

/** Test seam: forget the apps read and the read in flight. */
export function resetGallerySnapshotForTests(): void {
  snapshot = null
  reading = null
}
