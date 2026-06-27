---
name: visuals
description: >
  Use when adding charts, KPIs, tables, slicers, or any visual to a dashboard.
  Charts are authored as Envy chart specs — one chart = one JSON `ChartSpec`
  (type + tidy `data` + `encoding`) dropped into `<ChartCard spec={…} />`, which
  owns loading / empty / error and the app theme. Covers the spec model and the
  per-type recipes (line/area/bar/scatter/pie/heatmap), the DAX→rows helpers
  (toChartData / topN / deriveKpi), `KpiCard`, `DataTableCard` (Fabric DataGrid),
  slicers (dropdown/list/search/date-range/range + FilterBar) with shared filter
  state, layout (PageShell/grids/bento), value formatting, and color tokens.
---

# Visuals — author an Envy spec, drop it in a tile

**One chart = one JSON spec.** You don't hand-write SVG or wire a charting
library. You (1) map your DAX result into plain rows, (2) author a single Envy
[`ChartSpec`](references/envy-spec-reference.md) — a `type`, a tidy `data` array,
and an `encoding` that names the columns — and (3) drop it into
`<ChartCard spec={…} />`. The card owns the loading / empty / error states and
bridges the app theme, so a spec never needs a color or a size.

Three things are React components, not Envy specs:

- **KPIs** → `<KpiCard>` (big value + delta pill + sparkline).
- **Tabular data** → `<DataTableCard>` (the Fabric `DataGrid` — sortable,
  resizable, themed).
- **Filters** → the **slicers** (`FilterBar` + `DropdownSlicer`/…) over shared
  filter state.

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

**Phase 2 — Breadth:** add the rest (KPIs, more charts, a `DataTableCard`),
wrapped in `PageShell` + `KpiGrid`/`ChartGrid`/`BentoGrid`. Deploy + review every
1–2 additions.

**Phase 3 — Polish:** slicers, multi-series, formatting, dark-mode review.

## The data flow (map → author → drop in)

Every tile follows the same shape:

1. **Fetch** with `useSemanticModelQuery({ connection, query })` →
   `{ data, isLoading, error }` (see the `dax` + `fabric-data` skills).
2. **Map** the DAX result into the shape the visual wants. Both helpers accept
   the query result, a raw `QueryTable`, or `undefined` — no `status` check:
   - **Charts** want **tidy/long rows** → `toChartData(result, options?)`.
   - **DataGrid** wants a `DataTable` → `toDataTable(result, columnMetadata)`.
3. **Author + pass.** Put the rows in a spec's `data` and hand the spec (or the
   `DataTable`) to the card with `loading` + `error`. Don't pre-render
   skeletons/empty states — the cards do it.

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

Envy wants **long/tidy** data: one row per observation. To show multiple series
(multi-line, grouped/stacked bars, stacked areas), add a `series` channel that
points at the category column — **do not** widen the table into one column per
category.

```jsonc
// ✅ tidy — one row per (quarter, channel); split with series
[{ "quarter": "Q1", "channel": "Online", "revenue": 210 },
 { "quarter": "Q1", "channel": "Retail", "revenue": 180 }]
// encoding: { x:{field:"quarter"}, y:{field:"revenue"}, series:{field:"channel"} }
```

`toChartData` already returns long rows, so a normal DAX result drops straight in.
(`pivotChartData` still exists for the rare case you truly need wide rows, but with
Envy you almost never do.)

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
  (`theta`+`color`), and `heatmap` (`x`+`y`+`color`). `FieldDef.type` is
  `quantitative | temporal | ordinal | nominal` (inferred when omitted).
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
| Composition of a total | `bar` + `stack`, or `pie`/donut | bar: `series`; pie: `theta` + `color`, `donut` |
| Correlation / 3rd dim | `scatter` | `x`, `y`, optional `size`, `series` |
| Density across two categories | `heatmap` | `x`, `y`, `color`, `scheme` |
| Headline metric | **`KpiCard`** (React) | not an Envy spec — see Cards |
| Raw / detail records | **`DataTableCard`** (React) | not an Envy spec — see Cards |

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

