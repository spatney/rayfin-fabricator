import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deferred } from '../../test/deferred'
import { DesignSession } from './session'
import { newDesignDraft } from './protocol'
import { createDesignHarness, designReceipt, designTransaction } from './testFixtures'

const sessions: DesignSession[] = []
const target = { url: 'https://app.example/', appUrl: 'https://app.example/', embedded: false }

async function ready(harness = createDesignHarness()) {
  const session = new DesignSession('p1', harness.api)
  sessions.push(session)
  await session.initialize('direct')
  session.setTarget(target)
  await session.reconnect()
  return { session, harness }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  for (const session of sessions.splice(0)) session.setTarget(null)
  vi.useRealTimers()
})

describe('Design draft coordinator', () => {
  it('restores the durable journal after a no-source-change failure reloaded into read-only mode', async () => {
    const { session, harness } = await ready()
    await session.command({ type: 'style', values: { color: '#ff0000' } })
    await session.prepareApply()
    harness.setDocument('reloaded-during-apply')
    await session.reconnect()
    expect(harness.api.connect.mock.calls.at(-1)?.[0].history).toEqual([])
    session.setReceipt(designReceipt({ phase: 'error', filesModified: [], sourceRevisionAfter: 'source-1', error: 'Sign-in expired' }))
    expect(session.getSnapshot().draft?.cursor).toBe(1)
    session.reportError('Sign-in expired')
    session.finishBusy()
    await session.resumeUnappliedDraft()
    expect(harness.api.connect.mock.calls.at(-1)?.[0].cursor).toBe(1)
    expect(session.getSnapshot().draft?.cursor).toBe(1)
    expect(session.getSnapshot().error).toBe('Sign-in expired')
  })

  it('flushes the last native gesture before switching preview sources', async () => {
    const { session, harness } = await ready()
    const frame = harness.frame()!
    harness.setFrame({ ...frame, history: [designTransaction('last-gesture')], cursor: 1, revision: frame.revision + 1 })
    await session.setSource('fabric')
    expect(harness.stored()?.history[0].id).toBe('last-gesture')
    expect(harness.stored()?.source).toBe('fabric')
  })

  it('captures a native gesture when a covering view pauses the preview', async () => {
    const { session, harness } = await ready()
    const frame = harness.frame()!
    harness.setFrame({ ...frame, history: [designTransaction('paused-gesture')], cursor: 1, revision: frame.revision + 1 })
    session.setTarget(null)
    session.setTarget(target)
    await session.reconnect()
    await session.flush()
    expect(harness.stored()?.history[0].id).toBe('paused-gesture')
  })

  it('persists a fresh draft and connects independently of any chat or model request', async () => {
    const { session, harness } = await ready()
    expect(session.getSnapshot().ready).toBe(true)
    expect(session.getSnapshot().savedRevision).toBe(session.getSnapshot().draft?.revision)
    expect(harness.api.apply).not.toHaveBeenCalled()
    expect(harness.stored()?.projectId).toBe('p1')
  })

  it('recovers serializable edits and staged assets with a fresh connection nonce', async () => {
    const draft = newDesignDraft('p1', 'fabric', 'source-1')
    draft.history = [
      {
        ...designTransaction(),
        edits: [{ ...designTransaction().edits[0], kind: 'image', after: { assetId: 'asset-1' } }]
      }
    ]
    draft.cursor = 1
    draft.revision = 7
    const { session, harness } = await ready(createDesignHarness(draft))
    const options = harness.api.connect.mock.calls.at(-1)?.[0]
    expect(options?.history).toEqual(draft.history)
    expect(options?.assetPreviews).toEqual({ 'asset-1': 'data:image/png;base64,AAAA' })
    expect(options?.sessionId).not.toBe(draft.sessionId)
    expect(session.getSnapshot().draft?.source).toBe('fabric')
  })

  it('records committed gestures but not a continuous preview as a saved transaction', async () => {
    const { session, harness } = await ready()
    await session.command({
      type: 'style',
      values: { color: '#ff0000' },
      phase: 'preview',
      gestureId: 'g1'
    })
    await session.flush()
    expect(harness.stored()?.cursor).toBe(0)
    await session.command({
      type: 'style',
      values: { color: '#ff0000' },
      phase: 'commit',
      gestureId: 'g1'
    })
    await session.command({
      type: 'style',
      values: { color: '#00ff00' },
      phase: 'commit',
      gestureId: 'g2'
    })
    await session.flush()
    expect(harness.stored()?.cursor).toBe(2)
    await session.command({ type: 'undo' })
    await session.flush()
    expect(harness.stored()?.cursor).toBe(1)
    expect(harness.stored()?.history).toHaveLength(2)
  })

  it('does not acknowledge failed disk writes or leave Design through an unsaved exit', async () => {
    const { session, harness } = await ready()
    const saved = session.getSnapshot().savedRevision
    harness.api.save.mockRejectedValueOnce(new Error('Disk full'))
    await session.command({ type: 'style', values: { color: '#ff0000' } })
    await expect(session.suspend()).rejects.toThrow('Disk full')
    expect(session.getSnapshot().savedRevision).toBe(saved)
    expect(session.getSnapshot().saveError).toContain('Draft not saved')
    expect(session.getSnapshot().ready).toBe(true)
    await session.retrySave()
    expect(session.getSnapshot().saveError).toBeNull()
  })

  it('rejects unacknowledged and wrong-document commands without persisting their response', async () => {
    const { session, harness } = await ready()
    const snapshot = harness.frame()!
    harness.api.command.mockResolvedValueOnce({
      ...snapshot,
      documentId: 'old-document',
      acknowledged: []
    })
    await expect(session.command({ type: 'text', value: 'No' })).rejects.toThrow(
      'did not acknowledge'
    )
    expect(session.getSnapshot().error).toContain('current document')
    expect(harness.stored()?.cursor).toBe(0)
  })

  it('restores the canonical draft rather than accepting an empty journal after document replacement', async () => {
    const { session, harness } = await ready()
    await session.command({ type: 'style', values: { color: '#ff0000' } })
    await session.flush()
    const frame = harness.frame()!
    harness.setDocument('document-2')
    harness.setFrame({ ...frame, documentId: 'document-2', history: [], cursor: 0 })
    await vi.advanceTimersByTimeAsync(310)
    expect(session.getSnapshot().draft?.cursor).toBe(1)
    expect(harness.api.connect.mock.calls.at(-1)?.[0].cursor).toBe(1)
    expect(session.getSnapshot().snapshot?.documentId).toBe('document-2')
  })

  it('blocks Apply on changed source without losing the draft', async () => {
    const { session, harness } = await ready()
    await session.command({ type: 'style', values: { color: '#ff0000' } })
    harness.setSource('source-changed')
    await expect(session.prepareApply()).rejects.toThrow('source changed')
    expect(session.getSnapshot().sourceChanged).toBe(true)
    expect(session.getSnapshot().busy).toBe(false)
    expect(session.getSnapshot().draft?.cursor).toBe(1)
    expect(harness.api.apply).not.toHaveBeenCalled()
  })

  it('reserves Apply before asynchronous preparation and rejects a second Apply', async () => {
    const { session, harness } = await ready()
    await session.command({ type: 'style', values: { color: '#ff0000' } })
    const gate = deferred<string>()
    harness.api.sourceRevision.mockImplementationOnce(() => gate.promise)
    const first = session.prepareApply()
    await expect(session.prepareApply()).rejects.toThrow('already running')
    expect(session.getSnapshot().busy).toBe(true)
    gate.resolve('source-1')
    await first
  })

  it('does not mistake new draft edits for the previously accepted Apply on restart', async () => {
    const receipt = designReceipt({
      phase: 'deployed',
      deployment: { ok: true, outcome: 'success' }
    })
    const draft = newDesignDraft('p1', 'direct', 'source-2')
    draft.receipt = receipt
    draft.history = [designTransaction('new-edit')]
    draft.cursor = 1
    draft.revision = 9
    const harness = createDesignHarness(draft, receipt)
    harness.setSource('source-2')
    const { session } = await ready(harness)
    expect(session.getSnapshot().reviewing).toBe(false)
    expect(harness.api.connect.mock.calls.at(-1)?.[0].cursor).toBe(1)
  })

  it('keeps an interrupted source Apply unprojected until reviewed', async () => {
    const draft = newDesignDraft('p1', 'direct', 'source-1')
    draft.history = [designTransaction()]
    draft.cursor = 1
    const { session, harness } = await ready(
      createDesignHarness(draft, designReceipt({ phase: 'interrupted' }))
    )
    expect(session.getSnapshot().reviewing).toBe(true)
    expect(harness.api.connect.mock.calls.at(-1)?.[0].history).toEqual([])
    expect(session.getSnapshot().snapshot?.tool).toBe('interact')
    await expect(session.prepareApply()).rejects.toThrow('previous Apply')
  })
})
