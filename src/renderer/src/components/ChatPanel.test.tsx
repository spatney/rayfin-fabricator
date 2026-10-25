import { useMemo, useState, type JSX } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type {
  ChatAdvisorFix,
  ChatAdvisorSummary,
  ChatEventEnvelope,
  ChatPlanArtifact,
  ChatPlanQuestion
} from '@shared/ipc'
import { makeProject } from '../../test/harness'
import { deferred } from '../../test/deferred'
import type { DesignItem } from '@shared/design'
import type { DesignTurn } from '../design/useDesignSession'
import type { FixOutcome } from '../advisor/lifecycle'
import { AdvisorFixContext, type AdvisorFixLinks } from './advisor/AdvisorFixSummary'
import ChatPanel, { reduceChatMessage, type OutboundPrompt, type UIChatMessage } from './ChatPanel'
import { tryAgainPrompt } from './chat/prompts'
import { invalidateCopilotModels } from '../copilotModels'
import { setPendingData } from '../fabricData'

vi.mock('../monaco', () => ({}))
vi.mock('@monaco-editor/react', () => ({
  default: () => <textarea data-testid="plan-editor" />
}))

/**
 * Guards issue #9: a typed-but-unsent prompt must survive ChatPanel unmounting.
 * The Build view renders ChatPanel only while `viewMode === 'build'`, so switching
 * to the Code tab tears the panel down; the composer draft is therefore lifted to
 * the parent (keyed by project) and re-seeded on remount. These tests exercise that
 * contract through a small parent harness that mirrors Workbench's draft plumbing.
 */

const PLACEHOLDER = /Message Fabricator about/i

interface InstalledApi {
  onChatEvent: ReturnType<typeof vi.fn>
  auth: { loginCopilot: ReturnType<typeof vi.fn> }
  chat: {
    send: ReturnType<typeof vi.fn>
    steer: ReturnType<typeof vi.fn>
    resolvePlan: ReturnType<typeof vi.fn>
    resolveQuestion: ReturnType<typeof vi.fn>
    exportPlan: ReturnType<typeof vi.fn>
  }
}

/** Minimal `window.api` surface ChatPanel touches on mount / while typing. */
function installApi(): InstalledApi {
  const api = {
    onChatEvent: vi.fn(() => () => {}),
    onProcLog: vi.fn(() => () => {}),
    auth: { loginCopilot: vi.fn(() => Promise.resolve({ ok: true, exitCode: 0 })) },
    chat: {
      suggest: vi.fn(() => Promise.resolve({ ok: false, suggestions: [] })),
      cancelSuggest: vi.fn(() => Promise.resolve(true)),
      setOptions: vi.fn(() => Promise.resolve(undefined)),
      listModels: vi.fn(() => Promise.resolve([])),
      send: vi.fn(() =>
        Promise.resolve({ ok: true, filesModified: [], ranDeploy: false })
      ),
      steer: vi.fn(() => Promise.resolve({ steered: true })),
      resolvePlan: vi.fn(() => Promise.resolve(undefined)),
      resolveQuestion: vi.fn(() => Promise.resolve(undefined)),
      exportPlan: vi.fn(() => Promise.resolve(null)),
      reset: vi.fn(() => Promise.resolve(undefined))
    },
    projects: { files: { tree: vi.fn(() => Promise.resolve({ path: '', name: '', children: [] })) } },
    screenshot: { save: vi.fn(() => Promise.resolve('C:/tmp/shot.png')) }
  }
  ;(window as unknown as { api: unknown }).api = api
  return api
}

/**
 * Mirrors how Workbench keeps a per-project composer draft and conditionally
 * mounts ChatPanel. `onCode` flips the panel off (Code tab) and back (Build tab).
 */
function Harness({ initialDraft = '' }: { initialDraft?: string }): JSX.Element {
  const [drafts, setDrafts] = useState<Record<string, string>>(
    initialDraft ? { p1: initialDraft } : {}
  )
  const [onCode, setOnCode] = useState(false)
  const project = useMemo(() => makeProject('p1'), [])
  return (
    <div>
      <button type="button" onClick={() => setOnCode((v) => !v)}>
        toggle-tab
      </button>
      {!onCode && (
        <ChatPanel
          project={project}
          messages={[]}
          onChange={() => {}}
          draft={drafts.p1 ?? ''}
          onDraftChange={(value) => setDrafts((all) => ({ ...all, p1: value }))}
        />
      )}
    </div>
  )
}

function planArtifact(overrides: Partial<ChatPlanArtifact> = {}): ChatPlanArtifact {
  return {
    id: 'plan-1',
    phase: 'review',
    summary: 'Implement the durable workflow.',
    content: '# Plan\n\nImplement the durable workflow.',
    actions: ['interactive', 'autopilot'],
    recommendedAction: 'interactive',
    todos: [],
    dependencies: [],
    questions: [],
    liveRequestId: 'request-1',
    ...overrides
  }
}

function PlanHarness({
  plan,
  pending = true,
  onPlanExecutionStart
}: {
  plan: ChatPlanArtifact
  pending?: boolean
  onPlanExecutionStart?: () => void
}): JSX.Element {
  const [messages, setMessages] = useState<UIChatMessage[]>([
    {
      id: 'user-1',
      role: 'user',
      text: 'Improve the workflow',
      tools: [],
      pending: false
    },
    {
      id: 'assistant-1',
      role: 'assistant',
      text: '',
      tools: [],
      pending,
      interrupted: pending ? undefined : true,
      plan
    }
  ])
  return (
    <ChatPanel
      project={makeProject('p1')}
      messages={messages}
      onChange={(update) => setMessages(update)}
      draft=""
      onPlanExecutionStart={onPlanExecutionStart}
    />
  )
}

async function toggleTab(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByText('toggle-tab'))
  })
}

let raf: typeof globalThis.requestAnimationFrame | undefined
let cancelRaf: typeof globalThis.cancelAnimationFrame | undefined

beforeEach(() => {
  localStorage.clear()
  installApi()
  // jsdom may not expose rAF; ChatPanel's scroll/flush effects rely on it.
  if (!globalThis.requestAnimationFrame) {
    raf = globalThis.requestAnimationFrame
    cancelRaf = globalThis.cancelAnimationFrame
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
      setTimeout(() => cb(Date.now()), 0) as unknown as number) as typeof requestAnimationFrame
    globalThis.cancelAnimationFrame = ((id: number) =>
      clearTimeout(id)) as typeof cancelAnimationFrame
  }
})

afterEach(() => {
  cleanup()
  if (raf) {
    globalThis.requestAnimationFrame = raf
    globalThis.cancelAnimationFrame = cancelRaf as typeof cancelAnimationFrame
    raf = undefined
    cancelRaf = undefined
  }
  delete (window as unknown as { api?: unknown }).api
})

function AuthHarness({ onAuthChanged }: { onAuthChanged?: () => Promise<void> }): JSX.Element {
  const [messages, setMessages] = useState<UIChatMessage[]>([])
  const [draft, setDraft] = useState('')
  return (
    <ChatPanel project={makeProject('p1')} messages={messages} onChange={setMessages}
      draft={draft} onDraftChange={setDraft} onCopilotAuthChanged={onAuthChanged} />
  )
}

