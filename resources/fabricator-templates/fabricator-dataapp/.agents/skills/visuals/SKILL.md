---
name: visuals
description: >
  Use when adding charts, KPIs, tables, slicers, or any visual to a dashboard.
  Charts are authored as Graphein chart specs — one chart = one JSON `ChartSpec`
  (type + tidy `data` + `encoding`) dropped into `<ChartCard spec={…} />`, which
  owns loading / empty / error and the app theme. Covers the spec model and the
  per-type recipes (line/area/bar/scatter/pie/heatmap/funnel/table/matrix), the
  DAX→rows helpers (toChartData / toTable / topN / deriveKpi), `KpiCard`,
  `DataTableCard` (Graphein table/matrix), slicers (dropdown/list/search/date-range/range + FilterBar)
  with shared filter state, interactivity, layout, value formatting, and color tokens.
---

# Visuals — author a Graphein spec, drop it in a tile

**One chart = one JSON spec.** You don't hand-write SVG or wire a charting
library. You (1) map your DAX result into plain rows, (2) author a single Graphein
[`ChartSpec`](references/graphein-spec-reference.md) — a `type`, a tidy `data`
array, and an `encoding` that names the columns — and (3) drop it into
`<ChartCard spec={…} />`. The card owns the loading / empty / error states and
bridges the app theme, so a spec never needs a color or a size.

Three things are React surfaces around Graphein specs or state:

- **KPIs** → `<KpiCard>` (big value + delta pill + sparkline).
- **Tabular data** → `<DataTableCard spec={tableOrMatrixSpec}>` (Graphein
  `table` / `matrix` — virtualized, sortable, conditional formatting, totals).
- **Filters** → the **slicers** (`FilterBar` + `DropdownSlicer`/…) over shared
  filter state; chart selections can bridge into the same state.

Everything is exported from one barrel: **`@/components/dashboard`**.

## Fast path

Optimize *time to wow*: ship one real tile, deploy, review, iterate.

**Phase 1 — Hero slice:** render ONE real visual the simplest way — map the hero
query with `toChartData(...)`, author a spec, pass it to a `ChartCard`. Pass
`loading` / `error` straight from the query hook. That's enough to deploy.

```tsx
import { ChartCard, toChartData } from "@/components/dashboard";
import { useSemanticModelQuery } from "@/hooks/use-semantic-model-query";

const { data, isLoading, error } = useSemanticModelQuery({ connection, query });

<ChartCard
  title="Revenue"
  subtitle="Last 12 months"
  loading={isLoading}
  error={error}
  spec={{
    type: "line",
    data: toChartData(data, { columns: { month: "Date[Month]", revenue: "Total Revenue" } }),
    points: true,
    encoding: {
      x: { field: "month", type: "temporal" },
      y: { field: "revenue", type: "quantitative", format: "$,.0f" },
    },
  }}
/>
```

**Phase 2 — Breadth:** add the rest (metric band, more charts, a `DataTableCard`),
wrapped in `PageShell` + `StatStrip` + `DashboardGrid`/`Tile`. Deploy + review every
1–2 additions.

**Phase 3 — Polish:** slicers, interactivity, multi-series, formatting, dark-mode
review.

## The data flow (map → author → drop in)

Every tile follows the same shape:

1. **Fetch** with `useSemanticModelQuery({ connection, query })` →
   `{ data, isLoading, error }` (see the `dax` + `fabric-data` skills).
2. **Map** the DAX result into the shape the visual wants. Helpers accept the
   query result, a raw `QueryTable`, or `undefined` — no `status` check:
   - **Charts** want **tidy/long rows** → `toChartData(result, options?)`.
   - **Tables** want a Graphein `table` spec → `toTable(result, { columns })`.
     Hand-author a `matrix` spec over `toChartData(result)` rows for pivots.
3. **Author + pass.** Put rows in a spec's `data` and hand the spec to the card
   with `loading` + `error`. Don't pre-render skeletons/empty states — the cards do it.

