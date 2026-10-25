import type { JSX } from 'react'
import type { CopilotModel } from '@shared/ipc'
import { AnthropicLogo, GrokLogo, OpenAILogo } from '../brand-icons'
import { Codicon } from '../icons'
import claudeSvg from '../../assets/brands/claude.svg'
import geminiSvg from '../../assets/brands/gemini.svg'
import metaSvg from '../../assets/brands/meta.svg'
import microsoftSvg from '../../assets/brands/microsoft.svg'
import './modelPicker.css'

/** Who makes a model, as far as its logo goes. */
export type ModelMaker = 'claude' | 'openai' | 'gemini' | 'grok' | 'microsoft' | 'meta' | 'other'

const VENDORS: Record<string, ModelMaker> = {
  anthropic: 'claude',
  openai: 'openai',
  google: 'gemini',
  xai: 'grok',
  microsoft: 'microsoft',
  meta: 'meta'
}

/** The maker of a model: Copilot's vendor, else its id (`claude-…`, `gpt-…`). A
 *  model on the user's own key is named after its provider (`xai/grok-4.7`). */
export function modelMaker(model: Pick<CopilotModel, 'id' | 'vendor'>): ModelMaker {
  const vendor = VENDORS[(model.vendor ?? '').toLowerCase().replace(/[^a-z]/g, '')]
  if (vendor) return vendor
  const id = (model.id.split('/').pop() ?? '').toLowerCase()
  if (id.startsWith('claude')) return 'claude'
  if (/^(gpt|o\d|openai-|chatgpt)/.test(id)) return 'openai'
  if (id.startsWith('gemini')) return 'gemini'
  if (id.startsWith('grok')) return 'grok'
  if (id.startsWith('mai-')) return 'microsoft'
  if (/^(meta-|llama)/.test(id)) return 'meta'
  return 'other'
}

const IMAGES: Partial<Record<ModelMaker, string>> = {
  claude: claudeSvg,
  gemini: geminiSvg,
  microsoft: microsoftSvg,
  meta: metaSvg
}

/** A model's maker's logo; for an unknown maker, its provider's, else a neutral glyph. */
export function ModelLogo({
  model,
  className = ''
}: {
  model: Pick<CopilotModel, 'id' | 'vendor' | 'byok'>
  className?: string
}): JSX.Element {
  const maker = modelMaker(model)
  if (maker === 'other' && model.byok)
    return <ProviderLogo provider={model.byok.provider} className={className} />
  const image = IMAGES[maker]
  return (
    <span className={`brand-logo ${className}`} aria-hidden="true">
      {image ? (
        <img src={image} alt="" draggable={false} />
      ) : maker === 'openai' ? (
        <OpenAILogo className="brand-logo-mark" />
      ) : maker === 'grok' ? (
        <GrokLogo className="brand-logo-mark" />
      ) : (
        <Codicon name="sparkle" />
      )}
    </span>
  )
}

/** A model provider's logo (Accounts → Model providers, the picker's key tags). */
export function ProviderLogo({
  provider,
  className = ''
}: {
  provider: string
  className?: string
}): JSX.Element {
  return (
    <span className={`brand-logo ${className}`} aria-hidden="true">
      {provider === 'anthropic' ? (
        <AnthropicLogo className="brand-logo-mark brand-logo-mark--wide" />
      ) : provider === 'openai' ? (
        <OpenAILogo className="brand-logo-mark" />
      ) : provider === 'xai' ? (
        <GrokLogo className="brand-logo-mark" />
      ) : provider === 'google' ? (
        <img src={geminiSvg} alt="" draggable={false} />
      ) : (
        <Codicon name="key" />
      )}
    </span>
  )
}
