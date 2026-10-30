import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import type { LocalLogEvent, LocalProblem, LocalReady, LocalStatus } from '@shared/ipc'
import { api } from './api'
import {
  LocalBackendError,
  alreadyServing,
  changesLocalSupport,
  localBackendStore,
  localFallbackCode,
  localFallbackReason,
  localStateLabel,
  refusedSchemaLosses,
  retriesAfterTurn,
  runningProblems,
  useLocalBackend,
  useLocalBackendLogs
} from './localBackend'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))

function status(patch: Partial<LocalStatus> = {}): LocalStatus {
  return {
    projectId: 'p1',
    state: 'stopped',
    revision: 1,
    phase: null,
    pid: null,
    version: null,
    projectRoot: null,
    signInAs: null,
    ready: null,
    analysis: null,
    schema: null,
    functions: null,
    vite: null,
    config: null,
    warnings: [],
    error: null,
    stopped: null,
    crashes: 0,
    startedAt: null,
    updatedAt: null,
    ...patch
  }
}

const ready: LocalReady = {
  appUrl: 'http://localhost:5173/',
  apiUrl: 'http://localhost:7171',
  embedUrl: null,
  portalUrl: 'http://localhost:7171/.rayfin-local/portal',
  dataDir: null,
  signInAs: { kind: 'developer' },
  sdk: { version: '1.36.2', supported: true },
  features: {
    data: { enabled: true, entities: ['Note'] },
    functions: { enabled: false, names: [] },
    storage: { enabled: false, folders: [] },
    auth: { enabled: true, fabric: true, password: false },
    connectors: []
  },
  time: null
}

function problem(code: string, details: LocalProblem['details'] = null): LocalProblem {
  return { code, message: `${code} happened.`, hint: null, fatal: true, details, time: null }
}

function line(seq: number, projectId = 'p1'): LocalLogEvent {
  return {
    projectId,
    seq,
    source: 'vite',
    level: 'info',
    line: `line ${seq}`,
    time: '2026-10-30T03:12:09.512Z'
  }
}

let emitState: (status: LocalStatus) => void
let emitLog: (line: LocalLogEvent) => void
let local: Record<string, Mock>
let preview: { resetSiteData: Mock }

