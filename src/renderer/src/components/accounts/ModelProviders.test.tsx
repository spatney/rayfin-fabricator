import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ByokModelInfo, ByokProviderStatus, ByokStatus } from '@shared/ipc'
import { ModelProviders } from './ModelProviders'

const info = (id: string, name: string, recommended: boolean): ByokModelInfo => ({
  id,
  name,
  contextWindow: 400_000,
  maxOutput: 128_000,
  vision: true,
  efforts: ['low', 'medium', 'high'],
  deprecated: false,
  recommended,
  created: 0
})

const provider = (id: string, name: string, more: Partial<ByokProviderStatus> = {}): ByokProviderStatus => ({
  id,
  name,
  description: `${name} models`,
  keyUrl: `https://${id}.example/keys`,
  keyPrefix: 'sk-',
  endpoint: 'fixed',
  keyNeed: 'required',
  hasKey: false,
  connected: false,
  models: [],
  enabled: [],
  ...more
})

const ANTHROPIC = provider('anthropic', 'Anthropic', {
  hasKey: true,
  connected: true,
  models: [info('claude-opus-5-5', 'Claude Opus 5.5', true), info('claude-sonnet-5-5', 'Claude Sonnet 5.5', true)],
  enabled: ['claude-opus-5-5']
})
const OPENAI = provider('openai', 'OpenAI')
const OLLAMA = provider('ollama', 'Ollama', {
  description: 'Open models that run on this computer',
  keyUrl: 'https://ollama.com/download',
  keyPrefix: '',
  endpoint: 'local',
  keyNeed: 'unused',
  defaultBaseUrl: 'http://localhost:11434/v1'
})
const CUSTOM = provider('custom', 'OpenAI-compatible server', {
  keyUrl: '',
  keyPrefix: '',
  endpoint: 'custom',
  keyNeed: 'optional'
})

let api: {
  status: ReturnType<typeof vi.fn>
  setKey: ReturnType<typeof vi.fn>
  connect: ReturnType<typeof vi.fn>
  refresh: ReturnType<typeof vi.fn>
  removeKey: ReturnType<typeof vi.fn>
  setModels: ReturnType<typeof vi.fn>
}

