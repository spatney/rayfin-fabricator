/**
 * Runs the catalog's quick rules over a project snapshot and derives the facts
 * the Copilot deep review is grounded on.
 */
import type {
  AdvisorCondition,
  AdvisorFacts,
  AdvisorFinding,
  AdvisorQuickRef,
  AdvisorRuleResult,
  RayfinVersionInfo
} from '@shared/ipc'
import { QUICK_RULES, ruleApplies } from '@shared/advisor/catalog'
import { translator } from '../i18n'
import { buildQuickContext, type QuickContext } from './context'
import { toFinding } from './quick'
import { QUICK_IMPLS } from './rules'

export interface QuickCheckResult {
  findings: AdvisorFinding[]
  results: AdvisorRuleResult[]
  conditions: AdvisorCondition[]
  facts: AdvisorFacts
  /** Every project file path the snapshot listed (for linking file mentions). */
  files: string[]
  ranAt: string
  /** The snapshot hit its size caps, so some files weren't checked. */
  truncated: boolean
}

export function runQuickRules(ctx: QuickContext): { findings: AdvisorFinding[]; results: AdvisorRuleResult[] } {
  const t = translator('advisor')
  const findings: AdvisorFinding[] = []
  const results: AdvisorRuleResult[] = []
  for (const rule of QUICK_RULES) {
    if (!ruleApplies(rule, ctx.conditions)) {
      results.push({ ruleId: rule.id, status: 'na' })
      continue
    }
    const impl = QUICK_IMPLS.get(rule.id)
    if (!impl) {
      results.push({ ruleId: rule.id, status: 'skipped', note: t('engine.noQuickCheck') })
      continue
    }
    let out: ReturnType<typeof impl.run>
    try {
      out = impl.run(ctx)
    } catch (err) {
      results.push({
        ruleId: rule.id,
        status: 'skipped',
        note: t('engine.checkFailed', { error: String(err) })
      })
      continue
    }
    if (out === 'na' || out === 'skipped') {
      results.push({ ruleId: rule.id, status: out })
    } else if (out.length === 0) {
      results.push({ ruleId: rule.id, status: 'pass' })
    } else {
      findings.push(toFinding(rule, impl, out, ctx))
      results.push({ ruleId: rule.id, status: 'fail' })
    }
  }
  return { findings, results }
}

/** Describe the app's stack in a few words for the review prompt. */
function stackOf(ctx: QuickContext): string {
  const parts: string[] = []
  if (ctx.hasDependency('react')) parts.push('React')
  if (ctx.hasDependency('vite')) parts.push('Vite')
  if (ctx.hasDependency('react-router-dom') || ctx.hasDependency('react-router')) parts.push('React Router')
  if (ctx.conditions.has('fabricSso')) parts.push('Fabric SSO')
  if (ctx.hasDependency('graphein')) parts.push('Graphein charts')
  if (ctx.hasDependency('@microsoft/fabric-app-data')) parts.push('Power BI semantic-model analytics (fabric-app-data)')
  if (ctx.conditions.has('connectors')) parts.push('Rayfin connectors')
  return parts.join(', ')
}

export function buildFacts(ctx: QuickContext): AdvisorFacts {
  const services = Object.entries((ctx.yml?.data.services as Record<string, unknown>) ?? {})
    .filter(([, v]) => (v as { enabled?: unknown } | null)?.enabled === true)
    .map(([k]) => k)
  const latest = new Map((ctx.versions?.packages ?? []).map((p) => [p.name, p.latest ?? undefined]))
  const names = new Set([
    ...ctx.packages.filter((p) => p.declared).map((p) => p.name),
    ...(ctx.versions?.packages ?? []).map((p) => p.name)
  ])
  const versions = [...names].sort().map((name) => ({
    name,
    installed: ctx.packages.find((p) => p.name === name)?.installed ?? undefined,
    latest: latest.get(name)
  }))
  return {
    services,
    conditions: [...ctx.conditions],
    entities: ctx.model.entities.map((e) => ({ name: e.name, file: e.file, access: e.access.label })),
    versions,
    stack: stackOf(ctx) || undefined
  }
}

/** Collect a project's snapshot and run every applicable quick rule. */
export async function runQuickChecks(
  projectId: string,
  versions: RayfinVersionInfo | null
): Promise<QuickCheckResult> {
  const snapshot = await window.api.advisor.collect(projectId)
  const ctx = await buildQuickContext(snapshot, versions)
  const { findings, results } = runQuickRules(ctx)
  return {
    findings,
    results,
    conditions: [...ctx.conditions],
    facts: buildFacts(ctx),
    files: snapshot.files.map((f) => f.path),
    ranAt: new Date().toISOString(),
    truncated: Boolean(snapshot.truncated)
  }
}

/** Quick findings the deep review is told not to repeat. */
export function quickRefs(findings: AdvisorFinding[]): AdvisorQuickRef[] {
  return findings.map((f) => ({ ruleId: f.ruleId, title: f.title, file: f.file, line: f.line }))
}
