import { describe, expect, it } from 'vitest'
import type { ChatModelUsage, ChatUsage, CopilotQuota } from '@shared/ipc'
import {
  copilotUsageUrl,
  formatAmount,
  formatDollars,
  formatShare,
  modelBreakdown,
  quotaLeft,
  quotaNotes,
  usageSummary
} from './usage'

const copilot: ChatModelUsage = {
  model: 'grok-4.7',
  name: 'Grok 4.7',
  ownKey: false,
  inputTokens: 7_573_247,
  cachedTokens: 7_253_632,
  outputTokens: 46_951,
  aiCredits: 454.7752,
  premiumRequests: 3
}
const ownKey: ChatModelUsage = {
  ...copilot,
  ownKey: true,
  provider: 'xAI',
  inputTokens: 17_541_757,
  outputTokens: 101_374,
  aiCredits: 0,
  premiumRequests: 0
}

function chat(models: ChatModelUsage[], over: Partial<ChatUsage> = {}): ChatUsage {
  return {
    sessionId: 's',
    billing: 'ai_credits',
    aiCredits: models.reduce((sum, m) => sum + m.aiCredits, 0),
    creditsPartial: false,
    premiumRequests: models.reduce((sum, m) => sum + m.premiumRequests, 0),
    models,
    ...over
  }
}

describe('usageSummary', () => {
  it('counts Copilot in the account’s unit and your own keys in tokens', () => {
    expect(usageSummary(chat([copilot]))).toBe('455 credits')
    expect(usageSummary(chat([copilot, ownKey]))).toBe('455 credits · 17.64M tokens')
    expect(usageSummary(chat([ownKey]))).toBe('17.64M tokens')
    expect(usageSummary(chat([copilot], { billing: 'premium_requests' }))).toBe(
      '3 premium requests'
    )
    expect(usageSummary(chat([{ ...copilot, aiCredits: 1 }]))).toBe('1 credit')
    expect(usageSummary(chat([]))).toBeNull()
  })

  it('shows tokens when Copilot reported no amount', () => {
    expect(usageSummary(chat([{ ...copilot, aiCredits: 0 }]))).toBe('7.62M tokens')
  })

  it('splits what the session used between its models, by tokens for a chat only on your keys', () => {
    const haiku = { ...copilot, model: 'claude-haiku-5.5', aiCredits: 50 }
    const mixed = modelBreakdown(chat([copilot, haiku, ownKey]))
    expect(mixed.map((p) => [p.index, Math.round(p.share), p.color])).toEqual([
      [0, 90, 1],
      [1, 10, 2]
    ])
    const keys = modelBreakdown(chat([ownKey, { ...ownKey, inputTokens: 0, outputTokens: 0 }]))
    expect(keys.map((p) => [p.index, p.amount, p.share])).toEqual([[0, 17_643_131, 100]])
    expect([formatShare(75.4), formatShare(0.3)]).toEqual(['75%', '<1%'])
  })

  it('links to Copilot’s usage on the account’s own host', () => {
    expect(copilotUsageUrl()).toBe('https://github.com/settings/copilot')
    expect(copilotUsageUrl('https://company.ghe.com/')).toBe(
      'https://company.ghe.com/settings/copilot'
    )
    expect(copilotUsageUrl('company.ghe.com')).toBe('https://company.ghe.com/settings/copilot')
  })
})

describe('amounts', () => {
  it('keeps as much precision as an amount’s size needs', () => {
    expect([0.004, 0.37, 3.6874, 24.8096, 999_000].map(formatAmount)).toEqual([
      '<0.01',
      '0.37',
      '3.69',
      '24.8',
      '999,000'
    ])
    expect([24.8096, 0.5, 454.7752].map(formatDollars)).toEqual(['$0.25', '<$0.01', '$4.55'])
  })
})

describe('the Copilot plan', () => {
  const plan: CopilotQuota = {
    unit: 'ai_credits',
    unlimited: false,
    entitlement: 1_000_000,
    used: 1000,
    remainingPercent: 99.9,
    overage: 0,
    overageAllowed: true,
    resetDate: '2026-12-01T00:00:00Z'
  }
  const now = Date.parse('2026-11-01T04:00:00Z')

  it('says what’s left, when it resets and any usage past it', () => {
    expect(quotaLeft(plan)).toBe('999,000 of 1,000,000 AI credits left')
    expect(quotaNotes(plan, now)).toEqual(['Resets Dec 1'])
    const over = {
      ...plan,
      unit: 'premium_requests' as const,
      entitlement: 300,
      used: 312,
      overage: 12
    }
    expect(quotaLeft(over)).toBe('0 of 300 premium requests left')
    // A reset date that has passed says nothing.
    expect(quotaNotes({ ...over, resetDate: '2026-10-01T00:00:00Z' }, now)).toEqual([
      '12 premium requests of additional usage'
    ])
    expect(quotaLeft({ ...plan, unlimited: true })).toBe('Unlimited AI credits')
  })
})
