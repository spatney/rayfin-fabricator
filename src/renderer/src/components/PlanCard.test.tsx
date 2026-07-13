import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ChatPlanArtifact } from '@shared/ipc'
import { OverlayProvider, usePreviewSuppressed } from '../overlay'
import PlanCard, { alternatePlanActions, primaryPlanAction, type PlanCardProps } from './PlanCard'

// Monaco doesn't run under jsdom — swap the editor for a plain textarea and stub the
// local Monaco bootstrap side-effect, same as CustomSkillModal.test.tsx.
vi.mock('../monaco', () => ({}))
vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange }: { value: string; onChange?: (v: string | undefined) => void }) => (
    <textarea
      data-testid="plan-editor"
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
    />
  )
}))

afterEach(() => cleanup())

function basePlan(overrides: Partial<ChatPlanArtifact> = {}): ChatPlanArtifact {
  return {
    id: 'plan-1',
    phase: 'review',
    summary: 'A short summary of the plan.',
    content: '# The plan\n\nDo the thing.',
    actions: ['interactive', 'autopilot', 'exit_only'],
    recommendedAction: 'interactive',
    todos: [
      { id: 't1', title: 'Step one', status: 'done' },
      { id: 't2', title: 'Step two', status: 'in_progress' },
      { id: 't3', title: 'Step three', status: 'pending' }
    ],
    dependencies: [{ todoId: 't3', dependsOn: 't2' }],
    questions: [],
    ...overrides
  }
}

function renderCard(props: Partial<PlanCardProps> = {}): {
  onContentChange: ReturnType<typeof vi.fn>
  onResolve: ReturnType<typeof vi.fn>
  onAnswerQuestion: ReturnType<typeof vi.fn>
  onResume: ReturnType<typeof vi.fn>
  onExport: ReturnType<typeof vi.fn>
  container: HTMLElement
} {
  const onContentChange = vi.fn()
  const onResolve = vi.fn()
  const onAnswerQuestion = vi.fn()
  const onResume = vi.fn()
  const onExport = vi.fn(() => Promise.resolve())
  const { container } = render(
    <OverlayProvider>
      <PlanCard
        plan={basePlan()}
        projectName="Demo Project"
        onContentChange={onContentChange}
        onResolve={onResolve}
        onAnswerQuestion={onAnswerQuestion}
        onResume={onResume}
        onExport={onExport}
        {...props}
      />
    </OverlayProvider>
  )
  return { onContentChange, onResolve, onAnswerQuestion, onResume, onExport, container }
}

describe('primaryPlanAction / alternatePlanActions', () => {
  it('picks the recommended action when it is known and allowed', () => {
    const plan = { actions: ['interactive', 'autopilot', 'exit_only'], recommendedAction: 'autopilot' }
    expect(primaryPlanAction(plan)).toBe('autopilot')
    expect(alternatePlanActions(plan, 'autopilot')).toEqual(['interactive', 'exit_only'])
  })

  it('falls back to interactive when the recommendation is unknown but interactive is allowed', () => {
    const plan = { actions: ['interactive', 'weird_custom_action'], recommendedAction: 'weird_custom_action' }
    expect(primaryPlanAction(plan)).toBe('interactive')
  })

  it('never includes unknown action strings among the alternates', () => {
    const plan = { actions: ['interactive', 'autopilot', 'weird_custom_action'] }
    expect(alternatePlanActions(plan, 'interactive')).toEqual(['autopilot'])
  })

  it('falls back to the first known action when interactive is not allowed', () => {
    const plan = { actions: ['autopilot_fleet', 'exit_only'], recommendedAction: 'something_unknown' }
    expect(primaryPlanAction(plan)).toBe('autopilot_fleet')
  })

  it('never promotes an unknown action to primary when no known action is allowed', () => {
    const plan = { actions: ['weird_custom_action'], recommendedAction: 'weird_custom_action' }
    expect(primaryPlanAction(plan)).toBeUndefined()
  })
})

