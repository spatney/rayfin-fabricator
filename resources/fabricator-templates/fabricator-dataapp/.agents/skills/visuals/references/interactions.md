# Interactions & interactivity

Graphein adds a declarative selection model: charts and tables can publish
named selections, and other specs can consume them with `highlight` or `filter`.
In this app, that is an additive layer. The primary filter path remains React
slicers → shared filter state → `applyFilters` or server-side DAX re-query via
`toDaxFilters`, because tiles are independently DAX-aggregated per tile rather
than all sharing one client dataset.

## Graphein selection model

Three optional fields are available on any chart/table spec:

- `params` — selections this visual publishes. A `point` selection picks discrete
  marks (usually on click); an `interval` selection brushes a continuous range.
- `highlight` — consume a named selection by emphasizing matches and dimming the
  rest. An array unions multiple sources.
- `filter` — consume selections or literal predicates by subsetting rows (ANDed).

```jsonc
// Bar publishes a click selection named "pick" keyed by region.
{ "type": "bar", "data": rows,
  "params": [{ "name": "pick", "select": { "type": "point", "fields": ["region"] } }],
  "encoding": { "x": { "field": "region" }, "y": { "field": "revenue" } } }

// Line consumes that selection and dims non-matching regions.
{ "type": "line", "data": rows, "highlight": { "param": "pick" },
  "encoding": { "x": { "field": "month", "type": "temporal" },
                "y": { "field": "revenue" },
                "series": { "field": "region" } } }
```

Selection values flow through a `SelectionStore`: `createSelectionStore(initial?)`
plus `get` / `set` / `clear` / `all` / `subscribe`. `ChartCard`, `DataTableCard`,
and `Chart` all accept `store` and `onSelectionChange`.

## Primary app path: slicers + DAX

1. **Slicers** (Power BI-style) write to one **shared filter model**
   (`FilterStateProvider` → `useFilterState`). Wrap the dashboard once; every
   slicer reads/writes the same selections.
2. **Apply** the selections:
   - `applyFilters(rows, selections)` — instant, client-side filtering of mapped
     rows.
   - `toDaxFilters(selections)` — rebuild a server-side DAX query (see `dax`).
3. The affected `ChartCard` / `KpiCard` / `DataTableCard` gets new rows or a new
   spec and re-renders.

```tsx
<FilterStateProvider>
  <FilterBar>
    <DropdownSlicer label="Region" field="Geography[Region]" options={regionOptions} />
  </FilterBar>
  <RevenueChart />   {/* const rows = applyFilters(toChartData(data), selections) */}
</FilterStateProvider>
```

Full guide: [slicers & filter state](slicers.md).

## Chart-driven cross-highlight

Pass the same Graphein store to several specs. Publishers use `params`; consumers
use `highlight` or `filter`.

```tsx
import { ChartCard, SelectionStoreProvider, useSelectionStore } from "@/components/dashboard";

function DashboardTiles({ barSpec, lineSpec }) {
  const store = useSelectionStore();
  return <>
    <ChartCard title="Revenue by region" spec={barSpec} store={store} />
    <ChartCard title="Revenue trend" spec={lineSpec} store={store} />
  </>;
}

<SelectionStoreProvider>
  <DashboardTiles barSpec={barSpec} lineSpec={lineSpec} />
</SelectionStoreProvider>
```

This is best when the linked views already share the relevant field in their
client-side `data` arrays.

## Chart-driven cross-filter into slicers/DAX

Use `useSelectionFilterBridge(store, { fieldMap })` to turn a chart-published
selection into the app's existing slicer state. That keeps React slicers and
server-side DAX re-query as the source of truth while allowing a chart click to
cross-filter.

```tsx
function DashboardInteractions() {
  const store = useSelectionStore();
  useSelectionFilterBridge(store, {
    fieldMap: { region: "Geography[Region]" },
    params: ["regionPick"],
  });
  return <ChartCard spec={regionBarSpec} store={store} />;
}
```

Graphein also has native slicer specs (`dropdown` / `list` / `search` / `range` /
`dateRange`) and a `dashboard` spec (`interactions: "auto"`) rendered with
`renderDashboard`. Treat those as optional client-only paths here: auto-wiring
filters a view only if that view's data contains the field, while this app's tiles
are independently DAX-aggregated per tile.

## Drill-down

You can bridge a chart click into slicer state, but explicit grain controls remain
clearest for drill-down. Use a `SegmentedControl` or `DropdownSlicer` to pick the
level, then re-query (or re-filter) at that grain and re-render the same
`ChartCard`. The user sees exactly which level is active.
