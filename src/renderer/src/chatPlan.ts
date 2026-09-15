import type {
  ChatEvent,
  ChatMode,
  ChatPlanArtifact,
  ChatPlanPhase,
  ChatPlanTodo
} from '@shared/ipc'

const COMPLEX_CUES =
  /\b(architect(?:ure|ural)?|redesign|refactor|restructure|migrat(?:e|ion)|overhaul|end[- ]to[- ]end|cross[- ]cutting|multi[- ](?:file|step|phase)|rollout|backward compatib|data model|state machine|authentication|authorization|performance|accessibility)\b/i
const SIMPLE_CUES =
  /^\s*(?:fix|change|rename|remove|add|update)\s+(?:the\s+)?(?:typo|label|text|color|icon|title|comment)\b/i
const FILE_REF = /(?:^|\s)(?:[\w.-]+[\\/])+\w[\w.-]*|\b[\w.-]+\.(?:ts|tsx|js|jsx|rs|css|json|yml|yaml|md)\b/g
const ACTION_CUE =
  /\b(add|build|change|create|design|fix|implement|integrate|migrate|move|refactor|remove|replace|test|update|wire)\b/gi

export const PLAN_ACTION_LABELS: Record<string, string> = {
  interactive: 'Build plan',
  autopilot: 'Run in Autopilot',
  autopilot_fleet: 'Run with fleet',
  exit_only: 'Approve plan'
}

function chatModeKey(projectId: string): string {
  return `rayfin.chatMode.${projectId}`
}

export function readChatMode(projectId: string): ChatMode {
  try {
    const stored = localStorage.getItem(chatModeKey(projectId))
    return stored === 'plan' || stored === 'autopilot' ? stored : 'agent'
  } catch {
    return 'agent'
  }
}

export function writeChatMode(projectId: string, mode: ChatMode): void {
  try {
    localStorage.setItem(chatModeKey(projectId), mode)
  } catch {
    // Storage is optional; the current in-memory mode remains usable.
  }
}

export function planActionLabel(action: string): string {
  return PLAN_ACTION_LABELS[action] ?? action.replace(/_/g, ' ')
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
              error: plan.error || 'Planning did not complete.'
            }
      }
      return {
        ...plan,
        phase: event.ok ? 'completed' : 'failed',
        liveRequestId: undefined,
        todos: event.ok ? completedPlanTodos(plan.todos) : plan.todos,
        error: event.ok ? undefined : plan.error || 'Plan execution did not complete.'
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

/**
 * Deterministic local complexity score. It intentionally favors precision over
 * recall so a Plan suggestion feels helpful rather than appearing on every prompt.
 */
export function planPromptComplexity(text: string): number {
  const value = text.trim()
  if (!value || value.length < 45 || SIMPLE_CUES.test(value)) return 0

  let score = 0
  if (value.length >= 140) score += 1
  if (value.length >= 320) score += 1
  if (COMPLEX_CUES.test(value)) score += 2

  const lines = value.split(/\r?\n/).filter((line) => line.trim())
  const listItems = lines.filter((line) => /^\s*(?:[-*]|\d+[.)])\s+/.test(line)).length
  if (listItems >= 2 || lines.length >= 4) score += 2

  const files = new Set(value.match(FILE_REF) ?? [])
  if (files.size >= 2) score += 1

  const actions = new Set((value.match(ACTION_CUE) ?? []).map((word) => word.toLowerCase()))
  if (actions.size >= 3) score += 1

  if (/\b(frontend|renderer|client)\b/i.test(value) && /\b(backend|server|api|database)\b/i.test(value)) {
    score += 1
  }
  return score
}

export function shouldSuggestPlanMode(text: string): boolean {
  return planPromptComplexity(text) >= 3
}
