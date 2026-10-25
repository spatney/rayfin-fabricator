import { useEffect, useRef, useState, type JSX } from 'react'
import { normalizeSeverity, ruleById } from '@shared/advisor/catalog'
import type { AdvisorDismissReason } from '@shared/ipc'
import type { FindingItem } from '../../advisor/lifecycle'
import type { ExplainState } from '../../advisor/store'
import Markdown, { MarkdownLinksContext, type MarkdownLinks } from '../Markdown'
import { Codicon } from '../icons'
import { EvidenceView } from './EvidenceView'
import { plainText, relativeTime } from './format'

function DismissMenu({
  onDismiss,
  onMute
}: {
  onDismiss: (reason: AdvisorDismissReason) => void
  onMute: () => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', esc)
    }
  }, [open])
  const pick = (fn: () => void) => () => {
    setOpen(false)
    fn()
  }
  return (
    <div className="adv-menu" ref={ref}>
      <button
        type="button"
        className="btn btn--sm btn--ghost"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Codicon name="eye-closed" /> Dismiss <Codicon name="chevron-down" className="adv-menu-caret" />
      </button>
      {open && (
        <div className="adv-menu-pop" role="menu">
          <button type="button" role="menuitem" onClick={pick(() => onDismiss('false-positive'))}>
            <strong>False positive</strong>
            <span>This isn’t actually a problem here.</span>
          </button>
          <button type="button" role="menuitem" onClick={pick(() => onDismiss('accepted-risk'))}>
            <strong>Accepted risk</strong>
            <span>It’s a real issue, but it’s intended for this app.</span>
          </button>
          <button type="button" role="menuitem" onClick={pick(onMute)}>
            <strong>Mute this rule</strong>
            <span>Stop reporting this rule for this app.</span>
          </button>
        </div>
      )}
    </div>
  )
}

function Explanation({
  state,
  generating,
  onRetry,
  onStop
}: {
  state: ExplainState | undefined
  generating: boolean
  onRetry: () => void
  onStop: () => void
}): JSX.Element {
  if (state?.status === 'error' && !state.text) {
    return (
      <div className="adv-explain adv-explain--error">
        <span>{state.error || 'Couldn’t generate an explanation.'}</span>
        <button type="button" className="btn btn--sm btn--ghost" onClick={onRetry}>
          <Codicon name="refresh" /> Try again
        </button>
      </div>
    )
  }
  if (generating && !state?.text) {
    return (
      <div className="adv-explain adv-explain--thinking">
        <span className="shimmer-text">Copilot is looking into this…</span>
        <button type="button" className="adv-link" onClick={onStop}>
          Stop
        </button>
      </div>
    )
  }
  return (
    <div className={`adv-explain${generating ? ' is-streaming' : ''}`}>
      <Markdown>{state?.text ?? ''}</Markdown>
      <div className="adv-explain-foot">
        {generating ? (
          <button type="button" className="adv-link" onClick={onStop}>
            <Codicon name="debug-stop" /> Stop
          </button>
        ) : (
          <>
            <span className="adv-explain-by">
              <Codicon name="sparkle" /> Explained by Copilot
            </span>
            <button type="button" className="adv-link" onClick={onRetry}>
              <Codicon name="refresh" /> Regenerate
            </button>
          </>
        )}
      </div>
    </div>
  )
}