// Heatmap — category × category, colored by a measure
{ "type": "heatmap", "data": rows, "scheme": "teal",
  "encoding": { "x": { "field": "quarter" }, "y": { "field": "region" },
                "color": { "field": "revenue", "type": "quantitative", "format": "$,.2s" } } }
```

Full field-by-field docs + every channel/option:
[Envy spec reference](references/envy-spec-reference.md).

### Gotchas

- **Horizontal bars aren't available** in this Envy version. `BarSpec` *types*
  an `orientation` field, but the runtime ignores it — bars always render
  vertical. For "top N" / ranked breakdowns, use a **vertical** bar and sort the
  rows by value (`topN(rows, key, n)`); don't set `orientation`.
- **Temporal fields are ISO strings** (`"2024-01"`, `"2024-01-15"`) or epoch ms —
  JSON has no `Date`. Mark the field `type: "temporal"` for a time axis.
- **Empty `data` → empty tile.** A spec with `data: []` makes `ChartCard` show
  its empty state. Never ship mock/placeholder rows.
- **No click events.** Envy charts have hover tooltips + crosshair but no
  click/selection callback — interactivity comes from **slicers** (below), not
  from clicking a mark.

## Cards

### `ChartCard`
The card shell — rounded-2xl, hairline border, no shadow — in two modes:

```tsx
// Spec mode (the common case): pass an Envy spec + query state.
<ChartCard title="Revenue" subtitle="Last 12 months"
  loading={isLoading} error={error} spec={spec} />

// Children mode: own the body (e.g. a slicer, custom content).
<ChartCard title="Filters"><ListSlicer … /></ChartCard>
```

Props: `title`, `subtitle`, `action` (right-aligned header slot), `spec`,
`height` (omit for responsive aspect-based height), `isEmpty` (force empty;
defaults to detecting empty `spec.data`), `footer`, `loading`, `error`,
`emptyMessage`, `onRetry`, `bodyClassName`, `children`.

### `KpiCard`
Hero metric tile: big formatted value, colored delta pill, optional accent dot /
badge / icon, and an inline `trend` sparkline.

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

Pass a literal `value` **or** `data` + `valueKey` (reads the first row). With no
value it renders the empty state — never a fake `0`. `delta` is a **percent
number** (`9.2` → `+9.2%`), not a fraction. Use `deriveKpi(result, { valueKey })`
to get `{ value, previous, delta, trend }` from a time series in one call.

> **Empty card with data present?** `valueKey` must match a mapped column name
> **exactly** (case-sensitive). Alias columns in `toChartData({ columns: … })`
> for stable keys; in dev the console prints the available keys.

### `DataTableCard`
The Fabric `DataGrid` in the card shell — sortable, filterable, resizable, themed.

```tsx
const table = toDataTable(data, [
  { name: "month", displayName: "Month" },
  { name: "revenue", displayName: "Revenue", format: "$#,0.00" },
]);
<DataTableCard title="Top accounts" loading={isLoading} error={error}
  data={table} pageSize={10} />
```

Props: `data` (a `DataTable`), `height`, `rowHeight`, `pageSize`, plus the shared
state props. Cell rendering + the `DataTable` shape:
[data-grid-visual.md](references/data-grid-visual.md) ·
[data-table.md](references/data-table.md).

## Shape helpers (DAX → rows)

- **`toChartData(result, { columns? })`** → tidy rows for a spec's `data`. Alias
  columns for stable keys.
- **`topN(rows, valueKey, n, { other?, ascending? })`** — sort + slice mapped
  rows for ranked bars / leaderboards, with an optional `"Other"` rollup.
- **`deriveKpi(result, { valueKey })`** → `{ value, previous, delta, trend }` for
  a `KpiCard`.
- **`toDataTable(result, columnMetadata)`** → a `DataTable` for `DataTableCard`.

## Layout

```tsx
<PageShell title="Sales overview" subtitle="FY24" actions={<ThemeToggle />}>
  <KpiGrid>{/* KpiCards */}</KpiGrid>
  <ChartGrid>{/* ChartCards */}</ChartGrid>
