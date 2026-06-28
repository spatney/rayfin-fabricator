# Graphein spec reference

Every chart/table is one **`ChartSpec`** — a plain, JSON-serializable object (no
functions, colors, or callbacks). You author it and drop it into
`<ChartCard spec={…} />` or `<DataTableCard spec={…} />`. This file is the
field-by-field reference; the `visuals` SKILL has the workflow and recipes.

> Adapted for Graphein 0.6. The template depends on `graphein` from npm
> (`^0.6.0`). `validateSpec(spec)` (re-exported from `@/components/dashboard`)
> checks a spec against the real schema; `repairSpec(spec)` auto-fixes many
> mistakes. Render a spec headlessly against live data with `npm run preview`
> (see the **headless-preview** skill).

## The one rule

> Emit a single object with a `type`, a `data` array of flat records, and (for
> encoded visuals) an `encoding` that names the columns.

```jsonc
{
  "type": "bar",
  "data": [{ "quarter": "Q1", "revenue": 210 }, { "quarter": "Q2", "revenue": 245 }],
  "encoding": { "x": { "field": "quarter" }, "y": { "field": "revenue", "format": "$,d" } },
  "title": "Quarterly revenue"
}
```

## Shape data as a tidy table

Graphein expects **long/tidy** data: one row per observation, one column per
variable. The *same* table drives every chart — point different channels at
columns. To compare groups, add a `series` channel (`"series": { "field": "region" }`)
— don't pre-pivot into one column per group.

## App conventions (important)

- **Don't author `theme`.** `ChartCard` injects the app's CSS-token theme (brand
  accent + light/dark) automatically. Recolor via `src/global.css`, never per-spec
  hex. Setting `spec.theme` is a deliberate escape hatch only.
- **Don't set `dimensions`.** `ChartCard` sizes charts responsively; table/matrix
  specs get a fixed scrollable height.
- **Tables / pivots:** use `DataTableCard` with a Graphein `table` / `matrix` spec.
  Build tables with `toTable(result, { columns })`; author matrices over
  `toChartData(result)` rows.
- **Horizontal bars are not honored** in this version: `BarSpec` types an
  `orientation` field but the runtime ignores it (bars always render vertical).
  For ranked/top-N, sort rows by value and use a vertical bar; for a horizontal
  two-point comparison, use a `dumbbell`.

## Common fields (`BaseSpec`)

Shared by all chart/table specs.

| Field | Type | Notes |
| --- | --- | --- |
| `data` | `Array<Record<string, unknown>>` | **Required.** Row-oriented records. |
| `transform` | `Transform[]` | In-spec pipeline run before the chart builds — `aggregate`, `bin`, `filter`, `fold`, `timeUnit`, `calculate`. Reshape data inside the spec. |
| `annotations` | `Annotation[]` | Reference lines/bands/zones + point callouts overlaid on cartesian plots. |
| `insights` | `boolean \| InsightOptions` | Auto-mark notable points (`true` = max + min; opt into `outliers`). |
| `trendline` | `boolean \| TrendlineConfig` | Linear line of best fit (line/scatter). |
| `facet` | `{ field, columns?, … }` | Split into a trellis of small multiples, one panel per category. |
| `title` | `string \| { text, subtitle?, align? }` | Chart title. |
| `legend` | `boolean \| { show?, position?, title? }` | `position`: `top \| right \| bottom \| left`. Auto by default. |
| `tooltip` | `boolean \| { show? }` | Hover tooltips, on by default. |
| `axes` | `{ x?: AxisConfig, y?: AxisConfig }` | Per-axis overrides (cartesian). |
| `animation` | `boolean \| { enabled?, duration?, easing? }` | Brief entrance on first render; honors `prefers-reduced-motion`. |
| `description` | `string` | Accessible alt text (auto-synthesized when omitted). |
| `params` | `SelectionParam[]` | Selections this visual publishes. |
| `highlight` | `HighlightConfig \| HighlightConfig[]` | Emphasize matching selection rows, dim the rest. |
| `filter` | `FilterClause[]` | Subset rows; clauses are ANDed. |

