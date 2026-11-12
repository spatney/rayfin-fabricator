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

  it('says which of your custom instructions a turn followed, with what Copilot did on hover', () => {
    const followed = (id: string, title: string, output?: string, state = 'success' as const) => ({
      id,
      name: 'fabricator_followed_instruction',
      title,
      state,
      output
    })
    const message: UIChatMessage = {
      id: 'a1',
      role: 'assistant',
      text: 'Done.',
      tools: [
        followed('f1', 'Use system theme by default', 'made the app follow the system’s setting'),
        followed('f2', 'use system theme by default', 'again'),
        followed('f3', 'Show dates like 5 Mar 2026'),
        { ...followed('f4', 'Write in French'), state: 'error' }
      ],
      pending: false
    }
    const { container } = render(
      <TurnFooter message={message} projectPath="C:\\apps\\todo" latest={false} />
    )
    const line = container.querySelector('.turn-instructions')
    expect(line?.textContent).toBe(
      'Followed your instructions “Use system theme by default” and “Show dates like 5 Mar 2026”'
    )
    expect(screen.getByText('“Use system theme by default”').getAttribute('title')).toBe(
      'made the app follow the system’s setting'
    )
  })
})
