import { afterEach, describe, expect, it } from 'vitest'
import { CATEGORIES, RULES } from '@shared/advisor/catalog'
import { i18n, setLanguage } from '../i18n'
import { categoryText, ruleText } from './ruleText'

describe('ruleText', () => {
  afterEach(async () => {
    await setLanguage('en')
    localStorage.clear()
  })

  it('shows a rule and an area in the language shown, else in English', async () => {
    const rule = RULES[0]
    const area = CATEGORIES[0]
    expect(ruleText(rule, 'title')).toBe(rule.title)
    await setLanguage('de')
    i18n.addResource('de', 'advisorRules', `rules.${rule.id}.title`, 'Regel auf Deutsch')
    i18n.addResource('de', 'advisorRules', `categories.${area.id}.title`, 'Bereich auf Deutsch')
    expect(ruleText(rule, 'title')).toBe('Regel auf Deutsch')
    expect(categoryText(area, 'title')).toBe('Bereich auf Deutsch')
    expect(ruleText({ ...rule, id: 'test/untranslated' }, 'why')).toBe(rule.why)
    expect(categoryText({ ...area, id: 'untranslated' as typeof area.id }, 'description')).toBe(
      area.description
    )
  })
})
