import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CopilotModel } from '@shared/ipc'
import { invalidateCopilotModels, isFastModel, loadCopilotModels } from './copilotModels'

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

describe('fast models', () => {
  it('reads whole words, so Gemini Pro and powerful "-fast" models are not fast', () => {
    expect(isFastModel({ ...model('gemini-2.5-pro'), name: 'Gemini 2.5 Pro' })).toBe(false)
    expect(isFastModel(model('gpt-5.6-sol-fast'))).toBe(false)
    expect(isFastModel(entry('gpt-5.6-sol-fast', 'powerful', 'very_high'))).toBe(false)
    expect(isFastModel(model('gemini-3.8-flash'))).toBe(true)
    expect(isFastModel(model('gpt-5-mini'))).toBe(true)
    expect(isFastModel(entry('gpt-6-luna', 'lightweight', 'low'))).toBe(true)
  })
})