describe('ChatPanel authentication recovery', () => {
  it('does not ask for a Copilot sign-in while the launch check is still running', async () => {
    installApi()
    const { rerender } = render(
      <ChatPanel project={makeProject('p1')} messages={[]} onChange={() => {}}
        copilotAuth={{ signedIn: false, checking: true }} />
    )
    expect(screen.queryByRole('button', { name: 'Sign in to Copilot' })).toBeNull()
    rerender(
      <ChatPanel project={makeProject('p1')} messages={[]} onChange={() => {}}
        copilotAuth={{ signedIn: false, error: 'Session expired' }} />
    )
    expect(await screen.findByRole('button', { name: 'Sign in to Copilot' })).toBeTruthy()
  })
  it('handles a failed result without streamed events and signs in without losing drafts or replaying', async () => {
    const api = installApi()
    api.chat.send.mockResolvedValue({ ok: false, error: 'Not logged in', filesModified: [], ranDeploy: false })
    const onAuthChanged = vi.fn(async () => {})
    render(<AuthHarness onAuthChanged={onAuthChanged} />)
    const composer = screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement
    fireEvent.change(composer, { target: { value: 'Build my dashboard' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    const signIn = await screen.findByRole('button', { name: 'Sign in to Copilot' })
    fireEvent.change(composer, { target: { value: 'Keep this unsent draft' } })
    fireEvent.click(signIn)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Sign in to Copilot' })).toBeNull())
    expect(onAuthChanged).toHaveBeenCalledOnce()
    expect(api.chat.send).toHaveBeenCalledOnce()
    expect(composer.value).toBe('Keep this unsent draft')
    expect(screen.getByText('Build my dashboard')).toBeTruthy()
  })

  it('settles a rejected send and exposes the in-app sign-in action', async () => {
    const api = installApi()
    api.chat.send.mockRejectedValue(new Error('Not authenticated'))
    render(<AuthHarness />)
    const composer = screen.getByPlaceholderText(PLACEHOLDER)
    fireEvent.change(composer, { target: { value: 'Build my dashboard' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    await screen.findByText('Not authenticated')
    expect(screen.getByRole('button', { name: 'Sign in to Copilot' })).toBeTruthy()
  })
})

describe('ChatPanel composer draft', () => {
  it('preserves a typed-but-unsent prompt when navigating to Code and back (issue #9)', async () => {
    render(<Harness />)

    const ta = screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement
    await act(async () => {
      fireEvent.change(ta, { target: { value: 'build me a sales dashboard' } })
    })

    expect(ta.value).toBe('build me a sales dashboard')

    // Switch to the Code tab — ChatPanel unmounts.
    await toggleTab()
    expect(screen.queryByPlaceholderText(PLACEHOLDER)).toBeNull()

    // Return to Build — ChatPanel remounts and must restore the draft.
    await toggleTab()
    const restored = screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement
    expect(restored.value).toBe('build me a sales dashboard')
  })

  it('seeds the composer from the persisted draft on first mount', async () => {
    await act(async () => {
      render(<Harness initialDraft="a prompt I left earlier" />)
    })
    const ta = screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement
    expect(ta.value).toBe('a prompt I left earlier')
  })

  it('starts empty when there is no persisted draft', async () => {
    await act(async () => {
      render(<Harness />)
    })
    const ta = screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement
    expect(ta.value).toBe('')
  })
})

describe('ChatPanel Agent-mode entry', () => {
  const complexPrompt = [
    'Redesign authentication across the frontend and backend.',
    '1. Migrate token storage while preserving backward compatibility.',
    '2. Refactor the API middleware.',
    '3. Update the React sign-in flow and add integration tests.'
  ].join('\n')

  it('has no mode selector or Plan suggestion, even for a complex draft', async () => {
    render(
      <ChatPanel
        project={makeProject('p1')}
        messages={[]}
        onChange={() => {}}
        draft=""
      />
    )
    const input = screen.getByPlaceholderText(PLACEHOLDER)
    await act(async () => {
      fireEvent.change(input, { target: { value: complexPrompt } })
    })

    expect(screen.queryByText('This looks multi-step.')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Use Plan' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^(Agent|Plan|Autopilot)$/ })).toBeNull()
    expect(screen.getByRole('button', { name: /^Model:/ })).toBeTruthy()
  })

  it.each(['plan', 'autopilot'])('ignores a saved %s selection after remounting and sends as Agent', async (mode) => {
    const api = installApi()
    localStorage.setItem('rayfin.chatMode.p1', mode)
    const props = {
      project: makeProject('p1'),
      messages: [] as UIChatMessage[],
      onChange: () => {},
      draft: ''
    }
    const first = render(<ChatPanel {...props} />)
    first.unmount()
    render(<ChatPanel {...props} />)
    await act(async () => {
      const input = screen.getByPlaceholderText(PLACEHOLDER)
      fireEvent.change(input, { target: { value: complexPrompt } })
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    expect(api.chat.send).toHaveBeenCalledWith('p1', expect.any(String), complexPrompt, [], 'agent')
  })

  it.each(['Retry', 'Resume', 'Try again'])('uses Agent for an ordinary %s despite a saved Autopilot selection', async (action) => {
    const api = installApi()
    localStorage.setItem('rayfin.chatMode.p1', 'autopilot')
    const prompt = 'Add a chart'
    const messages: UIChatMessage[] = [
      { id: 'u1', role: 'user', text: prompt, tools: [], pending: false },
      {
        id: 'a1',
        role: 'assistant',
        text: 'Previous response',
        tools: [],
        pending: false,
        error: action === 'Retry' ? 'Previous turn failed' : undefined,
        interrupted: action === 'Resume'
      }
    ]
    render(<ChatPanel project={makeProject('p1')} messages={messages} onChange={() => {}} draft="" />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(action) }))
    })
    expect(api.chat.send).toHaveBeenCalledWith(
      'p1',
      expect.any(String),
      action === 'Try again' ? tryAgainPrompt(prompt) : prompt,
      [],
      'agent'
    )
  })

  it('does not subscribe twice when the workbench owns chat events', () => {
    const api = installApi()
    render(
      <ChatPanel
        project={makeProject('p1')}
        messages={[]}
        onChange={() => {}}
        draft=""
        eventsManagedExternally
      />
    )
    expect(api.onChatEvent).not.toHaveBeenCalled()
  })
})

describe('ChatPanel Plan lifecycle integration', () => {
  it('writes the current plan before transitioning a live approval to execution', async () => {
    const api = installApi()
    const onPlanExecutionStart = vi.fn()
    render(
      <PlanHarness
        plan={planArtifact()}
        onPlanExecutionStart={onPlanExecutionStart}
      />
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Build plan' }))
    })

    expect(api.chat.resolvePlan).toHaveBeenCalledWith(
      'p1',
      'request-1',
      'interactive',
      '# Plan\n\nImplement the durable workflow.',
      undefined
    )
    expect(screen.getByRole('button', { name: /expand plan progress/i })).toBeTruthy()
    expect(onPlanExecutionStart).toHaveBeenCalledTimes(1)
  })

  it('keeps a live plan actionable and surfaces the backend error when approval fails', async () => {
    const api = installApi()
    api.chat.resolvePlan.mockRejectedValueOnce(new Error('Could not save the edited plan'))
    render(<PlanHarness plan={planArtifact()} />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Build plan' }))
    })

    expect(screen.getByText('Could not save the edited plan')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Build plan' }) as HTMLButtonElement).disabled).toBe(
      false
    )
  })

  it.each([
    { action: 'autopilot', label: 'Run in Autopilot' },
    { action: 'autopilot_fleet', label: 'Run with fleet' }
  ])('retains the explicit $action approval route', async ({ action, label }) => {
    const api = installApi()
    const onPlanExecutionStart = vi.fn()
    render(
      <PlanHarness
        plan={planArtifact({ actions: [action], recommendedAction: action })}
        onPlanExecutionStart={onPlanExecutionStart}
      />
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: label }))
    })
    expect(api.chat.resolvePlan).toHaveBeenCalledWith(
      'p1',
      'request-1',
      action,
      '# Plan\n\nImplement the durable workflow.',
      undefined
    )
    expect(onPlanExecutionStart).toHaveBeenCalledOnce()
  })

  it('tells the agent to reconcile todos when approving a directly edited plan', async () => {
    const api = installApi()
    render(<PlanHarness plan={planArtifact({ edited: true, content: '# Edited plan' })} />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Build plan' }))
    })

    expect(api.chat.resolvePlan).toHaveBeenCalledWith(
      'p1',
      'request-1',
      'interactive',
      '# Edited plan',
      expect.stringContaining('reconcile the structured todos')
    )
  })

  it('routes composer feedback through plan revision instead of a generic interjection', async () => {
    const api = installApi()
    const onPlanExecutionStart = vi.fn()
    render(
      <PlanHarness
        plan={planArtifact()}
        onPlanExecutionStart={onPlanExecutionStart}
      />
    )
    const input = screen.getByPlaceholderText(PLACEHOLDER)

    await act(async () => {
      fireEvent.change(input, { target: { value: 'Split the UI work into two steps' } })
      fireEvent.keyDown(input, { key: 'Enter' })
    })

    expect(api.chat.resolvePlan).toHaveBeenCalledWith(
      'p1',
      'request-1',
      'keep_planning',
      '# Plan\n\nImplement the durable workflow.',
      'Split the UI work into two steps'
    )
    expect(api.chat.steer).not.toHaveBeenCalled()
    expect(onPlanExecutionStart).not.toHaveBeenCalled()
    expect(screen.getByText('Revising the plan…')).toBeTruthy()
    expect(screen.getByText('Split the UI work into two steps')).toBeTruthy()
  })

  it.each(['interactive', 'autopilot', 'autopilot_fleet'])('resumes unfinished work via %s without changing the next ordinary message mode', async (action) => {
    const api = installApi()
    render(
      <PlanHarness
        pending={false}
        plan={planArtifact({
          phase: 'interruptedExecution',
          selectedAction: action,
          liveRequestId: undefined,
          todos: [
            { id: 'done', title: 'Finished step', status: 'done' },
            { id: 'next', title: 'Remaining step', status: 'pending' }
          ]
        })}
      />
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Resume remaining work' }))
    })

    await waitFor(() => expect(api.chat.send).toHaveBeenCalled())
    const calls = api.chat.send.mock.calls
    const [, , prompt, , mode] = calls[calls.length - 1] ?? []
    expect(mode).toBe(action === 'interactive' ? 'agent' : 'autopilot')
    expect(prompt).toContain('next: Remaining step')
    expect(prompt).toContain('done: Finished step')
    expect(prompt).toContain('do not redo')

    await act(async () => {
      const input = screen.getByPlaceholderText(PLACEHOLDER)
      fireEvent.change(input, { target: { value: 'Update the heading' } })
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    expect(api.chat.send).toHaveBeenLastCalledWith(
      'p1', expect.any(String), 'Update the heading', [], 'agent'
    )
  })

  it('continues an interrupted planning turn in Plan mode without a selector', async () => {
    const api = installApi()
    render(
      <PlanHarness
        pending={false}
        plan={planArtifact({ phase: 'interruptedReview', content: '', liveRequestId: undefined })}
      />
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue planning' }))
    })
    expect(api.chat.send).toHaveBeenCalledWith(
      'p1', expect.any(String), expect.stringContaining('Do not implement yet.'), [], 'plan'
    )
  })
})