```tsx
// DAX rows are positional (unknown[][]); toChartData keys them by column
// (short) name and coerces numerics. Prefer explicit aliases for stable keys
// (and when two columns share a short name, e.g. Date[Month] + Ship[Month]):
const rows = toChartData(data, {
  columns: { month: "Date[Month]", revenue: "Total Revenue" },
});
// rows → [{ month: "2024-01", revenue: 84200 }, …]
```

### Keep data tidy — split with `series`, don't pre-pivot

Graphein wants **long/tidy** data: one row per observation. To show multiple
series (multi-line, grouped/stacked bars, stacked areas), add a `series` channel
that points at the category column — **do not** widen the table into one column
per category.

```jsonc
// ✅ tidy — one row per (quarter, channel); split with series
[{ "quarter": "Q1", "channel": "Online", "revenue": 210 },
 { "quarter": "Q1", "channel": "Retail", "revenue": 180 }]
// encoding: { x:{field:"quarter"}, y:{field:"revenue"}, series:{field:"channel"} }
```

`toChartData` already returns long rows, so a normal DAX result drops straight in.
(`pivotChartData` still exists for the rare case you truly need wide rows, but with
Graphein you almost never do.)

## Authoring a spec

A spec is a plain JSON object — no functions, no colors, no sizes:

```jsonc
{
  "type": "bar",                       // the discriminator
  "data": [ /* tidy rows */ ],         // required for every type
  "encoding": {                        // names the columns → visual channels
    "x": { "field": "quarter" },
    "y": { "field": "revenue", "type": "quantitative", "format": "$,.0f" },
    "series": { "field": "channel" }
  },
  "stack": true                        // per-type option
}
```

- **`encoding` is required** for `line`/`area`/`bar`/`scatter` (`x`+`y`), `pie`
  (`theta`+`color`), `heatmap` (`x`+`y`+`color`), and `funnel` (`stage`+`value`).
  `FieldDef.type` is `quantitative | temporal | ordinal | nominal` (inferred when omitted).
- **Validate before render** in tricky cases: `validateSpec(spec)` →
  `{ valid, errors, warnings }` (re-exported from the barrel). `ChartCard`
  renders whatever you pass, so catch field-name typos here.
- **Don't author `theme`.** `ChartCard` injects the app's CSS-token theme (brand
  color + dark mode) automatically. Recolor via `src/global.css` tokens, never
  per-spec hex.

### Pick a type

| Goal | `type` | Key channels / options |
|---|---|---|
| Trend over time | `line` (`area` to emphasize volume) | `x` temporal, `y`, optional `series`; `points`, `curve` |
| Part-to-whole over time | `area` + `stack: true` | `x`, `y`, `series` |
| Compare categories | `bar` | `x` category, `y`, optional `series`; `stack` or grouped |
| Stage conversion | `funnel` | `stage`, `value`, optional `percent: "first" | "previous"` |
| Composition of a total | `bar` + `stack`, or `pie`/donut | bar: `series`; pie: `theta` + `color`, `donut`, `labels` |
| Correlation / 3rd dim | `scatter` | `x`, `y`, optional `size`, `series` |
| Density across two categories | `heatmap` | `x`, `y`, `color`, `scheme` |
| Headline metric | **`KpiCard`** (React) | not a Graphein chart spec — see Cards |
| Raw / detail records | **`DataTableCard`** with `table` spec | `toTable(result, { columns })`; see Cards |
| Pivot / cross-tab | **`DataTableCard`** with `matrix` spec | `rows`, `columns`, `values`, totals, conditional formatting |

Rules of thumb: prefer `bar` over `pie` beyond ~6 slices; `stack` for
part-to-whole, grouped bars for direct comparison.

### Recipes (mirror the gallery)

