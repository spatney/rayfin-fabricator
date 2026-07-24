import { useMemo, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ChatEventEnvelope, ChatPlanArtifact, ChatPlanQuestion } from '@shared/ipc'
import { makeProject } from '../../test/harness'
import ChatPanel, { reduceChatMessage, type UIChatMessage } from './ChatPanel'

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
      modeSelectorEnabled
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

describe('ChatPanel Plan-mode entry', () => {
  const complexPrompt = [
    'Redesign authentication across the frontend and backend.',
    '1. Migrate token storage while preserving backward compatibility.',
    '2. Refactor the API middleware.',
    '3. Update the React sign-in flow and add integration tests.'
  ].join('\n')

  it('suggests Plan mode for a complex draft without switching automatically', async () => {
    render(
      <ChatPanel
        project={makeProject('p1')}
        messages={[]}
        onChange={() => {}}
        draft=""
        modeSelectorEnabled
      />
    )
    const input = screen.getByPlaceholderText(PLACEHOLDER)
    await act(async () => {
      fireEvent.change(input, { target: { value: complexPrompt } })
    })

    expect(screen.getByText('This looks multi-step.')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Agent/i })).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Use Plan' }))
    })
    expect(screen.getByRole('button', { name: /Plan/i })).toBeTruthy()
  })

  it('does not suggest Plan mode for a small cosmetic edit', async () => {
    render(
      <ChatPanel
        project={makeProject('p1')}
        messages={[]}
        onChange={() => {}}
        draft=""
        modeSelectorEnabled
      />
    )
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER), {
        target: { value: 'Change the button label to Save changes' }
      })
    })
    expect(screen.queryByText('This looks multi-step.')).toBeNull()
  })

  it('restores the selected mode for the project after remounting', async () => {
    const props = {
      project: makeProject('p1'),
      messages: [] as UIChatMessage[],
      onChange: () => {},
      draft: '',
      modeSelectorEnabled: true
    }
    const first = render(<ChatPanel {...props} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Agent/i }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitemradio', { name: /Plan/i }))
    })
    first.unmount()

    render(<ChatPanel {...props} />)
    expect(screen.getByRole('button', { name: /Plan/i })).toBeTruthy()
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

  it('resumes interrupted execution with only unfinished work marked for execution', async () => {
    const api = installApi()
    render(
      <PlanHarness
        pending={false}
        plan={planArtifact({
          phase: 'interruptedExecution',
          selectedAction: 'interactive',
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
    expect(mode).toBe('agent')
    expect(prompt).toContain('next: Remaining step')
    expect(prompt).toContain('done: Finished step')
    expect(prompt).toContain('do not redo')
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
        modeSelectorEnabled
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
    ({
      top,
      bottom,
      left: 0,
      right: 0,
      width: 1,
      height: bottom - top,
      x: 0,
      y: top,
      toJSON: () => ({})
    }) as DOMRect

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
 * Live local preview (experiment): the host starts the project's Vite dev server
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
})

/**
 * Outbound autoSend (the migrate hand-off): a prompt flagged `autoSend` submits
 * itself once a new turn is allowed. The migrate flow seeds it while the first
 * deploy is still streaming, so it must stay staged in the composer behind the
 * deploy gate and fire the instant the gate clears — never require an Enter.
 */
describe('ChatPanel outbound autoSend', () => {
  const sendMock = (): ReturnType<typeof vi.fn> =>
    (window as unknown as { api: { chat: { send: ReturnType<typeof vi.fn> } } }).api.chat.send

  it('stages an autoSend prompt behind the deploy gate, then fires it when the gate clears', async () => {
    const onConsumed = vi.fn()
    const outbound = {
      id: 'mig-1',
      display: 'Migrate report',
      prompt: 'rebuild this report',
      autoSend: true
    }
    let rerender: ReturnType<typeof render>['rerender'] = () => {}
    await act(async () => {
      const r = render(
        <ChatPanel
          project={makeProject('p1')}
          messages={[]}
          onChange={() => {}}
          draft=""
          deployLock
          outbound={outbound}
          onOutboundConsumed={onConsumed}
        />
      )
      rerender = r.rerender
    })

    // Gate up: staged in the composer, not sent.
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(ta.value).toBe('rebuild this report')
    expect(sendMock()).not.toHaveBeenCalled()
    expect(onConsumed).toHaveBeenCalledTimes(1)

    // Deploy lands → gate clears → the prompt submits itself, composer cleared.
    await act(async () => {
      rerender(
        <ChatPanel
          project={makeProject('p1')}
          messages={[]}
          onChange={() => {}}
          draft=""
          deployLock={false}
          outbound={outbound}
          onOutboundConsumed={onConsumed}
        />
      )
    })
    await waitFor(() => expect(sendMock()).toHaveBeenCalled())
    const calls = sendMock().mock.calls
    const [, , prompt] = calls[calls.length - 1] ?? []
    expect(prompt).toBe('rebuild this report')
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('')
  })

  it('sends an autoSend prompt immediately when no gate is up, showing the full prompt as the message', async () => {
    // Capture the visible user message the panel appends so we can assert the
    // bubble shows the full prompt (not a short display label).
    const userTexts: string[] = []
    const onChange = (updater: (prev: UIChatMessage[]) => UIChatMessage[]): void => {
      for (const m of updater([])) if (m.role === 'user') userTexts.push(m.text)
    }
    await act(async () => {
      render(
        <ChatPanel
          project={makeProject('p1')}
          messages={[]}
          onChange={onChange}
          draft=""
          outbound={{ id: 'mig-2', display: 'Migrate report', prompt: 'rebuild it now', autoSend: true }}
        />
      )
    })
    await waitFor(() => expect(sendMock()).toHaveBeenCalled())
    const calls = sendMock().mock.calls
    const [, , prompt] = calls[calls.length - 1] ?? []
    expect(prompt).toBe('rebuild it now')
    // The visible message is the full prompt, not the short display label.
    expect(userTexts.at(-1)).toBe('rebuild it now')
    expect(userTexts).not.toContain('Migrate report')
  })

  it('forwards autoSend attachment paths to chat.send (the migrate report-page images)', async () => {
    await act(async () => {
      render(
        <ChatPanel
          project={makeProject('p1')}
          messages={[]}
          onChange={() => {}}
          draft=""
          outbound={{
            id: 'mig-3',
            display: 'Migrate report',
            prompt: 'rebuild it now',
            autoSend: true,
            attachments: [
              { path: '/tmp/page-1.png', thumb: 'data:image/png;base64,AAAA' },
              { path: '/tmp/page-2.png', thumb: 'data:image/png;base64,BBBB' }
            ]
          }}
        />
      )
    })
    await waitFor(() => expect(sendMock()).toHaveBeenCalled())
    const calls = sendMock().mock.calls
    // chat.send(projectId, turnId, prompt, attachmentPaths[], mode)
    const [, , , attachments] = calls[calls.length - 1] ?? []
    expect(attachments).toEqual(['/tmp/page-1.png', '/tmp/page-2.png'])
  })
})

/**
 * Live local preview lifecycle: submitting a new turn while a deploy is in flight
 * used to leave the local preview unable to start (and never come back). With the
 * experiment on, submitting is paused during a deploy — typing stays enabled — so
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

  it('still submits while deploying when the block is off (experiment disabled)', async () => {
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