beforeEach(() => {
  const status: ByokStatus = {
    supported: true,
    store: 'Windows Credential Manager',
    providers: [ANTHROPIC, OPENAI, OLLAMA, CUSTOM],
    ownModels: true
  }
  api = {
    status: vi.fn(async () => status),
    setKey: vi.fn(),
    connect: vi.fn(),
    refresh: vi.fn(),
    removeKey: vi.fn(async () => ({
      ...ANTHROPIC,
      hasKey: false,
      connected: false,
      models: [],
      enabled: []
    })),
    setModels: vi.fn(async (_p: string, models: string[]) => ({ ...ANTHROPIC, enabled: models }))
  }
  ;(window as unknown as { api: unknown }).api = { byok: api, openExternal: vi.fn() }
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

const card = (name: string) => screen.getByRole('region', { name })

describe('ModelProviders', () => {
  it('checks a new key with the provider before keeping it, then lists its models', async () => {
    api.setKey
      .mockRejectedValueOnce('OpenAI didn’t accept this key. Check that you copied all of it.')
      .mockResolvedValueOnce({
        ...OPENAI,
        hasKey: true,
        connected: true,
        models: [info('gpt-6-astra', 'GPT-6 Astra', true), info('gpt-6-luna', 'GPT-6 Luna', false)],
        enabled: ['gpt-6-astra']
      })
    render(<ModelProviders />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add your OpenAI API key' }))
    const input = within(card('OpenAI')).getByLabelText('OpenAI API key', { selector: 'input' })
    expect(input.getAttribute('type')).toBe('password')

    fireEvent.change(input, { target: { value: ' sk-wrong ' } })
    fireEvent.click(within(card('OpenAI')).getByRole('button', { name: 'Save key' }))
    expect(await within(card('OpenAI')).findByRole('alert')).toHaveProperty(
      'textContent',
      'OpenAI didn’t accept this key. Check that you copied all of it.'
    )
    expect(api.setKey).toHaveBeenLastCalledWith('openai', 'sk-wrong')

    fireEvent.change(within(card('OpenAI')).getByLabelText('OpenAI API key', { selector: 'input' }), { target: { value: 'sk-right' } })
    fireEvent.click(within(card('OpenAI')).getByRole('button', { name: 'Save key' }))
    await within(card('OpenAI')).findByText('Saved in Windows Credential Manager')
    expect(within(card('OpenAI')).queryByLabelText('OpenAI API key', { selector: 'input' })).toBeNull()
    const astra = within(card('OpenAI')).getByRole('checkbox', { name: 'GPT-6 Astra' }) as HTMLInputElement
    expect(astra.checked).toBe(true)
    expect(within(card('OpenAI')).queryByRole('alert')).toBeNull()
  })

  it('saves which models the pickers show, and removes a key only after asking', async () => {
    render(<ModelProviders />)
    const sonnet = (await within(await screen.findByRole('region', { name: 'Anthropic' })).findByRole('checkbox', {
      name: 'Claude Sonnet 5.5'
    })) as HTMLInputElement
    fireEvent.click(sonnet)
    expect(sonnet.checked).toBe(true)
    await waitFor(() => expect(api.setModels).toHaveBeenCalledWith('anthropic', ['claude-opus-5-5', 'claude-sonnet-5-5']))

    fireEvent.click(within(card('Anthropic')).getByRole('button', { name: 'Remove your Anthropic API key' }))
    expect(api.removeKey).not.toHaveBeenCalled()
    fireEvent.click(within(card('Anthropic')).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(api.removeKey).toHaveBeenCalledWith('anthropic'))
    expect(await within(card('Anthropic')).findByRole('button', { name: 'Add your Anthropic API key' })).toBeTruthy()
  })

  it('connects Ollama at its address, with no key, then lists the models it can use', async () => {
    api.connect
      .mockRejectedValueOnce(
        'Ollama isn’t answering at http://localhost:11434. Start Ollama, then try again.'
      )
      .mockResolvedValueOnce({
        ...OLLAMA,
        connected: true,
        baseUrl: 'http://localhost:11434/v1',
        models: [info('gpt-oss:20b', 'gpt-oss:20b', true)],
        enabled: ['gpt-oss:20b']
      })
    render(<ModelProviders />)
    expect(
      await within(await screen.findByRole('region', { name: 'Ollama' })).findByText('Not set up')
    ).toBeTruthy()
    fireEvent.click(within(card('Ollama')).getByRole('button', { name: 'Connect Ollama' }))
    const address = within(card('Ollama')).getByLabelText('Ollama address') as HTMLInputElement
    expect(address.value).toBe('http://localhost:11434')
    expect(within(card('Ollama')).queryByLabelText('API key (optional)')).toBeNull()

    fireEvent.click(within(card('Ollama')).getByRole('button', { name: 'Connect' }))
    expect(await within(card('Ollama')).findByRole('alert')).toHaveProperty(
      'textContent',
      'Ollama isn’t answering at http://localhost:11434. Start Ollama, then try again.'
    )
    expect(api.connect).toHaveBeenLastCalledWith('ollama', 'http://localhost:11434', undefined)

    fireEvent.click(within(card('Ollama')).getByRole('button', { name: 'Connect' }))
    expect(await within(card('Ollama')).findByText('http://localhost:11434')).toBeTruthy()
    expect(
      (within(card('Ollama')).getByRole('checkbox', { name: 'gpt-oss:20b' }) as HTMLInputElement)
        .checked
    ).toBe(true)
    expect(within(card('Ollama')).getByText(/context length of at least 64k/)).toBeTruthy()
    expect(within(card('Ollama')).getByRole('button', { name: 'Remove Ollama' })).toBeTruthy()
  })

  it('sends an OpenAI-compatible server its address and the key it wants', async () => {
    api.connect.mockResolvedValueOnce({
      ...CUSTOM,
      connected: true,
      hasKey: true,
      baseUrl: 'http://localhost:1234/v1',
      models: [info('qwen3-coder', 'qwen3-coder', true)],
      enabled: ['qwen3-coder']
    })
    render(<ModelProviders />)
    fireEvent.click(await screen.findByRole('button', { name: 'Connect OpenAI-compatible server' }))
    const form = within(card('OpenAI-compatible server'))
    fireEvent.change(form.getByLabelText('OpenAI-compatible server address'), {
      target: { value: ' http://localhost:1234/v1 ' }
    })
    fireEvent.change(form.getByLabelText('API key (optional)'), { target: { value: 'lm-key' } })
    fireEvent.click(form.getByRole('button', { name: 'Connect' }))
    await waitFor(() =>
      expect(api.connect).toHaveBeenCalledWith('custom', 'http://localhost:1234/v1', 'lm-key')
    )
    expect(await form.findByText('API key saved in Windows Credential Manager')).toBeTruthy()
  })

  it('finds a model in a long list', async () => {
    const many = Array.from({ length: 14 }, (_, i) => info(`maker/model-${i}`, `Model ${i}`, false))
    api.status.mockResolvedValueOnce({
      supported: true,
      store: 'Windows Credential Manager',
      providers: [
        provider('openrouter', 'OpenRouter', {
          hasKey: true,
          connected: true,
          models: [
            ...many,
            info('anthropic/claude-sonnet-5.5', 'Anthropic: Claude Sonnet 5.5', true)
          ],
          enabled: []
        })
      ]
    })
    render(<ModelProviders />)
    const search = await within(
      await screen.findByRole('region', { name: 'OpenRouter' })
    ).findByRole('searchbox', {
      name: 'Find a model from OpenRouter'
    })
    const list = (): HTMLElement =>
      within(card('OpenRouter')).getByRole('list', {
        name: 'OpenRouter models in the model pickers'
      })
    expect(within(list()).getAllByRole('checkbox')).toHaveLength(1)
    fireEvent.change(search, { target: { value: 'model 1' } })
    expect(
      within(list())
        .getAllByRole('checkbox')
        .map((c) => c.closest('label')?.textContent)
    ).toEqual(['Model 1', 'Model 10', 'Model 11', 'Model 12', 'Model 13'])
    fireEvent.change(search, { target: { value: 'nothing like it' } })
    expect(within(card('OpenRouter')).getByText('No models match.')).toBeTruthy()
  })
})
