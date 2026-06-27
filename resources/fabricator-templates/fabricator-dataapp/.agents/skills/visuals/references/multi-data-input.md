# Multiple series & overlays

Multi-series in Envy is **one `series` channel over long/tidy rows** — not a
`series[]` prop and not a pre-pivot. Keep one row per observation, point
`encoding.series` at the category column, and Envy splits it into multiple lines /
grouped-or-stacked bars / stacked areas.

## Long result → series channel (the common case)

A DAX result that groups by a category (e.g.
`SUMMARIZECOLUMNS('Date'[Month], 'Product'[Category], "Revenue", [Total Revenue])`
→ `(Month, Category, Revenue)`) is **already** the shape Envy wants. Map it and
point `series` at the category — no pivot:

```tsx
const rows = toChartData(result, {
  columns: { month: "Date[Month]", category: "Product[Category]", revenue: "Revenue" },
});
// rows → [{ month: "2024-01", category: "Bikes", revenue: 84200 }, …]

<ChartCard title="Revenue by category" loading={isLoading} error={error}
  spec={{
    type: "bar",
    data: rows,
    stack: true,                       // omit for grouped (side-by-side) bars
    encoding: {
      x: { field: "month", type: "temporal" },
      y: { field: "revenue", type: "quantitative", format: "$,.0f" },
      series: { field: "category" },   // distinct values become the series
    },
  }} />
```

`stack: true` stacks (totals); omit it for grouped bars or overlapping areas.

## Multiple measure columns → melt to long

When one query returns **several measure columns** per x (a wide row like
`{ month, revenue, cost }`), melt them into long rows (one per measure) so a
single `series` channel can split them:

```tsx
const wide = toChartData(result); // [{ month, revenue, cost }, …]
const rows = wide.flatMap((r) => [
  { month: r.month, metric: "Revenue", value: r.revenue },
  { month: r.month, metric: "Cost",    value: r.cost },
]);

<ChartCard title="Revenue vs cost"
  spec={{
    type: "line", data: rows, points: true,
    encoding: {
      x: { field: "month", type: "temporal" },
      y: { field: "value", type: "quantitative", format: "$,.0f" },
      series: { field: "metric" },
    },
  }} />
```

## Merging two queries

When measures come from separate queries (different grain or source), merge them
into one **long** array in TypeScript keyed by the shared x + a `metric` label,
then split with `series` as above. Do the join in TS, not DAX, when the grains
differ.

```tsx
const rows = [
  ...toChartData(salesResult).map((r) => ({ month: r.month, metric: "Revenue", value: r.revenue })),
  ...toChartData(targetResult).map((r) => ({ month: r.month, metric: "Target", value: r.target })),
];
// → line/bar spec with series: { field: "metric" }
```

## Target / reference value

Envy v0.2.1 has no built-in reference-line option. To draw a goal or average, add
it as an extra **series** — a constant value repeated across every x — so it plots
as its own flat line:

```tsx
const goal = 1_000_000;
const rows = [
  ...series.map((r) => ({ month: r.month, metric: "Revenue", value: r.revenue })),
  ...series.map((r) => ({ month: r.month, metric: "Goal",    value: goal })),
];
// line spec, series: { field: "metric" } → "Revenue" plus a flat "Goal" line
```

## Subset overlay on a baseline (highlight)

To emphasize a subset against the whole, model the two as one two-valued `series`
field over aligned rows. Both come from aligned aggregations sharing the x key (the
subset is a separate aligned DAX aggregation — see the `dax` skill's design reference). Stack or overlap them by toggling `stack`.

```tsx
// rows: [{ category: "A", band: "All", value: 120 },
//        { category: "A", band: "Selected", value: 120 }, …]
<ChartCard title="Selected vs all"
  spec={{ type: "bar", data: rows,
    encoding: { x: { field: "category" },
                y: { field: "value", type: "quantitative" },
                series: { field: "band" } } }} />
```

## Keeping every category on the axis

Envy only plots the x values present in the rows. If a sparse measure would drop
categories, left-join the full dimension list onto the measure rows in TS (fill
missing measures with `0`/`null`) before mapping — so every category keeps its slot.

## Pies / donuts

A donut/pie is one value (`theta`) + one category (`color`) over a categorical
array — not multi-series:

```tsx
<ChartCard title="Sales by channel"
  spec={{ type: "pie", data: rows, donut: 0.6,
    encoding: { theta: { field: "sales", type: "quantitative", format: "$,.0f" },
                color: { field: "channel" } } }} />
```

## Combos & marks Envy lacks

There is **no dual-axis combo** and no radar/treemap/waterfall in this version.
Re-express the question with a supported type, or split it across two stacked
`ChartCard`s. See [choosing the closest type](custom-charts.md).
