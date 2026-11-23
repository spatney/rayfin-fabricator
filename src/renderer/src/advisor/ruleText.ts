// The Advisor's rules and areas in the interface's language. Their English is
// rules.json's, which the core also reads for its review prompt, so it stays
// there; the translations are in the advisorRules catalogs, by rule and area id:
// `rules.<rule id>.<field>` and `categories.<area id>.<field>`.
//
// Show a rule's text with these, when it's rendered. Findings, saved reviews and
// prompts for Copilot keep the English.
import { categoryById, ruleById } from '@shared/advisor/catalog'
import type { AdvisorCategoryDef, AdvisorRuleDef } from '@shared/advisor/types'
import { currentLanguage, i18n } from '../i18n'

export type RuleField = 'title' | 'summary' | 'why' | 'fix'
export type CategoryField = 'title' | 'description'

function translated(key: string): string | undefined {
  const language = currentLanguage()
  if (language === 'en') return undefined
  const text: unknown = i18n.getResource(language, 'advisorRules', key)
  return typeof text === 'string' && text.trim() ? text : undefined
}

/** A rule's text in the interface's language, or in English when it has no translation. */
export function ruleText(rule: AdvisorRuleDef, field: RuleField): string {
  return translated(`rules.${rule.id}.${field}`) ?? rule[field]
}

/** An area's text in the interface's language, or in English when it has no translation. */
export function categoryText(category: AdvisorCategoryDef, field: CategoryField): string {
  return translated(`categories.${category.id}.${field}`) ?? category[field]
}

/** An area's name by id, in the interface's language (`fallback` when it isn't an area). */
export function categoryTitle(id: string, fallback = id): string {
  const category = categoryById(id)
  return category ? categoryText(category, 'title') : fallback
}

/**
 * A finding's title in the interface's language. A quick check's finding keeps
 * its rule's English title, so that's translated; a title Copilot wrote is shown
 * as it is.
 */
export function findingTitle(finding: { ruleId?: string; title: string }): string {
  const rule = finding.ruleId ? ruleById(finding.ruleId) : undefined
  return rule && finding.title === rule.title ? ruleText(rule, 'title') : finding.title
}

/** How to fix a finding, in the interface's language when it's its rule's own fix. */
export function findingFix(finding: { ruleId?: string; recommendation?: string }): string {
  const rule = finding.ruleId ? ruleById(finding.ruleId) : undefined
  if (!rule) return finding.recommendation ?? ''
  return !finding.recommendation || finding.recommendation === rule.fix
    ? ruleText(rule, 'fix')
    : finding.recommendation
}
