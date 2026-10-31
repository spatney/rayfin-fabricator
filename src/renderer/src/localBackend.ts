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

  /** The projects whose backend a supervisor is on (starting, running or restarting), as last seen. */
  activeProjects(): string[] {
    return [...this.statuses.values()]
      .filter((status) => isLocalBackendActive(status))
      .map((status) => status.projectId)
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

/**
 * Something wrong with an app whose backend runs: it carries on with what it
 * had before. A data model change that would delete data isn't one of them: it
 * waits for a decision ({@link refusedSchemaLosses}).
 */
export interface LocalRunningProblem {
  kind: 'analysis' | 'schema' | 'functions' | 'vite'
  /** What it means for the app, in a sentence. */
  summary: string
  /** rayfin-local's own words: the compiler's errors, or why Vite stopped. */
  detail: string | null
}

function problemDetail(...texts: (string | null | undefined)[]): string | null {
  return texts.map((text) => text?.trim()).find((text) => Boolean(text)) ?? null
}

/**
 * What's wrong while the backend runs, as it last reported: its latest data
 * model change couldn't be read or applied, the functions don't build, or the
 * app's Vite stopped for good. Empty unless it runs.
 */
export function runningProblems(status: LocalStatus | null | undefined): LocalRunningProblem[] {
  if (status?.state !== 'running') return []
  const problems: LocalRunningProblem[] = []
  if (status.analysis && !status.analysis.ok) {
    problems.push({
      kind: 'analysis',
      summary:
        'Your app’s latest data model change couldn’t be read, so it still uses the previous data model.',
      detail: problemDetail(status.analysis.message)
    })
  }
  if (status.schema?.result === 'failed') {
    problems.push({
      kind: 'schema',
      summary:
        'Your app’s latest data model change couldn’t be applied to its local database, so it still uses the previous one.',
      detail: problemDetail(status.schema.message)
    })
  }
  if (status.functions?.state === 'failed') {
    problems.push({
      kind: 'functions',
      summary:
        'Your app’s functions didn’t build, so calling them fails or runs their previous build.',
      detail: problemDetail(status.functions.errors.join('\n'), status.functions.message)
    })
  }
  if (status.vite?.state === 'failed') {
    problems.push({
      kind: 'vite',
      summary:
        'Your app’s Vite dev server stopped and couldn’t start again, so the preview can’t show it.',
      detail: problemDetail(status.vite.message)
    })
  }
  return problems
}

/**
 * A short label for a status pill: Starting…, Running, Restarting…, Error or
 * Stopped, and Running · problem while it runs with one ({@link runningProblems}).
 * `pending` (a start is on its way, or the status isn't known yet) makes a
 * stopped one Starting….
 */
export function localStateLabel(status: LocalStatus | null | undefined, pending = false): string {
  switch (status?.state) {
    case 'starting':
      return 'Starting…'
    case 'running': {
      const problems = runningProblems(status).length
      return problems === 0
        ? 'Running'
        : problems === 1
          ? 'Running · problem'
          : `Running · ${problems} problems`
    }
    case 'restarting':
      return 'Restarting…'
    case 'error':
      return 'Error'
    default:
      return pending ? 'Starting…' : 'Stopped'
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

/** Join names the way a person would: "a, b and c". */
function sentenceList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

function detailText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** The Rayfin version the app uses when rayfin-local can't run it, or `null`. */
function unsupportedSdk(status: LocalStatus): { version: string | null } | null {
  const warning = status.warnings.find((w) => w.code === 'sdk-unsupported')
  const sdk = status.ready?.sdk ?? status.analysis?.sdk ?? null
  // Without a version the packages aren't installed: that's another problem.
  const version = sdk && !sdk.supported && sdk.version ? sdk.version : null
  if (!version && !warning) return null
  return { version: version ?? detailText(warning?.details?.version) }
}

/** The connectors that run only on Fabric, by name. */
function unsupportedConnectors(status: LocalStatus): string[] {
  const names = new Set<string>()
  for (const connector of status.ready?.features.connectors ?? []) {
    if (!connector.supported) names.add(connector.name)
  }
  for (const warning of status.warnings) {
    const name = warning.code === 'connector-unsupported' ? detailText(warning.details?.name) : null
    if (name) names.add(name)
  }
  return [...names]
}

/**
 * Why a published app's preview uses its published backend instead of this
 * computer's, as a sentence; `null` when the local backend can run the app.
 * rayfin-local says so in `analysis` and `ready` (the SDK, and each
 * connector's `supported`) and with `sdk-unsupported` and
 * `connector-unsupported` warnings.
 */
export function localFallbackReason(status: LocalStatus | null | undefined): string | null {
  if (!status) return null
  const sdk = unsupportedSdk(status)
  if (sdk) {
    return sdk.version
      ? `This app uses Rayfin ${sdk.version}, which Fabricator can’t run on this computer yet, so the preview uses your published app’s backend.`
      : 'This app’s Rayfin version can’t run on this computer yet, so the preview uses your published app’s backend.'
  }
  const names = unsupportedConnectors(status)
  if (names.length === 0) return null
  return names.length === 1
    ? `The ${names[0]} connector runs only on Fabric, so the preview uses your published app’s backend.`
    : `The ${sentenceList(names)} connectors run only on Fabric, so the preview uses your published app’s backend.`
}

/** The code behind {@link localFallbackReason}: `sdk-unsupported` or `connector-unsupported`. */
export function localFallbackCode(
  status: LocalStatus | null | undefined
): 'sdk-unsupported' | 'connector-unsupported' | null {
  if (!status) return null
  if (unsupportedSdk(status)) return 'sdk-unsupported'
  return unsupportedConnectors(status).length > 0 ? 'connector-unsupported' : null
}

/**
 * What the backend last reported about the app: the times of its latest
 * analysis, schema, functions, configuration and `ready` events. A change
 * between two moments means it rebuilt something in between.
 */
export function backendStamp(status: LocalStatus | null | undefined): string {
  return [
    status?.analysis?.time,
    status?.schema?.time,
    status?.functions?.time,
    status?.config?.time,
    status?.ready?.time
  ]
    .map((time) => time ?? '')
    .join('|')
}

/**
 * Whether changed files can change whether this computer runs the app: its
 * packages (`package.json` holds the Rayfin SDK's version) or `rayfin.yml`
 * (its connectors).
 */
export function changesLocalSupport(files: string[]): boolean {
  return files.some((file) =>
    /(^|\/)(package\.json|rayfin\.ya?ml)$/.test(file.replace(/\\/g, '/').toLowerCase())
  )
}

/** Problems outside the app's code, which a chat turn can't fix. */
const OUTSIDE_THE_APP = new Set([
  'already-serving',
  'node-missing',
  'node-too-old',
  'project-not-found',
  'binary-missing',
  'binary-too-old',
  'binary-incompatible',
  'binary-blocked',
  'binary-failed',
  'spawn-failed'
])

/**
 * The backend stopped on a problem in the app (a compile error, its packages,
 * a refused schema change…), which a chat turn may have fixed: worth starting
 * again once one ends.
 */
export function retriesAfterTurn(status: LocalStatus | null | undefined): boolean {
  return status?.state === 'error' && !OUTSIDE_THE_APP.has(status.error?.code ?? '')
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
  /**
   * Delete the local data: through the control API while running (then apply
   * a refused schema change, which loses nothing now), else restart with `reset`.
   */
  resetData: () => Promise<LocalStatus | null>
  /** Stop the other `serve` behind `already-serving`, then start this one. */
  stopOtherServe: () => Promise<LocalStatus | null>
  /** Install the npm packages behind `packages-missing`, then start it again. */
  installPackages: () => Promise<LocalStatus | null>
}

/**
 * A project's local backend: its live status (from `local:state`, fetched once
 * on mount) and lifecycle actions. Pass `null` while no personal project that
 * runs on one is open.
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
  const schemaWaiting = refusedSchemaLosses(status) !== null

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
        run(async (id) => {
          if (state !== 'running') return window.api.local.restart(id, { reset: true })
          await window.api.local.resetData(id)
          // It signed every session out: the preview forgets its own, and signs in again.
          void window.api.preview.resetSiteData().catch(() => undefined)
          // A change refused for the data it would lose applies now there's none.
          if (schemaWaiting) await window.api.local.reload(id, false)
        }),
      stopOtherServe: () =>
        run(async (id) => {
          if (pid !== undefined) await window.api.local.stopExternal(id, pid)
          return window.api.local.start(id)
        }),
      installPackages: () =>
        run(async (id) => {
          await window.api.local.installPackages(id)
          return window.api.local.restart(id)
        })
    }),
    [status, state, busy, actionError, run, pid, schemaWaiting]
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