/**
 * Regression: the embedded agent's `ask_user` tool was silently dropped in Agent
 * mode (the Rust `UserInputHandler` returned `None` when not in Plan mode), so the
 * tool resolved with "no response" and the user was never prompted. Agent-mode
 * questions now surface as a standalone question card, answered the same way a
 * Plan-mode clarifying question is.
 */
describe('ChatPanel Agent-mode ask_user questions', () => {
  function AgentQuestionHarness({ question }: { question: ChatPlanQuestion }): JSX.Element {
    const [messages, setMessages] = useState<UIChatMessage[]>([
      { id: 'user-1', role: 'user', text: 'Build the landing page', tools: [], pending: false },
      { id: 'assistant-1', role: 'assistant', text: '', tools: [], pending: true, questions: [question] }
    ])
    return (
      <ChatPanel
        project={makeProject('p1')}
        messages={messages}
        onChange={(update) => setMessages(update)}
        draft=""
      />
    )
  }

  const pendingAssistant: UIChatMessage = {
    id: 'assistant-1',
    role: 'assistant',
    text: '',
    tools: [],
    pending: true
  }

  it('reduceChatMessage surfaces an agent-question as a pending standalone question', () => {
    const next = reduceChatMessage(pendingAssistant, {
      type: 'agent-question',
      requestId: 'q1',
      question: 'Which theme?',
      choices: ['Light', 'Dark'],
      allowFreeform: true
    })
    // Agent-mode questions must NOT create a Plan artifact.
    expect(next.plan).toBeUndefined()
    expect(next.questions).toEqual([
      {
        id: 'q1',
        question: 'Which theme?',
        choices: ['Light', 'Dark'],
        allowFreeform: true,
        state: 'pending'
      }
    ])
  })

  it('reduceChatMessage marks a standalone question answered on resolution', () => {
    const asked = reduceChatMessage(pendingAssistant, {
      type: 'agent-question',
      requestId: 'q1',
      question: 'Which theme?',
      allowFreeform: true
    })
    const resolved = reduceChatMessage(asked, {
      type: 'plan-question-resolved',
      requestId: 'q1',
      answer: 'Dark'
    })
    expect(resolved.plan).toBeUndefined()
    expect(resolved.questions?.[0]).toMatchObject({ id: 'q1', state: 'answered', answer: 'Dark' })
  })

  it('renders a standalone question and answers a preset choice via resolveQuestion', async () => {
    const api = installApi()
    render(
      <AgentQuestionHarness
        question={{
          id: 'q1',
          question: 'Which theme should the site use?',
          choices: ['Light', 'Dark'],
          allowFreeform: false,
          state: 'pending'
        }}
      />
    )
    expect(screen.getByText('Fabricator needs your input')).toBeTruthy()
    expect(screen.getByText('Which theme should the site use?')).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Dark' }))
    })

    expect(api.chat.resolveQuestion).toHaveBeenCalledWith('q1', 'Dark', false)
  })

  it('answers a standalone question with a free-form reply', async () => {
    const api = installApi()
    render(
      <AgentQuestionHarness
        question={{
          id: 'q1',
          question: 'Describe the tone you want.',
          allowFreeform: true,
          state: 'pending'
        }}
      />
    )
    const box = screen.getByPlaceholderText(/Type an answer/)
    await act(async () => {
      fireEvent.change(box, { target: { value: 'Warm and playful' } })
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))
    })

    expect(api.chat.resolveQuestion).toHaveBeenCalledWith('q1', 'Warm and playful', true)
  })

  /**
   * Regression: the question card was appended to the *end* of the turn body, so
   * it slid further down the transcript as the rest of the turn kept streaming
   * (and ended up below the turn summary once the turn settled). It is now
   * anchored as a `'question'` segment where it was asked and rendered inline in
   * the chronological feed, so it stays docked at that point.
   */
  it('reduceChatMessage anchors an agent-question in the feed where it was asked', () => {
    const withTool = reduceChatMessage(
      { ...pendingAssistant, segments: [{ kind: 'text', text: 'Checking the deck.' }] },
      {
        type: 'tool-start',
        tool: { id: 't1', name: 'ask_user', title: 'ask_user', state: 'running' }
      }
    )
    const asked = reduceChatMessage(withTool, {
      type: 'agent-question',
      requestId: 'q1',
      question: 'Which theme?',
      allowFreeform: true
    })
    expect(asked.segments).toEqual([
      { kind: 'text', text: 'Checking the deck.' },
      { kind: 'tool', id: 't1' },
      { kind: 'question', id: 'q1' }
    ])

    // Later output appends *after* the anchor — the card does not drift down.
    const streamed = reduceChatMessage(asked, { type: 'delta', text: 'Now editing.' })
    expect((streamed.segments ?? []).slice(-1)[0]).toEqual({ kind: 'text', text: 'Now editing.' })
    expect(streamed.segments?.[2]).toEqual({ kind: 'question', id: 'q1' })

    // Re-emitting the same request id must not duplicate the anchor.
    const again = reduceChatMessage(streamed, {
      type: 'agent-question',
      requestId: 'q1',
      question: 'Which theme?',
      allowFreeform: true
    })
    expect(again.segments?.filter((s) => s.kind === 'question')).toHaveLength(1)
  })

  it('renders an anchored question inline in the feed, not after the turn body', () => {
    installApi()
    render(
      <ChatPanel
        project={makeProject('p1')}
        messages={[
          {
            id: 'assistant-1',
            role: 'assistant',
            text: 'Now editing.',
            tools: [],
            pending: true,
            segments: [
              { kind: 'question', id: 'q1' },
              { kind: 'text', text: 'Now editing.' }
            ],
            questions: [
              {
                id: 'q1',
                question: 'Which theme should the site use?',
                choices: ['Light', 'Dark'],
                allowFreeform: false,
                state: 'pending'
              }
            ]
          }
        ]}
        onChange={() => {}}
        draft=""
      />
    )
    const feed = document.querySelector('.turn-feed')
    expect(feed).toBeTruthy()
    const card = feed?.querySelector('.chat-agent-questions')
    expect(card).toBeTruthy()
    // Exactly one card (the trailing fallback block must not double-render it),
    // and it sits before the prose that streamed after the question.
    expect(document.querySelectorAll('.chat-agent-questions')).toHaveLength(1)
    expect(card?.parentElement).toBe(feed)
    const after = feed?.children[1]
    expect(after?.textContent).toContain('Now editing.')
  })
})

