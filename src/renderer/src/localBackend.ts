/**
 * The renderer's view of each project's local backend (rayfin-local): a store
 * that follows `local:state`, hooks that read it, and the actions a UI offers.
 * The commands themselves are `window.api.local` (`LocalBackendApi` in
 * `@shared/ipc`).
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type {
  LocalBackendState,
  LocalCommandError,
  LocalLogEvent,
  LocalProblem,
  LocalReady,
  LocalStartOptions,
  LocalStatus
} from '@shared/ipc'

/** A failed `window.api.local` command: an `Error` with its stable `code` and a `hint`. */
export class LocalBackendError extends Error {
  readonly code: string
  readonly hint?: string
  /** The HTTP status the control API answered with. */
  readonly status?: number

  constructor(error: LocalCommandError) {
    super(error.message)
    this.name = 'LocalBackendError'
    this.code = error.code
    this.hint = error.hint
    this.status = error.status
  }
}

/** What a rejected local backend command threw, as a {@link LocalBackendError}. */
export function toLocalBackendError(reason: unknown): LocalBackendError {
  if (reason instanceof LocalBackendError) return reason
  if (reason && typeof reason === 'object') {
    const fields = reason as Partial<Record<keyof LocalCommandError, unknown>>
    if (typeof fields.message === 'string') {
      return new LocalBackendError({
        code: typeof fields.code === 'string' ? fields.code : 'error',
        message: fields.message,
        hint: typeof fields.hint === 'string' ? fields.hint : undefined,
        status: typeof fields.status === 'number' ? fields.status : undefined
      })
    }
  }
  const message = reason instanceof Error ? reason.message : String(reason)
  return new LocalBackendError({ code: 'error', message })
}

type Listener = () => void

/** Every project's latest status, fed by `local:state` while anything listens. */
export class LocalBackendStore {
  private statuses = new Map<string, LocalStatus>()
  private listeners = new Set<Listener>()
  private unsubscribe: (() => void) | null = null

  /** For `useSyncExternalStore`: listen to every project's changes. */
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    if (!this.unsubscribe)
      this.unsubscribe = window.api.local.onState((status) => this.accept(status))
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0 && this.unsubscribe) {
        this.unsubscribe()
        this.unsubscribe = null
      }
    }
  }

  get(projectId: string): LocalStatus | undefined {
    return this.statuses.get(projectId)
  }

  /** Keep `status` unless a newer snapshot of its project is already known. */
  accept(status: LocalStatus): void {
    const known = this.statuses.get(status.projectId)
    if (known && known.revision >= status.revision) return
    this.statuses.set(status.projectId, status)
    this.listeners.forEach((listener) => listener())
  }

  /** Fetch a project's status (`local:state` only reports changes). */
  async refresh(projectId: string): Promise<LocalStatus> {
    this.accept(await window.api.local.status(projectId))
    return this.statuses.get(projectId) as LocalStatus
  }

  /** Forget every status (tests). */
  clear(): void {
    this.statuses.clear()
  }
}

/** The app-wide store {@link useLocalBackend} reads. */
export const localBackendStore = new LocalBackendStore()

/** A supervisor is on it: starting, running or restarting. */
export function isLocalBackendActive(status: LocalStatus | null | undefined): boolean {
  return (
    status?.state === 'starting' || status?.state === 'running' || status?.state === 'restarting'
  )
}

/** A short label for a status pill: Starting…, Running, Restarting…, Error or Stopped. */
export function localStateLabel(status: LocalStatus | null | undefined): string {
  switch (status?.state) {
    case 'starting':
      return 'Starting…'
    case 'running':
      return 'Running'
    case 'restarting':
      return 'Restarting…'
    case 'error':
      return 'Error'
    default:
      return 'Stopped'
  }
}

/** The other `rayfin-local serve` that holds the project (`already-serving`), if that's why it isn't running. */
export function alreadyServing(
  status: LocalStatus | null | undefined
): { pid: number; appUrl: string | null; apiUrl: string | null } | null {
  const error = status?.state === 'error' ? status.error : null
  const pid = error?.code === 'already-serving' ? error.details?.pid : undefined
  if (typeof pid !== 'number') return null
  return { pid, appUrl: error?.details?.appUrl ?? null, apiUrl: error?.details?.apiUrl ?? null }
}

/**
 * The data a schema change would lose, while it waits for a decision: refused
 * at start (`error`, code `schema-refused`) or while running (the previous
 * schema stays in use). `null` when nothing waits.
 */
export function refusedSchemaLosses(status: LocalStatus | null | undefined): string[] | null {
  if (status?.state === 'error' && status.error?.code === 'schema-refused') {
    return status.error.details?.losses ?? status.schema?.losses ?? []
  }
  if (status?.state === 'running' && status.schema?.result === 'refused')
    return status.schema.losses
  return null
}

