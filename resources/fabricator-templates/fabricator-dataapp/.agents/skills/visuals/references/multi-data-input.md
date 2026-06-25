# Multi-Table Input for VegaVisual

`VegaVisual`'s `data` prop accepts two shapes:

- A single `DataTable` — injected as the spec's anonymous root `data`.
- A `Record<string, DataTable>` — each entry is emitted under `spec.datasets[name]`. Layers reference each dataset by name.

```tsx
<VegaVisual
  spec={spec}
  data={{ sales: salesTable, target: targetTable }}
  theme={theme}
/>
```

```json
{
  "layer": [
    { "data": { "name": "sales" },  "mark": "bar",  "encoding": { /* ... */ } },
    { "data": { "name": "target" }, "mark": "rule", "encoding": { /* ... */ } }
  ]
}
```

## What a named map does

Each key becomes a named entry in `spec.datasets`, and any layer binds to one with `"data": { "name": "<key>" }`. This lets a single spec draw marks from more than one table — a layered chart where each layer reads a different dataset.

Prefer a single `DataTable` for the common case: one table feeding one set of marks. Slicer filtering, hover highlighting within the same visual, and per-row coloring are all single-`DataTable` scenarios. A named map is the mechanism whenever the spec needs to bind separate layers to separate tables.

## How layers align

When two layers share an axis, Vega-Lite registers their marks by the encoded field. The component does not reshape, join, or pad the tables — each is emitted as-is under `spec.datasets`, and the spec is compiled as written. For marks to line up, the datasets must expose **compatible field names and types** on the shared encoding channels.

Mechanical consequences:

- A field a layer encodes (`"y": { "field": "Sales" }`) must exist with the same name and type in whatever dataset that layer binds to.
- Marks only meet at axis positions present in both datasets. A member present in one dataset but not the other renders in that layer alone.

## Common layered shapes

These describe what the named-map mechanism renders. Producing the underlying tables is a data concern, not a component concern.

**Secondary overlay at a different grain** — bars from one table, a reference rule or band from a single-value table:

```tsx
<VegaVisual spec={vegaLiteSpec} data={{ sales: salesTable, target: targetTable }} theme={theme} />
```

```json
{
  "layer": [
    { "data": { "name": "sales" }, "mark": "bar",
      "encoding": { "x": { "field": "Category" }, "y": { "field": "Sales", "type": "quantitative" } } },
    { "data": { "name": "target" }, "mark": { "type": "rule", "strokeDash": [4, 4] },
      "encoding": { "y": { "field": "Target", "type": "quantitative" } } }
  ]
}
```

**Subset overlay on a dimmed baseline** — a full dataset drawn dim, a second dataset drawn bright on the same axis. Both layers encode the same fields; the bright layer's marks appear only at the axis keys its rows supply:

```json
{
  "layer": [
    { "data": { "name": "all" }, "mark": { "type": "bar", "opacity": 0.3 },
      "encoding": { "x": { "field": "Category" }, "y": { "field": "Sales", "type": "quantitative" } } },
    { "data": { "name": "highlighted" }, "mark": "bar",
      "encoding": { "x": { "field": "Category" }, "y": { "field": "Sales", "type": "quantitative" } } }
  ]
}
```

Swap the second table to change what the bright layer shows; pass only `{ all }` to render the baseline alone.

```tsx
<VegaVisual
  spec={vegaLiteSpec}
  data={highlighted ? { all, highlighted } : { all }}
  theme={theme}
/>
```

**Axis spine** — an invisible point mark over a table listing every member pins the axis domain so a sparse measure layer doesn't drop categories:

```tsx
<VegaVisual spec={vegaLiteSpec} data={{ allCategories: dimList, sales: sparseSales }} theme={theme} />
```

```json
{
  "layer": [
    { "data": { "name": "allCategories" }, "mark": { "type": "point", "opacity": 0 },
      "encoding": { "x": { "field": "Category", "type": "nominal" } } },
    { "data": { "name": "sales" }, "mark": "bar",
      "encoding": { "x": { "field": "Category" }, "y": { "field": "Sales", "type": "quantitative" } } }
  ]
}
```

## Native selection — no named map needed

When an interaction stays within a single visual (clicking a bar to dim the others, hovering a point to emphasize matches), Vega-Lite's native selection with a conditional encoding handles it from one table — no named map, no second dataset.

```json
{
  "params": [{ "name": "sel", "select": { "type": "point", "fields": ["Category"] } }],
  "mark": "bar",
  "encoding": {
    "x": { "field": "Category", "type": "nominal" },
    "y": { "field": "Sales", "type": "quantitative" },
    "opacity": {
      "condition": { "param": "sel", "value": 1, "empty": false },
      "value": 0.3
    }
  }
}
```

## Caveats

- Auto-injected transforms (stacked data labels, crosshair tooltips) run only on the single-`DataTable` path. With a named map, the spec is compiled as written.
- Each named dataset resolves its own column metadata, so the same column name can carry different formats across tables.