/**
 * Guards issue #13: on a long prompt the caret drifted from the typed text
 * ("typing occurs below the cursor line") because the transparent textarea and
 * the `.composer-highlight` overlay scrolled independently and were reconciled
 * only by the textarea's `onScroll`. The composer now shares a single scrollport
 * (`.composer-input-sizer`) so the two layers can never desync; because the
 * textarea can no longer scroll internally, ChatPanel scrolls that shared
 * scrollport itself to keep the caret visible.
 *
 * jsdom performs no layout, so real scroll geometry is faked: the scrollport is
 * made to overflow and the caret's measured rect is stubbed below the viewport.
 */
describe('ChatPanel composer scrollport (issue #13)', () => {
  const rect = (top: number, bottom: number): DOMRect =>
    (({
      top,
      bottom,
      left: 0,
      right: 0,
      width: 1,
      height: bottom - top,
      x: 0,
      y: top,
      toJSON: () => ({})
    }) as DOMRect)

  it('renders the textarea and highlight overlay inside one shared scrollport', async () => {
    await act(async () => {
      render(
        <ChatPanel project={makeProject('p1')} messages={[]} onChange={() => {}} draft="" />
      )
    })
    const sizer = document.querySelector('.composer-input-sizer')
    const textarea = document.querySelector('.composer-input')
    const highlight = document.querySelector('.composer-highlight')
    expect(sizer).not.toBeNull()
    expect(textarea).not.toBeNull()
    expect(highlight).not.toBeNull()
    // Both visible layers live in the same scroll container — the invariant that
    // makes caret/text drift structurally impossible.
    expect(sizer?.contains(textarea)).toBe(true)
    expect(sizer?.contains(highlight)).toBe(true)
  })

  it('scrolls the shared scrollport to reveal the caret when a long prompt overflows', async () => {
    const longPrompt = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n')
    await act(async () => {
      render(
        <ChatPanel
          project={makeProject('p1')}
          messages={[]}
          onChange={() => {}}
          draft={longPrompt}
        />
      )
    })
    const ta = screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement
    const sizer = document.querySelector('.composer-input-sizer') as HTMLElement

    // Drain the reveal frame queued on mount (it early-returns with no layout),
    // so the only trigger left is re-entering the field below.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })

    // Fake an overflowing scrollport whose visible band is 100px tall.
    Object.defineProperty(sizer, 'clientHeight', { value: 100, configurable: true })
    Object.defineProperty(sizer, 'scrollHeight', { value: 400, configurable: true })
    sizer.getBoundingClientRect = () => rect(0, 100)
    // jsdom's Range has no getBoundingClientRect; report the caret ~380px down in
    // content space (below the visible band) so the reveal has to scroll.
    const proto = Range.prototype as unknown as { getBoundingClientRect?: () => DOMRect }
    const origRangeRect = proto.getBoundingClientRect
    proto.getBoundingClientRect = () => rect(380 - sizer.scrollTop, 396 - sizer.scrollTop)

    sizer.scrollTop = 0
    ta.setSelectionRange(longPrompt.length, longPrompt.length)
    // Re-enter the field (the issue's repro) and let the queued frame run.
    await act(async () => {
      fireEvent.focus(ta)
      await new Promise((r) => setTimeout(r, 50))
    })

    // Scrolled so the caret's bottom (396) sits at the viewport bottom: 396 - 100.
    expect(sizer.scrollTop).toBe(296)
    proto.getBoundingClientRect = origRangeRect
  })
})

/**
 * Live local preview: the host starts the project's Vite dev server
 * when a turn begins, so ChatPanel exposes an `onTurnStart` hook. It must fire
 * exactly once per fresh turn (a send), and only when a turn actually starts —
 * not on mount or while typing.
 */
