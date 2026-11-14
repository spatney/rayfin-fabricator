import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ChatToolCall,
  SecurityAreaId,
  SecurityAreaResult,
  SecurityEvent,
  SecurityFinding,
  SecurityReport
} from '@shared/ipc'
import { errorMessage } from '../../errorReport'
import { translator } from '../../i18n'

/** What's being checked: a project to import, or an app to install. */
export type SecurityCheckKind = 'project' | 'app'

/** What a running check has shown so far. */
export interface SecurityProgress {
  startedAt: number
  /** Where the file is unpacked, once it is: Copilot's steps name files in it. */
  root: string | null
  files: number | null
  areas: SecurityAreaId[]
  results: Partial<Record<SecurityAreaId, SecurityAreaResult>>
  findings: SecurityFinding[]
  activity: ChatToolCall[]
  summary: string | null
}

export type SecurityCheckState =
  | { phase: 'idle' }
  | { phase: 'running'; progress: SecurityProgress }
  | { phase: 'done'; progress: SecurityProgress; report: SecurityReport }

export interface SecurityCheck {
  state: SecurityCheckState
  /** Check the file, or check it again. */
  start: () => void
  /** Stop a check that's running; it ends with what it found so far. */
  stop: () => void
}

/** The areas a check covers: an app isn't built with Copilot, so it has no instructions for it. */
export function areasFor(kind: SecurityCheckKind): SecurityAreaId[] {
  const all: SecurityAreaId[] = ['install', 'packages', 'network', 'hidden', 'system', 'agents']
  return kind === 'project' ? all : all.filter((area) => area !== 'agents')
}

let checks = 0

function newCheckId(): string {
  checks += 1
  return `check-${Date.now().toString(36)}-${checks}`
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const at = list.findIndex((x) => x.id === item.id)
  if (at < 0) return [...list, item]
  const next = list.slice()
  next[at] = item
  return next
}

function apply(progress: SecurityProgress, event: SecurityEvent): SecurityProgress {
  switch (event.type) {
    case 'started':
      return { ...progress, root: event.root, files: event.files, areas: event.areas }
    case 'activity':
      return { ...progress, activity: upsert(progress.activity, event.tool) }
    case 'finding':
      return { ...progress, findings: upsert(progress.findings, event.finding) }
    case 'areas': {
      const results = { ...progress.results }
      for (const result of event.results) results[result.area] = result
      return { ...progress, results }
    }
    case 'summary':
      return { ...progress, summary: event.text }
  }
}

/**
 * Check the file at `path` for security risks, at the user's choice: Fabricator's
 * own checks, then Copilot's review on Auto, streamed as they go. A check
 * still running when the dialog closes is stopped.
 */
export function useSecurityCheck(path: string, kind: SecurityCheckKind): SecurityCheck {
  const [state, setState] = useState<SecurityCheckState>({ phase: 'idle' })
  const running = useRef<string | null>(null)
  const unsubscribe = useRef<(() => void) | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      unsubscribe.current?.()
      unsubscribe.current = null
      const id = running.current
      running.current = null
      if (id) void window.api.security.cancel(id).catch(() => {})
    }
  }, [])

  // Another file (an app's window opened again with another version): what
  // was found was about the last one.
  const checkedPath = useRef<string | null>(null)
  useEffect(() => {
    if (checkedPath.current === null || checkedPath.current === path) return
    checkedPath.current = null
    unsubscribe.current?.()
    unsubscribe.current = null
    const id = running.current
    running.current = null
    if (id) void window.api.security.cancel(id).catch(() => {})
    setState({ phase: 'idle' })
  }, [path])

  const start = useCallback(() => {
    if (running.current || !path) return
    const id = newCheckId()
    running.current = id
    checkedPath.current = path
    const progress: SecurityProgress = {
      startedAt: Date.now(),
      root: null,
      files: null,
      areas: areasFor(kind),
      results: {},
      findings: [],
      activity: [],
      summary: null
    }
    setState({ phase: 'running', progress })
    unsubscribe.current?.()
    unsubscribe.current = window.api.security.onEvent(({ checkId, event }) => {
      if (checkId !== id || running.current !== id) return
      setState((now) =>
        now.phase === 'running' ? { phase: 'running', progress: apply(now.progress, event) } : now
      )
    })
    const finish = (report: SecurityReport): void => {
      if (running.current !== id) return
      running.current = null
      unsubscribe.current?.()
      unsubscribe.current = null
      if (!mounted.current) return
      setState((now) => ({
        phase: 'done',
        progress: now.phase === 'running' ? now.progress : progress,
        report
      }))
    }
    window.api.security.check(id, path).then(finish, (reason) =>
      finish({
        ok: false,
        verdict: 'clear',
        summary: '',
        findings: [],
        areas: [],
        files: 0,
        readable: 0,
        durationMs: Date.now() - progress.startedAt,
        error: errorMessage(reason, translator('security')('errors.cantCheck'))
      })
    )
  }, [path, kind])

  const stop = useCallback(() => {
    const id = running.current
    if (id) void window.api.security.cancel(id).catch(() => {})
  }, [])

  return { state, start, stop }
}
