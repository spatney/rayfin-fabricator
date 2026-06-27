# Interactions & interactivity

Envy charts render hover **tooltips** and a **crosshair**, but they expose **no
click or selection callback** — there is no click-to-cross-filter, cross-highlight,
or click-to-drill-down on a chart mark. Interactivity in this app comes from
**filter controls** that re-query or re-filter the data; the charts simply
re-render with the new rows.

## The interactivity model

1. **Slicers** (Power BI-style) write to one **shared filter model**
   (`FilterStateProvider` → `useFilterState`). Wrap the dashboard once; every
   slicer reads/writes the same selections.
2. **Apply** the selections:
   - `applyFilters(rows, selections)` — instant, client-side filtering of mapped
     rows.
   - `toDaxFilters(selections)` — rebuild a server-side DAX query (see
     `dax`).
3. The affected `ChartCard` / `KpiCard` / `DataTableCard` gets new `data` and
   re-renders. No mark wiring required.

```tsx
<FilterStateProvider>
  <FilterBar>
    <DropdownSlicer label="Region" field="Geography[Region]" options={regionOptions} />
  </FilterBar>
  <RevenueChart />   {/* const rows = applyFilters(toChartData(data), selections) */}
</FilterStateProvider>
```

Lightweight, self-managed controls (`SegmentedControl`, `FilterChips`) are an
alternative when you only need a local `useState` filter on one tile.

Full guide: [slicers & filter state](slicers.md).

## Drill-down

There's no click-to-drill on a chart. To offer "go deeper", drive the grain from a
control: a `SegmentedControl` or `DropdownSlicer` that picks the level, then
re-query (or re-filter) at that grain and re-render the same `ChartCard`. The user
changes the level explicitly instead of clicking a bar.