describe('ChatPanel onTurnStart (live local preview hook)', () => {
  it('fires onTurnStart once when a fresh turn is dispatched', async () => {
    const onTurnStart = vi.fn()
    await act(async () => {
      render(
        <ChatPanel
          project={makeProject('p1')}
          messages={[]}
          onChange={() => {}}
          draft=""
          onTurnStart={onTurnStart}
        />
      )
    })

    const ta = screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement
    await act(async () => {
      fireEvent.change(ta, { target: { value: 'add a bar chart' } })
    })
    // Typing must not start a turn.
    expect(onTurnStart).not.toHaveBeenCalled()

    // Enter dispatches the turn → the hook fires so the host can start Vite.
    await act(async () => {
      fireEvent.keyDown(ta, { key: 'Enter' })
    })
    expect(onTurnStart).toHaveBeenCalledTimes(1)
    expect((window as unknown as { api: { chat: { send: unknown } } }).api.chat.send).toHaveBeenCalled()
  })

  it('does not fire onTurnStart on an empty send', async () => {
    const onTurnStart = vi.fn()
    await act(async () => {
      render(
        <ChatPanel
          project={makeProject('p1')}
          messages={[]}
          onChange={() => {}}
          draft=""
          onTurnStart={onTurnStart}
        />
      )
    })

    const ta = screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement
    // Enter with an empty composer is a no-op — no turn, no dev server.
    await act(async () => {
      fireEvent.keyDown(ta, { key: 'Enter' })
    })
    expect(onTurnStart).not.toHaveBeenCalled()
  })

  // The host may ask the user to settle a port conflict (and push a new port to
  // Fabric) before Copilot starts, so the turn waits for the hook.
  it('sends the turn only after an async onTurnStart settles', async () => {
    const gate = deferred<void>()
    const onTurnStart = vi.fn(() => gate.promise)
    const send = (window as unknown as { api: { chat: { send: ReturnType<typeof vi.fn> } } }).api.chat.send
    await act(async () => {
      render(
        <ChatPanel project={makeProject('p1')} messages={[]} onChange={() => {}} draft="" onTurnStart={onTurnStart} />
      )
    })
    const ta = screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement
    await act(async () => {
      fireEvent.change(ta, { target: { value: 'add a bar chart' } })
    })
    await act(async () => {
      fireEvent.keyDown(ta, { key: 'Enter' })
    })
    expect(onTurnStart).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()

    await act(async () => {
      gate.resolve()
    })
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  })

  it('still sends the turn when onTurnStart fails', async () => {
    const onTurnStart = vi.fn(() => Promise.reject(new Error('port check failed')))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const send = (window as unknown as { api: { chat: { send: ReturnType<typeof vi.fn> } } }).api.chat.send
    await act(async () => {
      render(
        <ChatPanel project={makeProject('p1')} messages={[]} onChange={() => {}} draft="" onTurnStart={onTurnStart} />
      )
    })
    const ta = screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement
    await act(async () => {
      fireEvent.change(ta, { target: { value: 'add a bar chart' } })
    })
    await act(async () => {
      fireEvent.keyDown(ta, { key: 'Enter' })
    })
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(logged).toHaveBeenCalled()
    logged.mockRestore()
  })
})

/**
 * Live local preview lifecycle: submitting a new turn while a deploy is in flight
 * used to leave the local preview unable to start (and never come back). The host
 * pauses submitting during a deploy — typing stays enabled — so
 * a turn never overlaps a deploy.
 */
describe('ChatPanel submit-pause while deploying', () => {
  const sendMock = (): ReturnType<typeof vi.fn> =>
    (window as unknown as { api: { chat: { send: ReturnType<typeof vi.fn> } } }).api.chat.send

  it('blocks a new turn while deploying (typing stays enabled)', async () => {
    const onTurnStart = vi.fn()
    await act(async () => {
      render(
        <ChatPanel
          project={makeProject('p1')}
          messages={[]}
          onChange={() => {}}
          draft=""
          onTurnStart={onTurnStart}
          deploying
          blockSubmitWhileDeploying
        />
      )
    })

    const ta = screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement
    // Typing is still allowed during a deploy.
    await act(async () => {
      fireEvent.change(ta, { target: { value: 'do a thing' } })
    })
    expect(ta.value).toBe('do a thing')
    expect(ta.disabled).toBe(false)

    // Enter must NOT dispatch a turn while deploying.
    await act(async () => {
      fireEvent.keyDown(ta, { key: 'Enter' })
    })
    expect(onTurnStart).not.toHaveBeenCalled()
    expect(sendMock()).not.toHaveBeenCalled()
    // The draft is preserved (not cleared) so it can be sent once the deploy lands.
    expect(ta.value).toBe('do a thing')
  })

  it('allows submitting when the host has not requested a deployment interlock', async () => {
    const onTurnStart = vi.fn()
    await act(async () => {
      render(
        <ChatPanel
          project={makeProject('p1')}
          messages={[]}
          onChange={() => {}}
          draft=""
          onTurnStart={onTurnStart}
          deploying
        />
      )
    })

    const ta = screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement
    await act(async () => {
      fireEvent.change(ta, { target: { value: 'do a thing' } })
    })
    await act(async () => {
      fireEvent.keyDown(ta, { key: 'Enter' })
    })
    // Without the block, a deploy doesn't stop the user from queuing a turn.
    expect(onTurnStart).toHaveBeenCalledTimes(1)
    expect(sendMock()).toHaveBeenCalled()
  })
})

