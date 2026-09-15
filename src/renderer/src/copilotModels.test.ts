import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CopilotModel } from '@shared/ipc'
import { invalidateCopilotModels, loadCopilotModels } from './copilotModels'

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
