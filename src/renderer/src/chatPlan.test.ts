import { afterEach, describe, expect, it } from 'vitest'
import type { ChatPlanArtifact } from '@shared/ipc'
import {
  buildRecoveredPlanPrompt,
  createPlanArtifact,
  planActionLabel,
  planErrorText,
  planForStorage,
  planFromStorage,
  reducePlanEvent,
  setPlanSubmitting
} from './chatPlan'
import { setLanguage } from './i18n'

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

describe('Plan text in other languages', () => {
  afterEach(async () => {
    await setLanguage('en')
    localStorage.clear()
  })

  it('keeps its own errors stored in English and shows them in the interface language', async () => {
    const failed = reducePlanEvent(
      createPlanArtifact('p1'),
      { type: 'result', ok: false, filesModified: [], ranDeploy: false },
      'fallback'
    )!
    expect(failed.error).toBe('Planning did not complete.')
    expect(planErrorText(failed.error!)).toBe('Planning did not complete.')

    await setLanguage('de')
    expect(failed.error).toBe('Planning did not complete.')
    expect(planErrorText(failed.error!)).toBe('Die Planung wurde nicht abgeschlossen.')
    expect(planErrorText('Permission denied')).toBe('Permission denied')
    expect(planActionLabel('autopilot_fleet')).toBe('Mit Flotte ausführen')
    expect(planActionLabel('keep_planning')).toBe('keep planning')
  })
})
