import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import type { LocalLogEvent, LocalProblem, LocalReady, LocalStatus } from '@shared/ipc'
import { api } from './api'
import {
  LocalBackendError,
  alreadyServing,
  localBackendStore,
  localStateLabel,
  refusedSchemaLosses,
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

beforeEach(() => {
  localBackendStore.clear()
  local = {
    start: vi.fn(async (id: string) => status({ projectId: id, state: 'starting' })),
    stop: vi.fn(async (id: string) => status({ projectId: id })),
    restart: vi.fn(async (id: string) => status({ projectId: id, state: 'starting' })),
    status: vi.fn(async (id: string) => status({ projectId: id })),
    reload: vi.fn(async () => ({ schema: null, config: null })),
    resetData: vi.fn(async () => undefined),
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
  ;(window as unknown as { api: unknown }).api = { local }
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

    act(() => emitState(status({ state: 'running', revision: 10, ready })))
    await act(async () => {
      await result.current.applySchemaChange()
      await result.current.resetData()
    })
    expect(local.reload).toHaveBeenCalledWith('p1', true)
    expect(local.resetData).toHaveBeenCalledWith('p1')
    expect(local.restart).toHaveBeenCalledTimes(2)
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
