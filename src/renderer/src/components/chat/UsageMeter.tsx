import { useEffect, useId, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import type { ChatModelUsage, ChatUsage, CopilotQuota } from '@shared/ipc'
import { openDocs } from '@renderer/docsLinks'
import { menuLayout, type MenuLayout } from '@renderer/menuLayout'
import { useSuppressPreview } from '@renderer/overlay'
import { Codicon } from '../icons'
import { ModelLogo } from '../models/ModelLogo'
import { formatTokens } from '../models/ModelPicker'
import {
  billedAmount,
  copilotUsageUrl,
  formatAmount,
  formatDollars,
  formatPercent,
  formatShare,
  measuresTokens,
  modelBreakdown,
  quotaLeft,
  quotaNotes,
  tokenDetail,
  tokenLine,
  totalTokens,
  unitName,
  usageSummary,
  type ModelShare
} from './usage'
import '../models/modelPicker.css'

const PANEL_WIDTH = 320

/** Usage is a side note: a failed read leaves what's shown (`undefined`). */
function readUsage(projectId: string): Promise<ChatUsage | null | undefined> {
  return Promise.resolve()
    .then(() => window.api.chat.usage(projectId))
    .catch(() => undefined)
}

/** A model's maker's logo, else (on your own key) its provider's. */
function Logo({ model: m }: { model: ChatModelUsage }): JSX.Element {
  const provider = m.provider?.toLowerCase()
  return (
    <ModelLogo
      model={{
        id: m.model,
        byok: provider ? { provider, providerName: m.provider ?? '', ready: true } : undefined
      }}
    />
  )
}

/** The key a model on your own key runs on: its provider's name, like the model picker's. */
function KeyTag({ model: m }: { model: ChatModelUsage }): JSX.Element {
  return (
    <span
      className="mp-tag usage-key"
      title={`On your ${m.provider ?? 'own'} key, which its provider bills`}
    >
      <Codicon name="key" />
      {m.provider ?? 'Your key'}
    </span>
  )
}

function ModelRow({
  model: m,
  part,
  byTokens,
  showShare,
  unit
}: {
  model: ChatModelUsage
  /** What it used, when it used something the view measures. */
  part?: ModelShare
  byTokens: boolean
  showShare: boolean
  unit: string
}): JSX.Element {
  const amount = part ? (byTokens ? formatTokens(part.amount) : formatAmount(part.amount)) : '–'
  return (
    <li className="usage-model">
      <Logo model={m} />
      <span className={`usage-dot${part ? ` usage-c${part.color}` : ''}`} aria-hidden="true" />
      <span className="usage-model-name">
        {m.name}
        {m.ownKey && byTokens && <KeyTag model={m} />}
      </span>
      {m.ownKey && !byTokens ? (
        <KeyTag model={m} />
      ) : (
        <span className="usage-model-amount" title={part ? `${amount} ${unit}` : undefined}>
          <strong>{amount}</strong>
          {showShare && part && <span>{formatShare(part.share)}</span>}
        </span>
      )}
    </li>
  )
}

function PlanSection({
  quota,
  failed
}: {
  /** `undefined` while it's being read. */
  quota: CopilotQuota | undefined
  failed: boolean
}): JSX.Element {
  const state =
    !quota || quota.unlimited
      ? ''
      : quota.remainingPercent <= 0
        ? ' is-out'
        : quota.remainingPercent < 10
          ? ' is-low'
          : ''
  const notes = quota ? quotaNotes(quota) : []
  return (
    <section className="usage-plan" aria-label="Copilot plan">
      <div className="usage-plan-head">
        <span className="usage-plan-title">Copilot plan</span>
        {quota && !quota.unlimited && (
          <span className={`usage-pill${state}`}>{formatPercent(quota.remainingPercent)} left</span>
        )}
      </div>
      {!quota ? (
        <p className="usage-foot">
          {failed ? 'Couldn’t check your Copilot plan.' : 'Checking your plan…'}
        </p>
      ) : quota.unlimited ? (
        <p className="usage-plan-line">Unlimited {unitName(quota.unit, 2)}</p>
      ) : (
        <>
          <p className="usage-plan-line">
            <strong>{formatAmount(Math.max(0, quota.entitlement - quota.used))}</strong> of{' '}
            {formatAmount(quota.entitlement)} {unitName(quota.unit, quota.entitlement, true)}{' '}
            remaining
          </p>
          <div
            className={`usage-bar${state}`}
            role="meter"
            aria-label="Copilot plan left"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(quota.remainingPercent)}
            aria-valuetext={quotaLeft(quota)}
          >
            <span style={{ width: `${quota.remainingPercent}%` }} />
          </div>
          {notes.length > 0 && <p className="usage-foot">{notes.join(' · ')}</p>}
        </>
      )}
    </section>
  )
}

