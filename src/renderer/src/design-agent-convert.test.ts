/// <reference types="node" />
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { beforeEach, describe, expect, it } from 'vitest'

/**
 * Unit tests for the Design controller's chart-type conversion engine
 * (`src-tauri/src/services/design_agent.js`). `shapeOf` / `canConvert` /
 * `convertSpec` are pure and drive the chart card's Type select: every Graphein
 * visual type is listed, targets the current chart can't become are disabled,
 * and encoding fields are remapped across shape-compatible families.
 */

const SRC = readFileSync(resolve(process.cwd(), 'src-tauri/src/services/design_agent.js'), 'utf8')

type ConvRes = { ok: boolean; reason?: string }
interface ConvertApi {
  chartTypes: string[]
  groups: [string, string[]][]
  shapeOf: (spec: unknown) => Record<string, unknown>
  canConvert: (shape: unknown, target: string) => ConvRes
  convertSpec: (spec: unknown, target: string) => Record<string, unknown>
}

const BAR = { type: 'bar', title: 'Sales by region', palette: 'bright', encoding: { x: { field: 'region' }, y: { field: 'sales' } } }
const HEATMAP = { type: 'heatmap', encoding: { x: { field: 'day' }, y: { field: 'hour' }, color: { field: 'load' } } }
const KPI = { type: 'kpi', value: { field: 'revenue', aggregate: 'sum' } }
const CHORO = { type: 'choropleth', geo: { type: 'FeatureCollection', features: [] }, encoding: { key: { field: 'state' }, color: { field: 'pop' } } }

let c: ConvertApi
beforeEach(() => {
  delete (window as unknown as { __rayfinDesign?: unknown }).__rayfinDesign
  new Function(SRC)()
  c = (window as unknown as { __rayfinDesign: { __test: { convert: ConvertApi } } }).__rayfinDesign.__test.convert
})

describe('design controller — chart-type conversion', () => {
  it('lists every Graphein visual type and excludes the slicer controls', () => {
    expect(c.chartTypes).toHaveLength(22)
    for (const s of ['dropdown', 'search', 'list', 'range', 'dateRange']) expect(c.chartTypes).not.toContain(s)
    const grouped = c.groups.flatMap((g) => g[1])
    expect(grouped.slice().sort()).toEqual(c.chartTypes.slice().sort())
  })

  it('enables shape-compatible targets and disables the rest with a reason (bar chart)', () => {
    const shape = c.shapeOf(BAR)
    for (const t of ['line', 'area', 'scatter', 'histogram', 'combo', 'box', 'pie', 'funnel', 'treemap', 'waterfall', 'kpi', 'gauge', 'bullet', 'table', 'matrix']) {
      expect(c.canConvert(shape, t).ok, `bar→${t}`).toBe(true)
    }
    const disabled: Record<string, string> = {
      heatmap: 'needs two categories and a value',
      slope: 'needs a series (or two categories)',
      dumbbell: 'needs a group (or two categories)',
      sankey: 'needs source & target',
      choropleth: 'needs map geometry',
      calendarHeatmap: 'needs a date field'
    }
    for (const [t, reason] of Object.entries(disabled)) expect(c.canConvert(shape, t)).toEqual({ ok: false, reason })
  })

  it('unlocks series / group / flow targets when the source has two categories', () => {
    const shape = c.shapeOf(HEATMAP)
    for (const t of ['slope', 'dumbbell', 'sankey', 'bar', 'pie']) expect(c.canConvert(shape, t).ok, `heatmap→${t}`).toBe(true)
  })

  it('keeps a single-value chart to value-family targets', () => {
    const shape = c.shapeOf(KPI)
    for (const t of ['gauge', 'bullet', 'histogram', 'table']) expect(c.canConvert(shape, t).ok, `kpi→${t}`).toBe(true)
    for (const t of ['bar', 'pie', 'scatter', 'matrix']) expect(c.canConvert(shape, t).ok, `kpi→${t}`).toBe(false)
  })

  it('only allows choropleth when the source carries map geometry', () => {
    expect(c.canConvert(c.shapeOf(BAR), 'choropleth').ok).toBe(false)
    expect(c.canConvert(c.shapeOf(CHORO), 'choropleth').ok).toBe(true)
    expect(c.canConvert(c.shapeOf(CHORO), 'bar').ok).toBe(true)
  })

  it('remaps encoding fields for bar → pie and carries cosmetics', () => {
    const pie = c.convertSpec(BAR, 'pie') as { type: string; title?: string; palette?: string; encoding: Record<string, { field: string } | undefined> }
    expect(pie.type).toBe('pie')
    expect(pie.encoding.theta?.field).toBe('sales')
    expect(pie.encoding.color?.field).toBe('region')
    expect(pie.encoding.x).toBeUndefined()
    expect(pie.title).toBe('Sales by region')
    expect(pie.palette).toBe('bright')
  })

  it('builds value / columns for chart → kpi and chart → table', () => {
    expect(c.convertSpec(BAR, 'kpi')).toMatchObject({ type: 'kpi', value: { field: 'sales', aggregate: 'sum' } })
    const table = c.convertSpec(BAR, 'table') as { columns: { field: string }[] }
    expect(table.columns.map((col) => col.field)).toEqual(['region', 'sales'])
  })

  it('maps two source categories onto sankey source / target', () => {
    expect(c.convertSpec(HEATMAP, 'sankey')).toMatchObject({
      type: 'sankey',
      encoding: { source: { field: 'day' }, target: { field: 'hour' }, value: { field: 'load' } }
    })
  })
})
