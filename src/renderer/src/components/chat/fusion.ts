import type { ChatFusion } from '@shared/ipc'

/** How Copilot Fusion ran a request, by Copilot's names for its patterns. */
const PATTERN: Record<string, string> = {
  single: 'Single',
  cascade: 'Cascade',
  critique: 'Critique',
  fallback: 'Fallback'
}

/** What a model did in a phase, said when more than one model worked on the turn. */
const DID: Record<string, string> = {
  primary: 'answered',
  draft: 'drafted',
  critic: 'reviewed',
  revision: 'revised',
  judge: 'checked',
  repair: 'repaired',
  follow_up: 'continued'
}

const spoken = (id: string): string => id.replace(/_/g, ' ')

/** "a", "a and b", "a, b and c". */
function joinAnd(items: string[]): string {
  if (items.length < 2) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
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
  const how = fusion.patterns.map((p) => PATTERN[p] ?? spoken(p)).join(' + ')
  const several = fusion.models.length > 1
  const models = fusion.models
    .map((m) => {
      const did = several ? joinAnd(m.phases.map((p) => DID[p] ?? spoken(p))) : ''
      return did ? `${modelName(m.id)} ${did}` : modelName(m.id)
    })
    .join(', ')
  return [level ? `Fusion ${level}` : 'Copilot Fusion', how, models].filter(Boolean).join(' · ')
}
