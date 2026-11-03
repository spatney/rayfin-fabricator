import { describe, expect, it } from 'vitest'
import type { ChatFusion } from '@shared/ipc'
import { describeFusion } from './fusion'

const NAMES: Record<string, string> = {
  'gpt-6-luna': 'GPT-6 Luna',
  'claude-sonnet-5': 'Claude Sonnet 5',
  'gpt-5.6-sol': 'GPT-5.6 Sol'
}
const name = (id: string): string => NAMES[id] ?? id

describe('describeFusion', () => {
  it('names the level, how Fusion ran the request and the one model', () => {
    const single: ChatFusion = {
      level: 'hydrafusion-max',
      patterns: ['single'],
      models: [{ id: 'gpt-6-luna', phases: ['primary'] }]
    }
    expect(describeFusion(single, name, 'Max')).toBe('Fusion Max · Single · GPT-6 Luna')
  })

  it('says what each model did when several worked on the turn', () => {
    const critique: ChatFusion = {
      level: 'hydrafusion',
      patterns: ['critique', 'fallback'],
      models: [
        { id: 'claude-sonnet-5', phases: ['draft', 'revision'] },
        { id: 'gpt-5.6-sol', phases: ['critic'] },
        { id: 'new-model', phases: ['follow_up', 'new_phase'] }
      ]
    }
    expect(describeFusion(critique, name, 'High')).toBe(
      'Fusion High · Critique + Fallback · Claude Sonnet 5 drafted and revised, GPT-5.6 Sol reviewed, new-model continued and new phase'
    )
  })

  it('says Copilot Fusion while the level’s name is unknown, and leaves out what isn’t known yet', () => {
    expect(describeFusion({ level: 'hydrafusion', patterns: ['cascade'], models: [] }, name)).toBe(
      'Copilot Fusion · Cascade'
    )
  })
})