```jsonc
// Multi-series line — points + currency Y, split by metric
{ "type": "line", "data": rows, "points": true,
  "encoding": { "x": { "field": "month", "type": "temporal" },
                "y": { "field": "value", "type": "quantitative", "format": "$,.0f" },
                "series": { "field": "metric" } } }

// Stacked area — quarterly channel mix
{ "type": "area", "data": rows, "stack": true,
  "encoding": { "x": { "field": "quarter", "type": "ordinal" },
                "y": { "field": "revenue", "type": "quantitative", "format": "$,.0f" },
                "series": { "field": "channel" } } }

// Grouped bars (drop `stack` for grouped; add it to stack)
{ "type": "bar", "data": rows, "stack": true,
  "encoding": { "x": { "field": "quarter" },
                "y": { "field": "revenue", "type": "quantitative", "format": "$,.0f" },
                "series": { "field": "channel" } } }

// Ranked bars — sort rows by value first (see "horizontal bars" gotcha)
{ "type": "bar", "data": topN(rows, "revenue", 8),
  "encoding": { "x": { "field": "region", "type": "nominal" },
                "y": { "field": "revenue", "type": "quantitative", "format": "$,.2s" } } }

// Bubble scatter — size = a third measure
{ "type": "scatter", "data": rows,
  "encoding": { "x": { "field": "price", "type": "quantitative", "format": "$,.0f" },
                "y": { "field": "units", "type": "quantitative" },
                "size": { "field": "margin", "title": "Margin" } } }

// Donut — theta = value, color = category
{ "type": "pie", "data": rows, "donut": 0.6,
  "encoding": { "theta": { "field": "value", "type": "quantitative", "format": "$,.0f" },
                "color": { "field": "category" } } }

// Pie with outside callout labels
{ "type": "pie", "data": rows,
  "labels": { "placement": "outside", "content": "category-percent", "minShare": 0.03, "connector": "muted" },
  "encoding": { "theta": { "field": "value", "type": "quantitative", "format": "$,.0f" },
                "color": { "field": "category" } } }

// Funnel — ordered stage conversion, labels show % vs previous stage
{ "type": "funnel", "data": rows, "labels": true, "percent": "previous",
  "encoding": { "stage": { "field": "stage" },
                "value": { "field": "users", "type": "quantitative", "format": ",d" } } }

// Heatmap — category × category, colored by a measure
{ "type": "heatmap", "data": rows, "scheme": "teal",
  "encoding": { "x": { "field": "quarter" }, "y": { "field": "region" },
                "color": { "field": "revenue", "type": "quantitative", "format": "$,.2s" } } }
```

Full field-by-field docs + every channel/option:
[Graphein spec reference](references/graphein-spec-reference.md).

### Gotchas

- **Horizontal bars aren't available** in this Graphein version. `BarSpec` *types*
  an `orientation` field, but the runtime ignores it — bars always render
  vertical. For "top N" / ranked breakdowns, use a **vertical** bar and sort the
  rows by value (`topN(rows, key, n)`); don't set `orientation`.
- **No dual-axis / combo chart.** Split it across two stacked `ChartCard`s, or use
  a `line` with `points` over the same x when one axis is enough.
- **Temporal fields are ISO strings** (`"2024-01"`, `"2024-01-15"`) or epoch ms —
  JSON has no `Date`. Mark the field `type: "temporal"` for a time axis.
- **Empty `data` → empty tile.** A spec with `data: []` makes `ChartCard` show
  its empty state. Never ship mock/placeholder rows.

## Cards

### `ChartCard`
The card shell — rounded-2xl, hairline border, no shadow — in two modes:

```tsx
// Spec mode (the common case): pass a Graphein spec + query state.
<ChartCard title="Revenue" subtitle="Last 12 months"
  loading={isLoading} error={error} spec={spec} />

// Children mode: own the body (e.g. a slicer, custom content).
<ChartCard title="Filters"><ListSlicer … /></ChartCard>
```

Props: `eyebrow`, `title`, `subtitle`, `action` (right-aligned header slot),
`variant` (`"surface" | "feature" | "outline" | "ghost"`), `accent`
(thin left spine; use chart tokens like `"chart-1"`), `spec`, `height` (omit
for responsive aspect-based height; table/matrix specs auto-use a fixed scroll
height), `isEmpty` (force empty; defaults to detecting empty `spec.data`),
`store`, `onSelectionChange`, `footer`, `loading`, `error`, `emptyMessage`,
`onRetry`, `bodyClassName`, `children`.

