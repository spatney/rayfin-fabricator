import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { invalidateCopilotModels } from '@renderer/copilotModels'
import { TurnFooter } from './TurnFooter'
import type { UIChatMessage } from './types'

beforeEach(() => {
  invalidateCopilotModels()
  ;(window as unknown as { api: unknown }).api = {
    chat: {
      listModels: vi.fn(async () => [
        { id: 'gpt-6-luna', name: 'GPT-6 Luna', supportedReasoningEfforts: [], vision: false }
      ]),
      autoTiers: vi.fn(async () => ({
        defaultTier: 'balance',
        tiers: [
          { id: 'hydrafusion-max', name: 'Max', description: '', enabled: true, fusion: true }
        ]
      }))
    }
  }
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('TurnFooter', () => {
  it('says under a turn what Copilot Fusion chose, with Copilot’s description on hover', async () => {
    const message: UIChatMessage = {
      id: 'a1',
      role: 'assistant',
      text: 'Done.',
      tools: [],
      pending: false,
      fusion: {
        level: 'hydrafusion-max',
        patterns: ['single'],
        models: [{ id: 'gpt-6-luna', phases: ['primary'] }],
        hint: 'Using Single: one solver will work on your request.'
      }
    }
    render(<TurnFooter message={message} projectPath="C:\\apps\\todo" latest={false} />)
    const line = await screen.findByText('Fusion Max · Single · GPT-6 Luna')
    expect(line.parentElement?.getAttribute('title')).toBe(
      'Using Single: one solver will work on your request.'
    )
  })
})
