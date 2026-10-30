import { describe, expect, it } from 'vitest'
import type { AdvisorFinding } from '@shared/ipc'
import { fixPrompt } from './prompts'

function finding(over: Partial<AdvisorFinding> & Pick<AdvisorFinding, 'id' | 'ruleId'>): AdvisorFinding {
  return {
    category: 'data-model',
    severity: 'medium',
    source: 'quick',
    title: 'A finding',
    detail: 'What is wrong.',
    recommendation: 'How to fix it.',
    ...over
  }
}

const LABEL = finding({
  id: 'ai:accessibility/control-label',
  ruleId: 'accessibility/control-label',
  category: 'accessibility',
  severity: 'medium',
  source: 'ai',
  title: 'Form control has no label',
  file: 'src/pages/Leads.tsx',
  line: 88,
  locations: [{ file: 'src/pages/Leads.tsx', line: 95 }, { file: 'src/pages/Deals.tsx', line: 12 }]
})

const MAX = finding({
  id: 'quick:data-model/text-without-max',
  ruleId: 'data-model/text-without-max',
  severity: 'high',
  title: 'Text field has no maximum length',
  file: 'rayfin/data/Lead.ts',
  line: 7
})

describe('fixPrompt', () => {
  it('lists the findings for the message card in the prompt’s most-severe-first order', () => {
    const { display, prompt, summary } = fixPrompt([LABEL, MAX])
    expect(display).toBe('Fix 2 Advisor issues')
    expect(prompt.indexOf('Text field has no maximum length')).toBeLessThan(prompt.indexOf('Form control has no label'))
    expect(summary.fixes).toEqual([
      {
        id: 'quick:data-model/text-without-max',
        ruleId: 'data-model/text-without-max',
        title: 'Text field has no maximum length',
        severity: 'high',
        category: 'data-model',
        source: 'quick',
        file: 'rayfin/data/Lead.ts',
        line: 7,
        places: undefined
      },
      {
        id: 'ai:accessibility/control-label',
        ruleId: 'accessibility/control-label',
        title: 'Form control has no label',
        severity: 'medium',
        category: 'accessibility',
        source: 'ai',
        file: 'src/pages/Leads.tsx',
        line: 88,
        places: 3
      }
    ])
  })

  it('names a single finding in the bubble text and still carries its card', () => {
    const { display, prompt, summary } = fixPrompt([finding({ ...MAX, severity: 'critical' })])
    expect(display).toBe('Fix: Text field has no maximum length')
    expect(prompt).toContain('The Advisor flagged an issue in this app.')
    expect(summary.fixes).toHaveLength(1)
    expect(summary.fixes[0]).toMatchObject({ id: MAX.id, severity: 'high' })
  })

  it('tells Copilot the fix shows in the local preview and leaves publishing to the user', () => {
    for (const findings of [[MAX], [LABEL, MAX]]) {
      const { prompt } = fixPrompt(findings)
      expect(prompt).toContain(
        "Don't publish the app or run `rayfin up`: the change shows in Fabricator's local preview, and it reaches the published app when the user publishes."
      )
      expect(prompt).not.toMatch(/deploy/i)
    }
  })
})
