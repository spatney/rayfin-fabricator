---
name: graphein-visuals
description: >
  Use when adding a chart, graph, plot, KPI, table, or any data visualization to
  this app. Charts are authored as Graphein specs — one chart = one JSON
  `ChartSpec` (a `type`, a tidy `data` array, and an `encoding` that names the
  columns) rendered by the bundled `<Chart spec={…} />` component
  (`@/components/Chart`). Covers the spec model, the chart-type catalog
  (line/area/bar/scatter/pie/heatmap/histogram/combo/funnel/treemap/waterfall/
  gauge/bullet/calendarHeatmap/slope/dumbbell/table/matrix/box/sankey/choropleth),
  encodings and field types, in-spec transforms/annotations/trendline/facet,
  value formatting, cross-chart selections, `validateSpec`, and gotchas.
  Triggers: chart, graph, plot, visualize, dashboard, bar chart, line chart,
  pie, scatter, heatmap, KPI, metric, table, Graphein, spec, dataviz.
---

# Graphein visuals — author a spec, drop it in `<Chart>`

**One chart is one JSON object.** You don't hand-write SVG or wire a charting
library. You (1) shape your data into plain rows, (2) author a single Graphein
[`ChartSpec`](https://github.com/spatney/graphein/blob/main/docs/spec-reference.md)
— a `type`, a tidy `data` array, and an `encoding` that names the columns — and
(3) render it with the bundled `<Chart>` component. Graphein owns axes, scales,
ticks, color, the legend, tooltips, number/date formatting, responsive sizing,
animation, and dark mode.

> `graphein` is a framework-agnostic canvas engine (no React entry of its own),
> so this app ships a thin binding at `src/components/Chart.tsx` (+ `useChart.ts`).
> Always render through `<Chart>` — don't call `render()` from `graphein`
> directly in components.

## Fast path

```tsx
import { Chart } from '@/components/Chart';
import type { ChartSpec } from 'graphein';

const spec: ChartSpec = {
  type: 'bar',
  title: 'Revenue by region',
  data: [
    { region: 'North', revenue: 4200 },
    { region: 'South', revenue: 3100 },
    { region: 'East', revenue: 5300 },
    { region: 'West', revenue: 2600 },
  ],
  encoding: {
    x: { field: 'region', type: 'nominal' },
    y: { field: 'revenue', type: 'quantitative', format: '$,.0f' },
  },
};

export function RevenueCard() {
  // The chart fills its parent, so give the parent an explicit size.
  return (
    <div style={{ width: '100%', height: 360 }}>
      <Chart spec={spec} />
    </div>
  );
}
```

**Size the parent.** `<Chart>` fills its container (`width/height: 100%`); it
draws nothing in a zero-height box. Wrap it in an element with a real height
(fixed px, a grid/flex track, or `100%` of a sized ancestor).

**Keep the spec stable.** Pass a memoized or module-constant spec. A brand-new
object every render replays the entrance animation — use `useMemo` when the spec
depends on props/state.

## Shape data as a tidy table

Graphein expects **long/tidy** data: one row per observation, one column per
variable. The *same* table drives every chart — point different channels at
columns. To compare groups, add a `series` channel — **don't pre-pivot** into
one column per group.

```ts
// Good (tidy): one row per month × region
[{ month: '2024-01', region: 'North', revenue: 4200 },
 { month: '2024-01', region: 'South', revenue: 3100 }]
// encoding: x=month, y=revenue, series=region  → multi-series line/bar
```

Rows are plain JSON — no functions, no DOM nodes, no `Date` objects. For time
axes, pass ISO strings (`"2024-01"`, `"2024-01-15"`) or epoch ms and set
`type: "temporal"`.

## Encoding & field definitions

Cartesian charts (`line`/`area`/`bar`/`scatter`) plus `pie`/`heatmap`/`funnel`/
`treemap`/`waterfall`/`calendarHeatmap`/`dumbbell`/`slope`/`combo` map columns
onto channels via `encoding`:

| Channel | Used by | Purpose |
| --- | --- | --- |
| `x` | line, area, bar, scatter, heatmap, histogram, combo, slope, calendarHeatmap | Horizontal position / bin field |
| `y` | line, area, bar, scatter, heatmap, slope | Vertical position |
| `series` | line, area, bar, slope | Split into multiple series |
| `size` | scatter | Bubble radius |
| `color` | heatmap, pie, treemap, calendarHeatmap | Continuous color or category |
| `theta` | pie | Slice value |
| `stage` / `value` | funnel, waterfall | Ordered stage / stage value |
| `category` / `value` / `group` | treemap, dumbbell | Leaf identity / measure / parent |
| `date` | calendarHeatmap | Date field → one cell per day |

**`FieldDef`** = `{ field, type?, aggregate?, title?, format?, scale? }`:

- `field` (**required**) — column name; dotted paths (`a.b`) read nested values.
- `type` — `quantitative | temporal | ordinal | nominal` (inferred when omitted;
  set it explicitly for time axes and to avoid surprises).
- `format` — a [format hint](#value-formatting) for labels / ticks / tooltips.
- `aggregate` — `sum | mean | avg | min | max | count | countDistinct | median |
  first | last` when grouping.

`gauge` and `bullet` use a top-level `value: { field }` instead of `encoding`.

## Chart-type catalog

Pick the closest type; there is no custom-chart escape hatch — re-express exotic
shapes with the nearest supported type.

- **line / area** — `x`, `y`, optional `series`. line: `points?`, `area?`,
  `curve?`. area: `stack?` (totals). `curve`: `linear|monotone|step|stepBefore|
  stepAfter|catmullRom`.
- **bar** — `x`, `y`, optional `series`. `stack?` (else side-by-side groups),
  `cornerRadius?`, `orientation?: 'vertical'|'horizontal'` (horizontal swaps
  axes; keep `x`=category, `y`=value). For top-N, sort rows by value.
- **scatter** — `x`, `y`, optional `size` (bubbles), `series` (colored groups).
- **pie / donut** — `theta` (value) + `color` (category). `donut?: true | 0..1`
  inner-radius ratio. `labels?`.
- **heatmap** — `x`, `y` (categories) + `color` (measure). `scheme?:
  blues|teal|viridis|magma|greys`.
- **histogram** — `x` (the numeric measure); auto-bins. `bin?: { maxbins?, step? }`.
- **combo (dual-axis)** — shared `x` + `layers: [{ mark:'bar'|'line'|'area',
  axis:'left'|'right', encoding:{ y } }]` for measures on independent scales.
- **funnel** — `stage` + `value`. `percent?: 'first'|'previous'`, `labels?`.
- **treemap** — `category` + `value`, optional `group` + `color`.
- **waterfall** — `stage` + `value` (signed). `totals?: string[]`.
- **gauge / bullet** — top-level `value: { field }`. gauge: `min?`, `max?`.
  bullet: `target?: { field }` + `encoding.label`.
- **calendarHeatmap** — `date` + `color`. `scheme?`.
- **slope** — `x` (two values), `y`, `series`.
- **dumbbell** — `category` + `value` + `group` (2+ points per category).
- **table** — `columns: TableColumn[]` (`field, title, format, align, width,
  sortable, conditionalFormat, total, …`), `totals?`, `density?`.
- **matrix (pivot)** — `rows`, `columns`, `values: [{ field, op, label?, format?,
  conditionalFormat?, showAs? }]`, `subtotals?`, `grandTotals?`.
- **box / sankey / choropleth** — distributions / flows (`source`+`target`+
  `value`) / geography (`geo` + `key` + `color`). Rare; see the library docs.

## In-spec features (declarative, on `BaseSpec`)

Reshape and enrich a spec without touching your data pipeline:

- `transform: Transform[]` — `aggregate`, `bin`, `filter`, `fold`, `timeUnit`,
  `calculate` run before the chart builds.
- `annotations: Annotation[]` — reference lines/bands/zones + point callouts,
  e.g. a target line: `annotations: [{ type: 'line', axis: 'y', value: 5000,
  label: 'Target' }]`.
- `insights: true` — auto-mark the max & min (opt into `outliers`).
- `trendline: true` — linear line of best fit (line/scatter).
- `facet: { field, columns? }` — small-multiples trellis, one panel per category.
- `title`, `legend`, `tooltip`, `axes`, `animation`, `description` (a11y).

## Value formatting

Format inside the spec (never pre-format numbers to strings). A subset of
d3-format for numbers, strftime for dates:

| Hint | Input → Output |
| --- | --- |
| `,d` | `1234567` → `1,234,567` |
| `.1f` | `3.14159` → `3.1` |
| `.0%` | `0.42` → `42%` |
| `$,.0f` | `5230` → `$5,230` |
| `.2s` | `1234567` → `1.2M` |

Dates: any hint with `%` is a date pattern — `%b %e, %Y` → `Jan 2, 2024`
(`%Y`/`%y` year, `%m` month, `%d`/`%e` day, `%B`/`%b` month name, `%H:%M` time).

## Theming

This template has no design-token system, so charts render with **Graphein's
built-in theme** (teal accent, slate neutrals, a 10-hue categorical palette) and
it is dark-mode aware. To recolor, set `spec.theme` (a `ThemeInput`) — e.g.
`theme: { colors: { accent: '#7c3aed' } }` — or pass a palette. Keep colors in
the spec; don't hand-paint marks.

## Interactivity (cross-chart selections)

Charts can publish/consume named selections. Create one shared bus and pass the
**same** `store` to several `<Chart>`s to cross-highlight / cross-filter:

```tsx
import { useMemo } from 'react';
import { createSelectionStore } from 'graphein';
import { Chart } from '@/components/Chart';

const store = useMemo(() => createSelectionStore(), []);

// Publisher: clicking a bar sets the "pick" selection
<Chart store={store} spec={{ type: 'bar', data: rows,
  params: [{ name: 'pick', select: { type: 'point', fields: ['region'] } }],
  encoding: { x: { field: 'region' }, y: { field: 'revenue' } } }} />

// Consumer: dims non-matching rows when "pick" changes
<Chart store={store} spec={{ type: 'line', data: rows, highlight: { param: 'pick' },
  encoding: { x: { field: 'month', type: 'temporal' },
              y: { field: 'revenue' }, series: { field: 'region' } } }} />
```

`filter` clauses (`{ param }`, `{ field, equals|oneOf|range|contains }`) subset
rows. Observe changes via `<Chart onSelectionChange={(name, value) => …} />`.

## Validate & self-check

Before shipping a spec, sanity-check it:

```ts
import { validateSpec } from 'graphein';
const { valid, errors, warnings } = validateSpec(spec);
```

Common failures `validateSpec` catches:

- **Missing `encoding`** for the type (`line`/`area`/`bar`/`scatter` need `x`+`y`;
  `pie` needs `theta`+`color`; `heatmap` needs `x`+`y`+`color`; `funnel` needs
  `stage`+`value`).
- **A `field` that doesn't exist** in the data rows (a typo silently drops the
  channel).
- **Pre-pivoted / wide data** — pass tidy rows and split with `series`.

Empty `data` renders an empty chart — show a real empty/loading state in the UI
rather than shipping placeholder rows.

## Gotchas

- Render through `<Chart>`, not `render()` — the binding handles mount/update/
  teardown and is StrictMode-safe.
- Give the chart's parent an explicit height, or it collapses to nothing.
- Memoize specs built from props/state so they don't re-animate every render.
- No custom-chart escape hatch — re-express with the closest supported type.
- Everything is plain JSON: no functions, no DOM nodes, no `Date` objects.
