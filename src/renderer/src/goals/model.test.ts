import { describe, expect, it } from 'vitest'
import type { GoalResult, GoalStatus, GoalsSnapshot } from '@shared/ipc'
import { checkRows, failingNow, fixPrompt, gapText, goalsGap, pastedChecks } from './model'

const checks = [
  { id: 'a', text: 'An approver sees only their team’s requests' },
  { id: 'b', text: 'A requester can’t approve their own request' },
  { id: 'c', text: 'Totals match the line items' }
]

function result(checkId: string, status: GoalStatus, stale = false): GoalResult {
  return {
    checkId,
    check: checks.find((c) => c.id === checkId)?.text ?? checkId,
    status,
    summary: `${checkId} ${status}`,
    calls: [`GET /api/${checkId} as approver → 200`],
    evidence: [`saw ${checkId}`],
    ranAt: '2026-11-01T10:00:00Z',
    fingerprint: 'f1',
    stale
  }
}

function snapshot(results: GoalResult[], extra: Partial<GoalsSnapshot> = {}): GoalsSnapshot {
  return {
    exists: true,
    purpose: 'Expense approvals for Contoso',
    checks,
    results,
    lastRun: null,
    allPassed: false,
    cannotRun: null,
    running: false,
    ...extra
  }
}

const idle = { running: false, checkIds: null, results: [] }

describe('Goals model', () => {
  it('shows a running run’s results first, and the checks it hasn’t reached as checking', () => {
    const saved = snapshot([result('a', 'failed'), result('b', 'passed', true)])
    const rows = checkRows(saved, {
      running: true,
      checkIds: ['a', 'b'],
      results: [result('a', 'passed')]
    })
    expect(rows.map((r) => [r.state, r.stale])).toEqual([
      ['passed', false],
      ['checking', true],
      ['not-run', false]
    ])
    expect(checkRows(saved, idle).map((r) => r.state)).toEqual(['failed', 'passed', 'not-run'])
  })

  it('counts checks that ran on older code as unchecked, not by their old outcome', () => {
    const gap = goalsGap(snapshot([result('a', 'failed'), result('b', 'failed', true)]))
    expect(gap).toEqual({ failed: 1, notProven: 0, unchecked: ['b', 'c'] })
    expect(gapText(gap!)).toBe('1 check failed and 2 haven’t run on the app as it is now.')
    expect(failingNow(snapshot([result('a', 'failed'), result('b', 'failed', true)]))).toBe(1)
  })

  it('has no gap when every check passed, the checks can’t run, or there are none', () => {
    const passed = [result('a', 'passed'), result('b', 'passed'), result('c', 'passed')]
    expect(goalsGap(snapshot(passed, { allPassed: true }))).toBeNull()
    expect(goalsGap(snapshot([], { cannotRun: 'Team apps can’t run checks yet.' }))).toBeNull()
    expect(goalsGap(snapshot([], { checks: [] }))).toBeNull()
  })

  it('words a gap with each kind it has', () => {
    expect(gapText({ failed: 0, notProven: 2, unchecked: [] })).toBe('2 checks couldn’t be proven.')
    expect(gapText({ failed: 1, notProven: 1, unchecked: ['c'] })).toBe(
      '1 check failed, 1 couldn’t be proven and 1 hasn’t run on the app as it is now.'
    )
  })

  it('hands Copilot only the checks that failed on the code as it is now', () => {
    const saved = snapshot([
      result('a', 'failed'),
      result('b', 'failed', true),
      result('c', 'not-proven')
    ])
    const one = fixPrompt(checkRows(saved, idle))
    expect(one.display).toBe(`Fix the app so it meets this goal: “${checks[0].text}”`)
    expect(one.prompt).toContain('GET /api/a as approver → 200')
    expect(one.prompt).not.toContain(checks[1].text)
    expect(one.prompt).not.toContain(checks[2].text)

    const two = fixPrompt(checkRows(snapshot([result('a', 'failed'), result('c', 'failed')]), idle))
    expect(two.display).toBe('Fix the app so it meets 2 of its goals')
  })

  it('splits a pasted list into checks without its bullets, numbers or boxes', () => {
    const pasted =
      '- Approvers see their team\r\n\n2. Totals add up\n* [ ] Requesters can’t approve\n  - [x] Nested done\n'
    expect(pastedChecks(pasted)).toEqual([
      'Approvers see their team',
      'Totals add up',
      'Requesters can’t approve',
      'Nested done'
    ])
  })
})
