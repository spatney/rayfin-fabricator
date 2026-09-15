import { readFileSync } from 'fs'
import { resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * Unit tests for the design controller's chart-type conversion engine and the
 * transient full-screen debug view (`src-tauri/src/services/design_agent.js`).
 *
 *  - `__convert` (shapeOf / canConvert / convertSpec) is pure and drives the
 *    inspector's Type dropdown: it lists every Graphein visual type, greys out
 *    targets the current chart can't become, and remaps encoding fields across
 *    shape-compatible families when it can.
 *  - `__debug.enter/exit` flips Graphein's `debug` flag on a chart and full-
 *    screens it *without* recording a change (never persisted / sent to chat).
 *
 * The controller is a document-start IIFE; we eval it into the jsdom window.
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
interface DebugApi {
  enter: (el: Element) => void
  exit: () => void
  active: () => boolean
  changeCount: () => number
}
interface DesignApi {
  __v: number
  __convert: ConvertApi
  __debug: DebugApi
  disable: () => void
}

function install(): DesignApi {
  new Function(SRC)()
  return (window as unknown as { __rayfinDesign: DesignApi }).__rayfinDesign
}

const BAR = { type: 'bar', title: 'Sales by region', palette: 'bright', encoding: { x: { field: 'region' }, y: { field: 'sales' } } }
const HEATMAP = { type: 'heatmap', encoding: { x: { field: 'day' }, y: { field: 'hour' }, color: { field: 'load' } } }
const KPI = { type: 'kpi', value: { field: 'revenue', aggregate: 'sum' } }
const CHORO = { type: 'choropleth', geo: { type: 'FeatureCollection', features: [] }, encoding: { key: { field: 'state' }, color: { field: 'pop' } } }

describe('design controller — chart-type conversion', () => {
  let d: DesignApi
  beforeEach(() => {
    delete (window as unknown as { __rayfinDesign?: unknown }).__rayfinDesign
    document.body.innerHTML = ''
    d = install()
  })
  afterEach(() => {
    try {
      d.disable()
    } catch {
      /* ignore */
    }
    delete (window as unknown as { __rayfinDesign?: unknown }).__rayfinDesign
  })

  it('lists every Graphein visual type and excludes the slicer controls', () => {
    const types = d.__convert.chartTypes
    const expected = [
      'bar', 'line', 'area', 'scatter', 'combo', 'histogram', 'pie', 'heatmap',
      'funnel', 'treemap', 'waterfall', 'box', 'slope', 'dumbbell', 'sankey',
      'choropleth', 'calendarHeatmap', 'kpi', 'gauge', 'bullet', 'table', 'matrix'
    ]
    expect(types).toHaveLength(22)
    for (const t of expected) expect(types).toContain(t)
    // slicers are filter controls, not chart marks → never offered
    for (const s of ['dropdown', 'search', 'list', 'range', 'dateRange']) expect(types).not.toContain(s)
    // every grouped type is a known visual type (no orphans in the dropdown)
    const grouped = d.__convert.groups.flatMap((g) => g[1])
    expect(grouped.slice().sort()).toEqual(types.slice().sort())
  })

  it('enables shape-compatible targets and greys out the rest (bar chart)', () => {
    const shape = d.__convert.shapeOf(BAR)
    const ok = (t: string): boolean => d.__convert.canConvert(shape, t).ok
    // one category + one measure → the whole cartesian + part-to-whole + value + tabular families
    for (const t of ['line', 'area', 'scatter', 'histogram', 'combo', 'box', 'pie', 'funnel', 'treemap', 'waterfall', 'kpi', 'gauge', 'bullet', 'table', 'matrix']) {
      expect(ok(t), `bar→${t} should be enabled`).toBe(true)
    }
    // targets that need roles a single bar doesn't have are greyed with a reason
    const greyed: Record<string, string> = {
      heatmap: 'needs two categories and a value',
      slope: 'needs a series (or two categories)',
      dumbbell: 'needs a group (or two categories)',
      sankey: 'needs source & target',
      choropleth: 'needs map geometry',
      calendarHeatmap: 'needs a date field'
    }
    for (const [t, reason] of Object.entries(greyed)) {
      const res = d.__convert.canConvert(shape, t)
      expect(res.ok, `bar→${t} should be greyed`).toBe(false)
      expect(res.reason).toBe(reason)
    }
  })

  it('unlocks series/group/flow targets when the source has two categories (heatmap)', () => {
    const shape = d.__convert.shapeOf(HEATMAP)
    const ok = (t: string): boolean => d.__convert.canConvert(shape, t).ok
    // two categorical dims satisfy slope (series), dumbbell (group), and sankey (source+target)
    for (const t of ['slope', 'dumbbell', 'sankey', 'bar', 'pie']) expect(ok(t), `heatmap→${t}`).toBe(true)
  })

  it('locks a single-value chart (kpi) to value-family / distribution targets', () => {
    const shape = d.__convert.shapeOf(KPI)
    const ok = (t: string): boolean => d.__convert.canConvert(shape, t).ok
    // a single number can become another single-value visual (or a 1-field table/histogram)
    for (const t of ['gauge', 'bullet', 'histogram', 'table']) expect(ok(t), `kpi→${t}`).toBe(true)
    // …but not a categorical chart — there's no category to plot against
    for (const t of ['bar', 'pie', 'scatter', 'matrix']) expect(ok(t), `kpi→${t} should be greyed`).toBe(false)
  })

  it('only allows choropleth when the source carries map geometry', () => {
    const barShape = d.__convert.shapeOf(BAR)
    expect(d.__convert.canConvert(barShape, 'choropleth').ok).toBe(false)
    const choroShape = d.__convert.shapeOf(CHORO)
    // identity is always allowed; a geo-bearing source can also feed a plain chart
    expect(d.__convert.canConvert(choroShape, 'choropleth').ok).toBe(true)
    expect(d.__convert.canConvert(choroShape, 'bar').ok).toBe(true)
  })

  it('remaps encoding fields when converting bar → pie (and carries cosmetics)', () => {
    const pie = d.__convert.convertSpec(BAR, 'pie') as {
      type: string
      title?: string
      palette?: string
      encoding: { theta?: { field: string }; color?: { field: string }; x?: unknown; y?: unknown }
    }
    expect(pie.type).toBe('pie')
    expect(pie.encoding.theta?.field).toBe('sales') // measure → theta
    expect(pie.encoding.color?.field).toBe('region') // category → color
    expect(pie.encoding.x).toBeUndefined() // cartesian channels dropped
    expect(pie.encoding.y).toBeUndefined()
    expect(pie.title).toBe('Sales by region') // cosmetics carried over
    expect(pie.palette).toBe('bright')
  })

  it('builds value/columns for chart → kpi and chart → table', () => {
    const kpi = d.__convert.convertSpec(BAR, 'kpi') as { type: string; value: { field: string; aggregate: string }; encoding?: unknown }
    expect(kpi.type).toBe('kpi')
    expect(kpi.value).toEqual({ field: 'sales', aggregate: 'sum' })
    expect(kpi.encoding).toBeUndefined()

    const table = d.__convert.convertSpec(BAR, 'table') as { type: string; columns: { field: string }[] }
    expect(table.type).toBe('table')
    expect(table.columns.map((c) => c.field)).toEqual(['region', 'sales'])
  })

  it('maps two source categories onto sankey source/target', () => {
    const sankey = d.__convert.convertSpec(HEATMAP, 'sankey') as {
      type: string
      encoding: { source: { field: string }; target: { field: string }; value: { field: string } }
    }
    expect(sankey.type).toBe('sankey')
    expect(sankey.encoding.source.field).toBe('day')
    expect(sankey.encoding.target.field).toBe('hour')
    expect(sankey.encoding.value.field).toBe('load')
  })
})

describe('design controller — transient debug view', () => {
  let d: DesignApi
  beforeEach(() => {
    delete (window as unknown as { __rayfinDesign?: unknown }).__rayfinDesign
    document.body.innerHTML = ''
    d = install()
  })
  afterEach(() => {
    try {
      d.disable()
    } catch {
      /* ignore */
    }
    delete (window as unknown as { __rayfinDesign?: unknown }).__rayfinDesign
  })

  it('flips debug + full-screens the chart container without recording, then reverts on exit', () => {
    // Mirror Graphein's real DOM: the `data-graphein-spec` root lives *inside* the
    // container Graphein measures (resolveSize(container)). The fullscreen styles
    // must land on that container, not the root, or the debug overlay stays at the
    // chart's original size (only the top-left corner fills).
    const container = document.createElement('div')
    const chart = document.createElement('div')
    container.appendChild(chart)
    document.body.appendChild(container)
    const original = JSON.stringify({
      type: 'bar',
      dimensions: { width: 320, height: 200 },
      encoding: { x: { field: 'region' }, y: { field: 'sales' } },
    })
    chart.setAttribute('data-graphein-spec', original)

    d.__debug.enter(chart)
    expect(d.__debug.active()).toBe(true)
    // debug flag is set on the live spec attribute, and authored dimensions are
    // dropped so the view fills the (now fullscreen) container instead of 320×200.
    const dbg = JSON.parse(chart.getAttribute('data-graphein-spec') || '{}')
    expect(dbg.debug).toBe(true)
    expect(dbg.dimensions.width).toBeUndefined()
    expect(dbg.dimensions.height).toBeUndefined()
    // …the CONTAINER (the element Graphein sizes from) is blown up to the viewport…
    expect(container.style.position).toBe('fixed')
    expect(container.style.width).toBe('100vw')
    // …the root carrying the spec is left un-styled…
    expect(chart.getAttribute('style')).toBeNull()
    // …but it is a transient inspection: nothing is recorded into the change-set.
    expect(d.__debug.changeCount()).toBe(0)

    d.__debug.exit()
    expect(d.__debug.active()).toBe(false)
    expect(chart.getAttribute('data-graphein-spec')).toBe(original) // debug flag + dimensions restored
    expect(container.getAttribute('style')).toBeNull() // inline full-screen styles removed
    expect(d.__debug.changeCount()).toBe(0)
  })
})