/** One project's local backend, live, with the actions a UI offers. */
export interface LocalBackend {
  /** The latest status; `null` until the first one arrives. */
  status: LocalStatus | null
  /** `stopped` until known. */
  state: LocalBackendState
  /** While running: the app's URLs and features. */
  ready: LocalReady | null
  /** With `state: 'error'`: why it isn't running. */
  error: LocalProblem | null
  /** One of the actions below is in flight. */
  busy: boolean
  /** The last action's failure (actions don't reject); cleared by the next action. */
  actionError: LocalBackendError | null
  /** Start it unless it runs. */
  start: (options?: LocalStartOptions) => Promise<LocalStatus | null>
  stop: () => Promise<LocalStatus | null>
  restart: (options?: LocalStartOptions) => Promise<LocalStatus | null>
  /** Fetch the status now. */
  refresh: () => Promise<LocalStatus | null>
  /** Apply a refused schema change and lose the data it drops: reload with `forceSchema` while running, else restart with it. */
  applySchemaChange: () => Promise<LocalStatus | null>
  /** Delete the local data: through the control API while running, else restart with `reset`. */
  resetData: () => Promise<LocalStatus | null>
  /** Stop the other `serve` behind `already-serving`, then start this one. */
  stopOtherServe: () => Promise<LocalStatus | null>
}

/**
 * A project's local backend: its live status (from `local:state`, fetched once
 * on mount) and lifecycle actions. Pass `null` while no project is open.
 */
export function useLocalBackend(projectId: string | null | undefined): LocalBackend {
  const status = useSyncExternalStore(localBackendStore.subscribe, () =>
    projectId ? (localBackendStore.get(projectId) ?? null) : null
  )
  const [busy, setBusy] = useState(0)
  const [actionError, setActionError] = useState<LocalBackendError | null>(null)

  useEffect(() => {
    setActionError(null)
    if (projectId) void localBackendStore.refresh(projectId).catch(() => undefined)
  }, [projectId])

  const run = useCallback(
    async (action: (id: string) => Promise<unknown>): Promise<LocalStatus | null> => {
      if (!projectId) return null
      setBusy((n) => n + 1)
      setActionError(null)
      try {
        const result = await action(projectId)
        if (isStatus(result)) localBackendStore.accept(result)
        return await localBackendStore.refresh(projectId)
      } catch (reason) {
        setActionError(toLocalBackendError(reason))
        return localBackendStore.get(projectId) ?? null
      } finally {
        setBusy((n) => n - 1)
      }
    },
    [projectId]
  )

  const state = status?.state ?? 'stopped'
  const pid = alreadyServing(status)?.pid

  return useMemo<LocalBackend>(
    () => ({
      status,
      state,
      ready: status?.ready ?? null,
      error: status?.state === 'error' ? status.error : null,
      busy: busy > 0,
      actionError,
      start: (options) => run((id) => window.api.local.start(id, options)),
      stop: () => run((id) => window.api.local.stop(id)),
      restart: (options) => run((id) => window.api.local.restart(id, options)),
      refresh: () => run(() => Promise.resolve()),
      applySchemaChange: () =>
        run((id) =>
          state === 'running'
            ? window.api.local.reload(id, true)
            : window.api.local.restart(id, { forceSchema: true })
        ),
      resetData: () =>
        run((id) =>
          state === 'running'
            ? window.api.local.resetData(id)
            : window.api.local.restart(id, { reset: true })
        ),
      stopOtherServe: () =>
        run(async (id) => {
          if (pid !== undefined) await window.api.local.stopExternal(id, pid)
          return window.api.local.start(id)
        })
    }),
    [status, state, busy, actionError, run, pid]
  )
}

function isStatus(value: unknown): value is LocalStatus {
  return Boolean(value && typeof value === 'object' && 'revision' in value && 'projectId' in value)
}

/** Merge output lines by `seq`, without repeats, keeping the last `limit`. */
export function mergeLogLines(
  lines: LocalLogEvent[],
  more: LocalLogEvent[],
  limit: number
): LocalLogEvent[] {
  const bySeq = new Map<number, LocalLogEvent>()
  for (const line of [...lines, ...more]) bySeq.set(line.seq, line)
  const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
  return merged.slice(Math.max(0, merged.length - limit))
}

/**
 * A project's recent output, live: the last `limit` lines (fetched on mount)
 * followed by new ones from `local:log`.
 */
export function useLocalBackendLogs(
  projectId: string | null | undefined,
  limit = 500
): LocalLogEvent[] {
  const [lines, setLines] = useState<LocalLogEvent[]>([])

  useEffect(() => {
    setLines([])
    if (!projectId) return
    let cancelled = false
    let loaded = false
    const early: LocalLogEvent[] = []
    const off = window.api.local.onLog((line) => {
      if (line.projectId !== projectId) return
      if (!loaded) early.push(line)
      else setLines((current) => mergeLogLines(current, [line], limit))
    })
    const settle = (tail: LocalLogEvent[]): void => {
      if (cancelled) return
      loaded = true
      setLines(mergeLogLines(tail, early, limit))
    }
    window.api.local.logs(projectId, limit).then(settle, () => settle([]))
    return () => {
      cancelled = true
      off()
    }
  }, [projectId, limit])

  return lines
}