### `KpiCard`
Hero metric tile: big formatted value, colored delta pill, optional accent dot /
badge / icon, an optional `variant`, and an inline `trend` sparkline. Prefer
`StatStrip` for the top KPI header; use `KpiCard` for standalone metrics.

```tsx
<KpiCard
  label="Revenue"
  data={rows} valueKey="revenue"   // …or a literal `value={341500}`
  valueFormat="currency"
  delta={9.2}                       // signed PERCENT-scale number → +9.2% pill
  deltaLabel="vs last month"
  trend={rows.map((r) => r.revenue)} // sparkline; auto-derives delta if omitted
  invertDelta={false}               // true when down-is-good (cost, churn)
/>
```

Pass a literal `value` **or** `data` + `valueKey` (reads **only the first row** — feed a single-row measure result or a
precomputed `value`, not a multi-row table you expect it to aggregate). With no
value it renders the empty state — never a fake `0`. `delta` is a **percent
number** (`9.2` → `+9.2%`), not a fraction. Use `deriveKpi(result, { valueKey })`
to get `{ value, previous, delta, trend }` from a time series in one call.

> **Empty card with data present?** `valueKey` must match a mapped column name
> **exactly** (case-sensitive). Alias columns in `toChartData({ columns: … })`
> for stable keys; in dev the console prints the available keys.

### `DataTableCard`
A Graphein `table` / `matrix` in the card shell — virtualized, sortable, themed,
with conditional formatting, groups, and totals. Build a table spec with
`toTable(result, { columns })`; hand-author a `matrix` over `toChartData(result)`
rows for a pivot/cross-tab.

```tsx
const table = toTable(data, {
  columns: [
    { field: "account", source: "Customer[Account]", title: "Account" },
    { field: "revenue", source: "Revenue", title: "Revenue", format: "$,.0f", align: "right",
      conditionalFormat: { type: "bar", showValue: true } },
  ],
  sort: { field: "revenue", order: "desc" },
  totals: { label: "Total" },
});

<DataTableCard title="Top accounts" loading={isLoading} error={error}
  spec={table} height={420} />
```

Props: `spec` (`TableSpec | MatrixSpec`), `height` (default `360`), `store`,
`onSelectionChange`, `isEmpty`, plus the shared card state props (`title`,
`subtitle`, `action`, `loading`, `error`, `emptyMessage`, `onRetry`). See
[formatting & color](references/formatting.md) and the
[Graphein spec reference](references/graphein-spec-reference.md) for table/matrix
fields.

## Interactivity

Graphein specs can publish and consume named selections:

- `params` publishes a `point` or `interval` selection (click marks or brush).
- `highlight` consumes a selection by emphasizing matches and dimming the rest.
- `filter` consumes selections or literal predicates by subsetting rows.

```jsonc
// Bar publishes a region pick; line consumes it as a highlight.
{ "type":"bar", "data":rows,
  "params":[{ "name":"pick", "select":{ "type":"point", "fields":["region"] } }],
  "encoding":{ "x":{"field":"region"}, "y":{"field":"revenue"} } }
{ "type":"line", "data":rows, "highlight":{ "param":"pick" },
  "encoding":{ "x":{"field":"month","type":"temporal"}, "y":{"field":"revenue"}, "series":{"field":"region"} } }
```

Use `SelectionStoreProvider` / `useSelectionStore()` and pass the same `store` to
several `ChartCard`s or `DataTableCard`s for cross-highlight/cross-filter. To turn
a chart click into the app's existing server-side path, call
`useSelectionFilterBridge(store, { fieldMap })`: it maps Graphein selections into
`useFilterState`, which drives `applyFilters` and `toDaxFilters`. React slicers +
DAX re-query remain the primary filter path because this app's tiles are
independently DAX-aggregated per tile.

## Shape helpers (DAX → rows/specs)

- **`toChartData(result, { columns? })`** → tidy rows for a spec's `data`. Alias
  columns for stable keys.
- **`toTable(result, { columns, sort, totals, density, striped, numeric, text })`**
  → a Graphein `table` spec for `DataTableCard`. `columns` are Graphein table
  columns plus optional `source` (full `Table[Col]`, short name, or index).
