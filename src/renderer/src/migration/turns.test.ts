import { describe, expect, it } from 'vitest'
import type { MigrationPage, MigrationState } from '@shared/ipc'
import {
  absolutePath,
  materialReady,
  migrationTurn,
  needsDrawing,
  nextPage,
  turnOrder
} from './turns'

const page = (over: Partial<MigrationPage> & { name: string; order: number }): MigrationPage => ({
  displayName: over.name,
  kind: 'page',
  hidden: false,
  stem: `0${over.order + 1}-${over.name.toLowerCase()}`,
  status: 'pending',
  ...over
})

const done = { status: 'done' as const }

function state(over: Partial<MigrationState> = {}): MigrationState {
  return {
    version: 1,
    dir: '.fabricator/migration/sales',
    alias: 'sales',
    source: {
      reportId: 'r1',
      reportName: 'Sales',
      workspaceId: 'ws-1',
      personal: false,
      modelId: 'ds-1',
      modelName: 'Sales model'
    },
    stages: { definition: done, model: done, export: done, images: done },
    pages: [
      page({ name: 'Overview', order: 0, image: '.fabricator/migration/sales/pages/01-overview.png', thumb: 'data:image/png;base64,AA', text: '.fabricator/migration/sales/pages/01-overview.txt' }),
      page({ name: 'Tip', order: 1, kind: 'tooltip', hidden: true }),
      page({ name: 'Detail', order: 2, kind: 'drillthrough', hidden: true }),
      page({ name: 'Regions', order: 3 })
    ],
    pdfs: ['export-1.pdf'],
    warnings: [],
    startedAt: '2026-10-25T00:00:00Z',
    dismissed: false,
    ...over
  }
}

describe('turn order', () => {
  it('migrates visible pages first, then drillthrough and tooltip pages', () => {
    expect(turnOrder(state())).toEqual([0, 3, 2, 1])
  })

  it('picks the first page not done, and waits while one is running', () => {
    const s = state()
    expect(nextPage(s)).toBe(0)
    s.pages[0].status = 'done'
    expect(nextPage(s)).toBe(3)
    s.pages[3].status = 'failed'
    expect(nextPage(s)).toBe(3)
    s.pages[3].status = 'running'
    expect(nextPage(s)).toBeNull()
    s.pages.forEach((p) => (p.status = 'done'))
    expect(nextPage(s)).toBeNull()
  })
})

describe('material', () => {
  it('is ready once every stage has finished, including drawing the exported pages', () => {
    expect(materialReady(state())).toBe(true)
    expect(materialReady(state({ stages: { definition: { status: 'running' }, model: done, export: done, images: done } }))).toBe(false)
    const drawing = state({ stages: { definition: done, model: done, export: done, images: { status: 'pending' } } })
    expect(materialReady(drawing)).toBe(false)
    expect(needsDrawing(drawing)).toBe(true)
    const noExport = state({ stages: { definition: done, model: done, export: { status: 'failed' }, images: { status: 'skipped' } } })
    expect(materialReady(noExport)).toBe(true)
    expect(needsDrawing(noExport)).toBe(false)
  })
})

describe('migration turns', () => {
  it('sets up the app and migrates the first page, with the exact connector command and the page image', () => {
    const turn = migrationTurn(state(), 0, 'C:\\apps\\sales')
    expect(turn.display).toBe('Migrate “Sales” from Power BI')
    expect(turn.migration).toEqual({ reportName: 'Sales', foundation: true, page: { index: 0, count: 4, name: 'Overview' } })
    expect(turn.prompt).toContain('migrate-powerbi-report skill')
    expect(turn.prompt).toContain(
      'npx rayfin connector add --type fabric-semanticmodel --workspace-id ws-1 --item-id ds-1 --name sales'
    )
    expect(turn.prompt).toContain('a page for each report page (“Overview”, “Regions”)')
    expect(turn.prompt).toContain('Graphein for the visuals')
    expect(turn.prompt).toContain('`.fabricator/migration/sales/pages/01-overview.png`')
    expect(turn.prompt).toContain("Don't migrate the other pages yet")
    expect(turn.shots).toEqual([
      { path: 'C:\\apps\\sales\\.fabricator\\migration\\sales\\pages\\01-overview.png', thumb: 'data:image/png;base64,AA' }
    ])
  })

  it('asks for one more page once the first is done, and wraps up on the last', () => {
    const s = state()
    s.pages[0].status = 'done'
    const second = migrationTurn(s, 3, '/apps/sales')
    expect(second.display).toBe('Migrate page 2 of 4: Regions')
    expect(second.migration.foundation).toBeUndefined()
    expect(second.prompt).toContain('page 2 of 4, “Regions”')
    expect(second.prompt).toContain('Build its visuals with Graphein')
    expect(second.prompt).toContain('There is no page image')
    expect(second.prompt).not.toContain('This is the last page')
    expect(second.shots).toEqual([])

    s.pages[3].status = 'done'
    s.pages[2].status = 'done'
    const last = migrationTurn(s, 1, '/apps/sales')
    expect(last.prompt).toContain('tooltip page')
    expect(last.prompt).toContain('This is the last page')
  })

  it('repeats the setup when the first turn failed', () => {
    const s = state()
    s.pages[0].status = 'failed'
    expect(migrationTurn(s, 0, '/apps/sales').migration.foundation).toBe(true)
  })

  it('finishes a one-page report in its first turn', () => {
    const only = migrationTurn(state({ pages: [state().pages[0]] }), 0, '/apps/sales')
    expect(only.migration.foundation).toBe(true)
    expect(only.prompt).not.toContain("Don't migrate the other pages yet")
    expect(only.prompt).toContain("This is the report's only page")
  })

  it('says what material is missing', () => {
    const s = state({ stages: { definition: { status: 'failed' }, model: { status: 'failed' }, export: done, images: done } })
    const turn = migrationTurn(s, 0, '/apps/sales')
    expect(turn.prompt).toContain("couldn't read the report's definition")
    expect(turn.prompt).toContain("`model.md` isn't available")
  })
})

describe('absolutePath', () => {
  it('joins in the root path style', () => {
    expect(absolutePath('C:\\apps\\sales\\', '.fabricator/a.png')).toBe('C:\\apps\\sales\\.fabricator\\a.png')
    expect(absolutePath('/Users/me/sales', '.fabricator/a.png')).toBe('/Users/me/sales/.fabricator/a.png')
  })
})