describe('ChatPanel images and the chosen model', () => {
  it('holds images back from a model on your own key that can’t read them', async () => {
    const api = (window as unknown as { api: { chat: { listModels: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> } } }).api
    api.chat.listModels.mockResolvedValue([
      {
        id: 'openai/o3-mini',
        name: 'o3-mini',
        supportedReasoningEfforts: ['low', 'medium', 'high'],
        vision: false,
        byok: { provider: 'openai', providerName: 'OpenAI', ready: true }
      }
    ])
    invalidateCopilotModels()
    await act(async () => {
      render(
        <ChatPanel
          project={makeProject('p1', { model: 'openai/o3-mini' })}
          messages={[]}
          onChange={() => {}}
          draft="What does this screen show?"
          attachments={[{ path: 'C:/tmp/shot.png', thumb: 'data:image/png;base64,AAAA' }]}
        />
      )
    })

    expect(await screen.findByText(/o3-mini can’t read images\. Remove the images/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => {
      fireEvent.keyDown(screen.getByPlaceholderText(PLACEHOLDER), { key: 'Enter' })
    })
    expect(api.chat.send).not.toHaveBeenCalled()
  })
})

/**
 * Perf guard (P1): streamed `delta` events must be coalesced. The SDK emits one
 * IPC event per token; applying each individually re-parsed the growing markdown
 * bubble ~60×/s. ChatPanel now buffers deltas and flushes on a fixed time budget,
 * so many deltas within one interval collapse into a single `onChange`. Structural
 * events still drain the buffer immediately (covered by other suites).
 */
describe('ChatPanel streamed delta coalescing (P1)', () => {
  /** A live assistant turn (`turnId` set, pending) plus its user prompt. */
  const seed = (): UIChatMessage[] => [
    { id: 'u1', role: 'user', text: 'hi', tools: [], pending: false },
    {
      id: 'a1',
      role: 'assistant',
      text: '',
      tools: [],
      segments: [],
      pending: true,
      turnId: 't1',
      startedAt: Date.now()
    }
  ]

  function StreamHarness({
    track
  }: {
    track: (updater: (prev: UIChatMessage[]) => UIChatMessage[]) => void
  }): JSX.Element {
    const project = useMemo(() => makeProject('p1'), [])
    const [messages, setMessages] = useState<UIChatMessage[]>(seed)
    return (
      <ChatPanel
        project={project}
        messages={messages}
        onChange={(updater) => {
          track(updater)
          setMessages((prev) => updater(prev))
        }}
        draft=""
        onDraftChange={() => {}}
      />
    )
  }

  it('buffers many deltas into a single flush, then renders the joined text', async () => {
    vi.useFakeTimers()
    try {
      // Capture the live chat-event subscriber so the test can emit like the native side.
      let handler: ((env: ChatEventEnvelope) => void) | null = null
      ;(
        window as unknown as {
          api: { onChatEvent: (cb: (env: ChatEventEnvelope) => void) => () => void }
        }
      ).api.onChatEvent = (cb) => {
        handler = cb
        return () => {
          handler = null
        }
      }
      const emit = (text: string): void =>
        handler?.({ projectId: 'p1', turnId: 't1', event: { type: 'delta', text } })

      const track = vi.fn()
      await act(async () => {
        render(<StreamHarness track={track} />)
      })

      // Ignore any mount-time onChange; only count flushes caused by the deltas below.
      track.mockClear()

      // Emit four tokens without advancing the clock. They must be buffered, not
      // applied one-by-one — so no flush has run and nothing is rendered yet.
      await act(async () => {
        emit('Hello')
        emit(', ')
        emit('brave ')
        emit('world')
      })
      expect(track).toHaveBeenCalledTimes(0)
      expect(screen.queryByText(/Hello, brave world/)).toBeNull()

      // Cross the flush interval: the whole buffer lands in exactly one update.
      await act(async () => {
        vi.advanceTimersByTime(200)
      })
      expect(track).toHaveBeenCalledTimes(1)
      expect(screen.getByText(/Hello, brave world/)).not.toBeNull()
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })
})

/**
 * Design mode ("visual chat"): changes queued in the preview show as chips in
 * the composer and go out as ONE turn. The transcript shows the note plus a
 * Design card; the structured prompt is hidden but re-sent on reruns.
 */
describe('ChatPanel Fabric data', () => {
  afterEach(() => setPendingData('p1', []))

  function DataHarness(): JSX.Element {
    const [messages, setMessages] = useState<UIChatMessage[]>([])
    return <ChatPanel project={makeProject('p1')} messages={messages} onChange={(update) => setMessages(update)} draft="" />
  }

  it('shows picked data as chips and tells only Copilot how to connect it', async () => {
    const api = installApi()
    setPendingData('p1', [
      { workspaceId: 'ws-fin', workspaceName: 'Finance', item: { id: 'm1', name: 'Sales', type: 'SemanticModel' } },
      { workspaceId: 'ws-ops', workspaceName: 'Ops', item: { id: 'l1', name: 'orders', type: 'Lakehouse' } }
    ])
    render(<DataHarness />)

    const tray = screen.getByRole('list', { name: 'Fabric data to connect' })
    expect(tray.textContent).toContain('SalesFinance')
    fireEvent.click(screen.getByRole('button', { name: 'Remove orders' }))
    expect(within(tray).queryByText('orders')).toBeNull()

    const composer = screen.getByPlaceholderText(/Say what to build with this data/) as HTMLTextAreaElement
    expect(composer.value).toBe('')
    fireEvent.change(composer, { target: { value: 'Chart sales by region' } })
    await act(async () => {
      fireEvent.keyDown(composer, { key: 'Enter' })
    })

    await waitFor(() => expect(api.chat.send).toHaveBeenCalledOnce())
    const [, , prompt] = api.chat.send.mock.calls[0] as unknown as [string, string, string]
    expect(prompt).toMatch(/^Chart sales by region\n\n\[Fabricator:/)
    expect(prompt).toContain('--type fabric-semanticmodel --workspace-id ws-fin --item-id m1')
    expect(prompt).not.toContain('orders')
    // The transcript shows the message and its data, not the instructions.
    const sent = await screen.findByRole('list', { name: 'Fabric data' })
    expect(sent.textContent).toContain('Sales')
    expect(screen.getByText('Chart sales by region')).toBeTruthy()
    expect(screen.queryByText(/rayfin connector add/)).toBeNull()
    expect(screen.queryByRole('list', { name: 'Fabric data to connect' })).toBeNull()
  })

  it('sends data on its own with a request to connect it, and Retry sends how to connect it again', async () => {
    const api = installApi()
    api.chat.send.mockResolvedValueOnce({ ok: false, error: 'Copilot is busy', filesModified: [], ranDeploy: false })
    setPendingData('p1', [
      { workspaceId: 'ws-fin', workspaceName: 'Finance', item: { id: 'm1', name: 'Sales', type: 'SemanticModel' } }
    ])
    render(<DataHarness />)

    const composer = screen.getByPlaceholderText(/just press Enter to connect it/)
    await act(async () => {
      fireEvent.keyDown(composer, { key: 'Enter' })
    })
    await waitFor(() => expect(api.chat.send).toHaveBeenCalledOnce())
    const first = (api.chat.send.mock.calls[0] as unknown as [string, string, string])[2]
    expect(first).toMatch(/^Connect this data to the app, and tell me what I could build with it\.\n\n\[Fabricator:/)
    expect(first).toContain('--type fabric-semanticmodel --workspace-id ws-fin --item-id m1')
    // The message is its chips alone: no empty bubble, and the request stays Copilot's.
    const sent = await screen.findByRole('list', { name: 'Fabric data' })
    expect(sent.closest('.turn')?.querySelector('.user-bubble')).toBeNull()
    expect(screen.queryByText(/Connect this data to the app/)).toBeNull()

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    })
    await waitFor(() => expect(api.chat.send).toHaveBeenCalledTimes(2))
    expect((api.chat.send.mock.calls[1] as unknown as [string, string, string])[2]).toBe(first)
    expect(screen.getAllByRole('list', { name: 'Fabric data' })).toHaveLength(2)
  })

  it('reopens Add Fabric data from a chip with what is picked, and Update changes the chips', async () => {
    const api = installApi() as unknown as Record<string, unknown> & { projects: Record<string, unknown> }
    Object.assign(api, {
      deploy: { list: vi.fn(async () => []) },
      fabric: {
        listWorkspaces: vi.fn(async () => ({
          ok: true,
          workspaces: [
            { id: 'ws-fin', displayName: 'Finance', capacityKind: 'fabric', eligible: true },
            { id: 'ws-ops', displayName: 'Ops', capacityKind: 'fabric', eligible: true }
          ]
        })),
        listWorkspaceData: vi.fn(async () => ({ ok: true, items: [] })),
        projectSemanticModels: vi.fn(async () => [])
      }
    })
    api.projects.files = { ...(api.projects.files as object), read: vi.fn(async () => ({ error: 'not found' })) }
    setPendingData('p1', [
      { workspaceId: 'ws-fin', workspaceName: 'Finance', item: { id: 'm1', name: 'Sales', type: 'SemanticModel' } },
      { workspaceId: 'ws-ops', workspaceName: 'Ops', item: { id: 'l1', name: 'orders', type: 'Lakehouse' } }
    ])
    render(<DataHarness />)

    const tray = screen.getByRole('list', { name: 'Fabric data to connect' })
    fireEvent.click(within(tray).getByText('Sales').closest('button')!)
    const dialog = await screen.findByRole('dialog', { name: 'Add Fabric data' })
    expect(await within(dialog).findByText('2 picked across workspaces')).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Update' }))
    expect(screen.queryByRole('dialog', { name: 'Add Fabric data' })).toBeNull()
    expect(screen.queryByRole('list', { name: 'Fabric data to connect' })).toBeNull()
    expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeTruthy()
  })
})

describe('ChatPanel Design changes', () => {
  const ITEM: DesignItem = {
    id: 'i1',
    kind: 'element',
    tweaks: [{ kind: 'background', summary: 'Background: bg-indigo-600 → bg-indigo-700' }],
    createdAt: 1,
    target: { label: 'Button · Save', role: 'button', tag: 'button', selector: 'button', route: '/', box: { w: 80, h: 32 } }
  }
  const TURN: DesignTurn = {
    projectId: 'p1',
    itemIds: ['i1'],
    display: 'make it pop',
    prompt: 'make it pop\n\n## Design changes from the live preview (1)\nAttached images: #1 is the full view',
    storedPrompt: 'make it pop\n\n## Design changes from the live preview (1)',
    shots: [
      { path: 'C:/tmp/full.png', thumb: 'data:image/png;base64,FULL' },
      { path: 'C:/tmp/crop.png', thumb: 'data:image/png;base64,CROP' }
    ],
    summary: { full: 0, items: [{ n: 1, kind: 'element', label: 'Button · Save', summary: 'Background: bg-indigo-600 → bg-indigo-700', shot: 1 }] }
  }

  function DesignHarness({
    initial = [],
    items = [ITEM],
    buildDesignTurn,
    onDesignSent,
    onDesignRemove
  }: {
    initial?: UIChatMessage[]
    items?: DesignItem[]
    buildDesignTurn?: (note: string, options?: { extraImages?: number }) => Promise<DesignTurn | null>
    onDesignSent?: (turn: DesignTurn) => void
    onDesignRemove?: (id: string) => void
  }): JSX.Element {
    const [messages, setMessages] = useState<UIChatMessage[]>(initial)
    return (
      <ChatPanel
        project={makeProject('p1')}
        messages={messages}
        onChange={(update) => setMessages(update)}
        draft=""
        designItems={items}
        buildDesignTurn={buildDesignTurn}
        onDesignSent={onDesignSent}
        onDesignRemove={onDesignRemove}
      />
    )
  }

  it('lists queued changes as chips and sends them as one turn with a clean card', async () => {
    const api = installApi()
    const build = vi.fn(async () => TURN)
    const sent = vi.fn()
    const removed = vi.fn()
    render(<DesignHarness buildDesignTurn={build} onDesignSent={sent} onDesignRemove={removed} />)

    const tray = screen.getByRole('group', { name: 'Design changes to send' })
    expect(tray.textContent).toContain('1 design change · sent with your message')
    expect(tray.textContent).toContain('Button · Save')
    fireEvent.click(screen.getByRole('button', { name: 'Remove change 1: Button · Save' }))
    expect(removed).toHaveBeenCalledWith('i1')

    const composer = screen.getByPlaceholderText(/Add a note for these changes/) as HTMLTextAreaElement
    // The changes alone are enough to send.
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.change(composer, { target: { value: 'make it pop' } })
    await act(async () => {
      fireEvent.keyDown(composer, { key: 'Enter' })
    })

    await waitFor(() => expect(api.chat.send).toHaveBeenCalledOnce())
    expect(build).toHaveBeenCalledWith('make it pop', { extraImages: 0 })
    expect(sent).toHaveBeenCalledWith(TURN)
    const [, , prompt, paths] = api.chat.send.mock.calls[0] as unknown as [string, string, string, string[]]
    expect(prompt).toBe(TURN.prompt)
    expect(paths).toEqual(['C:/tmp/full.png', 'C:/tmp/crop.png'])
    expect(composer.value).toBe('')

    // The transcript shows the note and a Design card — not the raw prompt.
    const card = await screen.findByRole('group', { name: 'Design changes (1)' })
    expect(card.textContent).toContain('1 design change')
    expect(card.textContent).toContain('Button · Save')
    expect(card.querySelector('img.design-card-shot')?.getAttribute('src')).toBe('data:image/png;base64,CROP')
    expect(card.querySelector('img.design-card-full')?.getAttribute('src')).toBe('data:image/png;base64,FULL')
    expect(screen.getByText('make it pop')).toBeTruthy()
    // Captures shown in the card aren't repeated as loose screenshots.
    expect(document.querySelectorAll('.msg-shots img')).toHaveLength(0)
    expect(card.querySelector('details pre')?.textContent).toBe(TURN.storedPrompt)
  })

  it('does nothing when the changes could not be prepared', async () => {
    const api = installApi()
    const sent = vi.fn()
    render(<DesignHarness buildDesignTurn={async () => null} onDesignSent={sent} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    })
    expect(api.chat.send).not.toHaveBeenCalled()
    expect(sent).not.toHaveBeenCalled()
  })

  it('re-sends the stored Design prompt on Try again, keeping the card', async () => {
    const api = installApi()
    const initial: UIChatMessage[] = [
      {
        id: 'u1',
        role: 'user',
        text: '',
        tools: [],
        pending: false,
        attachments: 2,
        attachmentThumbs: ['data:image/png;base64,FULL', 'data:image/png;base64,CROP'],
        design: TURN.summary,
        prompt: TURN.storedPrompt
      },
      { id: 'a1', role: 'assistant', text: 'Done — the Save button is darker now.', tools: [], pending: false }
    ]
    render(<DesignHarness initial={initial} items={[]} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Try again/ }))
    })
    await waitFor(() => expect(api.chat.send).toHaveBeenCalledOnce())
    const [, , prompt, paths] = api.chat.send.mock.calls[0] as unknown as [string, string, string, string[]]
    expect(prompt).toBe(tryAgainPrompt(TURN.storedPrompt))
    expect(paths).toEqual([])
    // Both Design messages render a card; the rerun has no captures to show.
    const cards = screen.getAllByRole('group', { name: 'Design changes (1)' })
    expect(cards).toHaveLength(2)
    expect(cards[1].querySelector('img')).toBeNull()
  })
})