/**
 * The chat toolbar's usage meter: what this chat's Copilot session has used, in
 * AI credits (or premium requests) on Copilot's models and in tokens on your own
 * keys. It opens to each model's share, its tokens, and what's left of your
 * Copilot plan.
 */
export function UsageMeter({
  projectId,
  sending,
  hidden,
  host
}: {
  projectId: string
  /** A turn is running: the totals are read again as it starts and ends. */
  sending: boolean
  /** The chat is empty, so it has used nothing. */
  hidden: boolean
  /** The signed-in Copilot account's host (`https://github.com`, or a GHE.com one). */
  host?: string
}): JSX.Element | null {
  const [usage, setUsage] = useState<ChatUsage | null>(null)
  const [open, setOpen] = useState(false)
  const [tokensOpen, setTokensOpen] = useState(false)
  const [layout, setLayout] = useState<MenuLayout>({ side: 'left', style: {} })
  const [quota, setQuota] = useState<CopilotQuota | null | undefined>(undefined)
  const [quotaFailed, setQuotaFailed] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const tokensId = useId()
  // Wider than the narrowest chat pane, so it can reach over the preview.
  useSuppressPreview(open)

  useEffect(() => {
    if (hidden) {
      setUsage(null)
      setOpen(false)
      return
    }
    let live = true
    void readUsage(projectId).then((next) => {
      if (live && next !== undefined) setUsage(next)
    })
    return () => {
      live = false
    }
  }, [projectId, sending, hidden])

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent): void => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !popRef.current?.contains(target)) setOpen(false)
    }
    const resize = (): void => setOpen(false)
    window.addEventListener('mousedown', close)
    window.addEventListener('resize', resize)
    const id = requestAnimationFrame(() => panelRef.current?.focus())
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('resize', resize)
      cancelAnimationFrame(id)
    }
  }, [open])

  const summary = usage ? usageSummary(usage) : null
  if (!usage || !summary) return null

  function openPanel(): void {
    const r = triggerRef.current?.getBoundingClientRect()
    if (r) setLayout(menuLayout(r, 'down', PANEL_WIDTH + 12))
    setOpen(true)
    void readUsage(projectId).then((next) => {
      if (next !== undefined) setUsage(next)
    })
    setQuotaFailed(false)
    Promise.resolve()
      .then(() => window.api.chat.quota())
      .then(setQuota, () => setQuotaFailed(true))
  }

  function closePanel(focusTrigger = true): void {
    setOpen(false)
    if (focusTrigger) requestAnimationFrame(() => triggerRef.current?.focus())
  }

  const byTokens = measuresTokens(usage)
  const total = byTokens ? totalTokens(usage) : billedAmount(usage)
  const unit = byTokens ? 'tokens' : unitName(usage.billing, total, true)
  const parts = modelBreakdown(usage)
  const partOf = new Map(parts.map((p) => [p.index, p]))
  const cost =
    !byTokens && usage.billing === 'ai_credits' && total > 0 ? formatDollars(total) : null
  const title = usage.billing === 'ai_credits' && !byTokens ? 'Session credits' : 'Session usage'
  const column = byTokens ? 'Tokens' : usage.billing === 'ai_credits' ? 'Credits' : 'Requests'

  return (
    <div
      ref={rootRef}
      className="usage-meter"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return
        event.preventDefault()
        event.stopPropagation()
        closePanel()
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`chat-tool chat-tool--label usage-chip${open ? ' is-open' : ''}`}
        onClick={() => (open ? closePanel(false) : openPanel())}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Chat usage: ${summary}`}
        title={`What this chat has used: ${summary}`}
      >
        <Codicon name="dashboard" />
        <span className="usage-chip-label">{summary}</span>
        <Codicon name={open ? 'chevron-up' : 'chevron-down'} className="usage-chip-chev" />
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            className={`mp-pop mp-pop--down mp-pop--${layout.side}`}
            style={layout.style}
          >
            <div
              ref={panelRef}
              className="mp-panel usage-panel"
              role="dialog"
              aria-labelledby={titleId}
              tabIndex={-1}
            >
              <div className="usage-top">
                <h2 id={titleId} className="usage-title">
                  {title}
                </h2>
                <button
                  type="button"
                  className="usage-info"
                  onClick={() => openDocs('chatUsage')}
                  aria-label="How usage is counted"
                  title="How usage is counted"
                >
                  <Codicon name="info" />
                </button>
              </div>
              <div className="usage-hero">
                <span className="usage-hero-num">
                  {byTokens ? formatTokens(total) : formatAmount(total)}
                </span>
                <span className="usage-hero-unit">{unit} used</span>
                {cost && (
                  <span className="usage-cost" title="At US$0.01 an AI credit">
                    ≈ {cost}
                  </span>
                )}
              </div>
              {parts.length > 0 && (
                <div className="usage-stack" aria-hidden="true">
                  {parts.map((p) => (
                    <span
                      key={p.index}
                      className={`usage-c${p.color}`}
                      style={{ flexGrow: p.share }}
                    />
                  ))}
                </div>
              )}
              {!byTokens && usage.billing === 'ai_credits' && usage.creditsPartial && (
                <p className="usage-foot">
                  Some replies didn’t report their credits, so this is a minimum.
                </p>
              )}
              <div className="usage-cols" aria-hidden="true">
                <span>Usage by model</span>
                <span>{column}</span>
              </div>
              <ul className="usage-models" aria-label="Usage by model">
                {usage.models.map((m, i) => (
                  <ModelRow
                    key={`${m.ownKey ? 'key' : 'copilot'}:${m.model}:${m.name}`}
                    model={m}
                    part={partOf.get(i)}
                    byTokens={byTokens}
                    showShare={parts.length > 1}
                    unit={byTokens ? 'tokens' : unitName(usage.billing, partOf.get(i)?.amount ?? 0)}
                  />
                ))}
              </ul>
              <div className="usage-rule" role="separator" />
              <button
                type="button"
                className="usage-disclosure"
                aria-expanded={tokensOpen}
                aria-controls={tokensId}
                onClick={() => setTokensOpen((v) => !v)}
              >
                <Codicon name="chevron-right" />
                Token details
              </button>
              {tokensOpen && (
                <ul id={tokensId} className="usage-tokens" aria-label="Token details">
                  {usage.models.map((m) => (
                    <li key={`${m.ownKey ? 'key' : 'copilot'}:${m.model}:${m.name}`}>
                      <span className="usage-tokens-name">
                        {m.name}
                        {m.ownKey && <KeyTag model={m} />}
                      </span>
                      <span className="usage-tokens-val" title={tokenDetail(m)}>
                        {tokenLine(m)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {quota !== null && (
                <>
                  <div className="usage-rule" role="separator" />
                  <PlanSection quota={quota} failed={quotaFailed} />
                </>
              )}
              <div className="usage-links">
                <button
                  type="button"
                  className="usage-link"
                  onClick={() => {
                    void window.api.openExternal(copilotUsageUrl(host))
                    closePanel(false)
                  }}
                >
                  View usage <Codicon name="arrow-right" />
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
