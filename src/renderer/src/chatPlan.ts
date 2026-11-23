import type {
  ChatEvent,
  ChatMode,
  ChatPlanArtifact,
  ChatPlanPhase,
  ChatPlanTodo
} from '@shared/ipc'
import { translator } from './i18n'

/** Whether `key` is one of `table`'s own keys (never one it inherits, like "constructor"). */
function own<T extends object>(table: T, key: PropertyKey): key is keyof T {
  return Object.prototype.hasOwnProperty.call(table, key)
}

/** The catalog keys (`plan` namespace) of the continuation actions' labels. */
export const PLAN_ACTION_LABELS = {
  interactive: 'actionLabels.interactive',
  autopilot: 'actionLabels.autopilot',
  autopilot_fleet: 'actionLabels.autopilotFleet',
  exit_only: 'actionLabels.exitOnly'
} as const satisfies Record<string, string>

export function planActionLabel(action: string): string {
  return own(PLAN_ACTION_LABELS, action)
    ? translator('plan')(PLAN_ACTION_LABELS[action])
    : action.replace(/_/g, ' ')
}

// A plan's own errors are saved with it in English, and shown in the interface's language.
const PLANNING_INCOMPLETE = 'Planning did not complete.'
const EXECUTION_INCOMPLETE = 'Plan execution did not complete.'
const PLAN_ERRORS = {
  [PLANNING_INCOMPLETE]: 'errors.planningIncomplete',
  [EXECUTION_INCOMPLETE]: 'errors.executionIncomplete'
} as const

/** A plan's error to show: its own in the interface's language, any other as it came. */
export function planErrorText(error: string): string {
  return own(PLAN_ERRORS, error) ? translator('plan')(PLAN_ERRORS[error]) : error
}

export function modeForPlanAction(action: string): ChatMode {
  return action === 'autopilot' || action === 'autopilot_fleet' ? 'autopilot' : 'agent'
}

export function createPlanArtifact(id: string): ChatPlanArtifact {
  return {
    id,
    phase: 'researching',
    summary: '',
    content: '',
    actions: [],
    recommendedAction: '',
    todos: [],
    dependencies: [],
    questions: []
  }
}

function phaseAfterQuestion(plan: ChatPlanArtifact): ChatPlanPhase {
  if (plan.liveRequestId) return 'review'
  if (plan.content) return 'drafting'
  return 'researching'
}

/** Apply one structural chat event to a durable Plan-mode artifact. */
export function reducePlanEvent(
  current: ChatPlanArtifact | undefined,
  event: ChatEvent,
  fallbackId: string
): ChatPlanArtifact | undefined {
  if (
    !current &&
    event.type !== 'plan-proposed' &&
    event.type !== 'plan-question'
  ) {
    return undefined
  }
  const plan = current ?? createPlanArtifact(fallbackId)

  switch (event.type) {
    case 'plan-content':
      return {
        ...plan,
        content: event.operation === 'delete' ? '' : event.content,
        phase: plan.phase === 'review' || plan.phase === 'executing' ? plan.phase : 'drafting',
        error: undefined
      }
    case 'plan-todos':
      return {
        ...plan,
        todos: event.todos,
        dependencies: event.dependencies
      }
    case 'plan-question': {
      const question = {
        id: event.requestId,
        question: event.question,
        choices: event.choices,
        allowFreeform: event.allowFreeform,
        state: 'pending' as const
      }
      const idx = plan.questions.findIndex((item) => item.id === event.requestId)
      const questions =
        idx < 0
          ? [...plan.questions, question]
          : plan.questions.map((item, i) => (i === idx ? question : item))
      return { ...plan, phase: 'clarifying', questions, error: undefined }
    }
    case 'plan-question-resolved':
      return {
        ...plan,
        phase: phaseAfterQuestion(plan),
        questions: plan.questions.map((question) =>
          question.id === event.requestId
            ? {
                ...question,
                state: 'answered' as const,
                answer: event.answer ?? question.answer
              }
            : question
        )
      }
    case 'plan-proposed':
      return {
        ...plan,
        phase: 'review',
        summary: event.summary,
        content: event.planContent || plan.content,
        actions: event.actions,
        recommendedAction: event.recommendedAction,
        liveRequestId: event.requestId,
        error: undefined
      }
    case 'plan-resolved':
      if (plan.liveRequestId !== event.requestId) return plan
      return { ...plan, liveRequestId: undefined }
    case 'error':
      return {
        ...plan,
        phase: 'failed',
        liveRequestId: undefined,
        error: event.text
      }
    case 'result':
      if (plan.phase !== 'executing' && plan.phase !== 'failed') {
        return event.ok
          ? { ...plan, liveRequestId: undefined }
          : {
              ...plan,
              phase: 'failed',
              liveRequestId: undefined,
              error: plan.error || PLANNING_INCOMPLETE
            }
      }
      return {
        ...plan,
        phase: event.ok ? 'completed' : 'failed',
        liveRequestId: undefined,
        todos: event.ok ? completedPlanTodos(plan.todos) : plan.todos,
        error: event.ok ? undefined : plan.error || EXECUTION_INCOMPLETE
      }
    default:
      return plan
  }
}

export function setPlanSubmitting(
  plan: ChatPlanArtifact,
  action: string,
  revising: boolean
): ChatPlanArtifact {
  return {
    ...plan,
    phase: revising ? 'revising' : 'executing',
    selectedAction: revising ? undefined : action,
    liveRequestId: undefined,
    revisionCount: revising ? (plan.revisionCount ?? 0) + 1 : plan.revisionCount,
    error: undefined
  }
}