/**
 * Advisor hand-offs: the message shows a card listing the issues Copilot is
 * fixing (not the raw prompt), says it's fixing while its turn runs, and then
 * follows each issue through the Advisor.
 */
describe('ChatPanel Advisor fixes', () => {
  const MAX: ChatAdvisorFix = {
    id: 'quick:data-model/text-without-max',
    ruleId: 'data-model/text-without-max',
    title: 'Text field has no maximum length',
    severity: 'high',
    category: 'data-model',
    source: 'quick',
    file: 'rayfin/data/Todo.ts',
    line: 7,
    places: 2
  }
  const LABEL: ChatAdvisorFix = {
    id: 'ai:accessibility/control-label',
    ruleId: 'accessibility/control-label',
    title: 'Form control has no label',
    severity: 'medium',
    category: 'accessibility',
    source: 'ai',
    file: 'src/App.tsx',
    line: 12
  }
  const SUMMARY: ChatAdvisorSummary = { fixes: [MAX, LABEL] }
  const PROMPT = 'The Advisor found 2 issues in this app. Please fix all of them, most severe first.'

  function AdvisorHarness({
    initial = [],
    outbound = null,
    links = null,
    onAdvisorRerun
  }: {
    initial?: UIChatMessage[]
    outbound?: OutboundPrompt | null
    links?: AdvisorFixLinks | null
    onAdvisorRerun?: (summary: ChatAdvisorSummary) => void
  }): JSX.Element {
    const [messages, setMessages] = useState<UIChatMessage[]>(initial)
    return (
      <AdvisorFixContext.Provider value={links}>
        <ChatPanel
          project={makeProject('p1')}
          messages={messages}
          onChange={(update) => setMessages(update)}
          draft=""
          outbound={outbound}
          onAdvisorRerun={onAdvisorRerun}
        />
      </AdvisorFixContext.Provider>
    )
  }

  function sent(advisor: ChatAdvisorSummary = SUMMARY, extra: Partial<UIChatMessage> = {}): UIChatMessage[] {
    return [
      { id: 'u1', role: 'user', text: 'Fix 2 Advisor issues', tools: [], pending: false, advisor, prompt: PROMPT },
      { id: 'a1', role: 'assistant', text: 'Fixed both.', tools: [], pending: false, ...extra }
    ]
  }

  it('shows what Copilot is fixing as a card instead of the raw prompt', async () => {
    const api = installApi()
    const turn = deferred<{ ok: boolean; filesModified: string[]; ranDeploy: boolean }>()
    api.chat.send.mockImplementationOnce(() => turn.promise)
    render(
      <AdvisorHarness
        outbound={{ id: 'fix-1', display: 'Fix 2 Advisor issues', prompt: PROMPT, advisor: SUMMARY }}
      />
    )
    await waitFor(() => expect(api.chat.send).toHaveBeenCalledOnce())
    expect((api.chat.send.mock.calls[0] as unknown[])[2]).toBe(PROMPT)

    const card = screen.getByRole('group', { name: 'Advisor issues to fix (2)' })
    expect(within(card).getByText('Fix 2 Advisor issues')).toBeTruthy()
    expect(within(card).getByText('Fixing…')).toBeTruthy()
    const rows = card.querySelectorAll('.adv-fix-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('Text field has no maximum length×2')
    expect(rows[0].textContent).toContain('Data model·rayfin/data/Todo.ts:7')
    expect(within(rows[0] as HTMLElement).getByRole('img', { name: 'High severity' })).toBeTruthy()
    expect(rows[1].textContent).toContain('Accessibility·src/App.tsx:12')
    // The card replaces the bubble; the full prompt sits behind a disclosure.
    expect(document.querySelector('.user-bubble')).toBeNull()
    expect(card.querySelector('details pre')?.textContent).toBe(PROMPT)

    await act(async () => turn.resolve({ ok: true, filesModified: [], ranDeploy: false }))
    expect(within(card).queryByText('Fixing…')).toBeNull()
  })

  it('follows each issue through the Advisor and opens it there from its row', async () => {
    installApi()
    const show = vi.fn()
    const outcomes: Record<string, FixOutcome> = { [MAX.id]: 'fixed', [LABEL.id]: 'still' }
    const links: AdvisorFixLinks = { outcome: (id) => outcomes[id], show }
    const { rerender } = render(<AdvisorHarness initial={sent()} links={links} />)
    const card = screen.getByRole('group', { name: 'Advisor issues to fix (2)' })
    expect(within(card).getByText('1 of 2 fixed')).toBeTruthy()
    expect(within(card).getByText('Fixed')).toBeTruthy()
    expect(within(card).getByText('Still detected')).toBeTruthy()

    fireEvent.click(within(card).getByRole('button', { name: /Form control has no label/ }))
    expect(show).toHaveBeenCalledWith(LABEL.id)

    outcomes[LABEL.id] = 'fixed'
    rerender(<AdvisorHarness initial={sent()} links={{ ...links }} />)
    expect(within(card).getByText('All 2 fixed')).toBeTruthy()
    expect(within(card).getAllByText('Fixed')).toHaveLength(2)
  })

  it('folds a long list behind “Show more”', async () => {
    installApi()
    const many: ChatAdvisorSummary = {
      fixes: Array.from({ length: 8 }, (_, i) => ({ ...LABEL, id: `ai:rule-${i}`, title: `Issue ${i + 1}` }))
    }
    render(<AdvisorHarness initial={sent(many)} />)
    const card = screen.getByRole('group', { name: 'Advisor issues to fix (8)' })
    expect(card.querySelectorAll('.adv-fix-row')).toHaveLength(5)
    // Without the Advisor wired up, rows are plain text, not buttons.
    expect(card.querySelector('button.adv-fix-row')).toBeNull()
    fireEvent.click(within(card).getByRole('button', { name: 'Show 3 more' }))
    expect(card.querySelectorAll('.adv-fix-row')).toHaveLength(8)
    expect(within(card).getByRole('button', { name: 'Show fewer' })).toBeTruthy()
  })

  it('re-sends the full prompt on Try again, keeps the card, and hands the issues off again', async () => {
    const api = installApi()
    const rerun = vi.fn()
    render(<AdvisorHarness initial={sent()} onAdvisorRerun={rerun} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Try again/ }))
    })
    await waitFor(() => expect(api.chat.send).toHaveBeenCalledOnce())
    expect((api.chat.send.mock.calls[0] as unknown[])[2]).toBe(tryAgainPrompt(PROMPT))
    expect(rerun).toHaveBeenCalledWith(SUMMARY)
    expect(screen.getAllByRole('group', { name: 'Advisor issues to fix (2)' })).toHaveLength(2)
  })

  it('keeps a hand-off’s full prompt so Retry re-sends what Copilot received', async () => {
    const api = installApi()
    api.chat.send.mockImplementationOnce(() =>
      Promise.resolve({ ok: false, error: 'The model is unavailable.', filesModified: [], ranDeploy: false })
    )
    const upgrade = 'Please upgrade this app’s Rayfin packages to the latest version.'
    render(<AdvisorHarness outbound={{ id: 'up-1', display: 'Update Rayfin to 1.36.2', prompt: upgrade }} />)
    const retry = await screen.findByRole('button', { name: /Retry/ })
    expect(screen.getByText('Update Rayfin to 1.36.2')).toBeTruthy()
    await act(async () => {
      fireEvent.click(retry)
    })
    await waitFor(() => expect(api.chat.send).toHaveBeenCalledTimes(2))
    expect((api.chat.send.mock.calls[1] as unknown[])[2]).toBe(upgrade)
  })
})