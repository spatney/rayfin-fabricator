import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { GoalResult, GoalsSnapshot, StudioProject } from '@shared/ipc'
import type { GoalsController } from '../../goals/store'
import { AUTO_SELECTION } from '../../modelSelection'
import GoalsView from './GoalsView'

const project: StudioProject = {
  id: 'p1',
  name: 'Expenses',
  path: 'C:\\apps\\expenses',
  addedAt: '2026-11-01T00:00:00.000Z'
}

const checks = [
  { id: 'c1', text: 'An employee can submit an expense, then find it in their list.' },
  { id: 'c2', text: 'An employee can’t see another employee’s expenses.' },
  { id: 'c3', text: 'A manager can approve an expense from their team.' },
  { id: 'c4', text: 'An employee can’t approve their own expense.' }
]

function passed(checkId: string, stale = false): GoalResult {
  const check = checks.find((c) => c.id === checkId)!
  return {
    checkId,
    check: check.text,
    status: 'passed',
    summary: 'The app did it.',
    calls: [],
    evidence: [],
    ranAt: new Date().toISOString(),
    fingerprint: 'f1',
    stale
  }
}

function snapshot(results: GoalResult[]): GoalsSnapshot {
  return {
    exists: true,
    purpose: 'Employees submit expenses; managers approve them.',
    checks,
    results,
    lastRun: null,
    allPassed: false,
    running: false
  }
}

function controller(snap: GoalsSnapshot): GoalsController {
  return {
    projectId: 'p1',
    loading: false,
    loadError: null,
    snapshot: snap,
    run: {
      running: false,
      adopted: false,
      startedAt: 0,
      checkIds: null,
      phase: null,
      activity: [],
      results: [],
      stopping: false
    },
    runError: null,
    dismissRunError: vi.fn(),
    draft: { running: false, activity: [] },
    draftError: null,
    dismissDraftError: vi.fn(),
    selection: AUTO_SELECTION,
    setSelection: vi.fn(),
    reload: vi.fn(async () => snap),
    save: vi.fn(async () => {}),
    startRun: vi.fn(),
    cancelRun: vi.fn(),
    startDraft: vi.fn(async () => null),
    cancelDraft: vi.fn()
  }
}

function renderView(goals: GoalsController, chatBusy = false): void {
  render(
    <GoalsView
      project={project}
      goals={goals}
      visible
      chatBusy={chatBusy}
      onFix={vi.fn()}
      onOpenFile={vi.fn()}
    />
  )
}

afterEach(() => cleanup())

describe('GoalsView', () => {
  it('runs only the checks without a result on the app as it is now', () => {
    const goals = controller(snapshot([passed('c1'), passed('c3', true)]))
    renderView(goals)

    fireEvent.click(screen.getByRole('button', { name: 'Run 3 checks' }))

    expect(goals.startRun).toHaveBeenCalledWith(['c2', 'c3', 'c4'])
  })

  it('leaves running every check to Run checks', () => {
    const goals = controller(snapshot([passed('c1', true)]))
    renderView(goals)

    expect(screen.getByRole('button', { name: 'Run checks' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Run \d+ checks?$/ })).toBeNull()
  })

  it('waits for the Build chat before running the rest', () => {
    renderView(controller(snapshot([passed('c1'), passed('c2'), passed('c3')])), true)

    const button = screen.getByRole('button', { name: 'Run 1 check' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.title).toBe(
      'Copilot is changing the app in the Build chat. Run the checks once it’s done.'
    )
  })
})
