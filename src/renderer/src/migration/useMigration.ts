/**
 * Drives a project's report migration from the workbench: follows its state,
 * draws the exported PDF's pages once they arrive, starts the first page's
 * turn on its own, and runs "Migrate next page" and "Migrate the rest".
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MigrationState, StudioProject } from '@shared/ipc'
import { isFresh, materialReady, migrationTurn, needsDrawing, nextPage, type MigrationTurn } from './turns'

/** How long a chained page waits after the previous turn for its deploy to begin. */
const CHAIN_DELAY_MS = 1500

interface Options {
  /** The Migrate Power BI reports experiment is on. */
  enabled: boolean
  /** The open project. */
  project: StudioProject | null
  /**
   * A migration turn can start in the open project now: it's deployed (or a team
   * app), its tools are ready, the Build chat is showing and idle, and no deploy runs.
   */
  canStart: boolean
  /** Send a migration turn to the project's chat. */
  send: (projectId: string, turn: MigrationTurn) => void
  onError: (message: string) => void
}

export interface MigrationControl {
  /** The open project's migration, or null. */
  state: MigrationState | null
  /** Its exported pages are being drawn. */
  drawing: boolean
  /** "Migrate the rest" is on. */
  chaining: boolean
  migrateNext: () => void
  migrateRest: () => void
  stopRest: () => void
  retry: (index: number) => void
  /** Stop exporting pages; Copilot works from the definition. */
  skipImages: () => void
  dismiss: () => void
  /** The workbench reports every finished turn… */
  onTurnComplete: (projectId: string, ok: boolean) => void
  /** …and when its after-turn work (saving, starting a deploy) is done. */
  onTurnSettled: (projectId: string) => void
}

const message = (reason: unknown, fallback: string): string =>
  reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : fallback

