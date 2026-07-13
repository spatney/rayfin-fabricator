import { useState } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatEventEnvelope } from '@shared/ipc'
import { createPlanArtifact } from './chatPlan'
import { useChatEventStore, type ChatStore } from './chatEventStore'

vi.mock('./monaco', () => ({}))
vi.mock('@monaco-editor/react', () => ({
  default: () => <textarea data-testid="plan-editor" />
}))

let emit: (event: ChatEventEnvelope) => void

function Harness(): JSX.Element {
  const [chats, setChats] = useState<ChatStore>({
    p1: [
      {
        id: 'assistant-1',
        turnId: 'turn-1',
        role: 'assistant',
        text: '',
        tools: [],
        pending: true,
        plan: createPlanArtifact('plan-1')
      }
    ]
  })
  useChatEventStore(setChats)
  return <output data-testid="chat-state">{JSON.stringify(chats.p1[0])}</output>
}

function AgentHarness(): JSX.Element {
  const [chats, setChats] = useState<ChatStore>({
    p1: [
      {
        id: 'assistant-1',
        turnId: 'turn-1',
        role: 'assistant',
        text: '',
        tools: [],
        pending: true
      }
    ]
  })
  useChatEventStore(setChats)
  return <output data-testid="chat-state">{JSON.stringify(chats.p1[0])}</output>
}

function state(): ChatStore['p1'][number] {
  return JSON.parse(screen.getByTestId('chat-state').textContent ?? '{}')
}

beforeEach(() => {
  localStorage.clear()
  ;(window as unknown as { api: unknown }).api = {
    onChatEvent: vi.fn((callback: (event: ChatEventEnvelope) => void) => {
      emit = callback
      return () => {}
    })
  }
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('workbench chat event store', () => {
  it('does not show a Plan card when an ordinary Agent turn writes todos', async () => {
    render(<AgentHarness />)
    await act(async () => {
      emit({
        projectId: 'p1',
        turnId: 'turn-1',
        event: {
          type: 'plan-todos',
          todos: [{ id: 'agent-work', title: 'Agent work', status: 'in_progress' }],
          dependencies: []
        }
      })
    })
    expect(state().plan).toBeUndefined()
  })

  it('retains a Plan proposal even when no ChatPanel is mounted', async () => {
    render(<Harness />)
    await act(async () => {
      emit({
        projectId: 'p1',
        turnId: 'turn-1',
        event: {
          type: 'plan-proposed',
          requestId: 'request-1',
          summary: 'A durable plan',
          planContent: '# Plan',
          actions: ['interactive'],
          recommendedAction: 'interactive'
        }
      })
    })

    expect(state().plan).toMatchObject({
      phase: 'review',
      content: '# Plan',
      liveRequestId: 'request-1'
    })
  })

  it('flushes buffered text before applying a structural Plan event', async () => {
    render(<Harness />)
    await act(async () => {
      emit({
        projectId: 'p1',
        turnId: 'turn-1',
        event: { type: 'delta', text: 'Research complete.' }
      })
      emit({
        projectId: 'p1',
        turnId: 'turn-1',
        event: { type: 'plan-content', content: '# Draft', operation: 'update' }
      })
    })

    expect(state().text).toBe('Research complete.')
    expect(state().plan?.content).toBe('# Draft')
  })

  it('persists authoritative mode changes while the composer is unmounted', async () => {
    render(<Harness />)
    await act(async () => {
      emit({
        projectId: 'p1',
        turnId: 'turn-1',
        event: { type: 'mode-changed', mode: 'autopilot' }
      })
    })
    expect(localStorage.getItem('rayfin.chatMode.p1')).toBe('autopilot')
  })
})
