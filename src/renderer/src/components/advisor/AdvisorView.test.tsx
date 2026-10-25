import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { AdvisorFinding, StudioProject } from '@shared/ipc'
import { CATALOG } from '@shared/advisor/catalog'
import { buildQuickContext } from '../../advisor/context'
import { buildFacts, runQuickRules, type QuickCheckResult } from '../../advisor/engine'
import { normalizeSnapshot } from '../../advisor/legacy'
import { deriveAdvisor, emptyState } from '../../advisor/lifecycle'
import type { AdvisorController } from '../../advisor/store'
import { GOOD_PROJECT, snapshotOf, versionInfo } from '../../advisor/testFixtures'
import { AUTO_SELECTION } from '../../modelSelection'
import AdvisorView from './AdvisorView'

const project: StudioProject = {
  id: 'p1',
  name: 'Todos',
  path: 'C:\\apps\\todos',
  addedAt: '2026-09-26T00:00:00.000Z'
}

const TODO = GOOD_PROJECT['rayfin/data/Todo.ts']

async function quickFor(overrides: Record<string, string>): Promise<QuickCheckResult> {
  const snapshot = snapshotOf({ ...GOOD_PROJECT, ...overrides })
  const ctx = await buildQuickContext(snapshot, versionInfo())
  const { findings, results } = runQuickRules(ctx)
  return {
    findings,
    results,
    conditions: [...ctx.conditions],
    facts: buildFacts(ctx),
    files: snapshot.files.map((f) => f.path),
    ranAt: new Date().toISOString(),
    truncated: false
  }
}

const aiFinding: AdvisorFinding = {
  id: 'ai:queries/unpaginated-list:abc',
  ruleId: 'queries/unpaginated-list',
  category: 'queries',
  severity: 'high',
  source: 'ai',
  title: 'Todo list stops at 100 rows',
  detail: '`listTodos` uses `.execute()` for a list that grows.',
  recommendation: 'Paginate with `.first(50).executePaginated()`.',
  file: 'src/services/todos.ts',
  line: 4,
  excerpt: "export async function listTodos() {\n  return client.data.Todo.select(['id']).execute();\n}",
  excerptStart: 3,
  verified: true
}

function controller(
  quick: QuickCheckResult | null,
  over: Partial<AdvisorController> = {},
  deepFindings: AdvisorFinding[] | null = null,
  schemaVersion = 2
): AdvisorController {
  const deep = deepFindings
    ? normalizeSnapshot({
        schemaVersion: schemaVersion || undefined,
        catalogVersion: CATALOG.catalogVersion,
        report: { ok: true, summary: 'Mostly solid; one list needs paging.', findings: deepFindings, rules: [] },
        analyzedAt: new Date().toISOString(),
        durationMs: 1000,
        stale: false
      })
    : null
  const state = over.state ?? emptyState()
  const review = over.review ?? { running: false, startedAt: 0, activity: [], findings: [], results: [] }
  const deepCurrent = Boolean(deep && !deep.legacy)
  const derived = deriveAdvisor({
    quick,
    deep,
    live: review.running ? { findings: review.findings, results: review.results } : null,
    state,
    deepCurrent
  })
  return {
    projectId: 'p1',
    loading: false,
    quick,
    quickRunning: false,
    quickError: null,
    deep,
    deepCurrent,
    review,
    derived,
    state,
    selection: AUTO_SELECTION,
    setSelection: vi.fn(),
    refreshQuick: vi.fn(),
    startReview: vi.fn(async () => {}),
    cancelReview: vi.fn(),
    dismiss: vi.fn(),
    undismiss: vi.fn(),
    mute: vi.fn(),
    unmute: vi.fn(),
    clearResolved: vi.fn(),
    handOff: vi.fn(),
    explains: {},
    explaining: null,
    explain: vi.fn(),
    cancelExplain: vi.fn(),
    verify: { running: false, ids: [] },
    startVerify: vi.fn(async () => {}),
    cancelVerify: vi.fn(),
    ...over
  }
}

function renderView(advisor: AdvisorController, chatBusy = false, openRequest?: { id: string; nonce: number }) {
  const onFix = vi.fn()
  const onOpenFile = vi.fn()
  const utils = render(
    <AdvisorView
      project={project}
      advisor={advisor}
      chatBusy={chatBusy}
      onFix={onFix}
      onOpenFile={onOpenFile}
      openRequest={openRequest}
    />
  )
  return { ...utils, onFix, onOpenFile }
}

