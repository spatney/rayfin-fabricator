/**
 * `useAdvisor`: the Advisor's per-project state machine. Owned by the Workbench
 * (so the tab badge stays current even when the Advisor tab was never opened)
 * and handed to the Advisor view.
 *
 * It loads the saved deep review and lifecycle state, runs the quick checks
 * whenever the project likely changed, streams deep reviews, and drives inline
 * explanations and Verify runs. Lifecycle changes are persisted (debounced).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AdvisorEventEnvelope,
  AdvisorFinding,
  AdvisorRuleResult,
  AdvisorUiState,
  AdvisorDismissReason,
  ChatToolCall,
  ContextTier,
  RayfinVersionInfo,
  ReasoningEffort,
  StudioProject
} from '@shared/ipc'
import { selectionArgs, selectionOf, type ModelSelection } from '../modelSelection'
import { quickRefs, runQuickChecks, type QuickCheckResult } from './engine'
import { isCurrent, normalizeSnapshot, type NormalizedSnapshot } from './legacy'
import {
  applyQuickRun,
  applyReview,
  applyVerdicts,
  clearResolved,
  coerceState,
  deriveAdvisor,
  dismiss,
  emptyState,
  markHandoffsApplied,
  markHandoffsStarted,
  mute,
  recordHandoffs,
  undismiss,
  unmute,
  type DerivedAdvisor
} from './lifecycle'

const MODEL_KEY = 'rayfin.advisor.aiModel'
const EFFORT_KEY = 'rayfin.advisor.aiEffort'
const AUTO_TIER_KEY = 'rayfin.advisor.aiAutoTier'
const CONTEXT_TIER_KEY = 'rayfin.advisor.aiContextTier'
const SAVE_DELAY_MS = 500
const QUICK_DELAY_MS = 350
const MAX_ACTIVITY = 200

export interface ReviewRun {
  running: boolean
  startedAt: number
  activity: ChatToolCall[]
  findings: AdvisorFinding[]
  results: AdvisorRuleResult[]
  summary?: string
  /** Why the last review failed (not set for a user cancel). */
  error?: string
}

export type ExplainStatus = 'loading' | 'streaming' | 'done' | 'error'

export interface ExplainState {
  status: ExplainStatus
  text: string
  error?: string
}

export interface VerifyRun {
  running: boolean
  ids: string[]
  error?: string
}

export interface AdvisorController {
  projectId: string | null
  loading: boolean
  quick: QuickCheckResult | null
  quickRunning: boolean
  quickError: string | null
  deep: NormalizedSnapshot | null
  deepCurrent: boolean
  review: ReviewRun
  derived: DerivedAdvisor
  state: AdvisorUiState
  /** The model the Advisor's own sessions use (kept on this computer). */
  selection: ModelSelection
  setSelection: (next: ModelSelection) => void
  refreshQuick: () => void
  startReview: () => Promise<void>
  cancelReview: () => void
  dismiss: (f: AdvisorFinding, reason: AdvisorDismissReason, note?: string) => void
  undismiss: (id: string) => void
  mute: (ruleId: string, note?: string) => void
  unmute: (ruleId: string) => void
  clearResolved: () => void
  /** Record findings just handed to the Build chat. */
  handOff: (findings: Pick<AdvisorFinding, 'id' | 'source'>[]) => void
  explains: Record<string, ExplainState>
  explaining: string | null
  explain: (f: AdvisorFinding) => void
  cancelExplain: () => void
  verify: VerifyRun
  startVerify: (findings: AdvisorFinding[]) => Promise<void>
  cancelVerify: () => void
}

const IDLE_REVIEW: ReviewRun = { running: false, startedAt: 0, activity: [], findings: [], results: [] }
const IDLE_VERIFY: VerifyRun = { running: false, ids: [] }

function readStored(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function writeStored(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    /* storage unavailable — keep the in-memory choice */
  }
}

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

function mergeResults(list: AdvisorRuleResult[], add: AdvisorRuleResult[]): AdvisorRuleResult[] {
  const map = new Map(list.map((r) => [r.ruleId, r]))
  for (const r of add) map.set(r.ruleId, r)
  return [...map.values()]
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return typeof err === 'string' ? err : String(err)
}

