import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HelpAnswer, HelpEventEnvelope } from '@shared/ipc'
import { createHelpConversation as create, type HelpConversation } from './conversation'

let emit: (envelope: HelpEventEnvelope) => void = () => {}
const ask = vi.fn<(input: { askId: string; history?: unknown }) => Promise<HelpAnswer>>()
const cancel = vi.fn(() => Promise.resolve(true))
const loadHistory = vi.fn<() => Promise<{ savedAt: string; data: unknown } | null>>()

const answer = (text: string): HelpAnswer => ({ text, actions: [], citations: [], elapsedMs: 5 })
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const made: HelpConversation[] = []
function createHelpConversation(): HelpConversation {
  const conversation = create()
  made.push(conversation)
  return conversation
}

beforeEach(() => {
  vi.clearAllMocks()
  loadHistory.mockResolvedValue(null)
  ;(window as unknown as { api: unknown }).api = {
    help: {
      ask,
      cancel,
      loadHistory,
      saveHistory: vi.fn(() => Promise.resolve()),
      clearHistory: vi.fn(() => Promise.resolve()),
      onEvent: (cb: (envelope: HelpEventEnvelope) => void) => {
        emit = cb
        return () => {}
      }
    }
  }
})

afterEach(() => {
  for (const conversation of made.splice(0)) conversation.dispose()
  vi.useRealTimers()
  delete (window as unknown as { api?: unknown }).api
})

describe('the Help conversation', () => {
  it('keeps an answer arriving with nobody looking at it', async () => {
    const conversation = createHelpConversation()
    let resolve!: (value: HelpAnswer) => void
    ask.mockReturnValueOnce(new Promise((r) => (resolve = r)))
    const asked = conversation.ask('why did my deploy fail?', [], { projectId: 'p1' })
    await flush()

    const askId = ask.mock.calls[0][0].askId
    emit({ askId, event: { type: 'delta', text: 'No workspace ' } })
    expect(conversation.getState()).toMatchObject({ busy: true })
    expect(conversation.getState().exchanges[0].answer).toBe('No workspace ')

    resolve(answer('No workspace was selected.'))
    await asked
    expect(conversation.getState().busy).toBe(false)
    expect(conversation.getState().exchanges[0]).toMatchObject({
      status: 'done',
      answer: 'No workspace was selected.'
    })
  })

  it('stops the answer arriving before asking the next question', async () => {
    const conversation = createHelpConversation()
    let reject!: (reason: Error) => void
    ask
      .mockReturnValueOnce(new Promise((_, r) => (reject = r)))
      .mockResolvedValueOnce(answer('Second.'))
    void conversation.ask('first', [], {})
    await flush()
    cancel.mockImplementationOnce(() => {
      reject(new Error('Stopped.'))
      return Promise.resolve(true)
    })

    await conversation.ask('second', [], {})
    expect(cancel).toHaveBeenCalled()
    expect(conversation.getState().exchanges.map((e) => e.status)).toEqual(['stopped', 'done'])
  })

  it('replays what was restored with the next question', async () => {
    loadHistory.mockResolvedValue({
      savedAt: new Date().toISOString(),
      data: [{ id: 'old', question: 'how do I share?', answer: 'Select Share.', status: 'done' }]
    })
    ask.mockResolvedValueOnce(answer('Like this.'))
    const conversation = createHelpConversation()
    await conversation.ask('and with a team?', [], {})
    expect(ask.mock.calls[0][0].history).toEqual([
      { question: 'how do I share?', answer: 'Select Share.' }
    ])
  })

  it('reads what was said as earlier when the thread is picked up again', async () => {
    ask.mockResolvedValueOnce(answer('Because.'))
    const conversation = createHelpConversation()
    await conversation.ask('why?', [], {})
    conversation.resume()
    const state = conversation.getState()
    expect(state.exchanges[0].restored).toBe(true)
    expect(state.resumedAt).not.toBeNull()
  })

  it('starts fresh when the thread was left alone for a day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    ask.mockResolvedValueOnce(answer('Because.'))
    const conversation = createHelpConversation()
    await conversation.ask('why?', [], {})
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000)
    conversation.resume()
    expect(conversation.getState().exchanges).toEqual([])
  })
})