beforeEach(() => {
  localBackendStore.clear()
  preview = { resetSiteData: vi.fn(async () => true) }
  local = {
    start: vi.fn(async (id: string) => status({ projectId: id, state: 'starting' })),
    stop: vi.fn(async (id: string) => status({ projectId: id })),
    restart: vi.fn(async (id: string) => status({ projectId: id, state: 'starting' })),
    status: vi.fn(async (id: string) => status({ projectId: id })),
    reload: vi.fn(async () => ({ schema: null, config: null })),
    resetData: vi.fn(async () => undefined),
    installPackages: vi.fn(async () => undefined),
    stopExternal: vi.fn(async () => undefined),
    logs: vi.fn(async () => []),
    onState: vi.fn((cb: (status: LocalStatus) => void) => {
      emitState = cb
      return () => {}
    }),
    onLog: vi.fn((cb: (line: LocalLogEvent) => void) => {
      emitLog = cb
      return () => {}
    })
  }
  ;(window as unknown as { api: unknown }).api = { local, preview }
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('useLocalBackend', () => {
  it('follows its project and keeps the newest snapshot', async () => {
    const { result } = renderHook(() => useLocalBackend('p1'))
    await waitFor(() => expect(result.current.status).not.toBeNull())
    expect(local.status).toHaveBeenCalledWith('p1')
    expect(result.current.state).toBe('stopped')

    act(() => emitState(status({ state: 'running', revision: 3, ready })))
    expect(result.current.state).toBe('running')
    expect(result.current.ready?.appUrl).toBe('http://localhost:5173/')

    act(() => emitState(status({ state: 'starting', revision: 2 })))
    act(() => emitState(status({ projectId: 'p2', state: 'error', revision: 9 })))
    expect(result.current.state).toBe('running')
    expect(result.current.error).toBeNull()
  })

  it('applies a schema change and resets data the way the state allows', async () => {
    const { result } = renderHook(() => useLocalBackend('p1'))
    act(() =>
      emitState(
        status({
          state: 'error',
          revision: 5,
          error: problem('schema-refused', { losses: ['Note.title'] })
        })
      )
    )
    expect(refusedSchemaLosses(result.current.status)).toEqual(['Note.title'])
    await act(async () => {
      await result.current.applySchemaChange()
      await result.current.resetData()
    })
    expect(local.restart).toHaveBeenNthCalledWith(1, 'p1', { forceSchema: true })
    expect(local.restart).toHaveBeenNthCalledWith(2, 'p1', { reset: true })
    expect(preview.resetSiteData).not.toHaveBeenCalled()

    act(() => emitState(status({ state: 'running', revision: 10, ready })))
    await act(async () => {
      await result.current.applySchemaChange()
      await result.current.resetData()
    })
    expect(local.reload).toHaveBeenCalledWith('p1', true)
    expect(local.resetData).toHaveBeenCalledWith('p1')
    expect(local.restart).toHaveBeenCalledTimes(2)
    // The reset signed the preview's session out: it signs in again from scratch.
    expect(preview.resetSiteData).toHaveBeenCalledTimes(1)
    expect(local.resetData.mock.invocationCallOrder[0]).toBeLessThan(
      preview.resetSiteData.mock.invocationCallOrder[0]
    )
  })

  it('resets the data under a refused change, which then applies, and installs missing packages before starting again', async () => {
    const { result } = renderHook(() => useLocalBackend('p1'))
    const schema = {
      result: 'refused' as const,
      changes: ['changed Note'],
      losses: ['Note.title (3 values)'],
      message: null,
      live: true,
      time: '2026-10-30T03:12:09.512Z'
    }
    act(() => emitState(status({ state: 'running', revision: 3, ready, schema })))
    await act(async () => {
      await result.current.resetData()
    })
    expect(local.resetData).toHaveBeenCalledWith('p1')
    expect(local.reload).toHaveBeenCalledWith('p1', false)
    expect(local.resetData.mock.invocationCallOrder[0]).toBeLessThan(
      local.reload.mock.invocationCallOrder[0]
    )

    act(() =>
      emitState(
        status({
          state: 'error',
          revision: 4,
          error: problem('packages-missing', { dir: 'rayfin/functions' })
        })
      )
    )
    await act(async () => {
      await result.current.installPackages()
    })
    expect(local.installPackages).toHaveBeenCalledWith('p1')
    expect(local.restart).toHaveBeenCalledWith('p1')
    expect(local.installPackages.mock.invocationCallOrder[0]).toBeLessThan(
      local.restart.mock.invocationCallOrder[0]
    )
  })

  it('stops the other serve that holds the project, then starts', async () => {
    const { result } = renderHook(() => useLocalBackend('p1'))
    const details = { pid: 4242, appUrl: null, apiUrl: 'http://localhost:7171' }
    act(() =>
      emitState(status({ state: 'error', revision: 4, error: problem('already-serving', details) }))
    )
    expect(alreadyServing(result.current.status)).toEqual(details)
    await act(async () => {
      await result.current.stopOtherServe()
    })
    expect(local.stopExternal).toHaveBeenCalledWith('p1', 4242)
    expect(local.start).toHaveBeenCalledWith('p1')
    expect(local.stopExternal.mock.invocationCallOrder[0]).toBeLessThan(
      local.start.mock.invocationCallOrder[0]
    )
  })

  it("keeps a failed action's error instead of rejecting", async () => {
    local.start.mockRejectedValueOnce(
      new LocalBackendError({ code: 'project-not-found', message: 'Gone.', hint: 'Open it again.' })
    )
    const { result } = renderHook(() => useLocalBackend('p1'))
    await act(async () => {
      await result.current.start({ signInAs: 'none' })
    })
    expect(local.start).toHaveBeenCalledWith('p1', { signInAs: 'none' })
    expect(result.current.actionError).toMatchObject({
      code: 'project-not-found',
      hint: 'Open it again.'
    })
    expect(result.current.busy).toBe(false)
    await act(async () => {
      await result.current.stop()
    })
    expect(result.current.actionError).toBeNull()
  })

  it('does nothing without a project', async () => {
    const { result } = renderHook(() => useLocalBackend(null))
    await act(async () => {
      expect(await result.current.start()).toBeNull()
    })
    expect(result.current.status).toBeNull()
    expect(local.start).not.toHaveBeenCalled()
    expect(local.status).not.toHaveBeenCalled()
  })
})

describe('useLocalBackendLogs', () => {
  it('merges the fetched tail with live lines, without repeats', async () => {
    let resolveTail: (lines: LocalLogEvent[]) => void = () => {}
    local.logs.mockReturnValueOnce(new Promise((resolve) => (resolveTail = resolve)))
    const { result } = renderHook(() => useLocalBackendLogs('p1', 3))
    act(() => emitLog(line(3)))
    act(() => emitLog(line(9, 'p2')))
    await act(async () => resolveTail([line(1), line(2), line(3)]))
    expect(local.logs).toHaveBeenCalledWith('p1', 3)
    expect(result.current.map((l) => l.seq)).toEqual([1, 2, 3])

    act(() => emitLog(line(4)))
    act(() => emitLog(line(4)))
    expect(result.current.map((l) => l.seq)).toEqual([2, 3, 4])
  })
})

describe('local backend helpers', () => {
  it('labels states for a status pill', () => {
    expect(localStateLabel(null)).toBe('Stopped')
    expect(localStateLabel(status({ state: 'starting' }))).toBe('Starting…')
    expect(localStateLabel(status({ state: 'restarting' }))).toBe('Restarting…')
    expect(localStateLabel(status({ state: 'error' }))).toBe('Error')
  })

  it('tells a running app with a problem from one without', () => {
    const at = '2026-10-30T17:18:08.000Z'
    const unread: LocalStatus['analysis'] = {
      ok: false,
      sdk: null,
      entities: [],
      storageFolders: [],
      message: 'The data package packages/data has not been built.',
      time: at
    }
    const running = status({ state: 'running', ready })
    expect(runningProblems(running)).toEqual([])
    expect(localStateLabel(running)).toBe('Running')

    const stuck = status({ state: 'running', ready, analysis: unread })
    expect(runningProblems(stuck)).toEqual([
      {
        kind: 'analysis',
        summary:
          'Your app’s latest data model change couldn’t be read, so it still uses the previous data model.',
        detail: 'The data package packages/data has not been built.'
      }
    ])
    expect(localStateLabel(stuck)).toBe('Running · problem')

    const worse = status({
      state: 'running',
      ready,
      analysis: unread,
      schema: {
        result: 'failed',
        changes: [],
        losses: [],
        message: 'SQLITE_BUSY',
        live: true,
        time: at
      },
      functions: {
        state: 'failed',
        names: [],
        errors: ['src/index.ts(3,1): error TS2304'],
        message: null,
        time: at
      },
      vite: { state: 'failed', url: null, version: null, message: 'Vite kept exiting.', time: at }
    })
    expect(runningProblems(worse).map((p) => [p.kind, p.detail])).toEqual([
      ['analysis', 'The data package packages/data has not been built.'],
      ['schema', 'SQLITE_BUSY'],
      ['functions', 'src/index.ts(3,1): error TS2304'],
      ['vite', 'Vite kept exiting.']
    ])
    expect(localStateLabel(worse)).toBe('Running · 4 problems')

    // A change waiting for a decision has its own note; a Vite restarting on its own isn't one.
    const waiting = status({
      state: 'running',
      ready,
      schema: {
        result: 'refused',
        changes: [],
        losses: ['Tag'],
        message: null,
        live: true,
        time: at
      },
      vite: { state: 'restarting', url: null, version: null, message: null, time: at }
    })
    expect(runningProblems(waiting)).toEqual([])
    // A stopped backend says why elsewhere.
    expect(runningProblems(status({ state: 'error', analysis: unread }))).toEqual([])
  })

  it('finds a live refused schema change, and nothing otherwise', () => {
    const schema = {
      result: 'refused' as const,
      changes: [],
      losses: ['Tag'],
      message: null,
      live: true,
      time: null
    }
    expect(refusedSchemaLosses(status({ state: 'running', schema }))).toEqual(['Tag'])
    expect(refusedSchemaLosses(status({ state: 'running' }))).toBeNull()
    expect(alreadyServing(status({ state: 'error', error: problem('crashed') }))).toBeNull()
  })

  it('says why a published app previews on its published backend, and only when it must', () => {
    const analysis = (version: string | null, supported: boolean): LocalStatus['analysis'] => ({
      ok: true,
      sdk: { version, supported },
      entities: [],
      storageFolders: [],
      message: null,
      time: null
    })
    const tooNew = status({ state: 'starting', analysis: analysis('1.40.1', false) })
    expect(localFallbackReason(tooNew)).toBe(
      'This app uses Rayfin 1.40.1, which Fabricator can’t run on this computer yet, so the preview uses your published app’s backend.'
    )
    expect(localFallbackCode(tooNew)).toBe('sdk-unsupported')
    const warned = status({
      warnings: [{ ...problem('sdk-unsupported', { version: '1.37.0' }), fatal: false }]
    })
    expect(localFallbackReason(warned)).toContain('Rayfin 1.37.0')
    // Packages that aren't installed have no version: another problem, not a fallback.
    expect(localFallbackReason(status({ analysis: analysis(null, false) }))).toBeNull()

    const connectors = status({
      state: 'running',
      ready: {
        ...ready,
        features: {
          ...ready.features,
          connectors: [
            { name: 'sales', type: 'fabric-semanticmodel', supported: true },
            { name: 'logs', type: 'kusto', supported: false }
          ]
        }
      }
    })
    expect(localFallbackReason(connectors)).toBe(
      'The logs connector runs only on Fabric, so the preview uses your published app’s backend.'
    )
    expect(localFallbackCode(connectors)).toBe('connector-unsupported')
    // A stopped backend keeps its warnings, so the reason outlives the run.
    const stopped = status({
      warnings: ['logs', 'events', 'audit'].map((name) => ({
        ...problem('connector-unsupported', { name, type: 'kusto' }),
        fatal: false
      }))
    })
    expect(localFallbackReason(stopped)).toBe(
      'The logs, events and audit connectors run only on Fabric, so the preview uses your published app’s backend.'
    )
    expect(localFallbackReason(status({ state: 'running', ready }))).toBeNull()
    expect(localFallbackCode(status({ state: 'running', ready }))).toBeNull()
  })

  it('tells which changed files can change whether this computer runs the app', () => {
    expect(changesLocalSupport(['package.json'])).toBe(true)
    expect(changesLocalSupport(['C:\\apps\\notes\\rayfin\\rayfin.yml'])).toBe(true)
    expect(changesLocalSupport(['web/Package.json'])).toBe(true)
    expect(changesLocalSupport(['src/App.tsx', 'rayfin/data/Note.ts', 'package-lock.json'])).toBe(
      false
    )
  })

  it('starts again after a turn only a backend a problem in the app stopped', () => {
    const failed = (code: string): LocalStatus => status({ state: 'error', error: problem(code) })
    for (const code of ['analysis-failed', 'packages-missing', 'schema-refused', 'crashed']) {
      expect(retriesAfterTurn(failed(code)), code).toBe(true)
    }
    for (const code of ['already-serving', 'node-missing', 'binary-blocked']) {
      expect(retriesAfterTurn(failed(code)), code).toBe(false)
    }
    expect(retriesAfterTurn(status({ state: 'running', ready }))).toBe(false)
  })
})

describe('window.api.local', () => {
  it('invokes the local_* commands with their arguments', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined)
    await api.local.start('p1', { forceSchema: true })
    expect(invoke).toHaveBeenLastCalledWith('local_start', {
      projectId: 'p1',
      options: { forceSchema: true }
    })
    await api.local.restart('p1')
    expect(invoke).toHaveBeenLastCalledWith('local_restart', { projectId: 'p1', options: null })
    await api.local.rows('p1', 'Note', 0, 50, 'title', true)
    expect(invoke).toHaveBeenLastCalledWith('local_rows', {
      projectId: 'p1',
      entity: 'Note',
      offset: 0,
      limit: 50,
      orderBy: 'title',
      desc: true
    })
    await api.local.setIdentity('p1', { kind: 'user', user: 'ana@example.com', create: true })
    expect(invoke).toHaveBeenLastCalledWith('local_set_identity', {
      projectId: 'p1',
      identity: { kind: 'user', user: 'ana@example.com', create: true }
    })
    await api.local.setSecret('p1', 'API_KEY', 'value')
    expect(invoke).toHaveBeenLastCalledWith('local_set_secret', {
      projectId: 'p1',
      name: 'API_KEY',
      value: 'value'
    })
    await api.local.stopExternal('p1', 4242)
    expect(invoke).toHaveBeenLastCalledWith('local_stop_external', { projectId: 'p1', pid: 4242 })
  })

  it('rejects with a LocalBackendError that carries the code', async () => {
    vi.mocked(invoke).mockRejectedValueOnce({
      code: 'not-running',
      message: "The local backend isn't running.",
      hint: 'Start it first.'
    })
    const error = await api.local.users('p1').catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(LocalBackendError)
    expect(error).toMatchObject({
      code: 'not-running',
      hint: 'Start it first.',
      message: "The local backend isn't running."
    })

    vi.mocked(invoke).mockRejectedValueOnce('A plain failure.')
    await expect(api.local.status('p1')).rejects.toMatchObject({
      code: 'error',
      message: 'A plain failure.'
    })
  })
})
