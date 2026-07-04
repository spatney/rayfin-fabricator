---
name: visual-style-recipes
description: Use when generating chart and table visuals. Provides guidance for consistent, polished data visualizations.

---
# Visual Style Recipes

Styling guidance for dashboard visuals — theming, dark mode, layout, and
chart-specific patterns. Charts are **Graphein specs** rendered by `ChartCard`; KPIs
use `KpiCard`; tabular data uses `DataTableCard` with Graphein `table` / `matrix` specs. For the
full spec model see the `visuals` skill.

---

## Theming

### How theming works

All visual styling flows from CSS custom properties defined in `src/global.css`.
Kit components and the chart theme bridge read these variables at runtime — edit
`global.css` to theme everything.

- **Light mode** values go in the `@theme` block
- **Dark mode** overrides go in the `.dark` block
- Changes cascade automatically to all charts, KPIs, and tables

The important tokens are `--color-primary`, `--color-primary-soft`,
`--color-background`, `--color-card`, `--color-border`, `--color-ring`,
`--color-brand`, `--color-chart-1` through `--color-chart-10`, `--font-display`,
`--font-sans`, `--font-mono`, and the radius scale (`--radius-sm` through
`--radius-3xl`, plus `--radius-full`).

### Charts auto-theme — never put color or theme in a spec

`ChartCard` bridges the app's CSS tokens into Graphein automatically, so an authored
spec carries **no `theme` and no per-series colors**. Author the data + encoding
only:

```tsx
import { ChartCard, toChartData } from "@/components/dashboard";

<ChartCard
  title="Revenue trend"
  loading={isLoading}
  error={error}
  spec={{
    type: "line",
    data: toChartData(data),
    encoding: {
      x: { field: "Month", type: "temporal" },
      y: { field: "Revenue", type: "quantitative", format: "$,.0f" },
    },
  }}
/>;
```

Series colors come from `--color-chart-1` through `--color-chart-10` **in series
order** (first series → `--color-chart-1`, and so on). To recolor charts, edit
those tokens in `global.css` (and the `.dark` block) — don't hardcode colors in
the spec. The accent is a single swappable family: recolor `--color-primary`,
`--color-primary-soft`, `--color-primary-strong`, `--color-chart-1`,
`--color-ring`, and `--color-brand` together.

### Color that carries meaning (KPIs)

`KpiCard` accents and semantic roles still take named colors. Prefer chart
tokens (`"chart-1"`…`"chart-10"`) for ordered metrics and semantic roles
(`"success"`, `"warning"`, `"info"`, `"brand"`, `"neutral"`) when the color
carries meaning — never raw hex.

```tsx
<KpiCard label="Revenue" value={revenue} valueFormat="currency" accent="chart-1" />
<KpiCard label="Churn" value={churn} valueFormat="percent" accent="warning" invertDelta />
```

### Chart typography alignment

Chart axes, legends, and tooltips inherit the app fonts through the theme
bridge. Keep type consistent by updating `--font-sans`, `--font-display`, and
`--font-mono` rather than styling charts individually.

- Keep chart font family aligned with the primary app font choice.
- Adjust card titles and surrounding layout density to match the type hierarchy.
- Re-check label legibility after changing theme colors, since typography and
  color contrast must work together.

---

## Layout

### Chart container sizing

Use `PageShell`, `StatStrip`, and `DashboardGrid` + `Tile` for structure. `ChartCard`
owns a responsive chart body; set the card `height` prop only when a specific
visual needs more or less vertical space.