export function useMigration(options: Options): MigrationControl {
  const { enabled, project, canStart } = options
  const projectId = project?.id ?? null
  const [states, setStates] = useState<Record<string, MigrationState | null>>({})
  const [drawingIds, setDrawingIds] = useState<ReadonlySet<string>>(() => new Set())
  const [chainIds, setChainIds] = useState<ReadonlySet<string>>(() => new Set())
  const [settleTick, setSettleTick] = useState(0)
  /** The page whose turn is running, by project. */
  const inflight = useRef(new Map<string, number>())
  /** Projects with no turn, and no turn's after-work, under way. */
  const settled = useRef(new Set<string>())
  const loaded = useRef(new Set<string>())
  const drawingRef = useRef(new Set<string>())
  const latest = useRef(options)
  latest.current = options
  const statesRef = useRef(states)
  statesRef.current = states

  const put = useCallback((id: string, state: MigrationState | null): void => {
    setStates((all) => ({ ...all, [id]: state }))
  }, [])

  const setChain = useCallback((id: string, on: boolean): void => {
    setChainIds((ids) => {
      if (ids.has(id) === on) return ids
      const next = new Set(ids)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  useEffect(() => {
    if (!enabled) return
    return window.api.migration.onState((event) => put(event.projectId, event.state))
  }, [enabled, put])

  // Load the open project's migration, picking up gathering a restart interrupted.
  useEffect(() => {
    if (!enabled || !projectId || loaded.current.has(projectId)) return
    loaded.current.add(projectId)
    void (async () => {
      try {
        let state = await window.api.migration.resume(projectId)
        // A page turn cut off by a restart can't finish: offer it again.
        if (state && !inflight.current.has(projectId)) {
          for (const [index, page] of state.pages.entries()) {
            if (page.status === 'running') state = await window.api.migration.setPageStatus(projectId, index, 'failed')
          }
        }
        settled.current.add(projectId)
        put(projectId, state)
      } catch (reason) {
        loaded.current.delete(projectId)
        latest.current.onError(message(reason, 'Could not load the report migration.'))
      }
    })()
  }, [enabled, projectId, put])

  // Draw exported pages as they arrive, for any project (it may not be open).
  useEffect(() => {
    if (!enabled) return
    for (const [id, state] of Object.entries(states)) {
      if (!state || !needsDrawing(state) || drawingRef.current.has(id)) continue
      drawingRef.current.add(id)
      setDrawingIds(new Set(drawingRef.current))
      void drawPages(id, state, put).finally(() => {
        drawingRef.current.delete(id)
        setDrawingIds(new Set(drawingRef.current))
      })
    }
  }, [enabled, states, put])

  const start = useCallback(
    async (id: string, index: number | null): Promise<void> => {
      const state = statesRef.current[id]
      const open = latest.current.project
      if (index === null || !state || !open || open.id !== id || inflight.current.has(id)) return
      const turn = migrationTurn(state, index, open.path)
      inflight.current.set(id, index)
      settled.current.delete(id)
      try {
        put(id, await window.api.migration.setPageStatus(id, index, 'running'))
      } catch (reason) {
        latest.current.onError(message(reason, 'Could not save the migration.'))
      }
      latest.current.send(id, turn)
    },
    [put]
  )

  const state = projectId ? (states[projectId] ?? null) : null

  // The first page starts by itself once the material is ready and a turn can
  // run, after a restart too: until a page has started, the migration waits for it.
  useEffect(() => {
    if (!enabled || !projectId || !state || !canStart || state.dismissed) return
    if (!isFresh(state) || !materialReady(state) || !settled.current.has(projectId)) return
    void start(projectId, nextPage(state))
  }, [enabled, projectId, state, canStart, start, settleTick])

  // "Migrate the rest": the next page starts once the last turn's deploy is under way and done.
  useEffect(() => {
    if (!enabled || !projectId || !state || !canStart || !chainIds.has(projectId)) return
    if (inflight.current.has(projectId) || !settled.current.has(projectId)) return
    const id = projectId
    const timer = window.setTimeout(() => {
      const current = statesRef.current[id]
      if (!latest.current.canStart || !current || inflight.current.has(id)) return
      const next = nextPage(current)
      if (next === null) setChain(id, false)
      else void start(id, next)
    }, CHAIN_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [enabled, projectId, state, canStart, chainIds, start, setChain, settleTick])

  const onTurnComplete = useCallback(
    (id: string, ok: boolean): void => {
      const index = inflight.current.get(id)
      if (index === undefined) {
        // Your own message pauses "Migrate the rest".
        setChain(id, false)
        return
      }
      inflight.current.delete(id)
      if (!ok) setChain(id, false)
      void window.api.migration
        .setPageStatus(id, index, ok ? 'done' : 'failed')
        .then((next) => put(id, next))
        .catch((reason) => latest.current.onError(message(reason, 'Could not save the migration.')))
    },
    [put, setChain]
  )

  const onTurnSettled = useCallback((id: string): void => {
    if (inflight.current.has(id)) return
    settled.current.add(id)
    setSettleTick((n) => n + 1)
  }, [])

  return {
    state: enabled ? state : null,
    drawing: Boolean(projectId && drawingIds.has(projectId)),
    chaining: Boolean(projectId && chainIds.has(projectId)),
    migrateNext: () => {
      if (projectId && state) void start(projectId, nextPage(state))
    },
    migrateRest: () => {
      if (!projectId || !state) return
      setChain(projectId, true)
      void start(projectId, nextPage(state))
    },
    stopRest: () => {
      if (projectId) setChain(projectId, false)
    },
    retry: (index) => {
      if (projectId) void start(projectId, index)
    },
    skipImages: () => {
      if (projectId) void window.api.migration.cancel(projectId)
    },
    dismiss: () => {
      if (!projectId) return
      void window.api.migration
        .dismiss(projectId, true)
        .then((next) => put(projectId, next))
        .catch((reason) => latest.current.onError(message(reason, 'Could not close the migration card.')))
    },
    onTurnComplete,
    onTurnSettled
  }
}

/** Draw a migration's exported PDFs as page images and text, in page order. */
async function drawPages(
  id: string,
  state: MigrationState,
  put: (id: string, state: MigrationState | null) => void
): Promise<void> {
  try {
    const { countPdfPages, drawPdfPages } = await import('./pdfPages')
    // Images are matched to pages by position, so every requested page must be there.
    const expected = state.pages.filter((p) => p.name).length
    if (expected > 0) {
      let total = 0
      for (let file = 0; file < state.pdfs.length; file++) {
        total += await countPdfPages(await window.api.migration.pdf(id, file))
      }
      if (total !== expected) {
        put(
          id,
          await window.api.migration.finishImages(
            id,
            `The export has ${total} of the report’s ${expected} pages, so Copilot works without page images.`
          )
        )
        return
      }
    }
    let drawn = 0
    for (let file = 0; file < state.pdfs.length; file++) {
      const bytes = await window.api.migration.pdf(id, file)
      const offset = drawn
      const count = await drawPdfPages(bytes, async (page, index) => {
        const at = offset + index
        if (at < state.pages.length) {
          put(id, await window.api.migration.savePage(id, at, page.png, page.text, page.thumb))
        }
      })
      drawn = offset + count
    }
    put(id, await window.api.migration.finishImages(id, drawn === 0 ? 'The export had no pages.' : undefined))
  } catch (reason) {
    try {
      put(id, await window.api.migration.finishImages(id, message(reason, 'Could not draw the exported pages.')))
    } catch {
      // The state stays as it was; drawing is tried again next session.
    }
  }
}
