/**
 * What Home and the app gallery show about the projects on this computer
 * besides their records: the newest Rayfin releases (to offer updates), which
 * published projects changed since they were published, and which run on this
 * computer.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { RayfinLatest, StudioProject } from '@shared/ipc'
import { localBackendStore } from './localBackend'

/** Published projects checked for unpublished changes at once (each runs git). */
const CHECKS_AT_ONCE = 4

/** The newest Rayfin releases, read once per launch. */
let latestRead: Promise<RayfinLatest | null> | null = null
/** Whether each published project changed since, as last checked. */
const changedSeen = new Map<string, boolean>()

/** Test seam: forget what's been read. */
export function resetProjectFactsForTests(): void {
  latestRead = null
  changedSeen.clear()
}

function readLatest(): Promise<RayfinLatest | null> {
  // Without an answer, nothing offers an update.
  latestRead ??= Promise.resolve()
    .then(() => window.api.rayfin.latest())
    .catch(() => null)
  return latestRead
}

/** For when there's no local backend to follow. */
const nothingToFollow = (): (() => void) => () => {}

/** The project's publish is one Fabricator records here, and can compare its folder with. */
function comparable(project: StudioProject): boolean {
  return !project.team && !project.missing && project.lastDeploy?.status === 'success'
}

export interface ProjectFacts {
  /** The newest Rayfin releases; `null` until read, or when npm can't be reached. */
  latest: RayfinLatest | null
  /** Whether each published project changed since it was published, by id, once checked. */
  changed: ReadonlyMap<string, boolean>
  /** Projects whose backend runs (or starts) on this computer. */
  running: ReadonlySet<string>
}

/**
 * The facts about `projects`, checked each time a view using it shows: their
 * folders against their last publish (a few at a time), and their local
 * backends. Earlier answers show meanwhile.
 */
export function useProjectFacts(projects: readonly StudioProject[]): ProjectFacts {
  const [latest, setLatest] = useState<RayfinLatest | null>(null)
  const [changed, setChanged] = useState<ReadonlyMap<string, boolean>>(() => new Map(changedSeen))
  const current = useRef(projects)
  current.current = projects

  useEffect(() => {
    let live = true
    void readLatest().then((value) => {
      if (live) setLatest(value)
    })
    return () => {
      live = false
    }
  }, [])

  const published = projects
    .filter(comparable)
    .map((p) => `${p.id}@${p.lastDeploy?.at ?? ''}`)
    .join('|')
  useEffect(() => {
    let live = true
    const queue = current.current.filter(comparable).map((p) => p.id)
    const next = async (): Promise<void> => {
      for (let id = queue.shift(); id && live; id = queue.shift()) {
        try {
          const value = await window.api.deploy.hasChanges(id)
          changedSeen.set(id, value)
          if (live) setChanged((all) => new Map(all).set(id, value))
        } catch {
          // Git couldn't say: the status stays as it was.
        }
      }
    }
    for (let i = 0; i < CHECKS_AT_ONCE; i += 1) void next()
    return () => {
      live = false
    }
  }, [published])

  const local = projects
    .filter((p) => !p.team && !p.missing)
    .map((p) => p.id)
    .join('|')
  useEffect(() => {
    for (const id of local.split('|').filter(Boolean)) {
      void localBackendStore.refresh(id).catch(() => undefined)
    }
  }, [local])
  const follow = local !== ''
  const runningKey = useSyncExternalStore(
    follow ? localBackendStore.subscribe : nothingToFollow,
    () => (follow ? localBackendStore.activeProjects().sort().join('|') : '')
  )
  const running = useMemo(() => new Set(runningKey.split('|').filter(Boolean)), [runningKey])

  return { latest, changed, running }
}
