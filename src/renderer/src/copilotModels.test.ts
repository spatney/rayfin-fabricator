import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CopilotModel } from '@shared/ipc'
import {
  invalidateCopilotModels,
  isFastModel,
  loadCopilotModels,
  pickDesignModel,
  resolveDesignModel
} from './copilotModels'

const listModels = vi.fn<() => Promise<CopilotModel[]>>()
const model = (id: string): CopilotModel => ({ id, name: id, supportedReasoningEfforts: [] })

beforeEach(() => {
  invalidateCopilotModels()
  listModels.mockReset()
  vi.stubGlobal('api', { chat: { listModels } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Copilot model cache after sign-in', () => {
  it('reloads the model catalog after credentials change', async () => {
    listModels.mockResolvedValueOnce([model('old-account')]).mockResolvedValueOnce([model('new-account')])
    expect(await loadCopilotModels()).toEqual([model('old-account')])
    invalidateCopilotModels()
    expect(await loadCopilotModels()).toEqual([model('new-account')])
    expect(listModels).toHaveBeenCalledTimes(2)
  })

  it('ignores an old account lookup that finishes after sign-in', async () => {
    let finishOld!: (models: CopilotModel[]) => void
    listModels.mockReturnValueOnce(new Promise((resolve) => { finishOld = resolve }))
      .mockResolvedValueOnce([model('new-account')])
    const oldLookup = loadCopilotModels()
    invalidateCopilotModels()
    await loadCopilotModels()
    finishOld([model('old-account')])
    await oldLookup
    expect(await loadCopilotModels()).toEqual([model('new-account')])
    expect(listModels).toHaveBeenCalledTimes(2)
  })
})

/** A catalog entry the way Copilot reports it (tier, price, vision, efforts). */
function entry(
  id: string,
  category?: CopilotModel['category'],
  priceCategory?: CopilotModel['priceCategory'],
  efforts: CopilotModel['supportedReasoningEfforts'] = ['low', 'medium', 'high']
): CopilotModel {
  return { id, name: id, category, priceCategory, vision: true, supportedReasoningEfforts: efforts }
}

const CATALOG = [
  entry('claude-haiku-4.5', 'lightweight', 'low', []),
  entry('claude-haiku-5.5', 'lightweight', 'low'),
  entry('claude-opus-4.8', 'powerful', 'high'),
  entry('gemini-3.7-flash', 'versatile', 'low', []),
  entry('gemini-3.8-flash', 'versatile', 'low', []),
  entry('gpt-5.6-sol-fast', 'powerful', 'very_high'),
  entry('gpt-6-luna', 'lightweight', 'low'),
  entry('mai-code-1.1-flash', 'lightweight', 'low')
]

describe('fast models', () => {
  it('reads whole words, so Gemini Pro and powerful "-fast" models are not fast', () => {
    expect(isFastModel({ ...model('gemini-2.5-pro'), name: 'Gemini 2.5 Pro' })).toBe(false)
    expect(isFastModel(model('gpt-5.6-sol-fast'))).toBe(false)
    expect(isFastModel(entry('gpt-5.6-sol-fast', 'powerful', 'very_high'))).toBe(false)
    expect(isFastModel(model('gemini-3.8-flash'))).toBe(true)
    expect(isFastModel(model('gpt-5-mini'))).toBe(true)
    expect(isFastModel(entry('gpt-6-luna', 'lightweight', 'low'))).toBe(true)
  })

  it('gives Design the fastest benchmarked model at low effort, falling back in benchmark order', () => {
    expect(pickDesignModel(CATALOG)).toEqual({ id: 'claude-haiku-5.5', name: 'claude-haiku-5.5', effort: 'low', vision: true })
    const order: string[] = []
    for (let left = CATALOG, id = pickDesignModel(left).id; id; id = pickDesignModel(left).id) {
      order.push(id)
      left = left.filter((m) => m.id !== id)
    }
    // Powerful and very-high-cost models never come up.
    expect(order).toEqual(['claude-haiku-5.5', 'gpt-6-luna', 'mai-code-1.1-flash', 'gemini-3.7-flash', 'gemini-3.8-flash', 'claude-haiku-4.5'])
    expect(pickDesignModel(CATALOG.filter((m) => m.id === 'gemini-3.7-flash')).effort).toBeUndefined()
  })

  it('prefers a newer unbenchmarked lightweight model that can think less', () => {
    const future = [entry('claude-haiku-4.5', 'lightweight', 'low', []), entry('claude-haiku-6', 'lightweight', 'low')]
    expect(pickDesignModel(future)).toMatchObject({ id: 'claude-haiku-6', effort: 'low' })
  })

  it('never picks a powerful or high-cost model, and falls back to names without tiers', () => {
    expect(pickDesignModel(CATALOG.filter((m) => m.category === 'powerful'))).toEqual({ vision: false })
    expect(pickDesignModel([model('claude-sonnet-4.5'), model('gpt-5-mini')])).toEqual({ id: 'gpt-5-mini', name: 'gpt-5-mini', effort: undefined, vision: false })
  })

  it('never picks a model on the user’s own key by itself, but uses one chosen in the Design bar', () => {
    const own: CopilotModel = {
      ...entry('google/gemini-3.5-flash-lite', 'lightweight', 'low'),
      name: 'Gemini 3.5 Flash Lite',
      vision: true,
      byok: { provider: 'google', providerName: 'Google', ready: true }
    }
    expect(pickDesignModel([own])).toEqual({ vision: false })
    expect(resolveDesignModel([own, ...CATALOG], null)).toMatchObject({ id: 'claude-haiku-5.5' })
    expect(resolveDesignModel([own, ...CATALOG], { model: own.id, effort: 'medium' })).toEqual({
      id: own.id,
      name: 'Gemini 3.5 Flash Lite',
      effort: 'medium',
      vision: true
    })
  })
})