describe('PlanCard — review phase actions', () => {
  it('renders the recommended action as primary and the rest in the alternate dropdown', () => {
    renderCard()
    expect(screen.getByRole('button', { name: 'Build plan' })).toBeTruthy()
    const select = screen.getByRole('combobox', { name: /other plan actions/i }) as HTMLSelectElement
    const optionLabels = Array.from(select.options).map((o) => o.textContent)
    expect(optionLabels).toContain('Run in Autopilot')
    expect(optionLabels).toContain('Approve plan')
    expect(optionLabels).not.toContain('Build plan')
  })

  it('resolves with the primary action on click', () => {
    const { onResolve } = renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Build plan' }))
    expect(onResolve).toHaveBeenCalledWith('interactive')
  })

  it('resolves with an alternate action chosen from the dropdown', () => {
    const { onResolve } = renderCard()
    const select = screen.getByRole('combobox', { name: /other plan actions/i })
    fireEvent.change(select, { target: { value: 'autopilot' } })
    expect(onResolve).toHaveBeenCalledWith('autopilot')
  })

  it('sends optional feedback through the request-changes flow', () => {
    const { onResolve } = renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }))
    fireEvent.change(screen.getByPlaceholderText(/what should change/i), {
      target: { value: 'Please add tests.' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }))
    expect(onResolve).toHaveBeenCalledWith('keep_planning', 'Please add tests.')
  })

  it('disables the primary/alternate/request-changes controls while busy', () => {
    renderCard({ busy: true })
    expect((screen.getByRole('button', { name: 'Build plan' }) as HTMLButtonElement).disabled).toBe(
      true
    )
    expect(
      (screen.getByRole('combobox', { name: /other plan actions/i }) as HTMLSelectElement).disabled
    ).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Request changes' }) as HTMLButtonElement).disabled
    ).toBe(true)
  })

  it('shows the inline plan.error message', () => {
    renderCard({ plan: basePlan({ error: 'The SDK call failed.' }) })
    expect(screen.getByText('The SDK call failed.')).toBeTruthy()
  })
})

describe('PlanCard — todo checklist', () => {
  it('starts execution as a thin bar and expands the structured progress on demand', () => {
    renderCard({ plan: basePlan({ phase: 'executing' }) })
    expect(screen.getByRole('button', { name: /expand plan progress/i })).toBeTruthy()
    expect(screen.getByText('1/3')).toBeTruthy()
    expect(screen.queryByText(/1 of 3 steps done/i)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /expand plan progress/i }))
    expect(screen.getByText(/1 of 3 steps done/i)).toBeTruthy()
    expect(screen.getAllByText('Step two').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: /collapse plan progress/i }))
    expect(screen.queryByText(/1 of 3 steps done/i)).toBeNull()
  })
})

describe('PlanCard — review dialog + edit callback', () => {
  it('opens the full-plan dialog and forwards edits via onContentChange', async () => {
    const { onContentChange } = renderCard()
    fireEvent.click(screen.getByRole('button', { name: /review full plan/i }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }))
    const editor = await screen.findByTestId('plan-editor')
    fireEvent.change(editor, { target: { value: '# Updated plan' } })
    expect(onContentChange).toHaveBeenCalledWith('# Updated plan')

    // Escape closes the dialog.
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('registers as a preview-suppressing overlay while open', async () => {
    function Probe(): JSX.Element {
      return <div data-testid="suppressed">{String(usePreviewSuppressed())}</div>
    }
    render(
      <OverlayProvider>
        <Probe />
        <PlanCard
          plan={basePlan()}
          projectName="Demo Project"
          onContentChange={() => {}}
          onResolve={() => {}}
          onAnswerQuestion={() => {}}
          onResume={() => {}}
          onExport={() => Promise.resolve()}
        />
      </OverlayProvider>
    )
    expect(screen.getByTestId('suppressed').textContent).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: /review full plan/i }))
    await waitFor(() => expect(screen.getByTestId('suppressed').textContent).toBe('true'))
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.getByTestId('suppressed').textContent).toBe('false'))
  })

  it('portals the focused review outside the scrolling Plan card', async () => {
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: /review full plan/i }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.closest('.chat-plan-card')).toBeNull()
    expect(dialog.parentElement?.parentElement).toBe(document.body)
  })
})

