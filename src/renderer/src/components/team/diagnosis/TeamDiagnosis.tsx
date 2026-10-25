import { useEffect, useRef, useState, type JSX } from 'react'
import type { TeamDiagnosisCheck } from '@shared/ipc'
import Markdown from '../../Markdown'
import { Codicon } from '../../icons'
import { StepList, type StepRow } from '../common'
import { sentDetails, useTeamDiagnosis, type DiagnosisInput, type DiagnosisState } from './useTeamDiagnosis'

interface Props {
  /** What failed. */
  input: DiagnosisInput
  /** Discards the last diagnosis when it changes (a new problem, a retry). */
  resetKey?: string
  /** Start right away (the button that opened it already asked). */
  autoStart?: boolean
  /** Hand the answer to the Build chat, offered when Copilot says the app's code needs the fix. */
  onFixInChat?: (answer: string) => void
}

function checkRows(checks: TeamDiagnosisCheck[]): StepRow[] {
  return checks.map((c) => ({ id: c.id, label: c.label, state: c.state === 'failed' ? 'error' : c.state }))
}

function checkSummary(checks: TeamDiagnosisCheck[]): string {
  const failed = checks.filter((c) => c.state === 'failed').length
  const ran = `${checks.length} read-only ${checks.length === 1 ? 'check' : 'checks'}`
  return failed ? `${ran} · ${failed} couldn’t complete` : ran
}

/** Everything that was sent to Copilot, so people can see (and copy) it. */
function SentDetails({ state }: { state: DiagnosisState }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const text = sentDetails(state)
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard can be unavailable; the text stays selectable */
    }
  }
  return (
    <details className="team-diagnosis-sent">
      <summary>Details sent to Copilot</summary>
      <pre className="team-diagnosis-sent-text">{text}</pre>
      <div>
        <button type="button" className="btn btn--sm" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy details'}
        </button>
      </div>
    </details>
  )
}

/**
 * "Diagnose with Copilot" for a failed team operation: read-only checks of
 * GitHub, Microsoft Entra ID and Fabric with the user's sign-ins, then a
 * streamed explanation of the likely cause and who can fix it.
 */
export default function TeamDiagnosis({ input, resetKey, autoStart, onFixInChat }: Props): JSX.Element {
  const { state, start, stop, reset } = useTeamDiagnosis()
  const inputRef = useRef(input)
  inputRef.current = input

  useEffect(() => {
    reset()
  }, [resetKey, reset])

  useEffect(() => {
    if (autoStart) start(inputRef.current)
  }, [autoStart, start])

  if (state.status === 'idle') {
    return (
      <div className="team-diagnosis-cta">
        <button type="button" className="btn btn--sm" onClick={() => start(inputRef.current)}>
          <Codicon name="sparkle" /> Diagnose with Copilot
        </button>
        <span className="team-muted">
          Copilot runs read-only checks with your sign-ins and explains what went wrong. It changes nothing.
        </span>
      </div>
    )
  }

  const running = state.status === 'running'
  const checking = state.checks.some((c) => c.state === 'running')
  const rows = checkRows(state.checks)
  return (
    <section className="team-diagnosis" aria-label="Diagnosis by Copilot" aria-busy={running}>
      <div className="team-diagnosis-head">
        <span className="team-diagnosis-title">
          <Codicon name="sparkle" /> {running ? 'Diagnosing…' : 'Diagnosis'}
        </span>
        {running ? (
          <button type="button" className="link-btn" onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="button" className="link-btn" onClick={() => start(inputRef.current)}>
            {state.status === 'error' ? 'Try again' : 'Diagnose again'}
          </button>
        )}
      </div>
      {rows.length > 0 &&
        (running && !state.text ? (
          <StepList rows={rows} />
        ) : (
          <details className="team-diagnosis-checks">
            <summary>{checkSummary(state.checks)}</summary>
            <StepList rows={rows} />
          </details>
        ))}
      {running && !checking && !state.text && (
        <p className="team-diagnosis-thinking" role="status">
          <span className="ws-spinner" aria-hidden="true" /> Copilot is looking into what the checks found…
        </p>
      )}
      {state.text && (
        <div className={`team-diagnosis-answer${running ? ' is-streaming' : ''}`}>
          <Markdown>{state.text}</Markdown>
        </div>
      )}
      {state.status === 'error' && (
        <div className="team-diagnosis-error" role="alert">
          {state.error}
        </div>
      )}
      {state.status === 'done' && state.conclusion?.fixInChat && onFixInChat && (
        <div>
          <button type="button" className="btn btn--sm btn--primary" onClick={() => onFixInChat(state.text)}>
            <Codicon name="sparkle" /> Fix with Copilot
          </button>
        </div>
      )}
      {state.status === 'done' && (
        <p className="team-diagnosis-by">Diagnosed by Copilot. It can be wrong, so check before you change settings.</p>
      )}
      {(state.context || state.checks.some((c) => c.detail)) && <SentDetails state={state} />}
    </section>
  )
}
