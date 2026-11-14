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
  LocalProblem,
  LocalReady,
  LocalStartOptions,
  LocalStatus,
  RayfinVersionInfo,
  StudioProject,
  TeamDeployRecord
} from '@shared/ipc'
import { formatList, i18n, translator } from './i18n'

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
  const t = translator('preview')
  const problems: LocalRunningProblem[] = []
  if (status.analysis && !status.analysis.ok) {
    problems.push({
      kind: 'analysis',
      summary: t('runningProblem.analysis'),
      detail: problemDetail(status.analysis.message)
    })
  }
  if (status.schema?.result === 'failed') {
    problems.push({
      kind: 'schema',
      summary: t('runningProblem.schema'),
      detail: problemDetail(status.schema.message)
    })
  }
  if (status.functions?.state === 'failed') {
    problems.push({
      kind: 'functions',
      summary: t('runningProblem.functions'),
      detail: problemDetail(status.functions.errors.join('\n'), status.functions.message)
    })
  }
  if (status.vite?.state === 'failed') {
    problems.push({
      kind: 'vite',
      summary: t('runningProblem.vite'),
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
  const t = translator('preview')
  switch (status?.state) {
    case 'starting':
      return t('localState.starting')
    case 'running': {
      const problems = runningProblems(status).length
      return problems === 0
        ? t('localState.running')
        : t('localState.runningProblems', { count: problems })
    }
    case 'restarting':
      return t('localState.restarting')
    case 'error':
      return t('status.error')
    default:
      return pending ? t('localState.starting') : t('localState.stopped')
  }
}

/**
 * How the app on this computer looks at a glance, for a dot: running, running
 * with a problem ({@link runningProblems}), starting, failed, or stopped.
 */
export function localTone(
  status: LocalStatus | null | undefined,
  pending = false
): 'ok' | 'warn' | 'busy' | 'err' | 'idle' {
  switch (status?.state) {
    case 'running':
      return runningProblems(status).length > 0 ? 'warn' : 'ok'
    case 'starting':
    case 'restarting':
      return 'busy'
    case 'error':
      return 'err'
    default:
      return pending ? 'busy' : 'idle'
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

/**
 * The Rayfin version the app uses when rayfin-local doesn't implement it, and
 * whether it's of a newer line (`newerSdk`), or `null`.
 */
function unsupportedSdk(status: LocalStatus): { version: string | null; newer: boolean } | null {
  const warning = status.warnings.find((w) => w.code === 'sdk-unsupported')
  const sdk = status.ready?.sdk ?? status.analysis?.sdk ?? null
  // Without a version the packages aren't installed: that's another problem.
  const version = sdk && !sdk.supported && sdk.version ? sdk.version : null
  if (!version && !warning) return null
  return { version: version ?? detailText(warning?.details?.version), newer: status.newerSdk }
}

/** Why a backend stops that has nothing to do with the app's Rayfin version. */
const NOT_THE_SDK = new Set(['port-in-use', 'schema-refused', 'packages-missing'])

/**
 * The backend stopped on a problem in the app, as a Rayfin version of a newer
 * line can cause: not one outside the app, nor one the preview has the user
 * settle (a refused data model change, packages to install).
 */
function stoppedInTheApp(status: LocalStatus): boolean {
  const code = status.state === 'error' ? (status.error?.code ?? '') : null
  return code !== null && !OUTSIDE_THE_APP.has(code) && !NOT_THE_SDK.has(code)
}

/**
 * The app's Rayfin version is why it runs on its published backend: a version
 * older than rayfin-local implements, or a newer one it couldn't start with.
 */
function sdkFallback(status: LocalStatus): { version: string | null; newer: boolean } | null {
  const sdk = unsupportedSdk(status)
  return sdk && (!sdk.newer || stoppedInTheApp(status)) ? sdk : null
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

/** A team deployment a live preview can connect to (as `local_preview::usable`). */
function usableDeployment(record: TeamDeployRecord | undefined): boolean {
  if (!record) return false
  return (
    Object.keys(record.publicEnv ?? {}).length > 0 || Boolean(record.itemId && record.workspaceId)
  )
}

/**
 * Whether an app has a backend in Fabric that its preview can use when this
 * computer can't run the app: its published app or, for a team app, the
 * team's deployment of it (your preview, or the published app). As the Rust
 * `agent_skills::has_fabric_backend`.
 */
export function hasFabricBackend(project: StudioProject | null | undefined): boolean {
  if (!project) return false
  if (project.team) {
    return usableDeployment(project.team.preview) || usableDeployment(project.team.production)
  }
  return Boolean(project.lastDeploy?.url)
}

/**
 * Why a published app's preview uses its published backend instead of this
 * computer's, as a sentence; `null` when the local backend can run the app.
 * rayfin-local says so in `analysis` and `ready` (the SDK, and each
 * connector's `supported`) and with `sdk-unsupported` and
 * `connector-unsupported` warnings. A Rayfin version of a newer line runs here
 * anyway, with {@link localSdkWarning}, unless the app couldn't start with it.
 * A team app's preview uses the team's deployment of it instead (`team`).
 * In the interface's language, or in English for logs (`english`).
 */
export function localFallbackReason(
  status: LocalStatus | null | undefined,
  { team = false, english = false }: { team?: boolean; english?: boolean } = {}
): string | null {
  if (!status) return null
  const t = english ? i18n.getFixedT('en', 'preview') : translator('preview')
  const sdk = sdkFallback(status)
  if (sdk?.newer) {
    if (sdk.version) {
      return team
        ? t('fallback.team.newerVersion', { version: sdk.version })
        : t('fallback.published.newerVersion', { version: sdk.version })
    }
    return team ? t('fallback.team.newer') : t('fallback.published.newer')
  }
  if (sdk) {
    if (sdk.version) {
      return team
        ? t('fallback.team.oldVersion', { version: sdk.version })
        : t('fallback.published.oldVersion', { version: sdk.version })
    }
    return team ? t('fallback.team.old') : t('fallback.published.old')
  }
  const names = unsupportedConnectors(status)
  if (names.length === 0) return null
  if (names.length === 1) {
    return team
      ? t('fallback.team.connector', { name: names[0] })
      : t('fallback.published.connector', { name: names[0] })
  }
  const list = english ? sentenceList(names) : formatList(names)
  return team
    ? t('fallback.team.connectors', { names: list })
    : t('fallback.published.connectors', { names: list })
}

/** The code behind {@link localFallbackReason}: `sdk-unsupported` or `connector-unsupported`. */
export function localFallbackCode(
  status: LocalStatus | null | undefined
): 'sdk-unsupported' | 'connector-unsupported' | null {
  if (!status) return null
  if (sdkFallback(status)) return 'sdk-unsupported'
  return unsupportedConnectors(status).length > 0 ? 'connector-unsupported' : null
}

/**
 * The Rayfin version the backend last found it can't run, when that's why the
 * app previews on its backend in Fabric. It's what the backend reported, so it
 * stays the same after the app's packages change, until it starts again.
 */
export function fallbackSdkVersion(status: LocalStatus | null | undefined): string | null {
  return (status && sdkFallback(status)?.version) || null
}

/** The Rayfin SDK version an app has installed: its packages ship in lockstep. */
export function installedSdkVersion(info: RayfinVersionInfo | null | undefined): string | null {
  const sdk = info?.packages.filter((p) => p.kind === 'sdk' && p.installed) ?? []
  return (sdk.find((p) => p.name === '@microsoft/rayfin-core') ?? sdk[0])?.installed ?? null
}

/**
 * A warning for an app that runs on this computer on a Rayfin version the
 * local backend doesn't implement, as a sentence: one of a newer line runs
 * here anyway, as it does in rayfin-local, and so does any version of an app
 * with no published backend to use instead. `null` otherwise.
 */
export function localSdkWarning(status: LocalStatus | null | undefined): string | null {
  const sdk = status ? unsupportedSdk(status) : null
  if (!sdk) return null
  const t = translator('preview')
  if (sdk.newer) {
    return sdk.version
      ? t('sdkWarning.newerVersion', { version: sdk.version })
      : t('sdkWarning.newer')
  }
  return sdk.version
    ? t('sdkWarning.olderVersion', { version: sdk.version })
    : t('sdkWarning.older')
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