describe('PlanCard — clarifying questions', () => {
  function questionPlan(): ChatPlanArtifact {
    return basePlan({
      phase: 'clarifying',
      todos: [],
      questions: [
        {
          id: 'q1',
          question: 'Which database should this use?',
          choices: ['Postgres', 'SQLite'],
          allowFreeform: true,
          state: 'pending'
        },
        {
          id: 'q2',
          question: 'Already answered?',
          allowFreeform: false,
          state: 'answered',
          answer: 'Yes'
        }
      ]
    })
  }

  it('answers with wasFreeform=false when a choice is clicked', () => {
    const { onAnswerQuestion } = renderCard({ plan: questionPlan() })
    fireEvent.click(screen.getByRole('button', { name: 'Postgres' }))
    expect(onAnswerQuestion).toHaveBeenCalledWith('q1', 'Postgres', false)
  })

  it('validates non-blank freeform input and answers with wasFreeform=true', () => {
    const { onAnswerQuestion } = renderCard({ plan: questionPlan() })
    const sendButton = screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement
    expect(sendButton.disabled).toBe(true)

    const textarea = screen.getByPlaceholderText('Type an answer…')
    fireEvent.change(textarea, { target: { value: '   ' } })
    expect(sendButton.disabled).toBe(true)

    fireEvent.change(textarea, { target: { value: 'Use Postgres in production.' } })
    expect(sendButton.disabled).toBe(false)
    fireEvent.click(sendButton)
    expect(onAnswerQuestion).toHaveBeenCalledWith('q1', 'Use Postgres in production.', true)
  })

  it('keeps answered questions visible in a compact answered state', () => {
    renderCard({ plan: questionPlan() })
    expect(screen.getByText('Already answered?')).toBeTruthy()
    expect(screen.getByText('Yes')).toBeTruthy()
  })
})

describe('PlanCard — interrupted recovery', () => {
  it('resumes remaining work with the previously selected action after interruptedExecution', () => {
    const { onResume } = renderCard({
      plan: basePlan({ phase: 'interruptedExecution', selectedAction: 'autopilot' })
    })
    fireEvent.click(screen.getByRole('button', { name: /resume remaining work/i }))
    expect(onResume).toHaveBeenCalledWith('execute', 'autopilot')
  })

  it('resumes remaining work after a failure that had already selected an action', () => {
    const { onResume } = renderCard({
      plan: basePlan({ phase: 'failed', selectedAction: 'interactive', error: 'It crashed.' })
    })
    fireEvent.click(screen.getByRole('button', { name: /resume remaining work/i }))
    expect(onResume).toHaveBeenCalledWith('execute', 'interactive')
  })

  it('offers to continue planning when interruptedReview has no recovered content', () => {
    const { onResume } = renderCard({
      plan: basePlan({ phase: 'interruptedReview', content: '' })
    })
    fireEvent.click(screen.getByRole('button', { name: /continue planning/i }))
    expect(onResume).toHaveBeenCalledWith('review')
  })

  it('does not submit a recovered plan while an interrupted clarification is unanswered', () => {
    const { onResume } = renderCard({
      plan: basePlan({
        phase: 'interruptedReview',
        questions: [
          {
            id: 'q1',
            question: 'Which database?',
            choices: ['SQLite', 'PostgreSQL'],
            allowFreeform: true,
            state: 'interrupted'
          }
        ]
      })
    })
    expect(screen.queryByRole('button', { name: 'Build plan' })).toBeNull()
    expect(screen.getByText(/not answered before/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /continue planning/i }))
    expect(onResume).toHaveBeenCalledWith('review')
  })

  it('approves recovered content via onResume("review", action) when content exists', () => {
    const { onResume } = renderCard({
      plan: basePlan({ phase: 'interruptedReview' })
    })
    fireEvent.click(screen.getByRole('button', { name: 'Build plan' }))
    expect(onResume).toHaveBeenCalledWith('review', 'interactive')
  })

  it('requests a revision via onResume("revise", undefined, feedback) for recovered content', () => {
    const { onResume } = renderCard({
      plan: basePlan({ phase: 'interruptedReview' })
    })
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }))
    fireEvent.change(screen.getByPlaceholderText(/what should change/i), {
      target: { value: 'Reconsider step two.' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }))
    expect(onResume).toHaveBeenCalledWith('revise', undefined, 'Reconsider step two.')
  })
})

describe('PlanCard — completed state', () => {
  it('renders a compact success state that remains inspectable', async () => {
    const { container } = renderCard({ plan: basePlan({ phase: 'completed' }) })
    expect(screen.getByText(/plan completed/i)).toBeTruthy()
    expect(screen.getByText('3 of 3 steps done')).toBeTruthy()
    expect(container.querySelector('.chat-plan-spin')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /review full plan/i }))
    expect(await screen.findByRole('dialog')).toBeTruthy()
  })
})