- **`topN(rows, valueKey, n, { other?, ascending? })`** — sort + slice mapped
  rows for ranked bars / leaderboards, with an optional `"Other"` rollup.
- **`deriveKpi(result, { valueKey })`** → `{ value, previous, delta, trend }` for
  a `KpiCard`.

## Layout

Default to the new flat, non-uniform dashboard path: `PageShell` → `StatStrip` →
`DashboardGrid` + `Tile`. Build hierarchy with layout, surfaces, borders, accent
edges, and typography — **no gradients or shadows**.

```tsx
import {
  PageShell, ThemeToggle,
  StatStrip, Stat,
  DashboardGrid, Tile,
  ChartCard, DataTableCard,
} from "@/components/dashboard";

<PageShell eyebrow="Sales" title="Revenue overview" subtitle="FY24" actions={<ThemeToggle />}>
  <StatStrip>
    <Stat label="Revenue" data={rows} valueKey="revenue" valueFormat="currency" accent="chart-1" delta={12.4} />
    <Stat label="Orders" data={rows} valueKey="orders" delta={3.1} />
    <Stat label="Avg order" value={84.2} valueFormat="currency" delta={-1.2} />
  </StatStrip>

  <DashboardGrid>
    <Tile size="hero"><ChartCard title="Revenue trend" className="h-full" variant="feature" accent="chart-1" spec={lineSpec} /></Tile>
    <Tile size="md"><ChartCard title="By region" spec={barSpec} /></Tile>
    <Tile size="md"><ChartCard title="Channel mix" spec={pieSpec} /></Tile>
    <Tile size="full"><DataTableCard title="Detail" spec={tableSpec} /></Tile>
  </DashboardGrid>
</PageShell>
```

- **Frames:** `PageShell` is the default; `SidebarShell` adds an in-content
  filter/context `rail` for filter-heavy analytics; `AppShell` is the flexible
  lower-level frame for custom mastheads, `toolbar`, or `rail` composition.
- **Metric header:** `StatStrip` + `Stat` is one bordered, hairline-divided band
  of 2–5 metrics. Prefer it over four look-alike `KpiCard`s at the top.
- **Grid:** `DashboardGrid` is the responsive 12-col canvas. Use `Tile size`:
  `"sm"` 3, `"md"` 4, `"lg"` 6, `"wide"` 8, `"hero"` 8×2, `"full"` 12.
  Mix sizes for editorial rhythm; do **not** default to a uniform grid. A `hero`
  tile needs `className="h-full"` on the card inside (it spans 2 rows; without it
  the card sits at its natural height and leaves the lower row blank). Two `md`
  tiles right after a `hero` stack to fill its remaining 4-col × 2-row corner.
- **Zones/cards:** `SectionBand` creates alternate-surface (`surface-2`) zones.
  `Card`, `ChartCard`, and `KpiCard` use flat variants (`"surface" | "feature" |
  "outline" | "ghost"`); `Card`/`ChartCard` also take `accent` for a thin left
  spine. Use chart tokens such as `"chart-1"`, not raw colors.
- **Legacy:** `KpiGrid`, `ChartGrid`, `BentoGrid`, and `BentoItem` still exist for
  back-compat, but avoid them by default in new dashboards.

## Controls & slicers (interactivity)

Chart specs can now publish selections, but React slicers remain the primary
server-side filter path in this app: they update shared filter state, which then
re-filters client rows or re-queries DAX.

**Lightweight controls** — own the value in `useState`, filter your rows:

```tsx
const [range, setRange] = useState("30d");
<SegmentedControl value={range} onChange={setRange}
  options={[{ label: "7D", value: "7d" }, { label: "30D", value: "30d" }]} />
```

`SegmentedControl<T>` (single-select pills) · `FilterChips<T>` (multi-select chips).

**Power BI-style slicers** — wire one **shared filter model**. **The starter
already mounts a `FilterBar` of slicers in the `PageShell` toolbar, wrapped in
`<FilterStateProvider>`** — feed real options and apply the selections; you
rarely need to add the provider yourself. Every slicer reads/writes the same
selections. **Apply** them with `applyFilters(rows, selections)` (instant,
client-side) or `toDaxFilters(selections)` (re-query the model — see `dax`).

