import { describe, expect, it, vi } from 'vitest'
import type { DeployResult } from '@shared/ipc'
import { deferred } from '../../test/deferred'
import { DeploymentQueue } from './deploymentQueue'

describe('shared deployment queue', () => {
  it('serializes projects and returns each actual result', async () => {
    const first = deferred<DeployResult>()
    const run = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ ok: true, url: 'second' })
    const queue = new DeploymentQueue()
    const a = queue.enqueue({ projectId: 'a' }, run)
    const b = queue.enqueue({ projectId: 'b', workspace: 'workspace-b', applyId: 'apply-b' }, run)
    expect(run).toHaveBeenCalledTimes(1)
    first.resolve({ ok: false, outcome: 'error', error: 'Failed' })
    expect(await a).toMatchObject({ ok: false })
    expect(await b).toMatchObject({ url: 'second' })
    expect(run).toHaveBeenLastCalledWith('b', 'workspace-b', 'apply-b')
  })

  it('coalesces duplicate Apply requests without coalescing different workspace targets', async () => {
    const first = deferred<DeployResult>()
    const run = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ ok: true })
    const queue = new DeploymentQueue()
    const a = queue.enqueue({ projectId: 'p1', applyId: 'apply' }, run)
    expect(queue.enqueue({ projectId: 'p1', applyId: 'apply' }, run)).toBe(a)
    const b = queue.enqueue({ projectId: 'p1', workspace: 'different', applyId: 'apply' }, run)
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
