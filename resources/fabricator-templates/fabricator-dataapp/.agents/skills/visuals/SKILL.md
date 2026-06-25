---
name: visuals
description: >
  Use when adding charts, KPIs, tables, or any visual to a dashboard. This is
  the dashboard KIT catalog: a curated set of pre-built, themed components you
  COMPOSE by passing data — you should rarely hand-write Recharts or raw JSX.
  Covers KpiCard, the chart cards (line/area/bar/donut), DataTableCard,
  layout (PageShell/grids), controls, state tiles, the data-mapping helpers
  (toChartData / toDataTable), value formatting, color tokens, and the
  Recharts escape hatch.
---

# Visuals — the dashboard kit (compose, don't hand-code)

**Pick a component from the kit and pass it data.** The kit lives in
`src/components/dashboard/` and is exported from a single barrel
(`@/components/dashboard`). Each card owns its theme, axes, gridlines,
tooltip, legend, number/date formatting, dark mode, and loading/empty/error
states — so you write *data*, not chart code. Writing a Recharts spec or a
bespoke `<div>` grid by hand is the slow, expensive, error-prone path; reach
for it only when nothing in the kit fits (see [Escape hatch](#escape-hatch)).

Charts are **Recharts**. Tables are the Fabric **DataGrid**. There is no
Vega-Lite.

## Fast path

Optimize *time to wow*: ship one real tile, deploy, review, iterate.

**Phase 1 — Hero slice:** render ONE compelling, real visual the simplest
way — a single `KpiCard` or `LineChartCard`/`BarChartCard` fed your hero
query. Map the DAX result with `toChartData(...)`, pass `loading`/`error`
straight from the query hook, and you're done. That is enough to deploy.

```tsx
import { LineChartCard, toChartData } from "@/components/dashboard";
import { useSemanticModelQuery } from "@/hooks/use-semantic-model-query";

const { data, isLoading, error } = useSemanticModelQuery({ connection, query });
const rows = toChartData(data); // pass the query result straight in

<LineChartCard
  title="Revenue"
  loading={isLoading}
  error={error}
  data={rows}
  xKey="Month"
  series={[{ key: "Revenue", color: "chart-1" }]}
  valueFormat="currency"
/>
```

**Phase 2 — Breadth:** add the remaining KPIs/charts/table, wrapping them in
`PageShell` + `KpiGrid`/`ChartGrid`. Deploy + review every 1–2 additions.

**Phase 3 — Polish:** filters (`SegmentedControl`/`FilterChips`), reference
lines, sparklines in KPI cards, donut breakdowns, and final formatting.

Read the per-component props below only when you reach for that component.
Every component also carries a JSDoc usage snippet — hover it or open the file.

## The two-step data flow

Every tile follows the same shape. **Map once, pass to the card.**

1. **Fetch** with `useSemanticModelQuery({ connection, query })` →
   `{ data, isLoading, error }` (see the `query-design` + `fabric-sdk` skills).
2. **Map** the DAX result into the shape the card wants. Both helpers accept the
   query result, a raw `QueryTable`, or `undefined` — no `status` check needed:
   - **Charts** want an array of row objects → `toChartData(result, options?)`.
   - **DataGrid** wants a `DataTable` → `toDataTable(result, columnMetadata)`.
3. **Pass** `data` + `loading` + `error` to the card. Don't pre-render
   skeletons/empty states yourself — the cards do it.

```tsx
// DAX rows are positional (unknown[][]); toChartData keys them by column
// (short) name and coerces numeric columns to numbers.
const rows = toChartData(data);
// rows → [{ Month: "Jan", Revenue: 84200 }, …]

// Prefer explicit aliases — stable lowercase keys, and the only safe option
// when two columns share a short name (e.g. Date[Month] + Ship[Month]):
const rows2 = toChartData(data, {
  columns: { month: "Date[Month]", revenue: "Total Revenue" },
});
// rows2 → [{ month: "Jan", revenue: 84200 }, …]
```

## Import surface

```tsx
import {
  // layout
  PageShell, KpiGrid, ChartGrid, Section, ThemeToggle,
  // controls
  SegmentedControl, FilterChips,
  // cards
  KpiCard, ChartCard, DataTableCard,
  // charts
  LineChartCard, AreaChartCard, BarChartCard, DonutChartCard, PieChartCard,
  Sparkline, ChartTooltip,
  // state tiles
  EmptyTile, ErrorTile, ChartSkeleton, KpiSkeleton, TileBody,
  // helpers
  toChartData, toDataTable,
  formatNumber, formatCompact, formatCurrency, formatPercent, formatDate,
  seriesColor, roleColor, useChartTheme,
} from "@/components/dashboard";
```

## Shared conventions

- **`valueFormat`** (charts + KPI): `"number" | "compact" | "currency" |
  "percent" | "ratio"` or a `(n: number) => string` function. `"percent"`
  expects a 0–100 value; `"ratio"` expects 0–1.
- **Colors** accept a chart token (`"chart-1"`…`"chart-6"`), a semantic role
  (`"success" | "danger" | "warning" | "info" | "brand" | "neutral"`),
  a `var(--…)`, or a hex string. Prefer tokens so charts re-theme with dark
  mode. Series default to the palette in order.
- **State props** (`loading`, `error`, `emptyMessage`, `onRetry`) are shared
  by every chart/table card. Pass the query hook's `isLoading`/`error`
  directly; the card renders skeleton → error → empty → content.
- **Never ship mock/fake data.** A tile with no data shows the empty state.

---

## Layout

### `PageShell`
The page frame: sticky blurred header (title / subtitle / actions) over a
centered, max-width column. Put `<ThemeToggle />` (and filters) in `actions`.

```tsx
<PageShell title="Sales overview" subtitle="FY24" actions={<ThemeToggle />}>
  <KpiGrid>{/* KpiCards */}</KpiGrid>
  <ChartGrid>{/* ChartCards */}</ChartGrid>
</PageShell>
```

- **`KpiGrid`** — responsive 1→2→4 column grid for KPI cards.
- **`ChartGrid`** — responsive 1→2 column grid for chart cards.
- **`Section`** — titled grouping (`title`, `subtitle`, `action`) for a band
  of tiles.
- **`ThemeToggle`** — light/dark button wired to the app theme context.

## Controls (filters)

Controlled — own the value in `useState`, then filter your mapped rows (or
re-query; see `query-design`).

```tsx
const [range, setRange] = useState("30d");
<SegmentedControl
  value={range} onChange={setRange}
  options={[{ label: "7D", value: "7d" }, { label: "30D", value: "30d" }]}
/>

const [regions, setRegions] = useState<string[]>([]);
<FilterChips value={regions} onChange={setRegions} options={regionOptions} />
```

- **`SegmentedControl<T>`** — single-select pill group (`size?: "sm" | "md"`).
- **`FilterChips<T>`** — multi-select chip row (`value` is an array).

---

## Cards

### `KpiCard`
Hero metric tile: big formatted value, colored delta pill, optional accent
dot / badge / icon, and an optional sparkline slot (`children`).

```tsx
<KpiCard
  label="Revenue"
  data={rows}             // derive the value from the first row…
  valueKey="revenue"      // …reading this column
  valueFormat="currency"
  secondary="vs $1.1M last month"   // optional muted sub-value
  delta={12.4}            // signed % vs baseline → green/red pill
  deltaLabel="vs last month"
  accent="chart-1"
  loading={isLoading}
  error={error}
  invertDelta={false}     // set true when down-is-good (cost, churn, latency)
>
  <Sparkline data={trend} color="chart-1" />
</KpiCard>
```

Pass either a literal `value` **or** `data` + `valueKey` (reads the first row).
With no value and no rows it renders the empty state — never a fake `0`.

> **Empty card with data present?** `valueKey` must match a column name **exactly**
> (case-sensitive) as it appears in your mapped rows. A mismatch (wrong casing, an
> un-aliased DAX name like `[Total Revenue]`, or forgetting `toChartData`) makes the
> card fall back to its empty state. In dev the console prints the available keys —
> alias columns in `toChartData({ columns: { revenue: "Total Revenue" } })` for stable keys.

Props: `label`, `value` (number→formatted, or string) **or** `data` + `valueKey`,
`valueFormat`, `secondary`, `delta`, `deltaLabel`, `invertDelta`, `accent`,
`icon`, `badge`, `loading`, `error`, `emptyMessage`, `onRetry`, `children`.

### `ChartCard`
Titled card shell (rounded-2xl, hairline border, no shadow) wrapping any
chart or content. The chart cards below use it internally; use it directly
only for custom content or the [escape hatch](#escape-hatch).

```tsx
<ChartCard title="Revenue" subtitle="Last 12 months" action={<FilterChips … />}>
  {/* any chart or content */}
</ChartCard>
```

Props: `title`, `subtitle`, `action`, `footer`, `bodyClassName`, `children`.

### `DataTableCard`
Fabric `DataGrid` inside the card shell — sortable, filterable, resizable,
themed for light/dark. See [data-grid-visual.md](references/data-grid-visual.md)
for custom cell rendering and [data-table.md](references/data-table.md) for
the `DataTable` shape.

```tsx
const table = toDataTable(data, columnMetadata); // result → DataTable

<DataTableCard title="Top accounts" loading={isLoading} error={error}
  data={table} pageSize={10} />
```

Props: `data` (a `DataTable`), `height`, `rowHeight`, `pageSize`, plus the
shared state props.

---

## Charts

All chart cards share `ChartCardCommonProps` (`title`, `subtitle`, `action`,
`className`, `loading`, `error`, `emptyMessage`, `onRetry`) and render the
right state automatically.

### `LineChartCard` / `AreaChartCard`
Time series, single or multi-series. `AreaChartCard` fills under the line and
supports `stacked`.

```tsx
<LineChartCard
  title="Revenue" subtitle="Last 12 months"
  loading={isLoading} error={error}
  data={rows}
  xKey="Month"
  xFormat={(m) => formatDate(m, "short")}
  series={[
    { key: "Revenue", label: "Revenue", color: "chart-1" },
    { key: "Target",  label: "Target",  color: "neutral" },
  ]}
  valueFormat="currency"
  referenceLines={[{ y: 1_000_000, label: "Goal" }]}
/>
```

### `BarChartCard`
Grouped or stacked bars (`stacked`), vertical by default. Set `horizontal`
for ranked horizontal bars (category on the Y axis) — ideal for "top N"
breakdowns. Bars plot in row order, so sort `rows` by value first.

```tsx
<BarChartCard title="Revenue by region" data={rows} xKey="Region"
  series={[{ key: "Revenue" }]} valueFormat="currency" />

// Ranked horizontal bars — categories down the Y axis, sorted by value:
<BarChartCard title="Top regions" horizontal data={rows} xKey="region"
  series={[{ key: "revenue", label: "Revenue" }]} valueFormat="currency" />
```

Cartesian chart props: `data` (mapped rows), `xKey`, `series`
(`{ key, label?, color?, stackId? }[]`), `height`, `valueFormat`, `xFormat`,
`showGrid`, `showLegend`, `stacked`, `layout`/`horizontal` (bar),
`curve` (line/area), `referenceLines`.

### `DonutChartCard` / `PieChartCard`
Categorical share with a value + % legend. The donut center shows the total
by default.

```tsx
<DonutChartCard title="Sales by channel" data={rows}
  nameKey="Channel" valueKey="Sales" valueFormat="currency" />
```

Props: `data`, `nameKey`, `valueKey`, `colors?`, `height`, `valueFormat`,
`donut`, `centerLabel`, `showLegend`, plus shared state props.

### `Sparkline`
Compact, axis-less trend for KPI cards / inline cells. Accepts a raw
`number[]` (or objects + `dataKey`).

```tsx
<Sparkline data={[12, 18, 9, 22, 17, 25]} color="chart-1" />
```

### `ChartTooltip`
The themed tooltip the chart cards wire up automatically. You only touch it
in the escape hatch (`<Tooltip content={<ChartTooltip valueFormat="currency" />} />`).

## State tiles

Used internally by the cards; use directly only in the escape hatch or for
custom content. `TileBody` is the switchboard (error → loading → empty →
children).

- **`EmptyTile`** (`message`, `icon`, `height`) — friendly no-data state.
- **`ErrorTile`** (`error`, `title`, `onRetry`, `height`).
- **`ChartSkeleton`** / **`KpiSkeleton`** — shimmer placeholders.

---

## Escape hatch

If a visualization genuinely isn't in the kit (e.g. scatter, radar, treemap,
a combo chart), compose it inside a `ChartCard` using Recharts directly **plus
the kit's helpers** so it still matches the theme:

```tsx
import { ScatterChart, Scatter, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { ChartCard, ChartTooltip, useChartTheme, seriesColor } from "@/components/dashboard";
import { axisProps, gridProps } from "@/lib/chartTokens";

function CorrelationCard({ data }: { data: Array<Record<string, number>> }) {
  const theme = useChartTheme();
  return (
    <ChartCard title="Spend vs. revenue">
      <ResponsiveContainer width="100%" height={280}>
        <ScatterChart>
          <XAxis dataKey="spend" {...axisProps(theme)} />
          <YAxis dataKey="revenue" {...axisProps(theme)} />
          <Tooltip content={<ChartTooltip valueFormat="currency" />} />
          <Scatter data={data} fill={seriesColor(0)} />
        </ScatterChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
```

Rules for the escape hatch:
- Wrap in `ChartCard`; keep the `ResponsiveContainer`.
- Use `axisProps`/`gridProps` + `useChartTheme()` and `seriesColor`/`roleColor`
  (or `var(--color-chart-n)`) — never hardcode hex, so dark mode keeps working.
- Pass `content={<ChartTooltip … />}` for a themed tooltip.
- If you find yourself writing the same custom chart twice, add it to the kit
  instead.

For deeper details: [formatting & colors](references/formatting.md),
[multiple series & overlays](references/multi-data-input.md),
[DataGrid cell rendering](references/data-grid-visual.md),
[the `DataTable` shape](references/data-table.md).