export function useAdvisor(
  project: StudioProject | null,
  opts: { refreshKey: number; versions: RayfinVersionInfo | null; chatBusy: boolean }
): AdvisorController {
  const projectId = project && !project.missing ? project.id : null
  const [loading, setLoading] = useState(true)
  const [quick, setQuick] = useState<QuickCheckResult | null>(null)
  const [quickRunning, setQuickRunning] = useState(false)
  const [quickError, setQuickError] = useState<string | null>(null)
  const [deep, setDeep] = useState<NormalizedSnapshot | null>(null)
  const [state, setState] = useState<AdvisorUiState>(emptyState)
  const [review, setReview] = useState<ReviewRun>(IDLE_REVIEW)
  const [explains, setExplains] = useState<Record<string, ExplainState>>({})
  const [explaining, setExplaining] = useState<string | null>(null)
  const [verify, setVerify] = useState<VerifyRun>(IDLE_VERIFY)
  const [selection, setSelectionState] = useState<ModelSelection>(() =>
    selectionOf({
      model: readStored(MODEL_KEY),
      effort: readStored(EFFORT_KEY) as ReasoningEffort | '',
      autoTier: readStored(AUTO_TIER_KEY),
      contextTier: readStored(CONTEXT_TIER_KEY) as ContextTier | ''
    })
  )

  const projectRef = useRef(projectId)
  projectRef.current = projectId
  const loadedRef = useRef(false)
  const stateRef = useRef(state)
  stateRef.current = state
  const quickRef = useRef(quick)
  quickRef.current = quick
  const deepRef = useRef(deep)
  deepRef.current = deep
  const versionsRef = useRef(opts.versions)
  versionsRef.current = opts.versions
  const quickBusyRef = useRef(false)
  const quickAgainRef = useRef(false)
  const quickTimerRef = useRef<number | undefined>(undefined)
  const cancelledRef = useRef(false)
  const explainingRef = useRef<string | null>(null)
  const verifyIdRef = useRef<string | null>(null)

  const setSelection = useCallback((next: ModelSelection) => {
    setSelectionState(next)
    writeStored(MODEL_KEY, next.model)
    writeStored(EFFORT_KEY, next.effort)
    writeStored(AUTO_TIER_KEY, next.autoTier)
    writeStored(CONTEXT_TIER_KEY, next.contextTier)
  }, [])

  // Run the quick checks now; a request while one is running queues one more pass.
  const runQuick = useCallback(async (): Promise<QuickCheckResult | null> => {
    const id = projectRef.current
    if (!id) return null
    if (quickBusyRef.current) {
      quickAgainRef.current = true
      return quickRef.current
    }
    quickBusyRef.current = true
    setQuickRunning(true)
    let result: QuickCheckResult | null = null
    try {
      result = await runQuickChecks(id, versionsRef.current)
      if (projectRef.current !== id) return null
      setQuick(result)
      setQuickError(null)
      const ran = result
      setState((s) => applyQuickRun(s, ran.findings, ran.ranAt))
    } catch (err) {
      if (projectRef.current === id) setQuickError(errorText(err))
    } finally {
      quickBusyRef.current = false
      if (projectRef.current === id) setQuickRunning(false)
      if (quickAgainRef.current) {
        quickAgainRef.current = false
        void runQuickRef.current()
      }
    }
    return result
  }, [])
  const runQuickRef = useRef(runQuick)
  runQuickRef.current = runQuick

  const refreshQuick = useCallback(() => {
    window.clearTimeout(quickTimerRef.current)
    quickTimerRef.current = window.setTimeout(() => void runQuickRef.current(), QUICK_DELAY_MS)
  }, [])

  // Load the saved review + lifecycle state whenever the project changes.
  useEffect(() => {
    loadedRef.current = false
    setLoading(true)
    setQuick(null)
    setQuickError(null)
    setDeep(null)
    setState(emptyState())
    setReview(IDLE_REVIEW)
    setExplains({})
    setExplaining(null)
    explainingRef.current = null
    setVerify(IDLE_VERIFY)
    if (!projectId) {
      setLoading(false)
      return
    }
    let alive = true
    window.api.advisor
      .load(projectId)
      .then((res) => {
        if (!alive) return
        setDeep(res.snapshot ? normalizeSnapshot(res.snapshot) : null)
        setState(coerceState(res.state))
      })
      .catch(() => {
        /* nothing saved yet */
      })
      .finally(() => {
        if (!alive) return
        loadedRef.current = true
        setLoading(false)
        void runQuickRef.current()
      })
    return () => {
      alive = false
    }
  }, [projectId])

  // Re-run the quick checks when the code or the Rayfin versions likely changed.
  const versionsKey = JSON.stringify(opts.versions?.packages ?? null)
  const firstTriggerRef = useRef(true)
  useEffect(() => {
    if (firstTriggerRef.current) {
      firstTriggerRef.current = false
      return
    }
    if (loadedRef.current) refreshQuick()
  }, [opts.refreshKey, versionsKey, refreshQuick])

  // Persist lifecycle changes (debounced) once the saved state has loaded.
  useEffect(() => {
    if (!projectId || !loadedRef.current) return
    const t = window.setTimeout(() => {
      void window.api.advisor.saveState(projectId, state).catch(() => {
        /* best-effort; retried on the next change */
      })
    }, SAVE_DELAY_MS)
    return () => window.clearTimeout(t)
  }, [projectId, state])

  // Hand-offs follow the Build chat: started when it goes busy, applied when it's done.
  const busyRef = useRef(opts.chatBusy)
  useEffect(() => {
    const was = busyRef.current
    busyRef.current = opts.chatBusy
    if (opts.chatBusy && !was) setState((s) => markHandoffsStarted(s))
    if (!opts.chatBusy && was) setState((s) => markHandoffsApplied(s, new Date().toISOString()))
  }, [opts.chatBusy])

  // Stream deep-review, explain, and verify events into state.
  useEffect(() => {
    if (!projectId) return
    return window.api.advisor.onEvent((env: AdvisorEventEnvelope) => {
      if (env.projectId !== projectId) return
      const ev = env.event
      switch (ev.type) {
        case 'activity':
          setReview((r) => (r.running ? { ...r, activity: upsert(r.activity, ev.tool, MAX_ACTIVITY) } : r))
          break
        case 'finding':
          setReview((r) => (r.running ? { ...r, findings: upsert(r.findings, ev.finding) } : r))
          break
        case 'ruleStatus':
          setReview((r) => (r.running ? { ...r, results: mergeResults(r.results, ev.results) } : r))
          break
        case 'summary':
          setReview((r) => (r.running ? { ...r, summary: ev.text } : r))
          break
        case 'explainDelta':
          setExplains((prev) => {
            const cur = prev[ev.explainId]
            if (!cur) return prev
            const text = ev.reset ? ev.text : cur.text + ev.text
            return { ...prev, [ev.explainId]: { status: text ? 'streaming' : 'loading', text } }
          })
          break
        case 'verdict':
          if (ev.verifyId !== verifyIdRef.current) break
          setState((s) => {
            const f = [...(quickRef.current?.findings ?? []), ...(deepRef.current?.report.findings ?? [])]
            return applyVerdicts(s, [ev.verdict], f, new Date().toISOString())
          })
          break
        default:
          break
      }
    })
  }, [projectId])

  const startReview = useCallback(async () => {
    const id = projectRef.current
    if (!id) return
    cancelledRef.current = false
    setReview({ ...IDLE_REVIEW, running: true, startedAt: Date.now() })
    const base = quickRef.current ?? (await runQuickRef.current())
    if (projectRef.current !== id) return
    if (!base) {
      setReview({ ...IDLE_REVIEW, error: 'Couldn’t read the project to start the review.' })
      return
    }
    try {
      const s = stateRef.current
      const last = deepRef.current?.report.ok ? deepRef.current.report.findings : []
      const open = last.filter((f) => f.ruleId && !s.dismissed[f.id] && !s.muted[f.ruleId] && !s.resolved[f.id])
      const snapshot = await window.api.advisor.run(id, {
        ...selectionArgs(selection),
        facts: base.facts,
        quick: quickRefs(base.findings),
        previous: quickRefs(open)
      })
      if (projectRef.current !== id) return
      if (snapshot.report.ok) {
        const next = normalizeSnapshot(snapshot)
        const previous = deepRef.current?.report.ok ? deepRef.current.report.findings : []
        const now = new Date().toISOString()
        setState((s) => applyReview(s, previous, next.report.findings, quickRef.current?.findings ?? [], now))
        setDeep(next)
        setReview(IDLE_REVIEW)
      } else {
        setReview({ ...IDLE_REVIEW, error: cancelledRef.current ? undefined : snapshot.report.summary })
      }
    } catch (err) {
      if (projectRef.current === id) {
        setReview({ ...IDLE_REVIEW, error: cancelledRef.current ? undefined : errorText(err) })
      }
    }
  }, [selection])

  const cancelReview = useCallback(() => {
    const id = projectRef.current
    if (!id) return
    cancelledRef.current = true
    void window.api.advisor.cancel(id)
  }, [])

  const explain = useCallback(
    (f: AdvisorFinding) => {
      const id = projectRef.current
      if (!id || explainingRef.current) return
      explainingRef.current = f.id
      setExplaining(f.id)
      setExplains((prev) => ({ ...prev, [f.id]: { status: 'loading', text: '' } }))
      window.api.advisor
        .explain(id, f.id, f, selectionArgs(selection))
        .then((full) => {
          if (projectRef.current !== id) return
          setExplains((prev) => ({ ...prev, [f.id]: { status: 'done', text: full } }))
        })
        .catch((err) => {
          if (projectRef.current !== id) return
          const msg = errorText(err)
          setExplains((prev) => {
            // A cancel with nothing streamed yet resets the slot for a clean retry.
            if (/cancel/i.test(msg) && !prev[f.id]?.text) {
              const next = { ...prev }
              delete next[f.id]
              return next
            }
            return { ...prev, [f.id]: { status: 'error', text: prev[f.id]?.text ?? '', error: msg } }
          })
        })
        .finally(() => {
          if (explainingRef.current === f.id) {
            explainingRef.current = null
            if (projectRef.current === id) setExplaining(null)
          }
        })
    },
    [selection]
  )

  const cancelExplain = useCallback(() => {
    const id = projectRef.current
    if (id && explainingRef.current) void window.api.advisor.explainCancel(id)
  }, [])

  const startVerify = useCallback(
    async (findings: AdvisorFinding[]) => {
      const id = projectRef.current
      if (!id || findings.length === 0 || verifyIdRef.current) return
      const verifyId = `verify-${Date.now()}`
      verifyIdRef.current = verifyId
      setVerify({ running: true, ids: findings.map((f) => f.id) })
      try {
        const verdicts = await window.api.advisor.verify(id, verifyId, findings, selectionArgs(selection))
        if (projectRef.current !== id) return
        setState((s) => applyVerdicts(s, verdicts, findings, new Date().toISOString()))
        setVerify(IDLE_VERIFY)
      } catch (err) {
        if (projectRef.current !== id) return
        const msg = errorText(err)
        setVerify({ ...IDLE_VERIFY, error: /cancel/i.test(msg) ? undefined : msg })
      } finally {
        if (verifyIdRef.current === verifyId) verifyIdRef.current = null
      }
    },
    [selection]
  )

  const cancelVerify = useCallback(() => {
    const id = projectRef.current
    if (id && verifyIdRef.current) void window.api.advisor.verifyCancel(id)
  }, [])

  const now = (): string => new Date().toISOString()
  const actions = useMemo(
    () => ({
      dismiss: (f: AdvisorFinding, reason: AdvisorDismissReason, note?: string) =>
        setState((s) => dismiss(s, f, reason, now(), note)),
      undismiss: (fid: string) => setState((s) => undismiss(s, fid)),
      mute: (ruleId: string, note?: string) => setState((s) => mute(s, ruleId, now(), note)),
      unmute: (ruleId: string) => setState((s) => unmute(s, ruleId)),
      clearResolved: () => setState((s) => clearResolved(s)),
      handOff: (findings: Pick<AdvisorFinding, 'id' | 'source'>[]) =>
        setState((s) => recordHandoffs(s, findings, now()))
    }),
    []
  )

  const deepCurrent = isCurrent(deep)
  const derived = useMemo(
    () =>
      deriveAdvisor({
        quick,
        deep,
        live: review.running ? { findings: review.findings, results: review.results } : null,
        state,
        deepCurrent
      }),
    [quick, deep, review.running, review.findings, review.results, state, deepCurrent]
  )

  return {
    projectId,
    loading,
    quick,
    quickRunning,
    quickError,
    deep,
    deepCurrent,
    review,
    derived,
    state,
    selection,
    setSelection,
    refreshQuick,
    startReview,
    cancelReview,
    ...actions,
    explains,
    explaining,
    explain,
    cancelExplain,
    verify,
    startVerify,
    cancelVerify
  }
}
