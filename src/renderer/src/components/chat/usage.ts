// Words and numbers for what a chat has used and what's left of the Copilot plan.
import type { ChatModelUsage, ChatUsage, CopilotBilling, CopilotQuota } from '@shared/ipc'
import { formatLocale, translator } from '../../i18n'
import { formatTokens } from '../models/ModelPicker'

const UNITS = {
  ai_credits: {
    long: 'usage.unit.aiCredits',
    short: 'usage.unit.credits',
    unlimited: 'usage.unlimited.aiCredits'
  },
  premium_requests: {
    long: 'usage.unit.premiumRequests',
    short: 'usage.unit.premiumRequests',
    unlimited: 'usage.unlimited.premiumRequests'
  }
} as const satisfies Record<CopilotBilling, unknown>

/** The unit an amount is counted in, e.g. "AI credits" (`short`: "credits"). */
export function unitName(unit: CopilotBilling, amount: number, short = false): string {
  const u = UNITS[unit]
  return translator('chat')(short ? u.short : u.long, { count: amount })
}

/** An amount of AI credits or premium requests, as precise as its size needs. */
export function formatAmount(n: number): string {
  const locale = formatLocale()
  if (n > 0 && n < 0.01) return `<${(0.01).toLocaleString(locale)}`
  const digits = n < 10 ? 2 : n < 100 ? 1 : 0
  return n.toLocaleString(locale, { maximumFractionDigits: digits })
}

/** What AI credits cost, at US$0.01 a credit. */
export function formatDollars(credits: number): string {
  const dollars = credits / 100
  const usd = (n: number): string =>
    n.toLocaleString(formatLocale(), { style: 'currency', currency: 'USD' })
  if (dollars > 0 && dollars < 0.01) return `<${usd(0.01)}`
  return usd(dollars)
}

function tokens(m: ChatModelUsage): number {
  return m.inputTokens + m.outputTokens
}

/** What Copilot's models used, in the account's unit. */
export function billedAmount(u: ChatUsage): number {
  return u.billing === 'ai_credits' ? u.aiCredits : u.premiumRequests
}

/**
 * The usage chip's words: Copilot's usage in the account's unit, then tokens on
 * your own keys ("24.8 credits · 1.2M tokens"). Null while nothing is used.
 */
export function usageSummary(u: ChatUsage): string | null {
  const parts: string[] = []
  const billed = billedAmount(u)
  const t = translator('chat')
  if (billed > 0) {
    parts.push(
      t('usage.amount', { amount: formatAmount(billed), unit: unitName(u.billing, billed, true) })
    )
  }
  const own = u.models.filter((m) => m.ownKey).reduce((sum, m) => sum + tokens(m), 0)
  // Copilot's models without a reported amount still show what they read and wrote.
  const shown = own > 0 ? own : parts.length === 0 ? totalTokens(u) : 0
  if (shown > 0) parts.push(t('usage.tokens', { tokens: formatTokens(shown) }))
  return parts.length > 0 ? parts.join(' · ') : null
}

/** What a model used, in the account's unit (nothing for one on your own key). */
export function modelAmount(m: ChatModelUsage, billing: CopilotBilling): number {
  if (m.ownKey) return 0
  return billing === 'ai_credits' ? m.aiCredits : m.premiumRequests
}

/** One model's part of what the chat used, as the session view splits it. */
export interface ModelShare {
  /** The model's index in the chat's models. */
  index: number
  amount: number
  /** Its share of the total (0–100). */
  share: number
  /** Its color in the bar and beside its name (1–6). */
  color: number
}

/**
 * Whether the session view measures what Copilot's models used, or (for a chat
 * only on your own keys) tokens.
 */
export function measuresTokens(u: ChatUsage): boolean {
  return billedAmount(u) === 0 && u.models.every((m) => m.ownKey)
}

/** The models that used something, each with its share and color, in order. */
export function modelBreakdown(u: ChatUsage): ModelShare[] {
  const byTokens = measuresTokens(u)
  const amounts = u.models.map((m) => (byTokens ? tokens(m) : modelAmount(m, u.billing)))
  const total = amounts.reduce((sum, a) => sum + a, 0)
  const shares: ModelShare[] = []
  amounts.forEach((amount, index) => {
    if (amount <= 0) return
    shares.push({
      index,
      amount,
      share: (100 * amount) / total,
      color: Math.min(6, shares.length + 1)
    })
  })
  return shares
}

/** A share as a whole percentage: "75%", or "<1%". */
export function formatShare(share: number): string {
  const percent = (n: number): string =>
    (n / 100).toLocaleString(formatLocale(), { style: 'percent' })
  return share > 0 && share < 1 ? `<${percent(1)}` : percent(Math.round(share))
}

/** Where the signed-in account's Copilot usage shows on GitHub (or GHE.com). */
export function copilotUsageUrl(host?: string): string {
  const origin = (host ?? '').trim().replace(/\/+$/, '')
  const base = !origin
    ? 'https://github.com'
    : /^https?:\/\//.test(origin)
      ? origin
      : `https://${origin}`
  return `${base}/settings/copilot`
}

/** All the tokens a chat's models read and wrote. */
export function totalTokens(u: ChatUsage): number {
  return u.models.reduce((sum, m) => sum + tokens(m), 0)
}

/** A model's tokens: "7.57M in · 47K out". */
export function tokenLine(m: ChatModelUsage): string {
  return translator('chat')('usage.tokenLine', {
    input: formatTokens(m.inputTokens),
    output: formatTokens(m.outputTokens)
  })
}

/** A model's tokens in full, for its tooltip. */
export function tokenDetail(m: ChatModelUsage): string {
  const t = translator('chat')
  const locale = formatLocale()
  const n = (v: number): string => v.toLocaleString(locale)
  const counts = { input: n(m.inputTokens), output: n(m.outputTokens) }
  return m.cachedTokens > 0
    ? t('usage.tokenDetailCached', { ...counts, cached: n(m.cachedTokens) })
    : t('usage.tokenDetail', counts)
}

/** What's left of the plan's allowance: "999,000 of 1,000,000 AI credits left". */
export function quotaLeft(q: CopilotQuota): string {
  const t = translator('chat')
  if (q.unlimited) return t(UNITS[q.unit].unlimited)
  const left = Math.max(0, q.entitlement - q.used)
  return t('usage.left', {
    left: formatAmount(left),
    total: formatAmount(q.entitlement),
    unit: unitName(q.unit, q.entitlement)
  })
}

/** The share of the allowance left: "99.9%". */
export function formatPercent(p: number): string {
  return (p / 100).toLocaleString(formatLocale(), { style: 'percent', maximumFractionDigits: 1 })
}

/** When the allowance resets ("Resets Dec 1"), and any usage past it. */
export function quotaNotes(q: CopilotQuota, now = Date.now()): string[] {
  const notes: string[] = []
  const reset = q.resetDate ? Date.parse(q.resetDate) : NaN
  if (!q.unlimited && reset > now) {
    // GitHub's billing cycle turns over at midnight UTC, so name that day.
    const day = new Date(reset).toLocaleDateString(formatLocale(), {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC'
    })
    notes.push(translator('chat')('usage.resets', { day }))
  }
  if (q.overage > 0) {
    notes.push(
      translator('chat')('usage.overage', {
        amount: formatAmount(q.overage),
        unit: unitName(q.unit, q.overage)
      })
    )
  }
  return notes
}
