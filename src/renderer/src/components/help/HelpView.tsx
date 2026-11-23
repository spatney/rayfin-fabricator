import { Fragment, useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { HelpAction, HelpGrounding, HelpIssueDraft } from '@shared/ipc'
import { useTranslation } from '../../i18n'
import { Codicon } from '../icons'
import { topLayerOpen, useSuppressPreview } from '../../overlay'
import { useToast } from '../../toast'
import { openDocs } from '../../docsLinks'
import { reportThrown } from '../../errorReport'
import { HelpComposer } from './HelpComposer'
import { HelpRayAvatar, TypedLine } from './HelpRay'
import { ExchangeView } from './HelpExchange'
import { useHelpConversation } from './HelpConversation'
import { PROMPTS, promptText, Spinner } from './parts'
import { describeWhen } from './history'
import { helpGreeting } from '../mascot/lines'
import './help.css'

export type { Exchange } from './conversation'

export interface HelpViewProps {
  onClose: () => void
  /** The project the user is working in, attached automatically for context. */
  projectId?: string
  projectName?: string
  /** Runs one of the assistant's offered actions. */
  onAction: (action: HelpAction) => void
  /** Opens a prefilled GitHub bug report from the assistant's draft. */
  onReportIssue: (issue: HelpIssueDraft) => void
  /**
   * What is true right now — accounts, tool readiness, the open project. The
   * journal records what happened over time; these say where things stand, so
   * the assistant can tell a problem the user already fixed from a live one.
   */
  facts?: string[]
  /**
   * Which screen Help was opened from. Sent so the assistant never offers a
   * button that can't do anything from there — "Open my projects" while the
   * project list is already on screen, or any of them during setup.
   */
  surface?: 'setup' | 'home' | 'project'
  appVersion?: string
  /**
   * A question to ask as soon as Help opens, such as "Why did my last publish
   * fail?" from a failed publish. It's asked once, after any saved conversation
   * has been restored, so it follows on from that rather than replacing it.
   */
  initialQuestion?: string
  /**
   * Opened to carry on a conversation from Search, so what was just asked
   * there reads as part of now rather than as an earlier thread picked up again.
   */
  continuing?: boolean
}

/**
 * The Help assistant: a full-screen, terminal-style overlay that debugs the
 * user's problem from the activity journal, the docs and Fabricator's own source.
 *
 * Deliberately spare — one column, one prompt, monospace chrome — so it reads as
 * a tool rather than a second chat. Motion is limited to the caret, the working
 * spinner and a short entrance; everything else is flat per the app's design.
 *
 * The conversation itself is shared with Search (see ./conversation), so this
 * view only shows it and adds to it.
 */
export function HelpView({
  onClose,
  projectId,
  projectName,
  onAction,
  onReportIssue,
  facts,
  surface,
  appVersion,
  initialQuestion,
  continuing
}: HelpViewProps): JSX.Element {
  const { t } = useTranslation('help')
  const toast = useToast()
  useSuppressPreview()
  const [conversation, { exchanges, busy, historyReady, resumedAt, grounding, preparing }] =
    useHelpConversation()

  /** `initialQuestion` has been asked. */
  const [askedInitial, setAskedInitial] = useState(false)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  /** Pinned to the bottom unless the user scrolled up to read. */
  const stick = useRef(true)

  /* ----------------------------- history ----------------------------- */

  // Restore the conversation on open. Help is where you come back to after
  // trying a fix — including after restarting the app, which is itself a fix —
  // so the thread outlives both the overlay and the process. Coming back marks
  // what was said before as earlier, unless this carries on from Search.
  const continuingRef = useRef(continuing)
  useEffect(() => {
    void conversation.load().then(() => {
      if (!continuingRef.current) conversation.resume()
    })
  }, [conversation])

  /* ----------------------------- grounding ----------------------------- */

  useEffect(() => {
    void conversation.checkGrounding()
  }, [conversation])

  const refreshGrounding = useCallback(async (): Promise<void> => {
    try {
      await conversation.refreshGrounding()
      toast.success(t('view.refreshed'))
    } catch (reason) {
      toast.error(reportThrown(reason, { operation: 'help_prepare', area: 'app' }), {
        title: t('view.refreshFailed'),
        record: false
      })
    }
  }, [conversation, toast, t])

  /* ----------------------------- asking ----------------------------- */

  const ask = useCallback(
    (question: string, attachments: string[]): Promise<void> => {
      stick.current = true
      return conversation.ask(question, attachments, { projectId, facts, surface })
    },
    [conversation, facts, projectId, surface]
  )

  const stop = useCallback((): void => conversation.stop(), [conversation])

  // Ask what Help was opened to ask, once the saved conversation is back, so
  // the restore can't replace it and the earlier turns are replayed with it.
  // The ref is the guard: another render can land before the state update does.
  const askedInitialRef = useRef(false)
  useEffect(() => {
    const question = initialQuestion?.trim()
    if (!historyReady || !question || askedInitialRef.current) return
    askedInitialRef.current = true
    setAskedInitial(true)
    // A starter question is asked in the user's language.
    void ask(promptText(question), [])
  }, [historyReady, initialQuestion, ask])

  /* ----------------------------- chrome ----------------------------- */

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      // Another dialog on top owns Escape first.
      if (topLayerOpen()) return
      if (busy) stop()
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose, stop])

  // Follow the stream, but yield to a user who has scrolled up to read.
  useEffect(() => {
    const el = scrollRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [exchanges])

  const onScroll = useCallback((): void => {
    const el = scrollRef.current
    if (!el) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }, [])

  // While a question Help was opened to ask is on its way, the starter
  // questions would only flash up and vanish.
  const empty = exchanges.length === 0 && !(initialQuestion?.trim() && !askedInitial)

  return (
    <div className="help" role="dialog" aria-modal="true" aria-label={t('title')}>
      <header className="help-bar">
        <span className="help-bar-id">
          <Codicon name="terminal" />
          fabricator&nbsp;help
        </span>
        <GroundingBadge grounding={grounding} preparing={preparing} onRefresh={refreshGrounding} />
        <span className="help-bar-spacer" />
        {projectName && (
          <span className="help-bar-ctx" title={t('view.projectTitle', { project: projectName })}>
            <Codicon name="folder" />
            {projectName}
          </span>
        )}
        {!empty && (
          <button
            className="help-bar-new"
            onClick={() => conversation.startNew()}
            title={t('view.newTitle')}
          >
            <Codicon name="add" />
            {t('view.new')}
          </button>
        )}
        {/* The escape hatch for someone who wants to read rather than ask.
            Kept in the bar, not just the welcome screen, so it stays reachable
            mid-conversation. */}
        <button
          className="help-bar-new"
          onClick={() => openDocs('home')}
          title={t('view.docsTitle')}
        >
          <Codicon name="book" />
          {t('view.docs')}
        </button>
        <button className="help-bar-close" onClick={onClose} title={t('view.close')}>
          <Codicon name="close" />
        </button>
      </header>

      <div className="help-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="help-col">
          {empty ? (
            <Welcome appVersion={appVersion} onPick={(text) => void ask(text, [])} />
          ) : (
            exchanges.map((item, i) => (
              <Fragment key={item.id}>
                {/* The point where an older conversation was picked up. */}
                {resumedAt && item.restored && i === 0 && (
                  <p className="help-resumed">
                    <Codicon name="history" />
                    {t('view.resumed', { when: describeWhen(resumedAt) })}
                  </p>
                )}
                {resumedAt && !item.restored && exchanges[i - 1]?.restored && (
                  <p className="help-resumed help-resumed--now">
                    <Codicon name="arrow-down" />
                    {t('view.now')}
                  </p>
                )}
                <ExchangeView
                  exchange={item}
                  onAction={onAction}
                  onReportIssue={onReportIssue}
                />
              </Fragment>
            ))
          )}
        </div>
      </div>

      <HelpComposer busy={busy} onAsk={ask} onStop={stop} />
    </div>
  )
}

