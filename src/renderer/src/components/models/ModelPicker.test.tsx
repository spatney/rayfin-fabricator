import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { AutoTiers, CopilotModel } from '@shared/ipc'
import { invalidateCopilotModels } from '@renderer/copilotModels'
import { AUTO_SELECTION, type ModelSelection } from '@renderer/modelSelection'
import { ModelPicker } from './ModelPicker'

const model = (id: string, name: string, more: Partial<CopilotModel> = {}): CopilotModel => ({
  id,
  name,
  supportedReasoningEfforts: ['low', 'medium', 'high'],
  defaultReasoningEffort: 'medium',
  vision: true,
  ...more
})

const MODELS: CopilotModel[] = [
  model('claude-sonnet-5.5', 'Claude Sonnet 5.5', {
    vendor: 'Anthropic',
    contextTiers: [
      { tier: 'default', tokens: 200_000 },
      { tier: 'long_context', tokens: 1_000_000 }
    ]
  }),
  model('gpt-6.1-sol', 'GPT-6.1 Sol', { vendor: 'OpenAI', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'] }),
  model('anthropic/claude-opus-5-5', 'Claude Opus 5.5', {
    vendor: 'Anthropic',
    byok: { provider: 'anthropic', providerName: 'Anthropic', ready: true }
  }),
  model('xai/grok-4.7', 'Grok 4.7', {
    vendor: 'xAI',
    byok: { provider: 'xai', providerName: 'xAI', ready: false, note: 'Add your xAI key in Accounts' }
  })
]

const TIERS: AutoTiers = {
  defaultTier: 'balance',
  tiers: [
    { id: 'efficiency', name: 'Efficiency', description: 'Faster models.', enabled: true },
    { id: 'balance', name: 'Balance', description: 'Speed and capability.', enabled: true },
    { id: 'intelligence', name: 'Intelligence', description: 'The most capable.', enabled: false, note: 'Not on your plan' }
  ]
}

/** The picker with its selection in state, reporting each change. */
function Picker({ initial, onChange }: { initial: ModelSelection; onChange: (s: ModelSelection) => void }) {
  const [value, setValue] = useState(initial)
  return (
    <ModelPicker
      value={value}
      disabled={false}
      tiers
      onManageKeys={() => {}}
      onChange={(next) => {
        setValue(next)
        onChange(next)
      }}
    />
  )
}

function renderPicker(initial: ModelSelection) {
  const onChange = vi.fn()
  render(<Picker initial={initial} onChange={onChange} />)
  return onChange
}

const pill = () => screen.getByRole('button', { name: /^Model:/ })

beforeEach(() => {
  invalidateCopilotModels()
  ;(window as unknown as { api: unknown }).api = {
    chat: { listModels: vi.fn(async () => MODELS), autoTiers: vi.fn(async () => TIERS) }
  }
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('ModelPicker', () => {
  it('offers what Auto optimizes for, with a tier the account can’t use disabled and why', async () => {
    const onChange = renderPicker(AUTO_SELECTION)
    expect(pill().textContent).toContain('Auto')
    fireEvent.click(pill())

    const group = await screen.findByRole('group', { name: 'Optimized for' })
    expect(within(group).getByRole('menuitemradio', { name: /Balance/ }).getAttribute('aria-checked')).toBe('true')
    const intelligence = within(group).getByRole('menuitemradio', { name: /Intelligence/ })
    expect((intelligence as HTMLButtonElement).disabled).toBe(true)
    expect(intelligence.textContent).toContain('Not on your plan')

    fireEvent.click(within(group).getByRole('menuitemradio', { name: /Efficiency/ }))
    expect(onChange).toHaveBeenLastCalledWith({ ...AUTO_SELECTION, autoTier: 'efficiency' })
    expect(pill().textContent).toContain('Auto · Efficiency')
  })

  it('turns Auto off on Copilot’s first model and opens the list, with your keys’ models in their own section', async () => {
    const onChange = renderPicker(AUTO_SELECTION)
    fireEvent.click(pill())
    const auto = await screen.findByRole('menuitemcheckbox', { name: /Auto/ })
    await waitFor(() => expect((auto as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(auto)

    expect(onChange).toHaveBeenLastCalledWith({ ...AUTO_SELECTION, model: 'claude-sonnet-5.5' })
    const list = await screen.findByRole('menu', { name: 'Models' })
    const keys = within(list).getByRole('group', { name: 'Your API keys' })
    expect(within(keys).getByRole('menuitemradio', { name: /Claude Opus 5\.5/ }).textContent).toContain('Anthropic')
    const grok = within(keys).getByRole('menuitemradio', { name: /Grok 4\.7/ }) as HTMLButtonElement
    expect(grok.disabled).toBe(true)
    expect(grok.textContent).toContain('Add your xAI key in Accounts')

    fireEvent.change(within(list).getByRole('textbox', { name: 'Search models' }), { target: { value: 'anthropic' } })
    const found = within(list)
      .getAllByRole('menuitemradio')
      .map((item) => item.textContent)
    expect(found).toHaveLength(2)
    fireEvent.click(within(list).getByRole('menuitemradio', { name: /Claude Opus 5\.5/ }))
    expect(onChange).toHaveBeenLastCalledWith({ ...AUTO_SELECTION, model: 'anthropic/claude-opus-5-5' })
    expect(pill().textContent).toContain('Claude Opus 5.5 · Medium')
  })

  it('keeps only the effort and context window a newly chosen model offers', async () => {
    const onChange = renderPicker({ model: 'claude-sonnet-5.5', effort: 'high', autoTier: '', contextTier: '' })
    fireEvent.click(pill())
    fireEvent.click(await screen.findByRole('menuitem', { name: /Context window/ }))
    const windows = await screen.findByRole('menu', { name: 'Context window' })
    fireEvent.click(within(windows).getByRole('menuitemradio', { name: /Long/ }))
    expect(onChange).toHaveBeenLastCalledWith({
      model: 'claude-sonnet-5.5',
      effort: 'high',
      autoTier: '',
      contextTier: 'long_context'
    })
    expect(pill().textContent).toContain('Claude Sonnet 5.5 · High · 1M')

    fireEvent.click(pill())
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Model/ }))
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /GPT-6\.1 Sol/ }))
    expect(onChange).toHaveBeenLastCalledWith({ model: 'gpt-6.1-sol', effort: 'high', autoTier: '', contextTier: '' })

    fireEvent.click(pill())
    fireEvent.click(await screen.findByRole('menuitem', { name: /Effort/ }))
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Extra high/ }))
    fireEvent.click(pill())
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Model/ }))
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Claude Sonnet 5\.5/ }))
    expect(onChange).toHaveBeenLastCalledWith({ model: 'claude-sonnet-5.5', effort: '', autoTier: '', contextTier: '' })
  })

  it('lists Copilot’s first models, the rest under More models, a chosen model that’s gone, and a way to add keys', async () => {
    const copilot = Array.from({ length: 10 }, (_, i) => model(`model-${i}`, `Model ${i}`))
    ;(window as unknown as { api: { chat: { listModels: unknown } } }).api.chat.listModels = vi.fn(async () => copilot)
    const onManageKeys = vi.fn()
    render(
      <ModelPicker
        value={{ model: 'anthropic/claude-gone', effort: '', autoTier: '', contextTier: '' }}
        disabled={false}
        onChange={() => {}}
        onManageKeys={onManageKeys}
      />
    )
    expect(pill().getAttribute('aria-label')).toBe('Model: claude-gone')
    fireEvent.click(pill())
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Model/ }))
    const list = await screen.findByRole('menu', { name: 'Models' })
    const gone = (await within(list).findByRole('menuitemradio', { name: /claude-gone/ })) as HTMLButtonElement
    expect(gone.disabled).toBe(true)
    expect(gone.textContent).toContain('Not available anymore')
    expect(within(list).getAllByRole('menuitemradio')).toHaveLength(1 + 8)

    fireEvent.click(within(list).getByRole('menuitem', { name: /More models/ }))
    const more = within(list).getByRole('group', { name: 'More models' })
    expect(within(more).getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual(['Model 8', 'Model 9'])

    // Without keys yet, the list offers to add some.
    fireEvent.click(within(list).getByRole('menuitem', { name: 'Add models with your API keys…' }))
    expect(onManageKeys).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu', { name: 'Models' })).toBeNull()
  })
})
