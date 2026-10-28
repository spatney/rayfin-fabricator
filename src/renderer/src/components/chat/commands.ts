import type { ChatMode } from '@shared/ipc'

export interface SlashCommand {
  name: string
  label: string
  description: string
  mode: ChatMode
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'plan',
    label: '/plan',
    description: 'create an implementation plan before coding',
    mode: 'plan'
  },
  {
    name: 'autopilot',
    label: '/autopilot',
    description: 'switch to autopilot mode with an objective',
    mode: 'autopilot'
  },
  {
    name: 'agent',
    label: '/agent',
    description: 'Default interactive agent mode',
    mode: 'agent'
  }
]

/**
 * Rank available slash commands for a query.
 * Prefix matches on command name rank first, then substring matches, then description matches.
 */
export function rankCommands(query: string): SlashCommand[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...SLASH_COMMANDS]

  const scored: { cmd: SlashCommand; score: number }[] = []
  for (const cmd of SLASH_COMMANDS) {
    const name = cmd.name.toLowerCase()
    let score = -1

    if (name.startsWith(q)) {
      score = 0
    } else if (name.includes(q)) {
      score = 1
    } else {
      const words = cmd.description.toLowerCase().split(/\s+/)
      if (words.some((w) => w.startsWith(q))) {
        score = 2
      } else if (q.length >= 3 && cmd.description.toLowerCase().includes(q)) {
        score = 3
      }
    }

    if (score >= 0) {
      scored.push({ cmd, score })
    }
  }

  scored.sort((a, b) => a.score - b.score || a.cmd.name.length - b.cmd.name.length)
  return scored.map((item) => item.cmd)
}

export interface ParsedSlashCommand {
  command: SlashCommand
  prompt: string
  isBare: boolean
}

/**
 * Parse an input string for a slash command.
 * Matches input starting with `/name`, extracting the command and any trailing prompt text.
 */
export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  const match = /^\s*\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(input)
  if (!match) {
    // Check if it's a bare command without whitespace: e.g. "/plan"
    const bareMatch = /^\s*\/([a-zA-Z0-9_-]+)\s*$/.exec(input)
    if (!bareMatch) return null
    const name = bareMatch[1].toLowerCase()
    const command = SLASH_COMMANDS.find((c) => c.name.toLowerCase() === name)
    if (!command) return null
    return { command, prompt: '', isBare: true }
  }

  const name = match[1].toLowerCase()
  const command = SLASH_COMMANDS.find((c) => c.name.toLowerCase() === name)
  if (!command) return null

  const prompt = (match[2] ?? '').trim()
  return {
    command,
    prompt,
    isBare: prompt.length === 0
  }
}

/**
 * Returns a short display label for an active mode badge in the composer,
 * or null if the mode is the default interactive agent.
 */
export function modeBadgeLabel(mode: ChatMode): string | null {
  switch (mode) {
    case 'plan':
      return 'Plan'
    case 'autopilot':
      return 'Autopilot'
    case 'agent':
    default:
      return null
  }
}

/**
 * Returns a tailored composer placeholder when an explicit non-default mode is active.
 */
export function modePlaceholder(mode: ChatMode, defaultPlaceholder: string): string {
  switch (mode) {
    case 'plan':
      return 'Message in Plan mode (Copilot will draft a plan for review)…'
    case 'autopilot':
      return 'Message in Autopilot mode (Copilot will run autonomously)…'
    default:
      return defaultPlaceholder
  }
}
