import { describe, expect, it } from 'vitest'
import type { Exchange } from './HelpView'
import { describeWhen, fromSaved, toSaved } from './history'

function exchange(over: Partial<Exchange> = {}): Exchange {
  return {
    id: 'ask-1',
    question: 'why did my deploy fail?',
    attachments: [],
    answer: 'No workspace is selected.',
    tools: [],
    actions: [],
    citations: [],
    status: 'done',
    ...over
  }
}

describe('choosing what to save', () => {
  it('keeps a finished exchange', () => {
    expect(toSaved([exchange()])).toHaveLength(1)
  })

  it('keeps a failed exchange, because the failure is the useful part', () => {
    const saved = toSaved([exchange({ answer: '', status: 'error', error: 'Copilot is signed out.' })])
    expect(saved).toHaveLength(1)
    expect(saved[0].error).toBe('Copilot is signed out.')
  })

  it('drops a question that never got an answer', () => {
    expect(toSaved([exchange({ answer: '', status: 'thinking' })])).toHaveLength(0)
  })

  it('settles a turn that was still running when the app closed', () => {
    const saved = toSaved([exchange({ answer: 'Partial…', status: 'streaming' })])
    expect(saved[0].status).toBe('stopped')
  })

  it('drops bulky tool output but keeps the step list', () => {
    const saved = toSaved([
      exchange({
        tools: [
          { id: 't1', name: 'read', title: 'Reading errors.jsonl', state: 'success', output: 'x'.repeat(5000) }
        ] as Exchange['tools']
      })
    ])
    expect(saved[0].tools).toHaveLength(1)
    expect(saved[0].tools[0].output).toBeUndefined()
  })

  it('keeps only the most recent exchanges', () => {
    const many = Array.from({ length: 40 }, (_, i) => exchange({ id: `ask-${i}` }))
    const saved = toSaved(many)
    expect(saved.length).toBeLessThanOrEqual(20)
    expect(saved.slice(-1)[0]?.id).toBe('ask-39')
  })
})

describe('restoring a conversation', () => {
  it('round-trips what it saved', () => {
    const restored = fromSaved(toSaved([exchange()]))
    expect(restored).toHaveLength(1)
    expect(restored[0].question).toBe('why did my deploy fail?')
    expect(restored[0].answer).toBe('No workspace is selected.')
  })

  it('marks restored turns so the UI can show the seam', () => {
    expect(fromSaved(toSaved([exchange()]))[0].restored).toBe(true)
  })

  it('never leaves a restored turn looking like it is still running', () => {
    const restored = fromSaved([{ id: 'a', question: 'q', answer: 'partial', status: 'streaming' }])
    expect(restored[0].status).toBe('stopped')
  })

  it('ignores anything that is not a conversation', () => {
    expect(fromSaved(null)).toEqual([])
    expect(fromSaved('nope')).toEqual([])
    expect(fromSaved({ not: 'an array' })).toEqual([])
  })

  it('skips malformed entries instead of failing', () => {
    const restored = fromSaved([
      null,
      'nonsense',
      { question: 'no id' },
      { id: 'ok', question: 'kept', answer: 'yes', status: 'done' }
    ])
    expect(restored).toHaveLength(1)
    expect(restored[0].id).toBe('ok')
  })

  it('repairs missing collections so the UI can render it', () => {
    const restored = fromSaved([{ id: 'a', question: 'q' }])
    expect(restored[0].tools).toEqual([])
    expect(restored[0].actions).toEqual([])
    expect(restored[0].citations).toEqual([])
    expect(restored[0].attachments).toEqual([])
  })
})

describe('describing when a thread was left', () => {
  const now = new Date('2026-10-06T12:00:00Z')

  it.each([
    ['2026-10-06T11:59:30Z', 'a moment ago'],
    ['2026-10-06T11:30:00Z', '30 minutes ago'],
    ['2026-10-06T11:00:00Z', 'an hour ago'],
    ['2026-10-06T07:00:00Z', '5 hours ago'],
    ['2026-10-05T20:00:00Z', 'yesterday']
  ])('describes %s as %s', (savedAt, expected) => {
    expect(describeWhen(savedAt, now)).toBe(expected)
  })

  it('falls back when the timestamp is unreadable', () => {
    expect(describeWhen('not a date', now)).toBe('earlier')
  })
})
