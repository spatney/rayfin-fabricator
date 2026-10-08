import { describe, expect, it, vi } from 'vitest'
import type { DeployResult } from '@shared/ipc'
import { deferred } from '../test/deferred'
import { DeploymentQueue } from './deploymentQueue'

describe('shared deployment queue', () => {
  it('cancels only queued automatic deployments, preserving active and manual work', async () => {
    const first = deferred<DeployResult>()
    const run = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ ok: true, outcome: 'success' })
    const queue = new DeploymentQueue()
    const active = queue.enqueue({ projectId: 'p1', automatic: true }, run)
    const automatic = queue.enqueue({ projectId: 'p2', automatic: true }, run)
    const manual = queue.enqueue({ projectId: 'p2' }, run)
    expect(manual).not.toBe(automatic)
    queue.cancelPending('Auto-deploy paused', (request) => Boolean(request.automatic))
    expect(await automatic).toEqual({ ok: false, outcome: 'error', error: 'Auto-deploy paused' })
    expect(run).toHaveBeenCalledTimes(1)
    first.resolve({ ok: true, outcome: 'success' })
    await Promise.all([active, manual])
    expect(run).toHaveBeenCalledTimes(2)
    expect(run).toHaveBeenLastCalledWith('p2', undefined)
  })

  it('serializes projects and returns each actual result', async () => {
    const first = deferred<DeployResult>()
    const run = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ ok: true, url: 'second' })
    const queue = new DeploymentQueue()
    const a = queue.enqueue({ projectId: 'a' }, run)
    const b = queue.enqueue({ projectId: 'b', workspace: 'workspace-b' }, run)
    expect(run).toHaveBeenCalledTimes(1)
    first.resolve({ ok: false, outcome: 'error', error: 'Failed' })
    expect(await a).toMatchObject({ ok: false })
    expect(await b).toMatchObject({ url: 'second' })
    expect(run).toHaveBeenLastCalledWith('b', 'workspace-b')
  })

  it('coalesces duplicate waiting requests but not different workspace targets', async () => {
    const first = deferred<DeployResult>()
    const run = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ ok: true })
    const queue = new DeploymentQueue()
    const running = queue.enqueue({ projectId: 'p0' }, run)
    const a = queue.enqueue({ projectId: 'p1' }, run)
    expect(queue.enqueue({ projectId: 'p1' }, run)).toBe(a)
    const b = queue.enqueue({ projectId: 'p1', workspace: 'different' }, run)
    expect(b).not.toBe(a)
    first.resolve({ ok: true, outcome: 'success' })
    await Promise.all([running, a, b])
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('queues a fresh run when the same deploy is requested while it is running', async () => {
    const first = deferred<DeployResult>()
    const run = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ ok: true, outcome: 'success' })
    const queue = new DeploymentQueue()
    const a = queue.enqueue({ projectId: 'p1' }, run)
    const b = queue.enqueue({ projectId: 'p1' }, run)
    expect(b).not.toBe(a)
    first.resolve({ ok: true, outcome: 'success' })
    await Promise.all([a, b])
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('does not leave a waiter hanging when pending work is cancelled', async () => {
    const first = deferred<DeployResult>()
    const run = vi.fn(() => first.promise)
    const queue = new DeploymentQueue()
    const a = queue.enqueue({ projectId: 'p1' }, run)
    const b = queue.enqueue({ projectId: 'p2' }, run)
    queue.cancelPending('Sign-in failed')
    expect(await b).toEqual({ ok: false, outcome: 'error', error: 'Sign-in failed' })
    first.resolve({ ok: true, outcome: 'success' })
    await a
  })
})
