import type { GoalCheck, GoalResult, GoalsSnapshot } from '@shared/ipc'

/** Where a check stands in the Goals tab. `checking`: the run going now has it. */
export type CheckState = 'passed' | 'failed' | 'not-proven' | 'not-run' | 'checking'

export interface CheckRow {
  check: GoalCheck
  /** The run going now's result when it has one, else the last saved one. */
  result: GoalResult | null
  state: CheckState
  /** The result ran on older code. */
  stale: boolean
}

/** What the rows need from a run: whether it's going, its checks (`null`: not known) and its results. */
export interface LiveRun {
  running: boolean
  checkIds: string[] | null
  results: GoalResult[]
}

/** Each check of `snapshot`, with its result: the live run's first, then the saved one. */
export function checkRows(snapshot: GoalsSnapshot | null, run: LiveRun): CheckRow[] {
  if (!snapshot) return []
  return snapshot.checks.map((check) => {
    const live = run.running ? run.results.find((r) => r.checkId === check.id) : undefined
    if (live) return { check, result: live, state: live.status, stale: false }
    const saved = snapshot.results.find((r) => r.checkId === check.id) ?? null
    if (run.running && run.checkIds?.includes(check.id)) {
      return { check, result: saved, state: 'checking', stale: saved?.stale ?? false }
    }
    if (!saved) return { check, result: null, state: 'not-run', stale: false }
    return { check, result: saved, state: saved.status, stale: saved.stale }
  })
}

/** What keeps an app's checks from all passing on its code as it is now. */
export interface GoalsGap {
  failed: number
  notProven: number
  /** The checks that never ran, or ran on older code. */
  unchecked: string[]
}

/** The gap before publishing, or `null` when there's none, no checks, or they can't run. */
export function goalsGap(snapshot: GoalsSnapshot): GoalsGap | null {
  if (!snapshot.checks.length || snapshot.allPassed || snapshot.cannotRun) return null
  const gap: GoalsGap = { failed: 0, notProven: 0, unchecked: [] }
  for (const check of snapshot.checks) {
    const result = snapshot.results.find((r) => r.checkId === check.id)
    if (!result || result.stale) gap.unchecked.push(check.id)
    else if (result.status === 'failed') gap.failed += 1
    else if (result.status === 'not-proven') gap.notProven += 1
  }
  return gap.failed || gap.notProven || gap.unchecked.length ? gap : null
}

/** Checks that failed on the app's code as it is now (the Goals tab's badge). */
export function failingNow(snapshot: GoalsSnapshot | null): number {
  return snapshot ? snapshot.results.filter((r) => r.status === 'failed' && !r.stale).length : 0
}

/** A pasted list as checks: one per line, without bullets or numbers. */
export function pastedChecks(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:(?:[-*•+]|\d+[.)]|\[[ xX]?\])\s+)+/, '').trim())
    .filter(Boolean)
}

/** A gap in a sentence: “1 check failed and 2 haven’t run on the app as it is now.” */
export function gapText(gap: GoalsGap): string {
  const parts: string[] = []
  const lead = (n: number): string =>
    parts.length ? `${n}` : `${n} ${n === 1 ? 'check' : 'checks'}`
  if (gap.failed) parts.push(`${lead(gap.failed)} failed`)
  if (gap.notProven) parts.push(`${lead(gap.notProven)} couldn’t be proven`)
  const unchecked = gap.unchecked.length
  if (unchecked) {
    parts.push(
      `${lead(unchecked)} ${unchecked === 1 ? 'hasn’t' : 'haven’t'} run on the app as it is now`
    )
  }
  const last = parts.pop()
  return `${parts.length ? `${parts.join(', ')} and ${last}` : last}.`
}

/** Rows whose check failed on the app as it is now, with the result that says how. */
export function failedRows(rows: CheckRow[]): (CheckRow & { result: GoalResult })[] {
  return rows.filter(
    (row): row is CheckRow & { result: GoalResult } =>
      row.state === 'failed' && !row.stale && row.result !== null
  )
}

/**
 * The Build chat message that hands the failed checks among `rows` to Copilot:
 * what the chat shows, and what Copilot reads.
 */
export function fixPrompt(rows: CheckRow[]): { display: string; prompt: string } {
  const failed = failedRows(rows)
  const one = failed.length === 1
  const display = one
    ? `Fix the app so it meets this goal: “${failed[0].check.text}”`
    : `Fix the app so it meets ${failed.length} of its goals`
  const lines = [
    `${one ? 'This check' : 'These checks'} from GOALS.md failed when Fabricator ran ${one ? 'it' : 'them'} on a fresh copy of the app, calling its routes as each kind of user:`,
    ''
  ]
  failed.forEach(({ check, result }, i) => {
    lines.push(`${i + 1}. “${check.text}”`)
    if (result.summary) lines.push(`   What was found: ${result.summary}`)
    if (result.evidence.length)
      lines.push('   Evidence:', ...result.evidence.map((e) => `   - ${e}`))
    if (result.calls.length) lines.push('   Calls made:', ...result.calls.map((c) => `   - ${c}`))
    lines.push('')
  })
  lines.push(
    `Fix the app so it meets ${one ? 'it' : 'them'}, keeping what the other checks in GOALS.md expect. Leave GOALS.md as it is. When you’re done, say what you changed; I’ll run the checks again from the Goals tab.`
  )
  return { display, prompt: lines.join('\n') }
}