export function FindingDetail({
  item,
  explain,
  explainBusy,
  verifying,
  verifyBusy,
  chatBusy,
  links,
  onFix,
  onExplain,
  onCancelExplain,
  onVerify,
  onDismiss,
  onUndismiss,
  onMute,
  onUnmute,
  onOpenFile,
  onOpenUrl
}: {
  item: FindingItem
  explain: ExplainState | undefined
  /** Another explanation is being generated. */
  explainBusy: boolean
  verifying: boolean
  verifyBusy: boolean
  chatBusy: boolean
  links: MarkdownLinks | null
  onFix: () => void
  onExplain: () => void
  onCancelExplain: () => void
  onVerify: () => void
  onDismiss: (reason: AdvisorDismissReason) => void
  onUndismiss: () => void
  onMute: () => void
  onUnmute: () => void
  onOpenFile: (path: string, line?: number) => void
  onOpenUrl: (url: string) => void
}): JSX.Element {
  const f = item.finding
  const rule = ruleById(f.ruleId)
  const sev = normalizeSeverity(f.severity)
  const ai = f.source === 'ai'
  const [showExplain, setShowExplain] = useState(Boolean(explain))
  // Opening another finding shows its explanation only if one already exists.
  useEffect(() => setShowExplain(Boolean(explain)), [f.id])
  const generating = explain?.status === 'loading' || explain?.status === 'streaming'
  const docs = [...(f.docsUrl ? [{ title: 'Cited guidance', url: f.docsUrl }] : []), ...(rule?.docs ?? [])]
  const fixable = item.status !== 'dismissed' && item.status !== 'muted'
  const canVerify = ai && (item.status === 'applied' || item.status === 'still' || item.status === 'open')

  const toggleExplain = (): void => {
    if (showExplain) {
      setShowExplain(false)
      return
    }
    setShowExplain(true)
    if (!explain) onExplain()
  }

  return (
    <MarkdownLinksContext.Provider value={links}>
      <article className={`adv-detail adv-detail--${sev}`} aria-label={plainText(f.title)}>
        <div className="adv-detail-tags">
          <span className="adv-detail-source">
            <Codicon name={ai ? 'sparkle' : 'zap'} /> {ai ? 'Found by Copilot’s deep review' : 'Found by a quick check'}
          </span>
          {ai && f.verified && (
            <span className="adv-verified" title="The quoted code was found in the file">
              <Codicon name="verified-filled" /> Evidence checked
            </span>
          )}
          {rule && <code className="adv-rule-id">{rule.id}</code>}
        </div>

        {item.status === 'fixing' && (
          <div className="adv-notice adv-notice--busy" role="status">
            <span className="step-spin" aria-hidden="true" /> Copilot is fixing this in the Build chat…
          </div>
        )}
        {item.status === 'checking' && (
          <div className="adv-notice adv-notice--busy" role="status">
            <span className="step-spin" aria-hidden="true" /> Copilot finished — re-running the quick checks…
          </div>
        )}
        {item.status === 'applied' && (
          <div className="adv-notice adv-notice--applied" role="status">
            <Codicon name="check" /> Copilot applied a fix. Verify to confirm the issue is gone.
          </div>
        )}
        {item.status === 'still' && (
          <div className="adv-notice adv-notice--still" role="status">
            <Codicon name="warning" /> Still detected after the fix.
            {item.verdict?.note ? ` ${item.verdict.note}` : ''}
          </div>
        )}
        {item.status === 'dismissed' && item.dismissal && (
          <div className="adv-notice" role="status">
            <Codicon name="eye-closed" /> Dismissed as{' '}
            {item.dismissal.reason === 'false-positive' ? 'a false positive' : 'an accepted risk'}{' '}
            {relativeTime(item.dismissal.at)}.
            <button type="button" className="adv-link" onClick={onUndismiss}>
              Restore
            </button>
          </div>
        )}
        {item.status === 'muted' && (
          <div className="adv-notice" role="status">
            <Codicon name="mute" /> This rule is muted for this app.
            <button type="button" className="adv-link" onClick={onUnmute}>
              Unmute
            </button>
          </div>
        )}

        <div className="adv-detail-body">
          <Markdown>{f.detail}</Markdown>
        </div>

        {f.file && (
          <div className="adv-where">
            <button
              type="button"
              className="file-chip adv-file"
              onClick={() => onOpenFile(f.file!, f.line)}
              title={`Open ${f.file} in the Code tab`}
            >
              <Codicon name="go-to-file" />
              <span className="file-chip-name">{f.line ? `${f.file}:${f.line}` : f.file}</span>
            </button>
            {(f.locations ?? []).map((l) => (
              <button
                key={`${l.file}:${l.line ?? ''}:${l.label ?? ''}`}
                type="button"
                className="file-chip adv-file adv-file--more"
                onClick={() => onOpenFile(l.file, l.line)}
                title={l.label ? `${l.label} — ${l.file}` : l.file}
              >
                <span className="file-chip-name">
                  {l.label && l.label !== l.file ? l.label : l.line ? `${l.file}:${l.line}` : l.file}
                </span>
              </button>
            ))}
          </div>
        )}

        {f.excerpt && (
          <EvidenceView
            text={f.excerpt}
            start={f.excerptStart ?? f.line ?? 1}
            file={f.file}
            from={f.line}
            to={f.endLine}
          />
        )}

        <div className="adv-detail-sections">
          {rule && (
            <section className="adv-detail-section">
              <h4>Why it matters</h4>
              <Markdown>{rule.why}</Markdown>
            </section>
          )}
          <section className="adv-detail-section">
            <h4>How to fix</h4>
            <Markdown>{f.recommendation || rule?.fix || ''}</Markdown>
          </section>
        </div>

        {docs.length > 0 && (
          <div className="adv-docs">
            <span className="adv-docs-label">Learn more</span>
            {docs.map((d) => (
              <button key={d.url} type="button" className="adv-doc" onClick={() => onOpenUrl(d.url)} title={d.url}>
                {d.title} <Codicon name="link-external" />
              </button>
            ))}
          </div>
        )}

        <div className="adv-detail-actions">
          {fixable && (
            <button
              type="button"
              className="btn btn--sm btn--primary"
              onClick={onFix}
              disabled={chatBusy || item.status === 'fixing'}
              title={
                chatBusy
                  ? 'Copilot is working on a task — fixes resume when it finishes'
                  : 'Send this finding to the Build chat for Copilot to fix'
              }
            >
              <Codicon name="sparkle" /> Fix with Copilot
            </button>
          )}
          <button
            type="button"
            className={`btn btn--sm btn--ghost${showExplain ? ' is-active' : ''}`}
            onClick={toggleExplain}
            disabled={explainBusy && !generating && !explain}
            title={explainBusy && !explain ? 'Finishing another explanation…' : 'Explain this in depth — read-only, kept out of the chat'}
          >
            <Codicon name="comment-discussion" /> {showExplain ? 'Hide explanation' : 'Explain'}
          </button>
          {canVerify && (
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={onVerify}
              disabled={verifyBusy}
              title="Ask Copilot to re-check just this finding against the current code"
            >
              {verifying ? <span className="step-spin" aria-hidden="true" /> : <Codicon name="verified" />}
              {verifying ? 'Verifying…' : 'Verify'}
            </button>
          )}
          <span className="adv-detail-actions-spacer" />
          {item.status !== 'dismissed' && item.status !== 'muted' && (
            <DismissMenu onDismiss={onDismiss} onMute={onMute} />
          )}
        </div>

        {showExplain && (
          <Explanation state={explain} generating={generating} onRetry={onExplain} onStop={onCancelExplain} />
        )}
      </article>
    </MarkdownLinksContext.Provider>
  )
}