afterEach(() => cleanup())

const BROKEN = {
  'rayfin/data/Todo.ts': TODO.replace('@text({ max: 200 }) title', '@text() title').replace(
    "@authenticated('*', {\n  policy: (claims, item) => claims.sub.eq(item.user_id),\n})",
    "@authenticated('*')"
  )
}

const WITH_SUGGESTION = {
  'rayfin/data/Todo.ts': TODO.replace('entity, authenticated,', 'entity, role,').replace(
    "@authenticated('*', {",
    "@role('authenticated', '*', {"
  )
}

function areas(): HTMLElement {
  return screen.getByRole('region', { name: 'Checks by area' })
}

describe('AdvisorView', () => {
  it('summarizes the app with a grade, severity chips, and a strip of every check', async () => {
    const { container } = renderView(controller(await quickFor(BROKEN)))
    expect(screen.getByRole('img', { name: /Health grade C, score 70/ })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '2 issues need attention' })).toBeTruthy()
    expect(screen.getByText('2 high')).toBeTruthy()
    const legend = container.querySelector('.adv-meter-legend')!.textContent
    expect(legend).toContain('2 checks with issues')
    expect(legend).toMatch(/\d+ need a deep review/)
    expect(container.querySelectorAll('.adv-meter-block--high')).toHaveLength(2)
    expect(within(areas()).getByRole('button', { name: /Data policies/ }).textContent).toMatch(/1 issue/)
  })

  it('opens an issue in place with its evidence and hands it to Copilot', async () => {
    const { onFix, onOpenFile } = renderView(controller(await quickFor(BROKEN)))
    const row = screen.getByRole('button', { name: /Text field has no maximum length/ })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    const detail = screen.getByRole('article', { name: 'Text field has no maximum length' })
    expect(within(detail).getByText('data-model/text-without-max')).toBeTruthy()
    expect(within(detail).getByRole('group', { name: 'Code from rayfin/data/Todo.ts' }).textContent).toContain('@text() title')
    fireEvent.click(within(detail).getByRole('button', { name: /rayfin\/data\/Todo.ts:7/ }))
    expect(onOpenFile).toHaveBeenCalledWith('rayfin/data/Todo.ts', 7)
    fireEvent.click(within(detail).getByRole('button', { name: /Fix with Copilot/ }))
    expect(onFix).toHaveBeenCalledWith([expect.objectContaining({ ruleId: 'data-model/text-without-max' })])
    fireEvent.click(row)
    expect(screen.queryByRole('article')).toBeNull()
  })

  it('fixes a suggestion opened from an area without lowering the health score', async () => {
    const quick = await quickFor(WITH_SUGGESTION)
    const { onFix } = renderView(controller(quick))
    expect(screen.getByRole('img', { name: /Health grade A, score 100/ })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Looking good' })).toBeTruthy()
    fireEvent.click(within(areas()).getByRole('button', { name: /Data policies/ }))
    fireEvent.click(within(areas()).getByRole('button', { name: /View suggestion/ }))
    const detail = screen.getByRole('article', { name: 'Use the @authenticated / @anonymous shorthand' })
    fireEvent.click(within(detail).getByRole('button', { name: /Fix with Copilot/ }))
    expect(onFix).toHaveBeenCalledExactlyOnceWith(quick.findings)
  })

  it('fixes a selection, or everything open, from the header', async () => {
    const { onFix } = renderView(controller(await quickFor(BROKEN)))
    expect(screen.getByRole('button', { name: /Fix 2 with Copilot/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: /Select “Per-user data isn't restricted/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Fix selected (1)' }))
    expect(onFix).toHaveBeenCalledWith([expect.objectContaining({ ruleId: 'policy/owner-field-without-policy' })])
  })

  it('includes suggestions in selected and all-open fixes', async () => {
    const quick = await quickFor(WITH_SUGGESTION)
    const { onFix } = renderView(controller(quick, {}, [aiFinding]))
    fireEvent.click(screen.getByRole('checkbox', { name: /Select “Use the @authenticated/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Fix selected (1)' }))
    expect(onFix).toHaveBeenNthCalledWith(1, quick.findings)
    fireEvent.click(screen.getByRole('button', { name: 'Fix 2 with Copilot' }))
    expect(onFix).toHaveBeenNthCalledWith(2, [aiFinding, ...quick.findings])
  })

  it('pauses fixes while the Build chat is busy', async () => {
    const { onFix } = renderView(controller(await quickFor(WITH_SUGGESTION), {}, [aiFinding]), true)
    expect((screen.getByRole('button', { name: /Fix 2 with Copilot/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/Fix is paused until it finishes/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Use the @authenticated/ }))
    const fix = screen.getByRole<HTMLButtonElement>('button', { name: 'Fix with Copilot' })
    expect(fix.disabled).toBe(true)
    fireEvent.click(fix)
    fireEvent.click(screen.getByRole('checkbox', { name: /Select “Use the @authenticated/ }))
    const fixSelected = screen.getByRole<HTMLButtonElement>('button', { name: 'Fix selected (1)' })
    expect(fixSelected.disabled).toBe(true)
    fireEvent.click(fixSelected)
    expect(onFix).not.toHaveBeenCalled()
  })

  it('opens the issue a chat fix card asks for, or the list it moved to', async () => {
    const quick = await quickFor(BROKEN)
    const id = quick.findings.find((f) => f.ruleId === 'data-model/text-without-max')!.id
    const { rerender } = renderView(controller(quick), false, { id, nonce: 1 })
    expect(screen.getByRole('article', { name: 'Text field has no maximum length' })).toBeTruthy()

    const resolved = controller(quick, {
      state: {
        ...emptyState(),
        resolved: {
          'quick:gone': {
            title: 'Old issue',
            ruleId: 'config/data-dialect',
            severity: 'medium',
            category: 'config',
            source: 'quick',
            at: new Date().toISOString(),
            via: 'quick',
            fixedByCopilot: true
          }
        }
      }
    })
    rerender(
      <AdvisorView
        project={project}
        advisor={resolved}
        chatBusy={false}
        onFix={vi.fn()}
        onOpenFile={vi.fn()}
        openRequest={{ id: 'quick:gone', nonce: 2 }}
      />
    )
    expect(screen.getByRole('tab', { name: /Resolved/ }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('Old issue')).toBeTruthy()
  })

  it('lists an area’s checks and jumps to the issue a check found', async () => {
    renderView(controller(await quickFor(BROKEN)))
    const dataModel = within(areas()).getByRole('button', { name: /Data model/ })
    fireEvent.click(dataModel)
    expect(dataModel.getAttribute('aria-expanded')).toBe('true')
    const list = areas().querySelector('.adv-checks')!
    expect(list.textContent).toContain('Every @text and @email field sets max')
    expect(list.querySelectorAll('.adv-check--passed').length).toBeGreaterThan(0)
    fireEvent.click(within(areas()).getByRole('button', { name: /View issue/ }))
    expect(screen.getByRole('article', { name: 'Text field has no maximum length' })).toBeTruthy()
    fireEvent.click(dataModel)
    expect(areas().querySelector('.adv-checks')).toBeNull()
  })

  it('says when a check couldn’t run instead of counting it as passed', async () => {
    const snapshot = snapshotOf(GOOD_PROJECT)
    const ctx = await buildQuickContext(snapshot, null)
    const { findings, results } = runQuickRules(ctx)
    const quick: QuickCheckResult = {
      findings,
      results,
      conditions: [...ctx.conditions],
      facts: buildFacts(ctx),
      files: snapshot.files.map((f) => f.path),
      ranAt: new Date().toISOString(),
      truncated: false
    }
    renderView(controller(quick))
    const platform = within(areas()).getByRole('button', { name: /Rayfin versions & platform/ })
    expect(platform.textContent).toMatch(/not checked/)
    fireEvent.click(platform)
    expect(areas().querySelector('.adv-check--skipped')).toBeTruthy()
  })

  it('dismisses and mutes through the dismiss menu', async () => {
    const advisor = controller(await quickFor(BROKEN))
    renderView(advisor)
    fireEvent.click(screen.getByRole('button', { name: /Text field has no maximum length/ }))
    fireEvent.click(screen.getByRole('button', { name: /Dismiss/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Accepted risk/ }))
    expect(advisor.dismiss).toHaveBeenCalledWith(
      expect.objectContaining({ ruleId: 'data-model/text-without-max' }),
      'accepted-risk'
    )
    fireEvent.click(screen.getByRole('button', { name: /Dismiss/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Mute this rule/ }))
    expect(advisor.mute).toHaveBeenCalledWith('data-model/text-without-max')
  })

  it('merges deep-review findings, shows Copilot’s summary and notes, and explains inline', async () => {
    const advisor = controller(await quickFor({}), {}, [aiFinding])
    const withNote = {
      ...advisor.deep!,
      report: {
        ...advisor.deep!.report,
        rules: [{ ruleId: 'performance/client-per-render', status: 'pass' as const, note: 'Created once at module scope.' }]
      }
    }
    const derived = deriveAdvisor({ quick: advisor.quick, deep: withNote, live: null, state: emptyState(), deepCurrent: true })
    renderView({ ...advisor, deep: withNote, derived })
    expect(screen.getByText('Mostly solid; one list needs paging.')).toBeTruthy()
    fireEvent.click(within(areas()).getByRole('button', { name: /Performance/ }))
    expect(within(areas()).getByText('Created once at module scope.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Todo list stops at 100 rows/ }))
    const detail = screen.getByRole('article', { name: 'Todo list stops at 100 rows' })
    expect(within(detail).getByText('Evidence checked')).toBeTruthy()
    fireEvent.click(within(detail).getByRole('button', { name: /Explain/ }))
    expect(advisor.explain).toHaveBeenCalledWith(expect.objectContaining({ id: aiFinding.id }))
    fireEvent.click(within(detail).getByRole('button', { name: /Verify/ }))
    expect(advisor.startVerify).toHaveBeenCalledWith([expect.objectContaining({ id: aiFinding.id })])
  })

  it('shows the live step, streamed findings, and activity while a review runs', async () => {
    const advisor = controller(await quickFor({}), {
      review: {
        running: true,
        startedAt: Date.now() - 65_000,
        activity: [
          {
            id: 't1',
            name: 'view',
            title: 'rayfin/data/Todo.ts',
            state: 'running',
            paths: ['C:\\apps\\todos\\rayfin\\data\\Todo.ts']
          }
        ],
        findings: [aiFinding],
        results: [{ ruleId: 'queries/unpaginated-list', status: 'fail' }]
      }
    })
    const { container } = renderView(advisor)
    expect(screen.getByRole('heading', { name: 'Copilot is reviewing your app' })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('Reading rayfin/data/Todo.ts…')
    expect(container.querySelector('.adv-meter-legend')!.textContent).toMatch(/\d+ being checked by Copilot/)
    expect(screen.getByRole('button', { name: /Todo list stops at 100 rows/ })).toBeTruthy()
    expect(screen.queryByRole('log')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Activity · 1 step/ }))
    expect(within(screen.getByRole('log', { name: 'Review activity' })).getByText(/Todo\.ts/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Stop review/ }))
    expect(advisor.cancelReview).toHaveBeenCalled()
  })

  it('flags reviews made with an older rule set', async () => {
    renderView(controller(await quickFor({}), {}, [{ ...aiFinding, ruleId: '', category: 'performance' }], 0))
    expect(screen.getByText(/ran with an older rule set/)).toBeTruthy()
  })

  it('celebrates a clean app and offers a deep review', async () => {
    const advisor = controller(await quickFor({}))
    renderView(advisor)
    expect(screen.getByRole('heading', { name: 'Looking good' })).toBeTruthy()
    expect(screen.getByText('Nothing needs your attention')).toBeTruthy()
    fireEvent.click(within(screen.getByRole('region', { name: 'Issues' })).getByRole('button', { name: /Run deep review/ }))
    expect(advisor.startReview).toHaveBeenCalled()
  })

  it('searches issues and explains an empty result', async () => {
    renderView(controller(await quickFor(BROKEN)))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search issues' }), { target: { value: 'maximum' } })
    expect(screen.getByRole('button', { name: /Text field has no maximum length/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Per-user data isn't restricted/ })).toBeNull()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search issues' }), { target: { value: 'zzz' } })
    expect(screen.getByText('No issues match “zzz”.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(screen.getByRole('button', { name: /Per-user data isn't restricted/ })).toBeTruthy()
  })
})