</PageShell>
```

- **`PageShell`** — sticky blurred header over a centered, max-width column. Put
  `<ThemeToggle />` (and a `FilterBar`) in `actions`.
- **`KpiGrid`** — fluid auto-fit grid (~220px min) for KPI cards.
- **`ChartGrid`** — fluid auto-fit grid (~380px min) for chart cards.
- **`Section`** — titled grouping (`title`, `subtitle`, `action`).
- **`BentoGrid` / `BentoItem`** — editorial 12-col layout for non-uniform sizes
  (a wide hero chart beside a stack of KPIs). Set each item's `colSpan` (1–12) and
  optional `rowSpan` (1–3). Reach for it over `ChartGrid` to avoid a uniform
  spreadsheet grid (the `app-design` skill asks for this).

```tsx
<BentoGrid>
  <BentoItem colSpan={8}><ChartCard title="Revenue" spec={lineSpec} /></BentoItem>
  <BentoItem colSpan={4}><KpiCard label="MRR" … /></BentoItem>
</BentoGrid>
```

## Controls & slicers (interactivity)

Envy charts don't emit clicks, so interactivity is **React-state filters** that
re-query or re-filter the data; the charts just re-render.

**Lightweight controls** — own the value in `useState`, filter your rows:

```tsx
const [range, setRange] = useState("30d");
<SegmentedControl value={range} onChange={setRange}
  options={[{ label: "7D", value: "7d" }, { label: "30D", value: "30d" }]} />
```

`SegmentedControl<T>` (single-select pills) · `FilterChips<T>` (multi-select chips).

**Power BI-style slicers** — wire one **shared filter model**. Wrap the dashboard
in `<FilterStateProvider>`; every slicer reads/writes the same selections. Then
**apply** them with `applyFilters(rows, selections)` (instant, client-side) or
`toDaxFilters(selections)` (re-query the model — see `dax`).

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

- **In a spec:** format numbers/dates with Envy's
  [format mini-language](references/formatting.md) on a `FieldDef` —
  `"$,.0f"`, `",d"`, `".1%"`, `".2s"` (→ `1.2k`), `"%b %e, %Y"` (dates).
- **KpiCard:** `valueFormat` — `"number" | "compact" | "currency" | "percent"
  (0–100) | "ratio" (0–1)` or a `(n) => string` function.
- **DataGrid:** a per-column `format` string (VBA/ECMA-376) in `columnMetadata`.
- **Color/theme:** never put hex in a spec — `ChartCard` themes every chart from
  `src/global.css` tokens (`--color-chart-1..6`, accent, dark mode). Restyle by
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
  PageShell, KpiGrid, ChartGrid, Section, BentoGrid, BentoItem, ThemeToggle,
  SegmentedControl, FilterChips,
  // slicers + shared filter state
  FilterStateProvider, useFilterState, FilterBar,
  DropdownSlicer, ListSlicer, SearchSlicer, DateRangeSlicer, RangeSlicer,
  useSlicerOptions, applyFilters, toDaxFilters,
  // cards + Envy runtime
  ChartCard, KpiCard, DataTableCard, Chart, validateSpec, type ChartSpec,
  // state tiles + sparkline
  EmptyTile, ErrorTile, ChartSkeleton, KpiSkeleton, TileBody, Sparkline,
  // DAX → rows helpers + formatting/color
  toChartData, toDataTable, topN, deriveKpi, pivotChartData,
  formatNumber, formatCompact, formatCurrency, formatPercent, formatDate,
  seriesColor, roleColor,
} from "@/components/dashboard";
```

## References

- [Envy spec reference](references/envy-spec-reference.md) — every chart type,
  channel, and option, with copy-paste JSON.
- [Formatting & color](references/formatting.md) — the format mini-language,
  `valueFormat`, DataGrid column formats, theme tokens.
- [Slicers & filter state](references/slicers.md) · [interactions](references/interactions.md).
- [DataGrid cell rendering](references/data-grid-visual.md) ·
  [the `DataTable` shape](references/data-table.md) ·
  [multiple data inputs](references/multi-data-input.md) ·
  [choosing the closest type](references/custom-charts.md).
