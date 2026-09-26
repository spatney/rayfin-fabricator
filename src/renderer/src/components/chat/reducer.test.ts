import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatToolCall } from '@shared/ipc'
import { reduceChatMessage } from './reducer'
import { ChatEventBuffer } from './eventCoalescer'
import { REASONING_STORE_MAX, segmentsForStorage, segmentsFromStorage } from './storage'
import type { UIChatMessage } from './types'

const base = (): UIChatMessage => ({
  id: 'a',
  turnId: 't',
  role: 'assistant',
  text: '',
  tools: [],
  segments: [],
  pending: true
})
const running: ChatToolCall = { id: 'x', name: 'powershell', title: 'Build', state: 'running' }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('reduceChatMessage streaming additions', () => {
  it('streams reasoning into one block and stamps its duration when text starts', () => {
    let m = reduceChatMessage(base(), { type: 'reasoning', id: 'r1', text: 'Let me ' })
    m = reduceChatMessage(m, { type: 'reasoning', id: 'r1', text: 'think' })
    expect(m.segments).toEqual([
      { kind: 'reasoning', id: 'r1', text: 'Let me think', startedAt: 1_000 }
    ])
    vi.setSystemTime(3_500)
    m = reduceChatMessage(m, { type: 'delta', text: 'Done.' })
    expect(m.segments).toEqual([
      { kind: 'reasoning', id: 'r1', text: 'Let me think', startedAt: 1_000, elapsedMs: 2_500 },
      { kind: 'text', text: 'Done.' }
    ])
  })

  it('starts a new block for a new reasoning id and closes reasoning at steps and turn end', () => {
    let m = reduceChatMessage(base(), { type: 'reasoning', id: 'r1', text: 'a' })
    vi.setSystemTime(1_400)
    m = reduceChatMessage(m, { type: 'reasoning', id: 'r2', text: 'b' })
    m = reduceChatMessage(m, { type: 'tool-start', tool: running })
    expect(m.segments?.map((s) => (s.kind === 'reasoning' ? [s.id, s.elapsedMs] : s.kind))).toEqual(
      [['r1', 400], ['r2', 0], 'tool']
    )
    const ended = reduceChatMessage(
      reduceChatMessage(base(), { type: 'reasoning', id: 'r', text: 'x' }),
      {
        type: 'result',
        ok: true,
        filesModified: [],
        ranDeploy: false
      }
    )
    expect(ended.segments?.[0]).toMatchObject({ kind: 'reasoning', elapsedMs: 0 })
  })

  it('timestamps steps, shows live output while running, and keeps the final details', () => {
    let m = reduceChatMessage(base(), { type: 'tool-start', tool: running })
    expect(m.tools[0].startedAt).toBe(1_000)
    m = reduceChatMessage(m, { type: 'tool-output', id: 'x', text: 'vite building' })
    expect(m.tools[0].output).toBe('vite building')
    const same = reduceChatMessage(m, { type: 'tool-output', id: 'x', text: 'vite building' })
    expect(same).toBe(m)
    vi.setSystemTime(35_000)
    m = reduceChatMessage(m, {
      type: 'tool-end',
      id: 'x',
      state: 'success',
      output: 'built',
      exitCode: 0,
      diff: '@@ -1 +1 @@\n-a\n+b',
      added: 1,
      removed: 1
    })
    expect(m.tools[0]).toMatchObject({
      state: 'success',
      output: 'built',
      exitCode: 0,
      added: 1,
      removed: 1,
      endedAt: 35_000
    })
    // Output arriving after the step ended is ignored.
    expect(
      reduceChatMessage(m, { type: 'tool-output', id: 'x', text: 'late' }).tools[0].output
    ).toBe('built')
  })

  it('settles steps still running when the turn ends', () => {
    let m = reduceChatMessage(base(), { type: 'tool-start', tool: running })
    vi.setSystemTime(9_000)
    m = reduceChatMessage(m, { type: 'error', text: 'Stopped' })
    expect(m.tools[0]).toMatchObject({ state: 'error', endedAt: 9_000 })
  })
})

describe('ChatEventBuffer', () => {
  it('merges consecutive deltas and reasoning, keeping order and the newest tool output', () => {
    const buf = new ChatEventBuffer()
    buf.push('t', { type: 'reasoning', id: 'r', text: 'a' })
    buf.push('t', { type: 'reasoning', id: 'r', text: 'b' })
    buf.push('t', { type: 'tool-output', id: 'x', text: 'one' })
    buf.push('t', { type: 'delta', text: 'Hel' })
    buf.push('t', { type: 'delta', text: 'lo' })
    buf.push('t', { type: 'tool-output', id: 'x', text: 'one two' })
    buf.push('u', { type: 'delta', text: 'other turn' })
    const drained = buf.drain()
    expect(drained.get('t')).toEqual([
      { type: 'reasoning', id: 'r', text: 'ab' },
      { type: 'delta', text: 'Hello' },
      { type: 'tool-output', id: 'x', text: 'one two' }
    ])
    expect(drained.get('u')).toEqual([{ type: 'delta', text: 'other turn' }])
    expect(buf.size).toBe(0)
  })
})

describe('chat storage helpers', () => {
  it('caps long reasoning for disk and drops segment kinds this build does not know', () => {
    const long = 'x'.repeat(REASONING_STORE_MAX + 50)
    const stored = segmentsForStorage([
      { kind: 'reasoning', text: long },
      { kind: 'text', text: 'ok' }
    ])
    expect(stored?.[0]).toMatchObject({ kind: 'reasoning' })
    expect(stored?.[0].kind === 'reasoning' && stored[0].text.length).toBe(REASONING_STORE_MAX + 1)
    const short = [{ kind: 'text' as const, text: 'a' }]
    expect(segmentsForStorage(short)).toBe(short)
    const loaded = segmentsFromStorage([
      { kind: 'text', text: 'a' },
      { kind: 'unknown' } as unknown as { kind: 'text'; text: string }
    ])
    expect(loaded).toEqual([{ kind: 'text', text: 'a' }])
  })
})
