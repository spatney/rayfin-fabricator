/**
 * `useGoals`: an app's Goals (an experiment): the purpose and checks in its
 * `GOALS.md`, their last results, and the runs and drafts Copilot does for
 * them. Owned by the Workbench, so a run keeps its live feed whichever tab is
 * open and publishing can start one; handed to the Goals view.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ChatToolCall,
  GoalResult,
  GoalsEventEnvelope,
  GoalsPhase,
  GoalsProposal,
  GoalsSnapshot,
  StudioProject
} from '@shared/ipc'
import {
  readStoredSelection,
  selectionArgs,
  writeStoredSelection,
  type ModelSelection
} from '../modelSelection'
import type { LiveRun } from './model'

const MODEL_KEY = 'fabricator.goals.model'
const MAX_ACTIVITY = 200
/** What `goals.draft` rejects with when it was stopped. */
const DRAFT_STOPPED = 'Drafting stopped.'

export interface GoalsRun extends LiveRun {
  /** It was already going when the goals loaded, so its start and earlier steps aren't known here. */
  adopted: boolean
  startedAt: number
  phase: GoalsPhase | null
  activity: ChatToolCall[]
  /** Stop was pressed: it's stopping and removing its copy of the app. */
  stopping: boolean
}

export interface GoalsDraft {
  running: boolean
  activity: ChatToolCall[]
}

export interface GoalsController {
  projectId: string | null
  loading: boolean
  /** Why the goals couldn't be read. */
  loadError: string | null
  snapshot: GoalsSnapshot | null
  run: GoalsRun
  /** Why the last run stopped short or couldn't start (not set when it was stopped). */
  runError: string | null
  dismissRunError: () => void
  draft: GoalsDraft
  /** Why the last draft failed (not set when it was stopped). */
  draftError: string | null
  dismissDraftError: () => void
  /** The model runs and drafts use (kept on this computer). */
  selection: ModelSelection
  setSelection: (next: ModelSelection) => void
  /** Read the goals again; resolves with them, or `null` when they couldn't be read. */
  reload: () => Promise<GoalsSnapshot | null>
  /** Save to `GOALS.md`. Rejects with why it couldn't. */
  save: (purpose: string, checks: string[]) => Promise<void>
  /** Run these checks (every check when absent). */
  startRun: (checkIds?: string[]) => void
  cancelRun: () => void
  /** Have Copilot propose goals; `null` when it was stopped or failed (see `draftError`). */
  startDraft: (purpose: string, checks: string[]) => Promise<GoalsProposal | null>
  cancelDraft: () => void
}

const IDLE_RUN: GoalsRun = {
  running: false,
  adopted: false,
  startedAt: 0,
  checkIds: null,
  phase: null,
  activity: [],
  results: [],
  stopping: false
}
const IDLE_DRAFT: GoalsDraft = { running: false, activity: [] }

function upsert<T extends { id: string }>(list: T[], item: T, max = Infinity): T[] {
  const i = list.findIndex((x) => x.id === item.id)
  if (i >= 0) {
    const next = list.slice()
    next[i] = item
    return next
  }
  const next = [...list, item]
  return next.length > max ? next.slice(next.length - max) : next
}

function withResult(list: GoalResult[], result: GoalResult): GoalResult[] {
  return [...list.filter((r) => r.checkId !== result.checkId), result]
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return typeof err === 'string' ? err : String(err)
}

