import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ChatUsage, CopilotQuota } from '@shared/ipc'
import { UsageMeter } from './UsageMeter'

const USAGE: ChatUsage = {
  sessionId: 's',
  billing: 'ai_credits',
  aiCredits: 454.7752,
  creditsPartial: false,
  premiumRequests: 3,
  models: [
    {
      model: 'grok-4.7',
      name: 'Grok 4.7',
      ownKey: false,
      inputTokens: 7_573_247,
      cachedTokens: 7_253_632,
      outputTokens: 46_951,
      aiCredits: 454.7752,
      premiumRequests: 3
    },
    {
      model: 'grok-4.7',
      name: 'Grok 4.7',
      ownKey: true,
      provider: 'xAI',
      inputTokens: 17_541_757,
      cachedTokens: 17_256_192,
      outputTokens: 101_374,
      aiCredits: 0,
      premiumRequests: 0
    }
  ]
}

const QUOTA: CopilotQuota = {
  unit: 'ai_credits',
  unlimited: false,
  entitlement: 1_000_000,
  used: 1000,
  remainingPercent: 99.9,
  overage: 0,
  overageAllowed: true
}

let chat: { usage: ReturnType<typeof vi.fn>; quota: ReturnType<typeof vi.fn> }
let openExternal: ReturnType<typeof vi.fn>

beforeEach(() => {
  chat = { usage: vi.fn(async () => USAGE), quota: vi.fn(async () => QUOTA) }
  openExternal = vi.fn(async () => undefined)
  ;(window as unknown as { api: unknown }).api = { chat, openExternal }
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

async function openPanel(host?: string): Promise<HTMLElement> {
  render(<UsageMeter projectId="p" sending={false} hidden={false} host={host} />)
  fireEvent.click(
    await screen.findByRole('button', { name: 'Chat usage: 455 credits · 17.64M tokens' })
  )
  return screen.getByRole('dialog', { name: 'Session credits' })
}

describe('UsageMeter', () => {
  it('shows the session’s credits by model, their tokens, and what’s left of the plan', async () => {
    const panel = await openPanel()
    expect(within(panel).getByText('≈ $4.55')).toBeTruthy()
    const [copilot, own] = within(
      within(panel).getByRole('list', { name: 'Usage by model' })
    ).getAllByRole('listitem')
    expect(within(copilot).getByText('Grok 4.7')).toBeTruthy()
    expect(within(copilot).getByText('455')).toBeTruthy()
    // A model on your own key shows its provider, like the model picker, and no credits.
    expect(within(own).getByText('xAI')).toBeTruthy()

    const details = within(panel).getByRole('button', { name: 'Token details' })
    expect(details.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(details)
    const tokens = within(panel).getByRole('list', { name: 'Token details' })
    expect(within(tokens).getByText('17.54M in · 101K out').title).toBe(
      '17,541,757 input tokens (17,256,192 from the prompt cache) and 101,374 output tokens'
    )

    const plan = await within(panel).findByRole('meter', { name: 'Copilot plan left' })
    expect(plan.getAttribute('aria-valuetext')).toBe('999,000 of 1,000,000 AI credits left')
    expect(within(panel).getByText('99.9% left')).toBeTruthy()

    fireEvent.keyDown(panel, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('links to the account’s usage on its own GitHub host, and to how usage is counted', async () => {
    const panel = await openPanel('https://company.ghe.com/')
    fireEvent.click(within(panel).getByRole('button', { name: 'How usage is counted' }))
    expect(openExternal).toHaveBeenLastCalledWith(
      expect.stringMatching(/\/docs\/build\/chat#see-what-a-chat-has-used$/)
    )
    fireEvent.click(within(panel).getByRole('button', { name: /View usage/ }))
    expect(openExternal).toHaveBeenLastCalledWith('https://company.ghe.com/settings/copilot')
  })

  it('reads the totals as each turn starts and ends, and stays away from an empty chat', async () => {
    const { rerender } = render(<UsageMeter projectId="p" sending={false} hidden />)
    expect(chat.usage).not.toHaveBeenCalled()
    expect(screen.queryByRole('button')).toBeNull()

    rerender(<UsageMeter projectId="p" sending hidden={false} />)
    await waitFor(() => expect(chat.usage).toHaveBeenCalledTimes(1))
    chat.usage.mockResolvedValue({ ...USAGE, aiCredits: 460, models: USAGE.models.slice(0, 1) })
    rerender(<UsageMeter projectId="p" sending={false} hidden={false} />)
    expect(await screen.findByRole('button', { name: 'Chat usage: 460 credits' })).toBeTruthy()
  })

  it('says when it couldn’t check the plan', async () => {
    chat.quota.mockRejectedValue(new Error('offline'))
    await openPanel()
    expect(await screen.findByText('Couldn’t check your Copilot plan.')).toBeTruthy()
  })
})
