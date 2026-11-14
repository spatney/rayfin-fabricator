import type { ChatFusion } from '@shared/ipc'
import { formatList, translator } from '../../i18n'

/** How Copilot Fusion ran a request, by Copilot's names for its patterns. */
const PATTERN: Record<string, string> = {
  single: 'Single',
  cascade: 'Cascade',
  critique: 'Critique',
  fallback: 'Fallback'
}

/** What a model did in a phase, said when more than one model worked on the turn. */
const DID = {
  primary: 'fusion.did.primary',
  draft: 'fusion.did.draft',
  critic: 'fusion.did.critic',
  revision: 'fusion.did.revision',
  judge: 'fusion.did.judge',
  repair: 'fusion.did.repair',
  follow_up: 'fusion.did.followUp'
} as const

const spoken = (id: string): string => id.replace(/_/g, ' ')

/** What a model did in a phase, in words. */
function phaseDid(phase: string): string {
  return Object.prototype.hasOwnProperty.call(DID, phase)
    ? translator('chat')(DID[phase as keyof typeof DID])
    : spoken(phase)
}

/**
 * The line under a Copilot Fusion turn: the level it ran at, how Fusion ran the
 * request and the models that worked on it, such as "Fusion Max · Single · GPT-6
 * Luna", or "Fusion High · Critique · Claude Sonnet 5 drafted and revised,
 * GPT-5.6 Sol reviewed". `level` is the tier's name, when it's known.
 */
export function describeFusion(
  fusion: ChatFusion,
  modelName: (id: string) => string,
  level?: string
): string {
  const t = translator('chat')
  const how = fusion.patterns.map((p) => PATTERN[p] ?? spoken(p)).join(' + ')
  const several = fusion.models.length > 1
  const models = fusion.models
    .map((m) => {
      const did = several ? formatList(m.phases.map(phaseDid)) : ''
      return did ? t('fusion.modelDid', { model: modelName(m.id), did }) : modelName(m.id)
    })
    .join(', ')
  return [level ? `Fusion ${level}` : 'Copilot Fusion', how, models].filter(Boolean).join(' · ')
}