export function useGoals(
  project: StudioProject | null,
  opts: { enabled: boolean; refreshKey: number }
): GoalsController {
  const projectId = opts.enabled && project && !project.missing ? project.id : null
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<GoalsSnapshot | null>(null)
  const [run, setRun] = useState<GoalsRun>(IDLE_RUN)
  const [runError, setRunError] = useState<string | null>(null)
  const [draft, setDraft] = useState<GoalsDraft>(IDLE_DRAFT)
  const [draftError, setDraftError] = useState<string | null>(null)
  const [selection, setSelectionState] = useState<ModelSelection>(() =>
    readStoredSelection(MODEL_KEY)
  )

  const projectRef = useRef(projectId)
  projectRef.current = projectId
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  /** A run is going for this project, as far as the tab knows. */
  const runningRef = useRef(false)
  /** Which run the tab follows: a run's own handlers act only while it's the latest. */
  const runSeqRef = useRef(0)
  /** The run going was adopted, so its `done` event, not a promise, ends it here. */
  const adoptedRef = useRef(false)
  /** The project a draft is running for. */
  const draftingRef = useRef<string | null>(null)
  const loadSeqRef = useRef(0)

  const setSelection = useCallback((next: ModelSelection) => {
    setSelectionState(next)
    writeStoredSelection(MODEL_KEY, next)
  }, [])

  const reload = useCallback(async (): Promise<GoalsSnapshot | null> => {
    const id = projectRef.current
    if (!id) return null
    const seq = ++loadSeqRef.current
    try {
      const next = await window.api.goals.load(id)
      if (projectRef.current !== id || seq !== loadSeqRef.current) return next
      setSnapshot(next)
      setLoadError(null)
      if (next.running && !runningRef.current) {
        // A run started before the tab last left this app: follow it to its end.
        runningRef.current = true
        adoptedRef.current = true
        runSeqRef.current += 1
        setRunError(null)
        setRun({ ...IDLE_RUN, running: true, adopted: true, startedAt: Date.now() })
      } else if (!next.running && runningRef.current && adoptedRef.current) {
        // Its end was missed: it's over.
        runningRef.current = false
        adoptedRef.current = false
        setRun(IDLE_RUN)
      }
      return next
    } catch (err) {
      if (projectRef.current === id && seq === loadSeqRef.current) setLoadError(errorText(err))
      return null
    }
  }, [])

  // A different app: start over, and stop drafting for the one left (its editor is gone).
  useEffect(() => {
    setSnapshot(null)
    setLoadError(null)
    setRun(IDLE_RUN)
    setRunError(null)
    setDraft(IDLE_DRAFT)
    setDraftError(null)
    runningRef.current = false
    adoptedRef.current = false
    runSeqRef.current += 1
    if (!projectId) {
      setLoading(false)
      return
    }
    setLoading(true)
    void reload().finally(() => {
      if (projectRef.current === projectId) setLoading(false)
    })
    return () => {
      if (draftingRef.current === projectId) void window.api.goals.draftCancel(projectId)
    }
  }, [projectId, reload])

  // The app's code likely changed (a chat turn, a restore): results may be out of date.
  const firstRefreshRef = useRef(true)
  useEffect(() => {
    if (firstRefreshRef.current) {
      firstRefreshRef.current = false
      return
    }
    void reload()
  }, [opts.refreshKey, reload])

  useEffect(() => {
    if (!projectId) return
    return window.api.goals.onEvent((env: GoalsEventEnvelope) => {
      if (env.projectId !== projectId) return
      const ev = env.event
      switch (ev.type) {
        case 'phase':
          setRun((r) => (r.running ? { ...r, phase: ev.phase } : r))
          break
        case 'activity':
          setRun((r) =>
            r.running ? { ...r, activity: upsert(r.activity, ev.tool, MAX_ACTIVITY) } : r
          )
          break
        case 'result':
          setRun((r) => (r.running ? { ...r, results: withResult(r.results, ev.result) } : r))
          break
        case 'draftActivity':
          setDraft((d) =>
            d.running ? { ...d, activity: upsert(d.activity, ev.tool, MAX_ACTIVITY) } : d
          )
          break
        case 'done':
          // A run this tab started ends when its promise settles.
          if (!adoptedRef.current) break
          adoptedRef.current = false
          runningRef.current = false
          setRun(IDLE_RUN)
          setRunError(ev.cancelled ? null : (ev.error ?? null))
          void reload()
          break
      }
    })
  }, [projectId, reload])

  const save = useCallback(async (purpose: string, checks: string[]): Promise<void> => {
    const id = projectRef.current
    if (!id) return
    const next = await window.api.goals.save(id, purpose, checks)
    if (projectRef.current === id) setSnapshot(next)
  }, [])

  const startRun = useCallback(
    (checkIds?: string[]) => {
      const id = projectRef.current
      if (!id || runningRef.current) return
      const seq = ++runSeqRef.current
      const current = (): boolean => projectRef.current === id && runSeqRef.current === seq
      runningRef.current = true
      adoptedRef.current = false
      setRunError(null)
      setRun({
        ...IDLE_RUN,
        running: true,
        startedAt: Date.now(),
        checkIds: checkIds ?? snapshotRef.current?.checks.map((c) => c.id) ?? null,
        phase: 'preparing'
      })
      window.api.goals
        .run(id, { checkIds, ...selectionArgs(selectionRef.current) })
        .then((end) => {
          if (!current()) return
          // A load that began while it ran would say it's still going.
          loadSeqRef.current += 1
          setSnapshot(end.snapshot)
          setRunError(end.cancelled ? null : (end.error ?? null))
          runningRef.current = false
          setRun(IDLE_RUN)
        })
        .catch((err) => {
          if (!current()) return
          runningRef.current = false
          setRun(IDLE_RUN)
          setRunError(errorText(err))
          // It may be one the tab didn't know was going: then follow it.
          void reload()
        })
    },
    [reload]
  )

  const cancelRun = useCallback(() => {
    const id = projectRef.current
    if (!id || !runningRef.current) return
    setRun((r) => (r.running ? { ...r, stopping: true } : r))
    void window.api.goals.cancel(id)
  }, [])

  const startDraft = useCallback(
    async (purpose: string, checks: string[]): Promise<GoalsProposal | null> => {
      const id = projectRef.current
      if (!id || draftingRef.current) return null
      draftingRef.current = id
      setDraftError(null)
      setDraft({ running: true, activity: [] })
      try {
        const proposal = await window.api.goals.draft(
          id,
          purpose,
          checks,
          selectionArgs(selectionRef.current)
        )
        return projectRef.current === id ? proposal : null
      } catch (err) {
        const message = errorText(err)
        if (projectRef.current === id && message !== DRAFT_STOPPED) setDraftError(message)
        return null
      } finally {
        if (draftingRef.current === id) draftingRef.current = null
        if (projectRef.current === id) setDraft(IDLE_DRAFT)
      }
    },
    []
  )

  const cancelDraft = useCallback(() => {
    const id = projectRef.current
    if (id && draftingRef.current === id) void window.api.goals.draftCancel(id)
  }, [])

  const dismissRunError = useCallback(() => setRunError(null), [])
  const dismissDraftError = useCallback(() => setDraftError(null), [])

  return {
    projectId,
    loading,
    loadError,
    snapshot,
    run,
    runError,
    dismissRunError,
    draft,
    draftError,
    dismissDraftError,
    selection,
    setSelection,
    reload,
    save,
    startRun,
    cancelRun,
    startDraft,
    cancelDraft
  }
}