```tsx
import {
  PageShell, ThemeToggle, StatStrip, Stat, DashboardGrid, Tile,
  ChartCard, DataTableCard, toChartData, toTable,
} from "@/components/dashboard";

const trend = toChartData(trendResult);   // long rows: { Month, Revenue }
const mix = toChartData(mixResult);        // long rows: { Channel, Sales }
const table = toTable(detailResult, {
  columns: [
    { field: "Account", source: "Customer[Account]", title: "Account" },
    { field: "Revenue", source: "Revenue", title: "Revenue", format: "$,.0f", align: "right" },
  ],
});

<PageShell title="Sales overview" actions={<ThemeToggle />}>
  <StatStrip>
    <Stat label="Revenue" data={kpi} valueKey="revenue" valueFormat="currency" accent="chart-1" />
    <Stat label="Margin" data={kpi} valueKey="margin" valueFormat="percent" accent="success" />
  </StatStrip>
  <DashboardGrid>
    <Tile size="hero"><ChartCard title="Revenue trend" variant="feature" accent="chart-1" className="h-full"
      spec={{ type: "line", data: trend, encoding: { x: { field: "Month", type: "temporal" }, y: { field: "Revenue", type: "quantitative", format: "$,.2s" } } }} /></Tile>
    <Tile size="md"><ChartCard title="Sales mix"
      spec={{ type: "pie", donut: true, data: mix, encoding: { theta: { field: "Sales", type: "quantitative", format: "$,.2s" }, color: { field: "Channel", type: "nominal" } } }} /></Tile>
    <Tile size="full"><DataTableCard title="Details" spec={table} /></Tile>
  </DashboardGrid>
</PageShell>;
```

### Chart container height chain

Charts must fill their card's visible height — no dead space, no cropping. With
`ChartCard` the height chain is mostly handled for you:

1. **Grid/flex cell** → provides the width and placement
2. **Card wrapper** → `ChartCard` owns the rounded card shell
3. **Tile body** → state handling reserves the requested height
4. **Graphein `<Chart>`** → responsive canvas fills that body

If a chart appears squished, first check the surrounding grid or flex parent,
then adjust the card `height` prop. Do not wrap chart cards in fixed-height
containers unless the whole dashboard section needs that constraint.

The kit's `DataTableCard` wraps Graphein `table` / `matrix` specs in a rounded,
scrollable, themed container.

### `minHeight` vs `height` for chart containers

Validate that containers provide a definite height when a section relies on
full-height cards.

- `height` creates a definite height and allows full-height wrappers to resolve.
- `minHeight` alone does not create a definite height for flex/grid children and
  can lead to squished charts in standalone sections.

Use layout-aware checks:

- Grid layouts: `minHeight` on the grid container is generally acceptable because
  grid tracks provide definite row heights.
- Standalone full-width chart sections: prefer explicit `height` on the
  section/container when using full-height card wrappers.

### Chart titles in cards

Use the card `title` and `subtitle` props (not a `title` inside the spec) for
dashboard cards. Scale the surrounding page headings to match the app's type
hierarchy.

- The title should summarize what the chart shows in plain language (e.g.,
  "Monthly Revenue by Region", "Top 10 Products by Units Sold").
- Derive the title from the data fields and the intent of the visualization — do
  not use generic titles like "Chart" or "Bar Chart".
- If the user provides a title, use it as-is. Otherwise infer a good title from
  the query and encodings.

> **Layout creativity**: Consider mixed card spans, a full-width hero row,
> asymmetric column ratios, or generous negative space between sections. The
> layout should reinforce the aesthetic direction.

---

## Named conventions

Use named conventions through component props and spec format strings instead of
raw values.

| Convention | Where | Effect |
|---|---|---|
| `--color-chart-1`…`--color-chart-10` (token order) | Chart series | Series take palette colors by order; recolor by editing tokens |
| `accent="chart-1"` / `"success"` / `"warning"` | `KpiCard` | Tokenized accent dot / semantic meaning |
| `valueFormat="currency"` / `"percent"` / `"ratio"` / `"compact"` | `KpiCard` | Centralized KPI number formatting |
| `format: "$,.0f"` / `".1%"` / `"%b %Y"` | Spec axis/label channels | Graphein format mini-language (see `visuals` → `formatting.md`) |
| `format` / `conditionalFormat` on table or matrix fields | `DataTableCard` | Per-column number/date formatting and visual emphasis |

---

## Soft Guidance

These produce good results. Deviate when the design calls for it.

### Card content spacing

Content inside a card should use consistent horizontal padding that matches the
card header. `ChartCard` and `KpiCard` already do this; keep any custom children
aligned with the same rhythm.

### Bar charts

Author a `bar` spec. Bars round corners via `cornerRadius`. Bars are vertical;
for ranked categories or long labels, pre-sort and limit with `topN(rows, key, n)`
so the axis stays readable.

```tsx
<ChartCard
  title="Revenue by region"
  spec={{
    type: "bar",
    data: topN(toChartData(data), "Revenue", 8),   // { Region, Revenue }
    encoding: {
      x: { field: "Region", type: "nominal" },
      y: { field: "Revenue", type: "quantitative", format: "$,.2s" },
    },
  }}
/>;
```