`AxisConfig`: `{ show?, title?, grid?, ticks?, tickValues?, format?, labels? }`.

`Annotation`: `{ type?: "line" | "band" | "zone" | "point", axis?: "x" | "y",
value?, from?, to?, x?, y?, label?, color?, strokeWidth?, strokeDash?,
fillOpacity?, labelPosition? }` — a `y` line uses `value`, a band uses `from`/`to`,
a point uses `x`+`y`.

`Transform` (one of): `{ aggregate: [{ op, field, as }], groupby }`,
`{ bin: { field, as, maxbins?, step? } }`, `{ filter: <predicate> }`,
`{ fold: [cols], as? }`, `{ timeUnit: { field, unit, as } }`,
`{ calculate: <expr>, as }`.

## Encoding & `FieldDef`

Cartesian charts (`line`/`area`/`bar`/`scatter`) plus `pie`/`heatmap`/`funnel`/
`treemap`/`waterfall`/`calendarHeatmap`/`dumbbell`/`slope`/`combo` map columns onto
channels via `encoding` (`gauge`/`bullet` use a top-level `value` instead).

| Channel | Used by | Purpose |
| --- | --- | --- |
| `x` | line, area, bar, scatter, heatmap, histogram, combo, slope, calendarHeatmap | Horizontal position / bin field. |
| `y` | line, area, bar, scatter, heatmap, slope | Vertical position. |
| `series` | line, area, bar, slope | Split into multiple series (multi-line, grouped/stacked bars/areas). |
| `size` | scatter | Bubble radius. |
| `color` | heatmap, pie, treemap, calendarHeatmap | Continuous color or slice/tile category. |
| `theta` | pie | Slice value. |
| `stage` | funnel, waterfall | Ordered stage along the x-axis. |
| `value` | funnel, waterfall | Stage value (waterfall = signed change). |
| `category` | treemap, dumbbell | Leaf/category identity. |
| `value` (enc.) | treemap, dumbbell | Numeric measure (tile area / dot position). |
| `group` | treemap, dumbbell | Parent grouping (treemap) / the 2+ points per category (dumbbell). |
| `date` | calendarHeatmap | Date field → one cell per day. |

**`FieldDef`** — `{ field, type?, aggregate?, title?, format?, scale? }`:

