import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeployResult } from '@shared/ipc'
import type { DesignApplyServices } from './apply'
import { applyDesign, retryDesignDeployment } from './apply'
import { DesignSession } from './session'
import { createDesignHarness, designReceipt } from './testFixtures'

const sessions: DesignSession[] = []
afterEach(() => {
  for (const session of sessions.splice(0)) session.setTarget(null)
  vi.useRealTimers()
})

async function setup() {
  const harness = createDesignHarness()
  const session = new DesignSession('p1', harness.api)
  sessions.push(session)
  await session.initialize('direct')
  session.setTarget({ url: 'https://app.example', appUrl: 'https://app.example', embedded: false })
  await session.reconnect()
  await session.command({ type: 'style', values: { color: '#ff0000' } })
  await session.flush()
  const services = {
    api: harness.api,
    capture: vi.fn(async () => 'data:image/png;base64,AAAA'),
    saveScreenshot: vi.fn(async () => 'C:\\temp\\design.png'),
    cleanupScreenshot: vi.fn(async () => {}),
    deploy: vi.fn(
      async (_projectId: string, _workspace?: string, applyId?: string): Promise<DeployResult> => {
        if (!applyId) throw new Error('An Apply ID is required')
        harness.setReceipt(
          designReceipt({
            id: applyId,
            phase: 'deployed',
            deployment: { ok: true, outcome: 'success' }
          })
        )
        return { ok: true, outcome: 'success' }
      }
    ),
    refresh: vi.fn(async () => {}),
    onTurnStart: vi.fn(),
    onTurnComplete: vi.fn()
  } satisfies DesignApplyServices
  vi.spyOn(session, 'waitForFreshDocument').mockResolvedValue()
  return { session, harness, services }
}

describe('visual Apply workflow', () => {
  it('captures the desired draft even when Apply is clicked while comparing Original', async () => {
    const { session, harness, services } = await setup()
    await session.command({ type: 'compare', enabled: true })
    services.capture.mockImplementation(async () => {
      expect(harness.frame()?.compare).toBe(false)
      return 'data:image/png;base64,AAAA'
    })
    await applyDesign(session, services)
    expect(services.capture).toHaveBeenCalledTimes(1)
  })

  it('sends source once, deploys once, verifies the real result and closes the draft', async () => {
    const { session, harness, services } = await setup()
    await applyDesign(session, services)
    expect(harness.api.apply).toHaveBeenCalledTimes(1)
    expect(services.deploy).toHaveBeenCalledTimes(1)
    const id = services.onTurnStart.mock.calls[0][1]
    expect(services.deploy).toHaveBeenCalledWith('p1', undefined, id)
    expect(services.onTurnComplete).toHaveBeenCalledTimes(1)
    expect(harness.api.finish).toHaveBeenCalledWith('p1', id, true)
    expect(session.getSnapshot().draft?.cursor).toBe(0)
    expect(session.getSnapshot().reviewing).toBe(false)
    expect(session.getSnapshot().busy).toBe(false)
  })

  it('does not deploy a partial or failed source Apply', async () => {
    const { session, harness, services } = await setup()
    harness.api.apply.mockResolvedValueOnce(
      designReceipt({ phase: 'needs-review', error: 'Two edits could not be mapped.' })
    )
    await expect(applyDesign(session, services)).rejects.toThrow('could not be mapped')
    expect(services.deploy).not.toHaveBeenCalled()
    expect(session.getSnapshot().draft?.cursor).toBe(1)
    expect(session.getSnapshot().reviewing).toBe(true)
  })

  it('keeps source success separate from deployment failure and retries only deployment', async () => {
    const { session, harness, services } = await setup()
    services.deploy.mockImplementationOnce(async () => ({
      ok: false,
      outcome: 'error',
      error: 'Fabric unavailable'
    }))
    await expect(applyDesign(session, services)).rejects.toThrow('Fabric unavailable')
    expect(session.getSnapshot().draft?.cursor).toBe(1)
    expect(session.getSnapshot().receipt?.phase).toBe('source-updated')
    await retryDesignDeployment(session, services)
    expect(harness.api.apply).toHaveBeenCalledTimes(1)
    expect(services.deploy).toHaveBeenCalledTimes(2)
  })

  it('keeps the draft open when fresh-DOM verification cannot confirm an edit', async () => {
    const { session, harness, services } = await setup()
    vi.useFakeTimers()
    const command = harness.api.command.getMockImplementation()!
    harness.api.command.mockImplementation(async (request) => {
      const result = await command(request)
      if (request.type === 'verify')
        result.verification = [
          { transactionId: request.history[0].id, ok: false, message: 'Target ambiguous' }
        ]
      return result
    })
    const applying = applyDesign(session, services)
    await vi.advanceTimersByTimeAsync(11_000)
    await applying
    expect(harness.api.finish).toHaveBeenLastCalledWith('p1', expect.any(String), false)
    expect(session.getSnapshot().draft?.cursor).toBe(1)
    expect(session.getSnapshot().receipt?.phase).toBe('needs-review')
  })

  it('waits for auth/data-driven elements to mount before finalizing verification', async () => {
    const { session, harness, services } = await setup()
    vi.useFakeTimers()
    const command = harness.api.command.getMockImplementation()!
    let attempts = 0
    harness.api.command.mockImplementation(async (request) => {
      const result = await command(request)
      if (request.type === 'verify' && ++attempts === 1) {
        result.verification = [
          {
            transactionId: request.history[0].id,
            ok: false,
            message: 'Target is missing while the page loads'
          }
        ]
      }
      return result
    })
    const applying = applyDesign(session, services)
    await vi.advanceTimersByTimeAsync(1000)
    await applying
    expect(attempts).toBe(2)
    expect(harness.api.finish).toHaveBeenLastCalledWith('p1', expect.any(String), true)
    expect(session.getSnapshot().draft?.cursor).toBe(0)
  })

  it('can continue without a screenshot, with a visible warning rather than losing changes', async () => {
    const { session, harness, services } = await setup()
    services.capture.mockRejectedValueOnce(new Error('Capture unavailable'))
    services.deploy.mockImplementationOnce(async () => ({
      ok: false,
      outcome: 'error',
      error: 'Keep receipt for review'
    }))
    await expect(applyDesign(session, services)).rejects.toThrow('Keep receipt')
    expect(harness.api.apply).toHaveBeenCalledTimes(1)
    expect(harness.api.apply.mock.calls[0][3]).toBeUndefined()
    expect(session.getSnapshot().draft?.cursor).toBe(1)
  })
})
