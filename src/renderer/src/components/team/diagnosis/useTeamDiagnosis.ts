import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  TeamDiagnoseRequest,
  TeamDiagnosisCheck,
  TeamDiagnosisConclusion,
  TeamDiagnosisEvent,
  TeamDiagnosisResult
} from '@shared/ipc'
import { translator } from '../../../i18n'
import { teamError } from '../common'

/** What to diagnose; the hook adds the id that routes its events. */
export type DiagnosisInput = Omit<TeamDiagnoseRequest, 'diagnosisId'>

export interface DiagnosisState {
  status: 'idle' | 'running' | 'done' | 'error'
  checks: TeamDiagnosisCheck[]
  /** The streamed, then final, Markdown answer. */
  text: string
  /** What was sent to Copilot about the failure. */
  context: string
  conclusion?: TeamDiagnosisConclusion
  error?: string
}

export const IDLE_DIAGNOSIS: DiagnosisState = { status: 'idle', checks: [], text: '', context: '' }

/** Fold one streamed event into the state. */
export function applyDiagnosisEvent(state: DiagnosisState, event: TeamDiagnosisEvent): DiagnosisState {
  switch (event.type) {
    case 'context':
      return { ...state, context: event.text }
    case 'check': {
      const known = state.checks.some((c) => c.id === event.check.id)
      const checks = known
        ? state.checks.map((c) => (c.id === event.check.id ? event.check : c))
        : [...state.checks, event.check]
      return { ...state, checks }
    }
    case 'delta':
      return { ...state, text: event.reset ? '' : state.text + event.text }
    case 'conclusion':
      return { ...state, conclusion: event.conclusion }
    default:
      return state
  }
}

/** The final state from the command's result (authoritative over the stream). */
export function finishDiagnosis(current: DiagnosisState, result: TeamDiagnosisResult): DiagnosisState {
  return {
    status: result.ok ? 'done' : 'error',
    checks: result.checks.length ? result.checks : current.checks,
    text: result.ok ? result.text : '',
    context: result.context || current.context,
    conclusion: result.conclusion ?? current.conclusion,
    error: result.ok ? undefined : (result.error ?? translator('team')('diagnosis.failed'))
  }
}

/** Everything sent to Copilot: the context, then each check's findings. */
export function sentDetails(state: DiagnosisState): string {
  const parts = [state.context.trim()]
  for (const check of state.checks) {
    if (check.detail) parts.push(`### ${check.label}\n${check.detail}`)
  }
  return parts.filter(Boolean).join('\n\n')
}

/** The Build chat request that hands a diagnosed pipeline failure to Copilot. */
export function fixInChatPrompt(answer: string): string {
  return [
    'The team pipeline couldn’t deploy this app. Here’s the diagnosis of the failed run:',
    '',
    answer.trim(),
    '',
    'Fix the cause in this app’s code or configuration, then explain what you changed. Fabricator saves your change and the pipeline deploys it again.'
  ].join('\n')
}

/**
 * Run one "Diagnose with Copilot" at a time and follow its streamed checks and
 * answer. Unmounting stops a diagnosis that's still running.
 */
export function useTeamDiagnosis(): {
  state: DiagnosisState
  start: (input: DiagnosisInput) => void
  stop: () => void
  reset: () => void
} {
  const [state, setState] = useState<DiagnosisState>(IDLE_DIAGNOSIS)
  const idRef = useRef<string | null>(null)

  useEffect(() => {
    const off = window.api.team.onDiagnosis((envelope) => {
      if (envelope.diagnosisId !== idRef.current) return
      setState((current) => applyDiagnosisEvent(current, envelope.event))
    })
    return () => {
      off()
      if (idRef.current) void window.api.team.cancel(idRef.current)
      idRef.current = null
    }
  }, [])

  const start = useCallback((input: DiagnosisInput) => {
    if (idRef.current) void window.api.team.cancel(idRef.current)
    const id = `team-diagnosis-${crypto.randomUUID()}`
    idRef.current = id
    setState({ ...IDLE_DIAGNOSIS, status: 'running' })
    window.api.team
      .diagnose({ ...input, diagnosisId: id })
      .then((result) => {
        if (idRef.current !== id) return
        idRef.current = null
        setState((current) => finishDiagnosis(current, result))
      })
      .catch((reason: unknown) => {
        if (idRef.current !== id) return
        idRef.current = null
        setState((current) => ({
          ...current,
          status: 'error',
          text: '',
          error: teamError(reason, translator('team')('diagnosis.failed'))
        }))
      })
  }, [])

  const stop = useCallback(() => {
    if (idRef.current) void window.api.team.cancel(idRef.current)
  }, [])

  const reset = useCallback(() => {
    if (idRef.current) void window.api.team.cancel(idRef.current)
    idRef.current = null
    setState(IDLE_DIAGNOSIS)
  }, [])

  return { state, start, stop, reset }
}
