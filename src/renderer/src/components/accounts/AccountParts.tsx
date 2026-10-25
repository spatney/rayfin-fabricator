import { Children, type JSX, type ReactNode } from 'react'
import { CheckIcon } from '../icons'

/** How a service (or a model provider) stands. */
export type CardState = 'ok' | 'off' | 'checking' | 'error'

const STATE_LABEL: Record<CardState, string> = {
  ok: 'Signed in',
  off: 'Not signed in',
  checking: 'Checking…',
  error: 'Needs attention'
}

/**
 * One service: a top row with its name, what it's for, how it stands, and its
 * one action (Sign in, Add account or Install from setup), then a row per
 * account and any messages.
 */
export function AccountCard({
  icon,
  title,
  purpose,
  state,
  stateLabels,
  action,
  children
}: {
  icon: ReactNode
  title: string
  purpose: string
  state: CardState
  /** Words for the states, when "Signed in" and the rest don't fit (a saved API key). */
  stateLabels?: Partial<Record<CardState, string>>
  action?: ReactNode
  children: ReactNode
}): JSX.Element {
  const label = (s: CardState): string => stateLabels?.[s] ?? STATE_LABEL[s]
  return (
    <section className={`acct-card acct-card--${state}`} aria-label={title}>
      <div className="acct-head">
        <span className="acct-ico" aria-hidden="true">
          {icon}
        </span>
        <h3 className="acct-title">
          {title}
          {state === 'ok' ? (
            <span className="acct-ok" role="img" aria-label={label('ok')} title={label('ok')}>
              <CheckIcon />
            </span>
          ) : (
            <span className={`acct-chip acct-chip--${state}`}>{label(state)}</span>
          )}
        </h3>
        <p className="acct-purpose">{purpose}</p>
        {action ? <div className="acct-head-action">{action}</div> : null}
      </div>
      {children}
    </section>
  )
}

/** Messages and forms at the end of a card, when there are any. */
export function Foot({ children }: { children: ReactNode }): JSX.Element | null {
  return Children.toArray(children).length > 0 ? <div className="acct-foot">{children}</div> : null
}

export function errorLine(text?: string): JSX.Element | null {
  return text ? (
    <p className="acct-error" role="alert">
      {text}
    </p>
  ) : null
}

/** One account: who it is, then what you can do with it. */
export function Row({
  as: Tag = 'div',
  name,
  meta,
  title,
  badge,
  badgeTitle,
  warning,
  children
}: {
  as?: 'div' | 'li'
  name: string
  meta?: string
  title?: string
  badge?: string
  /** What the badge means, on hover. */
  badgeTitle?: string
  warning?: string
  children?: ReactNode
}): JSX.Element {
  return (
    <Tag className="acct-row">
      <span className="acct-row-who" title={title}>
        <span className="acct-row-name">{name}</span>
        {meta && <span className="acct-row-meta">{meta}</span>}
        {badge && (
          <span className="acct-badge" title={badgeTitle}>
            {badge}
          </span>
        )}
        {warning && <span className="acct-badge acct-badge--warn">{warning}</span>}
      </span>
      {children ? <span className="acct-row-actions">{children}</span> : null}
    </Tag>
  )
}
