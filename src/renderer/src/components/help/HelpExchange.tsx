import { useState, type JSX } from 'react'
import type { HelpAction, HelpIssueDraft } from '@shared/ipc'
import Markdown from '../Markdown'
import { Codicon } from '../icons'
import type { Exchange } from './conversation'
import { HelpWorkLog } from './HelpWorkLog'
import { HelpRayThinking } from './HelpRay'

/** One question and its answer, in the full-screen Help transcript. */
export function ExchangeView({
  exchange,
  onAction,
  onReportIssue
}: {
  exchange: Exchange
  onAction: (action: HelpAction) => void
  onReportIssue: (issue: HelpIssueDraft) => void
}): JSX.Element {
  return (
    <article className="help-x">
      <div className="help-q">
        <span className="help-q-caret" aria-hidden="true">
          &gt;
        </span>
        <div className="help-q-body">
          <p>{exchange.question}</p>
          {exchange.attachments.length > 0 && (
            <ul className="help-q-files">
              {exchange.attachments.map((path) => (
                <li key={path} title={path}>
                  <Codicon name="file" />
                  {path.split(/[\\/]/).pop()}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <ExchangeAnswer exchange={exchange} onAction={onAction} onReportIssue={onReportIssue} />
    </article>
  )
}

/**
 * What Help did and said for a question: its work, the answer as it arrives, the
 * steps it offers and where it looked. Help's transcript and Search both show it.
 */
export function ExchangeAnswer({
  exchange,
  onAction,
  onReportIssue
}: {
  exchange: Exchange
  onAction: (action: HelpAction) => void
  onReportIssue: (issue: HelpIssueDraft) => void
}): JSX.Element {
  const { status } = exchange
  const working = status === 'thinking' || status === 'streaming'

  return (
    <>
      {exchange.tools.length > 0 && <HelpWorkLog tools={exchange.tools} working={working} />}

      {status === 'thinking' && !exchange.answer && <HelpRayThinking />}

      {exchange.answer && (
        <div className={`help-a ${status === 'streaming' ? 'is-streaming' : ''}`}>
          <Markdown>{exchange.answer}</Markdown>
        </div>
      )}

      {exchange.actions.length > 0 && status !== 'thinking' && (
        <div className="help-actions">
          {exchange.actions.map((action, i) => (
            <button
              key={`${action.id}:${action.url ?? action.target ?? ''}`}
              // One suggested step per answer, so the recommended move is
              // unambiguous; the rest are offered as alternatives.
              className={`help-action ${i === 0 ? 'is-primary' : ''}`}
              onClick={() => onAction(action)}
            >
              <Codicon name={actionIcon(action.id)} className="help-action-icon" />
              <span className="help-action-label">{action.label}</span>
              <Codicon name="arrow-right" className="help-action-go" />
            </button>
          ))}
        </div>
      )}

      {exchange.issue && status !== 'thinking' && (
        <IssueDraftCard issue={exchange.issue} onReport={() => onReportIssue(exchange.issue!)} />
      )}

      {exchange.citations.length > 0 && (
        <ul className="help-cites">
          {exchange.citations.map((cite) => (
            <li key={cite.url}>
              <button onClick={() => void window.api.openExternal(cite.url)}>
                <Codicon name="book" />
                {cite.title}
              </button>
            </li>
          ))}
        </ul>
      )}

      {status === 'error' && (
        <p className="help-err">
          <Codicon name="error" />
          {exchange.error}
        </p>
      )}
      {status === 'stopped' && <p className="help-stopped">Stopped.</p>}
      {status === 'done' && exchange.elapsedMs !== undefined && (
        <p className="help-meta">{formatElapsed(exchange.elapsedMs)}</p>
      )}
    </>
  )
}

/** The glyph for each offered action, so a button reads before it is read. */
export function actionIcon(id: HelpAction['id']): string {
  switch (id) {
    case 'open-docs':
      return 'book'
    case 'open-project':
      return 'rocket'
    case 'open-home':
      return 'list-unordered'
    case 'share-app':
      return 'link'
    case 'open-team-access':
      return 'organization'
    case 'open-advisor':
      return 'shield'
    case 'open-code':
      return 'code'
    case 'run-doctor':
      return 'checklist'
    case 'refresh-fabric-auth':
    case 'sign-in-copilot':
      return 'key'
    case 'export-diagnostics':
      return 'save'
    case 'open-logs':
      return 'folder-opened'
    case 'report-issue':
      return 'bug'
    case 'open-settings':
      return 'settings-gear'
    case 'open-accounts':
      return 'account'
    default:
      return 'arrow-right'
  }
}

/**
 * A bug report the assistant wrote. Shown collapsed with the title visible, so
 * the user can see it exists without the answer turning into a wall of text,
 * and can read the whole thing before anything is sent anywhere.
 */
export function IssueDraftCard({
  issue,
  onReport
}: {
  issue: HelpIssueDraft
  onReport: () => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const feature = issue.kind === 'feature'
  return (
    <div className={`help-issue ${open ? 'is-open' : ''}`}>
      <div className="help-issue-head">
        <Codicon
          name={feature ? 'lightbulb' : 'bug'}
          className={`help-issue-icon ${feature ? 'is-feature' : ''}`}
        />
        <div className="help-issue-id">
          <span className="help-issue-kind">
            {feature ? 'Feature request ready' : 'Bug report ready'}
          </span>
          <span className="help-issue-title">{issue.title}</span>
        </div>
      </div>
      {open && (
        <div className="help-issue-body">
          <Markdown>{issue.body}</Markdown>
          <p className="help-issue-note">
            {feature
              ? 'Review it on GitHub before you submit.'
              : 'Your Fabricator version, system details and a diagnostics file are added when you report it. Review everything on GitHub before you submit.'}
          </p>
        </div>
      )}
      <div className="help-issue-actions">
        <button className="help-action is-primary" onClick={onReport}>
          <Codicon name="github" className="help-action-icon" />
          <span className="help-action-label">
            {feature ? 'Suggest this on GitHub' : 'Report this on GitHub'}
          </span>
          <Codicon name="link-external" className="help-action-go" />
        </button>
        <button className="help-issue-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide' : 'Review it first'}
        </button>
      </div>
    </div>
  )
}

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)} s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${Math.round(seconds % 60)}s`
}