### Grouped / stacked bars

Multi-series comes from **long rows** + `encoding.series` (one row per category ×
series), not from wide columns. Add `stack: true` when the intent is
contribution-to-total rather than side-by-side comparison.

```tsx
// long rows: { Region, Measure: "Actual" | "Target", Amount }
<ChartCard
  title="Actual vs target"
  spec={{
    type: "bar",
    data: rows,
    encoding: {
      x: { field: "Region", type: "nominal" },
      y: { field: "Amount", type: "quantitative", format: "$,.0f" },
      series: { field: "Measure", type: "nominal" },
    },
  }}
/>;
```

### Trend lines

Use `line` for precise trend comparison; set `area: true` when the filled shape
helps emphasize volume. For a goal/threshold, add `annotations: [{ type: "line",
value: target }]` (graphein 0.16); or state it in the card `footer`.

```tsx
<ChartCard
  title="Monthly recurring revenue"
  footer={`Target: ${formatCurrency(target)}`}
  spec={{
    type: "line",
    data: toChartData(data),   // { Month, MRR }
    encoding: {
      x: { field: "Month", type: "temporal" },
      y: { field: "MRR", type: "quantitative", format: "$,.0f" },
    },
  }}
/>;
```

### Pie / Donut

Use a `pie` spec with `donut: true` for categorical share. Encode `theta` (the
value) and `color` (the category).

```tsx
<ChartCard
  title="Sales by channel"
  spec={{
    type: "pie",
    donut: true,
    data: toChartData(data),   // { Channel, Sales }
    encoding: {
      theta: { field: "Sales", type: "quantitative", format: "$,.0f" },
      color: { field: "Channel", type: "nominal" },
    },
  }}
/>;
```

### KPI rows

Use `StatStrip` with `Stat` for the metric band (one band, 2–5 metrics). Use
`accent` to connect each metric to the chart palette or a semantic role; use
`invertDelta` for down-is-good measures (churn, cost, latency). `delta` is a
**percent-scale** number (`12.4` → "+12.4%"). `KpiGrid` is legacy.

```tsx
<StatStrip>
  <Stat label="Revenue" data={kpi} valueKey="revenue" valueFormat="currency" delta={12.4} accent="chart-1" />
  <Stat label="Churn" data={kpi} valueKey="churn" valueFormat="percent" delta={-0.6} accent="warning" invertDelta />
</StatStrip>;
```

### Tables

Use `DataTableCard` for Graphein `table` / `matrix` specs. Map detail query tables with
`toTable(result, { columns })`; the card handles theming, scrolling, sorting,
conditional formatting, totals, loading, empty, and error states.

```tsx
const table = toTable(data, {
  columns: [
    { field: "Account", source: "Customer[Account]", title: "Account" },
    { field: "Revenue", source: "Revenue", title: "Revenue", format: "$,.0f", align: "right",
      conditionalFormat: { type: "bar", showValue: true } },
  ],
});

<DataTableCard title="Top accounts" loading={isLoading} error={error} spec={table} />;
```

---

## When Graphein lacks a chart type

There is **no custom-chart escape hatch**. If a visualization is not a Graphein type
(radar, sunburst…), re-express the *insight* with the closest supported type —
Graphein 0.16 ships `line`, `area`, `bar`, `scatter`, `combo`
(dual-axis), `histogram`, `pie`/donut, `heatmap`, `calendarHeatmap`, `funnel`,
`box`, `sankey`, `choropleth`, `treemap`, `gauge`, `bullet`, `waterfall`, `slope`,
`dumbbell`, plus `table`/`matrix` (KPIs use `KpiCard`). See `visuals` → Gotchas and
`custom-charts.md`. Never hand-write SVG or pull in another chart library.

---

## Tables and matrices

Use the kit wrapper instead of wiring a table manually. `DataTableCard` renders a
Graphein `table` or `matrix` spec and receives the CSS-token theme automatically.

```tsx
import { DataTableCard, toTable } from "@/components/dashboard";

const table = toTable(data, { columns });

<DataTableCard title="Accounts" spec={table} loading={isLoading} error={error} />;
```

Font, spacing, border, focus, scrollbar, conditional formatting, and dark-mode
styles are controlled by CSS variables in `global.css` and cascade automatically.
