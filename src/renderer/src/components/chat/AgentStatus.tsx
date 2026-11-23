import { useEffect, useRef, useState, type JSX } from 'react'
import { translator, useTranslation } from '../../i18n'
import { Codicon } from '../icons'
import { isHiddenTool, phaseLabel } from './toolPresentation'
import type { UIChatMessage } from './types'

/** What the turn is doing right now, in a few plain words. */
export function livePhase(m: UIChatMessage): string {
  const t = translator('chat')
  // Subagents still working, such as an explore agent, by name.
  const agents = m.tools.flatMap((tool) =>
    tool.agent?.state === 'running' ? [tool.agent.name] : []
  )
  const running = m.tools.find((tool) => tool.state === 'running' && !isHiddenTool(tool.name))
  if (running) {
    if (agents.length === 1 && running.name.toLowerCase() === 'read_agent') {
      return t('agentStatus.waitingFor', { agent: agents[0] })
    }
    return phaseLabel(running.name, running.server)
  }
  if (agents.length > 0)
    return t('agentStatus.agentsWorking', { count: agents.length, agents: agents.join(', ') })
  const last = m.segments?.[m.segments.length - 1]
  if (last?.kind === 'reasoning') return t('agentStatus.thinking')
  if (last?.kind === 'text' && last.text.trim()) return t('agentStatus.writing')
  if (m.tools.length > 0) return t('agentStatus.working')
  return t('agentStatus.thinking')
}

/**
 * Live status line at the bottom of an assistant turn while it streams: a small
 * orb, what's happening now, and a ticking timer. When the turn is waiting on
 * the user (a plan decision or a question) it switches to a calm "waiting"
 * state with no timer or work motion, so it never looks like it's still working.
 */
export function AgentStatus({
  message,
  notice,
  awaitingDecision,
  startedAt
}: {
  message: UIChatMessage
  notice?: string
  awaitingDecision?: boolean
  startedAt?: number
}): JSX.Element {
  const { t } = useTranslation('chat')
  // Anchor the timer to the turn's real start time (persisted on the message),
  // not this component's mount time — otherwise remounting (e.g. switching away
  // from and back to the chat tab) would reset the elapsed counter to 0.
  const startRef = useRef(startedAt ?? Date.now())
  const [elapsed, setElapsed] = useState(() =>
    Math.max(0, Math.floor((Date.now() - startRef.current) / 1000))
  )
  useEffect(() => {
    if (startedAt != null) startRef.current = startedAt
    const tick = (): void =>
      setElapsed(Math.max(0, Math.floor((Date.now() - startRef.current) / 1000)))
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [startedAt])

  const awaitingAnswer = message.questions?.some((q) => q.state === 'pending') ?? false
  if (awaitingDecision || awaitingAnswer) {
    return (
      <div className="agent-status agent-status--await" role="status" aria-live="polite">
        <span className="agent-status-await-dot" aria-hidden="true" />
        <span className="agent-status-await-label">
          {awaitingDecision ? t('agentStatus.waitingDecision') : t('agentStatus.waitingAnswer')}
        </span>
      </div>
    )
  }

  const mm = Math.floor(elapsed / 60)
  const ss = String(elapsed % 60).padStart(2, '0')

  return (
    <div className={`agent-status${notice ? ' agent-status--notice' : ''}`}>
      <span className="agent-status-orb" aria-hidden="true">
        <span className="agent-status-orb-core" />
      </span>
      <span className="agent-status-label" role="status" aria-live="polite">
        {notice ? (
          <>
            <Codicon name="refresh" /> {notice}
          </>
        ) : (
          `${livePhase(message)}…`
        )}
      </span>
      <span className="agent-status-time" aria-hidden="true">
        {mm}:{ss}
      </span>
    </div>
  )
}