- `field` (**required**) — column name; dotted paths (`a.b`) read nested values.
- `type` — `quantitative | temporal | ordinal | nominal` (inferred when omitted).
- `format` — a [format hint](#format-mini-language) for labels/ticks/tooltips.
- `aggregate` — `sum | mean | avg | min | max | count | countDistinct | median |
  first | last` when grouping.

> **Temporal fields:** pass ISO strings (`"2024-01"`, `"2024-01-15"`) or epoch ms
> (JSON has no `Date`), and set `type: "temporal"` for a time axis.

## Selection model

A spec can publish or consume named selections:

```jsonc
{ "type": "bar", "data": rows,
  "params": [{ "name": "pick", "select": { "type": "point", "fields": ["region"] } }],
  "encoding": { "x": { "field": "region" }, "y": { "field": "revenue" } } }

{ "type": "line", "data": rows, "highlight": { "param": "pick" },
  "encoding": { "x": { "field": "month", "type": "temporal" },
                "y": { "field": "revenue" }, "series": { "field": "region" } } }
```

`SelectionParam = { name, select, value? }`. `select` is `{ type: "point" | "interval",
on?: "click" | "hover", fields?: string[], toggle?: boolean, empty?: "all" | "none" }`.
`fields` defaults to the chart's key channel. `filter` clauses can be `{ param }`,
`{ field, equals }`, `{ field, oneOf }`, `{ field, range: [min, max] }`, or
`{ field, contains }`.

Resolved values in the store are `point`, `set`, `range`, or `text` selections.
Use `createSelectionStore(initial?)` and pass the same store to linked
`ChartCard`s; see [interactions](interactions.md) for the app bridge into slicers
and DAX.

## Chart types

### line / area
`encoding`: requires `x`, `y`; optional `series`.
- line: `points?: boolean`, `area?: boolean`, `curve?`.
- area: `stack?: boolean` (totals; non-stacked areas overlap translucently), `curve?`.
- `curve`: `linear | monotone | step | stepBefore | stepAfter | catmullRom`.

### bar
`encoding`: requires `x`, `y`; optional `series`.
- `stack?: boolean` — stack series. Omit for side-by-side groups (the default when
  `series` is present and not stacked).
- `cornerRadius?: number`.
- `orientation` — **ignored in this version** (always vertical; see caveat above).

### scatter
`encoding`: requires `x`, `y`; optional `size` (bubble radius), `series` (colors
groups). Hover focuses the nearest point.

### pie
`encoding`: requires `theta` (value) + `color` (slice category).
- `donut?: boolean | number` — `true` for a default donut, or a `0..1` inner-radius
  ratio (e.g. `0.6`).
- `labels?: boolean | PieLabels` — `PieLabels = { show?, placement?: "inside" | "outside" | "auto", content?: "percent" | "value" | "category" | "category-percent" | "category-value", minShare?, connector?: "slice" | "muted" }`.

### heatmap
`encoding`: requires `x`, `y` (categories) + `color` (numeric measure).
- `scheme?` — sequential ramp: `blues | teal | viridis | magma | greys`.

### funnel
`encoding`: requires `stage` + `value`.
- `labels?: boolean`.
- `percent?: "first" | "previous"` — show retention vs first stage or previous stage.

```jsonc
{ "type": "funnel", "data": rows, "percent": "previous", "labels": true,
  "encoding": { "stage": { "field": "stage" }, "value": { "field": "users", "format": ",d" } } }
```

### combo (dual-axis)
Two or more measures sharing one `x` but plotted on independent left/right axes.
`encoding`: requires `x`. `layers: ComboLayer[]`, each
`{ mark: "bar" | "line" | "area", encoding: { y: FieldDef }, axis?: "left" | "right", curve?, points? }`.

```jsonc
{ "type": "combo", "data": rows,
  "encoding": { "x": { "field": "month", "type": "temporal" } },
  "layers": [
    { "mark": "bar",  "axis": "left",  "encoding": { "y": { "field": "revenue", "format": "$,.0f" } } },
    { "mark": "line", "axis": "right", "encoding": { "y": { "field": "margin",  "format": ".0%" } } } ] }
```

### histogram
Distribution of one numeric field; auto-bins the values.
`encoding`: requires `x` (the measure). `bin?: { maxbins?, step? }`.

### treemap
Nested part-to-whole as area-sized tiles.
`encoding`: requires `category` + `value`; optional `group` (one level of parent
tiles) and `color`.

### waterfall
Running total of signed changes (a bridge chart).
`encoding`: requires `stage` + `value` (signed). `totals?: string[]` — stage labels
drawn as absolute running-total bars from the baseline.

### gauge / bullet
A single value against a range. Both use a top-level `value` (`{ field }`), **not**
`encoding`. `gauge`: `min?`, `max?`. `bullet`: `target?` (`{ field }`) +
`encoding.label` for the row label.

### calendarHeatmap
One colored cell per day.
`encoding`: requires `date` + `color`. `scheme?` — sequential ramp.

### slope
Rank/value change between exactly two x positions.
`encoding`: requires `x` (two values), `y`, `series`.

### dumbbell
Two points per category joined by a connector (e.g. before/after).
`encoding`: requires `category` + `value` + `group` (the group provides the 2+
points per category). Reads on a horizontal value axis.

### table
A virtualized, sortable detail table.

```jsonc
{ "type": "table", "data": rows,
  "columns": [
    { "field": "account", "title": "Account", "sortable": true },
    { "field": "revenue", "title": "Revenue", "format": "$,.0f", "align": "right",
      "conditionalFormat": { "type": "bar", "showValue": true } }
  ],
  "totals": { "label": "Total" },
  "density": "compact" }
```

`TableColumn` supports `field`, `title`, `type`, `format`, `align`, `width`,
`conditionalFormat`, `prefix`, `suffix`, `negativeStyle`, `hidden`, `sortable`,
`wrap`, `group`, and `total`.

### matrix
A pivot/cross-tab over row, column, and value fields.

```jsonc
{ "type": "matrix", "data": rows,
  "rows": ["region"], "columns": ["quarter"],
  "values": [{ "field": "revenue", "op": "sum", "label": "Revenue", "format": "$,.0f",
                "conditionalFormat": { "type": "colorScale", "scheme": "teal" } }],
  "subtotals": true, "grandTotals": true }
```

`MatrixValueDef = { field, op, label?, format?, conditionalFormat?, prefix?, suffix?,
negativeStyle?, showAs? }`, with `showAs`: `value | percentOfRow |
percentOfColumn | percentOfTotal`.

### Also available (render via `ChartCard`)
`box` (distributions: `x` category, `y` raw observations, `whisker`), `sankey`
(flows: `source` + `target` + `value`), and `choropleth` (geography: a `geo`
FeatureCollection + `key` + `color`). See the library docs for these — most
dashboards won't need them.

## Conditional formatting

`ConditionalFormat` is one of:

- `{ type: "colorScale", scheme?, domain?, midpoint?, diverging?, target?: "background" | "text" }`
- `{ type: "bar", color?, negativeColor?, domain?, baseline?: "zero" | "min", showValue? }`
- `{ type: "icon", set?: "arrows" | "triangles" | "dots" | "trafficLights", rules?, position? }`
- `{ type: "rules", rules: ValueRule[] }`

`ValueRule = { when: "gt" | "gte" | "lt" | "lte" | "eq" | "ne" | "between", value, to?, background?, color?, weight?, icon? }`.

## Format mini-language

A small subset of d3-format (numbers) plus strftime-style dates.

**Numbers** — `[$][,][.precision][type]`:

| Hint | Input | Output |
| --- | --- | --- |
| `,d` | `1234567` | `1,234,567` |
| `.1f` | `3.14159` | `3.1` |
| `.0%` | `0.42` | `42%` |
| `$,.0f` | `5230` | `$5,230` |
| `.1s` | `1200` | `1.2k` |
| `.2s` | `1234567` | `1.2M` |

**Dates** — any hint containing `%` is a date pattern: `%Y` (2024), `%y` (24),
`%m` (01), `%d` (01), `%e` (1), `%B`/`%b` (January/Jan), `%a` (Mon), `%H`, `%M`,
`%p` (AM/PM), `%%` (literal `%`). Example: `%b %e, %Y` → `Jan 2, 2024`.

## Validation & gotchas

- **`encoding` is required** for `line`/`area`/`bar`/`scatter` (`x`+`y`), `pie`
  (`theta`+`color`), `heatmap` (`x`+`y`+`color`), and `funnel` (`stage`+`value`).
- **Field names must exist** in every `data` row (a typo silently drops the
  channel — run `validateSpec`).
- **Don't pre-pivot** — pass tidy rows and split with `series`.
- **Everything is plain JSON** — no functions, no DOM nodes, no `Date` objects.
- A spec with **empty `data`** makes `ChartCard` show its empty state — never ship
  placeholder rows.

## Lifecycle (for reference)

`ChartCard` (via the `Chart` wrapper) owns this; you rarely call it directly.

```ts
import { render, createSelectionStore } from "graphein";
const store = createSelectionStore();
const chart = render(el, spec, { store });
chart.on("selectionchange", (name, value) => console.log(name, value));
chart.getSelection("pick");
chart.setSelection("pick", null);
chart.clearSelection("pick");
chart.update(nextSpec);   // new data/config, same container
chart.resize();           // re-measure after a layout change
chart.destroy();          // teardown
```

When a render settles, Graphein sets `data-graphein-ready="true"` on the surface and
increments `window.__GRAPHEIN_READY` — handy for the Fabricator screenshot loop to
wait on.
