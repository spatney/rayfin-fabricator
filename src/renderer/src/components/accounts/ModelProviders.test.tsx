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
  hasKey: false,
  models: [],
  enabled: [],
  ...more
})

const ANTHROPIC = provider('anthropic', 'Anthropic', {
  hasKey: true,
  models: [info('claude-opus-5-5', 'Claude Opus 5.5', true), info('claude-sonnet-5-5', 'Claude Sonnet 5.5', true)],
  enabled: ['claude-opus-5-5']
})
const OPENAI = provider('openai', 'OpenAI')

let api: {
  status: ReturnType<typeof vi.fn>
  setKey: ReturnType<typeof vi.fn>
  refresh: ReturnType<typeof vi.fn>
  removeKey: ReturnType<typeof vi.fn>
  setModels: ReturnType<typeof vi.fn>
}

beforeEach(() => {
  const status: ByokStatus = { supported: true, store: 'Windows Credential Manager', providers: [ANTHROPIC, OPENAI] }
  api = {
    status: vi.fn(async () => status),
    setKey: vi.fn(),
    refresh: vi.fn(),
    removeKey: vi.fn(async () => ({ ...ANTHROPIC, hasKey: false, models: [], enabled: [] })),
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
})
