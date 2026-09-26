import type { ChatMode, ReasoningEffort } from '@shared/ipc'

/** Reasoning efforts shown when the engine's per-model list is unavailable
 * (offline / pre-fetch / signed-out). Also defines the canonical display order. */
export const EFFORT_OPTIONS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const EFFORT_ORDER: ReasoningEffort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max']

/** Composer mode options (Agent / Plan / Autopilot) with hover hints + menu copy. */
export const MODES: { id: ChatMode; label: string; hint: string; desc: string }[] = [
  {
    id: 'agent',
    label: 'Agent',
    hint: 'Agent — do the work, auto-approving tools (default).',
    desc: 'Does the work for you, auto-approving tools. The everyday default.'
  },
  {
    id: 'plan',
    label: 'Plan',
    hint: 'Plan — research first, then propose a plan for your approval before acting.',
    desc: 'Researches first, then proposes a plan for your approval before acting.'
  },
  {
    id: 'autopilot',
    label: 'Autopilot',
    hint: 'Autopilot — run autonomously end-to-end, auto-approving tools.',
    desc: 'Runs autonomously end-to-end, auto-approving tools.'
  }
]