/* ----------------------------- pieces ----------------------------- */

function GroundingBadge({
  grounding,
  preparing,
  onRefresh
}: {
  grounding: HelpGrounding | null
  preparing: boolean
  onRefresh: () => Promise<void>
}): JSX.Element | null {
  const { t } = useTranslation('help')
  if (preparing) {
    return (
      <span className="help-ground help-ground--busy">
        <Spinner />
        {t('grounding.reading')}
      </span>
    )
  }
  if (!grounding) return null

  const both = grounding.sourceReady && grounding.docsReady
  const label = both
    ? grounding.pinned && grounding.reference
      ? grounding.reference
      : t('grounding.ready')
    : grounding.docsReady
      ? t('grounding.docsOnly')
      : t('grounding.logsOnly')
  const title = both
    ? grounding.pinned
      ? t('grounding.pinnedTitle', { reference: grounding.reference })
      : t('grounding.latestTitle')
    : grounding.docsReady
      ? t('grounding.docsOnlyTitle')
      : t('grounding.logsOnlyTitle')

  return (
    <button
      className={`help-ground ${both ? 'help-ground--ok' : 'help-ground--partial'}`}
      title={title}
      onClick={() => void onRefresh()}
    >
      <span className="help-dot" aria-hidden="true" />
      {label}
    </button>
  )
}

/**
 * The empty state. Its host — Ray, or the Fabricator mark when he's turned
 * off — sits on the left; the greeting, the starter questions and the version
 * all share one text edge on the right.
 */
function Welcome({
  appVersion,
  onPick
}: {
  appVersion?: string
  onPick: (text: string) => void
}): JSX.Element {
  const { t } = useTranslation('help')
  // Ray's greeting goes by the time Help opened, in whatever language it's shown in.
  const [openedAt] = useState(() => new Date())
  const greeting = helpGreeting(openedAt)
  return (
    <div className="help-welcome">
      <div className="help-hello-host">
        <HelpRayAvatar />
      </div>
      <div className="help-hello-text">
        <h2 className="help-hello-title">
          <TypedLine text={greeting} />
        </h2>
        <p className="help-hello-lead">{t('welcome.lead')}</p>
        <ul className="help-prompts">
          {PROMPTS.map((prompt, i) => (
            <li key={prompt} style={{ animationDelay: `${90 + i * 55}ms` }}>
              <button onClick={() => onPick(promptText(prompt))}>
                <Codicon name="chevron-right" />
                {promptText(prompt)}
              </button>
            </li>
          ))}
        </ul>
        <p className="help-hello-meta">{t('welcome.meta', { version: appVersion ?? '\u2014' })}</p>
      </div>
    </div>
  )
}
