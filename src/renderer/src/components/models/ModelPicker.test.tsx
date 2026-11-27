import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { AutoTiers, CopilotModel } from '@shared/ipc'
import { invalidateCopilotModels } from '@renderer/copilotModels'
import { AUTO_SELECTION, type ModelSelection } from '@renderer/modelSelection'
import { OverlayProvider, usePreviewSuppressed } from '@renderer/overlay'
import { setLanguage } from '../../i18n'
import { formatTokens, ModelPicker } from './ModelPicker'

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

const FUSION: AutoTiers = {
  defaultTier: 'balance',
  tiers: [
    {
      id: 'balance',
      name: 'Standard',
      description: 'Everyday coding.',
      enabled: true,
      fusion: true
    },
    {
      id: 'hydrafusion',
      name: 'High',
      description: 'Challenging tasks.',
      enabled: true,
      fusion: true
    },
    {
      id: 'hydrafusion-max',
      name: 'Max',
      description: 'The hardest tasks.',
      enabled: true,
      fusion: true
    }
  ]
}

const offerTiers = (tiers: AutoTiers): void => {
  ;(window as unknown as { api: { chat: { autoTiers: unknown } } }).api.chat.autoTiers = vi.fn(
    async () => tiers
  )
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
  localStorage.clear()
  ;(window as unknown as { api: unknown }).api = {
    chat: { listModels: vi.fn(async () => MODELS), autoTiers: vi.fn(async () => TIERS) }
  }
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('ModelPicker', () => {
  it('without Copilot, names the model of the user’s own a chat on Auto runs on, and has no Auto', async () => {
    const ollama = model('ollama/gpt-oss:20b', 'gpt-oss:20b', {
      vendor: 'Ollama',
      byok: { provider: 'ollama', providerName: 'Ollama', ready: true, standIn: true }
    })
    const server = model('custom/qwen3', 'qwen3', {
      byok: { provider: 'custom', providerName: 'OpenAI-compatible server', ready: true }
    })
    ;(window as unknown as { api: { chat: { listModels: unknown } } }).api.chat.listModels = vi.fn(
      async () => [MODELS[2], ollama, server]
    )
    const onChange = renderPicker(AUTO_SELECTION)
    await waitFor(() => expect(pill().textContent).toBe('gpt-oss:20b · Medium'))
    expect(pill().title).toBe('Model: gpt-oss:20b · Medium — on Ollama')
    fireEvent.click(pill())
    expect(
      await screen.findByText(
        'You’re not signed in to GitHub Copilot, so chats run on your own models.'
      )
    ).toBeTruthy()
    expect(screen.queryByRole('menuitemcheckbox', { name: /Auto/ })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: /Model/ }))
    const list = await screen.findByRole('menu', { name: 'Models' })
    // The server added by its address is tagged "Your server": its full name doesn't fit.
    const qwen = within(list).getByRole('menuitemradio', { name: /qwen3/ })
    expect(qwen.textContent).toContain('Your server')
    expect(qwen.title).toBe('Runs on OpenAI-compatible server')
    fireEvent.click(within(list).getByRole('menuitemradio', { name: /Claude Opus 5\.5/ }))
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: 'anthropic/claude-opus-5-5' })
    )
  })

  it('offers what Auto optimizes for, with a tier the account can’t use disabled and why', async () => {
    const onChange = renderPicker(AUTO_SELECTION)
    expect(pill().textContent).toContain('Auto')
    fireEvent.click(pill())

    const row = await screen.findByRole('menuitem', { name: /Optimized for/ })
    expect(row.textContent).toContain('Balance')
    fireEvent.click(row)
    const list = await screen.findByRole('menu', { name: 'Optimized for' })
    expect(
      within(list)
        .getByRole('menuitemradio', { name: /Balance/ })
        .getAttribute('aria-checked')
    ).toBe('true')
    const intelligence = within(list).getByRole('menuitemradio', { name: /Intelligence/ })
    expect((intelligence as HTMLButtonElement).disabled).toBe(true)
    expect(intelligence.textContent).toContain('Not on your plan')

    fireEvent.click(within(list).getByRole('menuitemradio', { name: /Efficiency/ }))
    expect(onChange).toHaveBeenLastCalledWith({ ...AUTO_SELECTION, autoTier: 'efficiency' })
    expect(pill().textContent).toContain('Auto · Efficiency')
  })

  it('keeps Auto’s name where Copilot offers Copilot Fusion, names Fusion under it, and lists its effort levels beside the menu', async () => {
    offerTiers(FUSION)
    const openExternal = vi.fn()
    ;(window as unknown as { api: { openExternal: unknown } }).api.openExternal = openExternal
    const onChange = renderPicker(AUTO_SELECTION)
    await waitFor(() => expect(pill().textContent).toBe('Auto · Standard'))
    fireEvent.click(pill())

    const auto = await screen.findByRole('menuitemcheckbox', { name: /Auto/ })
    expect(auto.getAttribute('aria-checked')).toBe('true')
    expect(auto.textContent).toContain('Copilot Fusion picks the models for each request.')
    // One row, like a model's Effort, with the levels in a list beside the menu.
    const row = screen.getByRole('menuitem', { name: /Effort/ })
    expect(row.textContent).toContain('Standard')
    expect(screen.queryByRole('menuitemradio')).toBeNull()
    fireEvent.click(row)
    const list = await screen.findByRole('menu', { name: 'Effort' })
    expect(
      within(list)
        .getByRole('menuitemradio', { name: /Standard/ })
        .getAttribute('aria-checked')
    ).toBe('true')
    expect(list.textContent).toContain('so a request can take longer and cost more')

    fireEvent.click(within(list).getByRole('menuitemradio', { name: /High/ }))
    expect(onChange).toHaveBeenLastCalledWith({ ...AUTO_SELECTION, autoTier: 'hydrafusion' })
    expect(pill().textContent).toBe('Auto · High')

    fireEvent.click(pill())
    fireEvent.click(await screen.findByRole('menuitem', { name: /Effort/ }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Learn more about Copilot Fusion' }))
    expect(openExternal).toHaveBeenCalledWith(
      'https://docs.github.com/en/copilot/concepts/models/copilot-fusion'
    )
  })

  it('names a saved Fusion level in the pill without opening the menu', async () => {
    offerTiers(FUSION)
    renderPicker({ ...AUTO_SELECTION, autoTier: 'hydrafusion-max' })
    await waitFor(() => expect(pill().textContent).toBe('Auto · Max'))
  })

  it('stills the native preview while the menu reaches over it, as from a narrow chat column', async () => {
    // The preview starts at 400 px, where the chat column ends.
    const host = document.createElement('div')
    host.className = 'preview-webview-host'
    document.body.append(host)
    let menuRight = 380
    const box = (left: number, right: number): DOMRect =>
      ({
        left,
        right,
        top: 0,
        bottom: 600,
        width: right - left,
        height: 600,
        x: left,
        y: 0
      }) as DOMRect
    const measured = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this === host) return box(400, 1000)
        return this.classList.contains('mp-pop') ? box(100, menuRight) : box(0, 0)
      })
    function Preview() {
      return <output aria-label="preview">{usePreviewSuppressed() ? 'still' : 'live'}</output>
    }
    try {
      render(
        <OverlayProvider>
          <Picker initial={AUTO_SELECTION} onChange={() => {}} />
          <Preview />
        </OverlayProvider>
      )
      const preview = screen.getByLabelText('preview')
      fireEvent.click(pill())
      await screen.findByRole('menu', { name: 'Model' })
      expect(preview.textContent, 'the menu stays over the chat column').toBe('live')
      fireEvent.click(pill())

      menuRight = 460
      fireEvent.click(pill())
      await screen.findByRole('menu', { name: 'Model' })
      expect(preview.textContent).toBe('still')
      fireEvent.click(pill())
      expect(screen.queryByRole('menu', { name: 'Model' })).toBeNull()
      expect(preview.textContent).toBe('live')
    } finally {
      measured.mockRestore()
      host.remove()
    }
  })

  it('on Copilot Fusion, says how many models you could choose instead, and choosing one turns Auto off', async () => {
    offerTiers(FUSION)
    const onChange = renderPicker(AUTO_SELECTION)
    await waitFor(() => expect(pill().textContent).toBe('Auto · Standard'))
    fireEvent.click(pill())
    // Your own models that aren't set up yet (Grok 4.7) don't count.
    const row = await screen.findByRole('menuitem', { name: 'Choose from 3 models' })
    fireEvent.click(row)
    const list = await screen.findByRole('menu', { name: 'Models' })
    expect(list.textContent).toContain('Choosing a model turns Auto off.')
    fireEvent.click(within(list).getByRole('menuitemradio', { name: /GPT-6\.1 Sol/ }))
    expect(onChange).toHaveBeenLastCalledWith({ ...AUTO_SELECTION, model: 'gpt-6.1-sol' })
    expect(pill().textContent).toBe('GPT-6.1 Sol · Medium')
  })

  it('names the Fusion level from what Copilot offered last time, before it answers', async () => {
    offerTiers(FUSION)
    renderPicker(AUTO_SELECTION)
    await waitFor(() => expect(pill().textContent).toBe('Auto · Standard'))
    cleanup()

    invalidateCopilotModels()
    ;(window as unknown as { api: { chat: { autoTiers: unknown } } }).api.chat.autoTiers = vi.fn(
      () => new Promise(() => {})
    )
    renderPicker(AUTO_SELECTION)
    expect(pill().textContent).toBe('Auto · Standard')
  })

  it('turns Auto off on Copilot’s first model and opens the list, with your keys’ models in their own section', async () => {
    const onChange = renderPicker(AUTO_SELECTION)
    fireEvent.click(pill())
    const auto = await screen.findByRole('menuitemcheckbox', { name: /Auto/ })
    await waitFor(() => expect((auto as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(auto)

    expect(onChange).toHaveBeenLastCalledWith({ ...AUTO_SELECTION, model: 'claude-sonnet-5.5' })
    const list = await screen.findByRole('menu', { name: 'Models' })
    // Auto is off already, so the list doesn't warn about turning it off.
    expect(list.textContent).not.toContain('turns Auto off')
    const keys = within(list).getByRole('group', { name: 'Your models' })
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

  it('starts a model that names no effort of its own at Medium, with no Automatic to choose', async () => {
    const sonnet = model('claude-sonnet-5.5', 'Claude Sonnet 5.5', {
      defaultReasoningEffort: undefined,
      supportedReasoningEfforts: ['low', 'medium', 'high', 'max']
    })
    ;(window as unknown as { api: { chat: { listModels: unknown } } }).api.chat.listModels = vi.fn(
      async () => [sonnet, MODELS[1]]
    )
    // A choice saved before, with the effort left to the model.
    const onChange = renderPicker({ ...AUTO_SELECTION, model: 'claude-sonnet-5.5' })
    await waitFor(() => expect(pill().textContent).toContain('Claude Sonnet 5.5 · Medium'))

    fireEvent.click(pill())
    fireEvent.click(await screen.findByRole('menuitem', { name: /Effort/ }))
    const efforts = await screen.findByRole('menu', { name: 'Effort' })
    expect(within(efforts).queryByRole('menuitemradio', { name: /Automatic/ })).toBeNull()
    const medium = within(efforts).getByRole('menuitemradio', { name: /Medium/ })
    expect(medium.getAttribute('aria-checked')).toBe('true')
    expect(medium.textContent).toContain('Default')

    // Chosen afresh, it says so, rather than leaving the effort to Copilot.
    const auto = screen.getByRole('menuitemcheckbox', { name: /Auto/ })
    fireEvent.click(auto)
    fireEvent.click(auto)
    expect(onChange).toHaveBeenLastCalledWith({
      ...AUTO_SELECTION,
      model: 'claude-sonnet-5.5',
      effort: 'medium'
    })
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
    fireEvent.click(within(list).getByRole('menuitem', { name: 'Add your own models…' }))
    expect(onManageKeys).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu', { name: 'Models' })).toBeNull()
  })
})

describe('formatTokens', () => {
  afterEach(async () => {
    await setLanguage('en')
    localStorage.clear()
  })

  it('writes millions with the language’s decimal mark', async () => {
    expect(formatTokens(1_048_576)).toBe('1.05M')
    await setLanguage('de')
    expect(formatTokens(1_048_576)).toBe('1,05M')
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(200_000)).toBe('200K')
  })
})
