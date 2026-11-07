import { describe, expect, it } from 'vitest'
import type { TeamMapRun, TeamSessionStatus } from '@shared/ipc'
import { activityRunFor, appRunsKey, asAppRun, withActivity } from './appRun'

const BRANCH = 'fabricator/me/dash-20261003-191000'

function run(over: Partial<TeamMapRun>): TeamMapRun {
  return { id: 1, kind: 'preview', status: 'in_progress', url: 'https://run/1', sha: 'abc', branch: BRANCH, jobs: [], ...over }
}

function status(over: Partial<TeamSessionStatus> = {}): TeamSessionStatus {
  return {
    ok: true,
    branch: BRANCH,
    unpublished: 1,
    dirty: false,
    behind: 0,
    conflicted: false,
    requireReview: false,
    ...over
  }
}

describe('this app’s run, from the workspace activity', () => {
  it('finds its preview by branch and its publish by job', () => {
    const preview = run({
      jobs: [
        { name: 'Plan', status: 'completed', conclusion: 'success', steps: [] },
        { name: 'Preview dash', folder: 'dash', status: 'in_progress', steps: [{ name: 'Install dependencies', status: 'in_progress' }] }
      ]
    })
    const teammate = run({ id: 2, branch: 'fabricator/amy/dash-20261003-120000' })
    const publish = run({ id: 3, kind: 'production', branch: 'main', jobs: [{ name: 'Deploy dash', folder: 'dash', status: 'queued', steps: [] }] })
    const other = run({ id: 4, kind: 'production', branch: 'main', jobs: [{ name: 'Deploy trips', folder: 'trips', status: 'queued', steps: [] }] })
    expect(activityRunFor([teammate, other, preview], 'dash', BRANCH)?.id).toBe(1)
    expect(activityRunFor([teammate, publish], 'dash', BRANCH)?.id).toBe(3)
    expect(activityRunFor([teammate, other], 'dash', BRANCH)).toBeUndefined()
    expect(activityRunFor([{ ...preview, status: 'completed' }], 'dash', BRANCH)).toBeUndefined()
    expect(asAppRun(preview, 'dash')).toMatchObject({
      id: 1,
      kind: 'preview',
      status: 'in_progress',
      url: 'https://run/1',
      steps: [{ name: 'Install dependencies', status: 'in_progress' }]
    })
    // Still planning: no steps yet.
    expect(asAppRun(run({}), 'dash').steps).toEqual([])
  })

  it('fills in the app’s run until its own status has it', () => {
    const runs = [run({})]
    expect(withActivity(status(), runs, 'dash')?.run?.id).toBe(1)
    const own = { id: 9, kind: 'preview' as const, status: 'in_progress', url: '', sha: '', steps: [] }
    expect(withActivity(status({ run: own }), runs, 'dash')?.run?.id).toBe(9)
    expect(withActivity(status({ run: { ...own, status: 'completed' } }), runs, 'dash')?.run?.id).toBe(1)
    expect(withActivity(status(), [], 'dash')?.run).toBeUndefined()
    expect(withActivity(undefined, runs, 'dash')).toBeUndefined()
  })

  it('changes its key when one of the app’s runs starts or finishes', () => {
    const started = appRunsKey([run({})], 'dash', BRANCH)
    expect(started).toBe('1:in_progress')
    expect(appRunsKey([run({ status: 'completed' })], 'dash', BRANCH)).toBe('1:completed')
    expect(appRunsKey([run({ branch: 'fabricator/amy/dash-20261003-120000' })], 'dash', BRANCH)).toBe('')
    expect(appRunsKey([run({})], undefined, BRANCH)).toBe('')
  })
})
