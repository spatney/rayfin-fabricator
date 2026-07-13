import { describe, expect, it } from 'vitest'
import type { ChatPlanArtifact } from '@shared/ipc'
import {
  buildRecoveredPlanPrompt,
  createPlanArtifact,
  planForStorage,
  planFromStorage,
  reducePlanEvent,
  setPlanSubmitting,
  shouldSuggestPlanMode
} from './chatPlan'

describe('Plan lifecycle reducer', () => {
  it('does not fabricate a Plan artifact from ordinary Agent todo or plan-file events', () => {
    expect(
      reducePlanEvent(
        undefined,
        {
          type: 'plan-todos',
          todos: [{ id: 'agent-work', title: 'Agent work', status: 'in_progress' }],
          dependencies: []
        },
        'fallback'
      )
    ).toBeUndefined()
    expect(
      reducePlanEvent(
        undefined,
        { type: 'plan-content', content: '# Internal work', operation: 'update' },
        'fallback'
      )
    ).toBeUndefined()
  })

  it('moves a researching artifact through clarification and review', () => {
    const initial = createPlanArtifact('p1')
    const clarifying = reducePlanEvent(
      initial,
      {
        type: 'plan-question',
        requestId: 'q1',
        question: 'Which database?',
        choices: ['SQLite', 'PostgreSQL'],
        allowFreeform: true
      },
      'fallback'
    )!
    expect(clarifying.phase).toBe('clarifying')
    expect(clarifying.questions[0]).toMatchObject({ id: 'q1', state: 'pending' })

    const reviewed = reducePlanEvent(
      clarifying,
      {
        type: 'plan-proposed',
        requestId: 'r1',
        summary: 'Add durable storage',
        planContent: '# Plan\n\n1. Add schema',
        actions: ['interactive', 'autopilot'],
        recommendedAction: 'interactive'
      },
      'fallback'
    )!
    expect(reviewed).toMatchObject({
      phase: 'review',
      summary: 'Add durable storage',
      liveRequestId: 'r1'
    })
  })

  it('tracks native todo snapshots and completes execution on a successful result', () => {
    const executing: ChatPlanArtifact = {
      ...createPlanArtifact('p1'),
      phase: 'executing',
      selectedAction: 'interactive'
    }
    const withTodos = reducePlanEvent(
      executing,
      {
        type: 'plan-todos',
        todos: [
          { id: 'schema', title: 'Add schema', status: 'done' },
          { id: 'ui', title: 'Build UI', status: 'in_progress' }
        ],
        dependencies: [{ todoId: 'ui', dependsOn: 'schema' }]
      },
      'fallback'
    )!
    expect(withTodos.todos).toHaveLength(2)
    expect(withTodos.dependencies).toEqual([{ todoId: 'ui', dependsOn: 'schema' }])

    const completed = reducePlanEvent(
      withTodos,
      { type: 'result', ok: true, filesModified: [], ranDeploy: false },
      'fallback'
    )!
    expect(completed.phase).toBe('completed')
    expect(completed.todos.every((todo) => todo.status === 'done')).toBe(true)
  })

  it('keeps the revision number when draft-content events arrive before the next proposal', () => {
    const review = {
      ...createPlanArtifact('p1'),
      phase: 'review' as const,
      liveRequestId: 'request-1'
    }
    const revising = setPlanSubmitting(review, 'keep_planning', true)
    const drafting = reducePlanEvent(
      revising,
      { type: 'plan-content', content: '# Revised', operation: 'update' },
      'fallback'
    )!
    const proposed = reducePlanEvent(
      drafting,
      {
        type: 'plan-proposed',
        requestId: 'request-2',
        summary: 'Revised',
        planContent: '# Revised',
        actions: ['interactive'],
        recommendedAction: 'interactive'
      },
      'fallback'
    )!
    expect(proposed.revisionCount).toBe(1)
  })
})

describe('Plan persistence and recovery', () => {
  it('stores active review and execution without stale callback ids', () => {
    const review: ChatPlanArtifact = {
      ...createPlanArtifact('p1'),
      phase: 'review',
      liveRequestId: 'live'
    }
    expect(planForStorage(review, true)).toMatchObject({
      phase: 'interruptedReview',
      liveRequestId: undefined
    })
    expect(
      planForStorage({ ...review, phase: 'executing', selectedAction: 'interactive' }, true)
    ).toMatchObject({ phase: 'interruptedExecution', liveRequestId: undefined })
  })

  it('defensively converts legacy active phases during hydration', () => {
    const plan = planFromStorage({ ...createPlanArtifact('p1'), phase: 'drafting' })
    expect(plan?.phase).toBe('interruptedReview')
  })

  it('repairs stale todo statuses on a persisted completed plan', () => {
    const plan = planFromStorage({
      ...createPlanArtifact('p1'),
      phase: 'completed',
      todos: [
        { id: 'done', title: 'Done', status: 'done' },
        { id: 'stale', title: 'Stale', status: 'in_progress' }
      ]
    })
    expect(plan?.todos.every((todo) => todo.status === 'done')).toBe(true)
  })

  it('makes stale pending questions non-actionable and carries them into recovery context', () => {
    const live: ChatPlanArtifact = {
      ...createPlanArtifact('p1'),
      phase: 'clarifying',
      questions: [
        {
          id: 'question-1',
          question: 'Which database should this use?',
          choices: ['SQLite', 'PostgreSQL'],
          allowFreeform: true,
          state: 'pending'
        }
      ]
    }
    const stored = planForStorage(live, true)!
    expect(stored.questions[0].state).toBe('interrupted')

    const recovered = planFromStorage(stored)!
    const prompt = buildRecoveredPlanPrompt(recovered, 'Build durable storage', 'review')
    expect(prompt).toContain('Which database should this use?')
    expect(prompt).toContain('ask them again')
  })

  it('builds execution recovery from unfinished work without asking to redo completed todos', () => {
    const plan: ChatPlanArtifact = {
      ...createPlanArtifact('p1'),
      phase: 'interruptedExecution',
      selectedAction: 'autopilot_fleet',
      content: '# Plan\n\nImplement the feature.',
      todos: [
        { id: 'done', title: 'Finished migration', status: 'done' },
        { id: 'next', title: 'Wire the UI', status: 'pending' }
      ]
    }
    const prompt = buildRecoveredPlanPrompt(plan, 'Improve Plan mode', 'execute')
    expect(prompt).toContain('next: Wire the UI')
    expect(prompt).toContain('done: Finished migration')
    expect(prompt).toContain('do not redo')
    expect(prompt).toContain('parallel task agents')
  })
})

describe('Plan-mode suggestion heuristic', () => {
  it('does not suggest planning for a small cosmetic edit', () => {
    expect(shouldSuggestPlanMode('Change the button label to Save changes')).toBe(false)
  })

  it('suggests planning for a cross-cutting multi-step request', () => {
    expect(
      shouldSuggestPlanMode(
        [
          'Redesign authentication across the frontend and backend.',
          '1. Migrate the token storage and preserve backward compatibility.',
          '2. Refactor the API middleware.',
          '3. Update the React sign-in flow and add integration tests.'
        ].join('\n')
      )
    ).toBe(true)
  })
})