/** Convert live-only phases and callback ids into a restart-safe stored artifact. */
export function planForStorage(
  plan: ChatPlanArtifact | undefined,
  turnPending: boolean
): ChatPlanArtifact | undefined {
  if (!plan) return undefined
  let phase = plan.phase
  if (turnPending) {
    phase =
      phase === 'executing' ? 'interruptedExecution' : phase === 'completed' ? phase : 'interruptedReview'
  }
  const todos = phase === 'completed' ? completedPlanTodos(plan.todos) : plan.todos
  return {
    ...plan,
    phase,
    liveRequestId: undefined,
    todos,
    questions: plan.questions.map((question) =>
      turnPending && question.state === 'pending'
        ? { ...question, state: 'interrupted' as const }
        : question
    )
  }
}

/** Defensively recover old persisted artifacts that still carry an active-only phase. */
export function planFromStorage(plan: ChatPlanArtifact | undefined): ChatPlanArtifact | undefined {
  if (!plan) return undefined
  const phase =
    plan.phase === 'executing'
      ? 'interruptedExecution'
      : ['researching', 'clarifying', 'drafting', 'review', 'revising'].includes(plan.phase)
        ? 'interruptedReview'
        : plan.phase
  const todos = phase === 'completed' ? completedPlanTodos(plan.todos ?? []) : (plan.todos ?? [])
  return {
    ...plan,
    phase,
    liveRequestId: undefined,
    todos,
    dependencies: plan.dependencies ?? [],
    questions: (plan.questions ?? []).map((question) =>
      question.state === 'pending' ? { ...question, state: 'interrupted' as const } : question
    ),
    actions: plan.actions ?? []
  }
}

export function planProgress(todos: ChatPlanTodo[]): {
  done: number
  total: number
  percent: number
} {
  const total = todos.length
  const done = todos.filter((todo) => todo.status === 'done').length
  return { done, total, percent: total ? Math.round((done / total) * 100) : 0 }
}

export function remainingPlanTodos(todos: ChatPlanTodo[]): ChatPlanTodo[] {
  return todos.filter((todo) => todo.status !== 'done')
}

export function completedPlanTodos(todos: ChatPlanTodo[]): ChatPlanTodo[] {
  if (todos.every((todo) => todo.status === 'done')) return todos
  return todos.map((todo) => ({ ...todo, status: 'done' }))
}

function renderTodo(todo: ChatPlanTodo): string {
  const detail = todo.description && todo.description !== todo.title ? ` — ${todo.description}` : ''
  return `- [${todo.status === 'done' ? 'x' : ' '}] ${todo.id}: ${todo.title}${detail} (${todo.status})`
}

export function buildRecoveredPlanPrompt(
  plan: ChatPlanArtifact,
  originalPrompt: string,
  kind: 'review' | 'execute' | 'revise',
  feedback?: string
): string {
  const remaining = remainingPlanTodos(plan.todos)
  const completed = plan.todos.filter((todo) => todo.status === 'done')
  const planBlock = plan.content.trim() || '(The prior turn ended before a complete plan was saved.)'
  const original = originalPrompt.trim() || '(Original request unavailable.)'
  const unanswered = plan.questions.filter((question) => question.state !== 'answered')
  const unansweredBlock = unanswered.length
    ? [
        '',
        'Clarifications that were still unanswered when the prior turn ended (ask them again if still needed):',
        ...unanswered.map((question) => `- ${question.question}`)
      ]
    : []
  const route =
    plan.selectedAction === 'autopilot_fleet'
      ? 'Use parallel task agents for independent work, matching the previously selected fleet route.'
      : plan.selectedAction === 'autopilot'
        ? 'Continue autonomously end to end, matching the previously selected Autopilot route.'
        : 'Continue interactively in the current agent turn.'

  if (kind === 'revise') {
    return [
      'Resume Plan mode for the interrupted planning task below.',
      'Treat the recovered plan as the current draft, incorporate the user feedback, update the session plan and todos, then present the revised plan for approval. Do not implement yet.',
      '',
      'Original request:',
      original,
      '',
      'Recovered plan:',
      planBlock,
      ...unansweredBlock,
      '',
      'User feedback:',
      feedback?.trim() || 'Review and improve the recovered plan.'
    ].join('\n')
  }

  if (kind === 'review' && !plan.content.trim()) {
    return [
      'Resume the interrupted Plan-mode turn for this request.',
      'Research the codebase as needed, create a complete plan and structured todos, then present it for approval. Do not implement yet.',
      '',
      'Original request:',
      original,
      ...unansweredBlock
    ].join('\n')
  }

  return [
    'Continue from the recovered, user-approved implementation plan below.',
    'The completed items are historical context only: do not redo them. Work only on pending, in-progress, or blocked items, honor their dependencies, keep todo statuses current, validate the result, and finish the task.',
    route,
    '',
    'Original request:',
    original,
    '',
    'Approved plan:',
    planBlock,
    ...unansweredBlock,
    '',
    'Remaining work:',
    ...(remaining.length ? remaining.map(renderTodo) : ['- No structured remaining todos were saved; inspect the plan and continue only unfinished work.']),
    '',
    'Already completed (do not repeat):',
    ...(completed.length ? completed.map(renderTodo) : ['- None recorded.'])
  ].join('\n')
}