```tsx
<FilterStateProvider>
  <FilterBar>
    <DropdownSlicer label="Category" field="Product[Category]" options={catOptions} />
    <DateRangeSlicer label="Date" field="Date[Date]" />
    <RangeSlicer label="Price" field="Product[Price]" min={0} max={1000} />
  </FilterBar>
  <RevenueByRegion />   {/* reads useFilterState() → applyFilters(rows, selections) */}
</FilterStateProvider>
```

Slicers: `DropdownSlicer`, `ListSlicer`, `SearchSlicer`, `DateRangeSlicer`,
`RangeSlicer`, `FilterBar`. Fetch distinct values with
`useSlicerOptions({ connection, field, … })`. Full guide:
[slicers & filter state](references/slicers.md).

## Formatting & color

- **In a spec:** format numbers/dates with Graphein's
  [format mini-language](references/formatting.md) on a `FieldDef` —
  `"$,.0f"`, `",d"`, `".1%"`, `".2s"` (→ `1.2k`), `"%b %e, %Y"` (dates).
- **Pie labels:** use `labels` (`placement: "outside"` for callouts,
  `content: "category-percent"`, etc.).
- **KpiCard:** `valueFormat` — `"number" | "compact" | "currency" | "percent"
  (0–100) | "ratio" (0–1)` or a `(n) => string` function.
- **Table/matrix:** column/value `format` plus `conditionalFormat` (`bar`, `icon`,
  `colorScale`, `rules`).
- **Color/theme:** never put hex in a spec — `ChartCard` themes every chart from
  `src/global.css` tokens (`--color-chart-1..10`, accent, dark mode). Restyle by
  editing those tokens. See [formatting & color](references/formatting.md).

## State tiles

Used internally by the cards; use directly only for custom content.

- **`EmptyTile`** (`message`, `icon`, `height`) · **`ErrorTile`** (`error`,
  `title`, `onRetry`, `height`) · **`ChartSkeleton`** / **`KpiSkeleton`** ·
  **`TileBody`** (error → loading → empty → children switchboard).

## Import surface

```tsx
import {
  // layout + controls
  AppShell, PageShell, SidebarShell, DashboardGrid, Tile, StatStrip, Stat,
  SectionBand, Section, Card, ThemeToggle, SegmentedControl, FilterChips,
  // legacy layout (back-compat; avoid by default)
  KpiGrid, ChartGrid, BentoGrid, BentoItem,
  // slicers + shared filter state
  FilterStateProvider, useFilterState, FilterBar,
  DropdownSlicer, ListSlicer, SearchSlicer, DateRangeSlicer, RangeSlicer,
  useSlicerOptions, applyFilters, toDaxFilters,
  // cards + Graphein runtime
  ChartCard, KpiCard, DataTableCard, Chart, validateSpec, createSelectionStore,
  SelectionStoreProvider, useSelectionStore, useSelection, type ChartSpec,
  // selection bridge
  useSelectionFilterBridge, selectionToFilters, filterToSelection,
  // state tiles + sparkline
  EmptyTile, ErrorTile, ChartSkeleton, KpiSkeleton, TileBody, Sparkline,
  // DAX → rows/spec helpers + formatting/color
  toChartData, toTable, topN, deriveKpi, pivotChartData,
  formatNumber, formatCompact, formatCurrency, formatPercent, formatDate,
  seriesColor, roleColor,
} from "@/components/dashboard";
```

## References

- [Graphein spec reference](references/graphein-spec-reference.md) — every chart/table
  type, channel, and option, with copy-paste JSON.
- [Formatting & color](references/formatting.md) — the format mini-language,
  `valueFormat`, table/matrix formats, conditional formatting, theme tokens.
- [Slicers & filter state](references/slicers.md) · [interactions](references/interactions.md).
- [Multiple data inputs](references/multi-data-input.md) ·
  [choosing the closest type](references/custom-charts.md).
