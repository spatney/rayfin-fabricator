import { describe, expect, it } from 'vitest'
import {
  modeBadgeLabel,
  modePlaceholder,
  parseSlashCommand,
  rankCommands,
  SLASH_COMMANDS
} from './commands'

describe('slash commands', () => {
  it('registers expected commands', () => {
    const names = SLASH_COMMANDS.map((c) => c.name)
    expect(names).toEqual(['plan', 'autopilot', 'agent'])
  })

  describe('rankCommands', () => {
    it('returns all commands for empty query', () => {
      expect(rankCommands('')).toHaveLength(3)
      expect(rankCommands('   ')).toHaveLength(3)
    })

    it('filters commands by prefix match', () => {
      const planMatches = rankCommands('pl')
      expect(planMatches).toHaveLength(1)
      expect(planMatches[0].name).toBe('plan')

      const autoMatches = rankCommands('auto')
      expect(autoMatches).toHaveLength(1)
      expect(autoMatches[0].name).toBe('autopilot')
    })

    it('filters commands by description substring', () => {
      const results = rankCommands('implementation plan before coding')
      expect(results).toHaveLength(1)
      expect(results[0].name).toBe('plan')
    })

    it('returns empty array when no commands match', () => {
      expect(rankCommands('xyz123')).toHaveLength(0)
    })
  })

  describe('parseSlashCommand', () => {
    it('parses bare slash commands', () => {
      const plan = parseSlashCommand('/plan')
      expect(plan).not.toBeNull()
      expect(plan?.command.name).toBe('plan')
      expect(plan?.isBare).toBe(true)
      expect(plan?.prompt).toBe('')

      const auto = parseSlashCommand('  /autopilot  ')
      expect(auto).not.toBeNull()
      expect(auto?.command.name).toBe('autopilot')
      expect(auto?.isBare).toBe(true)
      expect(auto?.prompt).toBe('')

      const agent = parseSlashCommand('/agent')
      expect(agent?.command.name).toBe('agent')
      expect(agent?.isBare).toBe(true)
    })

    it('parses slash commands with prompts', () => {
      const plan = parseSlashCommand('/plan build an expense tracker')
      expect(plan).not.toBeNull()
      expect(plan?.command.name).toBe('plan')
      expect(plan?.command.mode).toBe('plan')
      expect(plan?.isBare).toBe(false)
      expect(plan?.prompt).toBe('build an expense tracker')

      const auto = parseSlashCommand('/autopilot refactor the auth service')
      expect(auto).not.toBeNull()
      expect(auto?.command.name).toBe('autopilot')
      expect(auto?.command.mode).toBe('autopilot')
      expect(auto?.isBare).toBe(false)
      expect(auto?.prompt).toBe('refactor the auth service')
    })

    it('handles uppercase and mixed case command names', () => {
      const plan = parseSlashCommand('/PLAN build something')
      expect(plan?.command.name).toBe('plan')
      expect(plan?.prompt).toBe('build something')
    })

    it('returns null for non-command or unrecognized inputs', () => {
      expect(parseSlashCommand('hello /plan')).toBeNull()
      expect(parseSlashCommand('/unknown')).toBeNull()
      expect(parseSlashCommand('/unknown command')).toBeNull()
      expect(parseSlashCommand('regular text')).toBeNull()
      expect(parseSlashCommand('')).toBeNull()
    })
  })

  describe('modeBadgeLabel & modePlaceholder', () => {
    it('returns badge labels for non-default modes', () => {
      expect(modeBadgeLabel('plan')).toBe('Plan')
      expect(modeBadgeLabel('autopilot')).toBe('Autopilot')
      expect(modeBadgeLabel('agent')).toBeNull()
    })

    it('tailors placeholders based on mode', () => {
      const def = 'Message Fabricator…'
      expect(modePlaceholder('plan', def)).toContain('Plan mode')
      expect(modePlaceholder('autopilot', def)).toContain('Autopilot mode')
      expect(modePlaceholder('agent', def)).toBe(def)
    })
  })
})