describe('PlanCard — question history persists past clarifying', () => {
  it('keeps an answered question visible once the plan has moved on to review', () => {
    renderCard({
      plan: basePlan({
        phase: 'review',
        questions: [
          {
            id: 'q1',
            question: 'Already answered?',
            allowFreeform: false,
            state: 'answered',
            answer: 'Yes'
          }
        ]
      })
    })
    expect(screen.getByText('Already answered?')).toBeTruthy()
    expect(screen.getByText('Yes')).toBeTruthy()
  })

  it('renders no questions container when there are none, to avoid clutter', () => {
    const { container } = renderCard({ plan: basePlan({ questions: [] }) })
    expect(container.querySelector('.chat-plan-questions')).toBeNull()
  })
})

describe('PlanCard — failed with no selected action offers a retry', () => {
  it('retries planning via onResume("review") when a failure has no selectedAction', () => {
    const { onResume } = renderCard({
      plan: basePlan({ phase: 'failed', selectedAction: undefined, error: 'Planning crashed.' })
    })
    expect(screen.queryByRole('button', { name: /resume remaining work/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /retry planning/i }))
    expect(onResume).toHaveBeenCalledWith('review')
  })

  it('still offers "Resume remaining work" (not retry) when a failure has a selectedAction', () => {
    renderCard({
      plan: basePlan({ phase: 'failed', selectedAction: 'interactive', error: 'It crashed.' })
    })
    expect(screen.queryByRole('button', { name: /retry planning/i })).toBeNull()
    expect(screen.getByRole('button', { name: /resume remaining work/i })).toBeTruthy()
  })
})

describe('PlanCard — progress bar semantics', () => {
  it('exposes an accessible progressbar with min/max/now', () => {
    renderCard({ plan: basePlan({ phase: 'executing' }) })
    fireEvent.click(screen.getByRole('button', { name: /expand plan progress/i }))
    const bar = screen.getByRole('progressbar', { name: /plan progress/i })
    expect(bar.getAttribute('aria-valuemin')).toBe('0')
    expect(bar.getAttribute('aria-valuemax')).toBe('100')
    expect(bar.getAttribute('aria-valuenow')).toBe('33')
    expect(bar.getAttribute('aria-valuetext')).toMatch(/1 of 3 steps done/i)
  })
})

describe('PlanCard — dependency ordering in the review dialog', () => {
  it('renders the prerequisite before the dependent todo, unambiguously labeled', async () => {
    renderCard({
      plan: basePlan({
        todos: [
          { id: 't1', title: 'Design schema', status: 'done' },
          { id: 't2', title: 'Write migration', status: 'in_progress' },
          { id: 't3', title: 'Wire up API', status: 'pending' }
        ],
        dependencies: [{ todoId: 't3', dependsOn: 't2' }]
      })
    })
    fireEvent.click(screen.getByRole('button', { name: /review full plan/i }))
    const dialog = await screen.findByRole('dialog')
    const dep = dialog.querySelector('.chat-plan-dialog-dep') as HTMLElement
    expect(dep).toBeTruthy()
    expect(dep.textContent).toMatch(/Write migration.*Wire up API/)
    expect(dep.getAttribute('aria-label')).toBe('Write migration must finish before Wire up API')
  })
})

describe('PlanCard — copy failure surfaces a visible error', () => {
  const originalClipboard = (navigator as unknown as { clipboard?: unknown }).clipboard

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      configurable: true
    })
  })

  it('shows an inline error in the card when the clipboard write rejects', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(() => Promise.reject(new Error('Permission denied'))) },
      configurable: true
    })
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: /^copy$/i }))
    expect(await screen.findByText('Permission denied')).toBeTruthy()
  })

  it('shows an inline error in the review dialog when the clipboard write rejects', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(() => Promise.reject(new Error('Permission denied'))) },
      configurable: true
    })
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: /review full plan/i }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /^copy$/i }))
    expect(await within(dialog).findByText('Permission denied')).toBeTruthy()
  })

  it('clears a prior copy error on a later successful copy', async () => {
    const writeText = vi
      .fn()
      .mockRejectedValueOnce(new Error('Permission denied'))
      .mockResolvedValueOnce(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderCard()
    const copyButton = screen.getByRole('button', { name: /^copy$/i })
    fireEvent.click(copyButton)
    expect(await screen.findByText('Permission denied')).toBeTruthy()

    fireEvent.click(copyButton)
    await waitFor(() => expect(screen.queryByText('Permission denied')).toBeNull())
  })
})
