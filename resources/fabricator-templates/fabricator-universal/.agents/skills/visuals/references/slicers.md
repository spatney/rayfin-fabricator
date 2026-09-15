# Slicers & shared filter state

Slicers and filter controls share one filter model. Wrap the dashboard
subtree in `FilterStateProvider`; read/write it with `useFilterState()`.

```tsx
import {
  FilterBar,
  FilterStateProvider,
  DropdownSlicer,
  SearchSlicer,
  DateRangeSlicer,
  RangeSlicer,
} from "@/components/dashboard";

<FilterStateProvider>
  <FilterBar>
    <DropdownSlicer label="Region" field="Geography[Region]" options={regions} />
    <SearchSlicer label="Product" field="Product[Name]" />
    <DateRangeSlicer label="Date" field="Date[Date]" />
    <RangeSlicer label="Price" field="Product[Price]" min={0} max={1000} />
  </FilterBar>
</FilterStateProvider>
```

Outside a provider, `useFilterState()` returns a stable no-op API, so a dropped-in
slicer is safe but won't change anything.

## Filter model

```ts
type FilterSelection =
  | { kind: "in"; field: string; values: Array<string | number> }
  | { kind: "range"; field: string; min: number | null; max: number | null; dataType?: "number" | "date" }
  | { kind: "contains"; field: string; text: string };

const filters = useFilterState();
filters.selections;                    // Record<FilterField, FilterSelection>
filters.getSelection("Product[Category]");
filters.setFilter({ kind: "in", field: "Product[Category]", values: ["Bikes"] });
filters.toggleValue("Product[Category]", "Accessories");
filters.setRange("Sales[Amount]", 0, 100000, "number");
filters.setSearch("Customer[Name]", "contoso");
filters.clearFilter("Product[Category]");
filters.clearAll();
filters.isActive;
```

Empty `in`, blank `contains`, and fully open ranges are pruned.

## Slicer props

All slicers have **connected mode** (`field`) and **controlled mode**
(`value` + `onChange`). Controlled mode wins if either `value` or `onChange` is
provided.

| Component | Required | Connected selection | Extra props |
|---|---|---|---|
| `DropdownSlicer` | `label`, `options` | `kind: "in"` | `multiple?`, `searchable?`, `isLoading?`, `error?`, `align?`, `className?` |
| `ListSlicer` | `label`, `options` | `kind: "in"` | `multiple?`, `searchable?`, `isLoading?`, `error?`, `title?`, `maxHeight?`, `className?` |
| `SearchSlicer` | none | `kind: "contains"` | `label?`, `placeholder?`, `className?` |
| `DateRangeSlicer` | none | `kind: "range"`, date | `label?`, `className?` |
| `RangeSlicer` | `min`, `max` | `kind: "range"`, number | `label?`, `step?`, `className?` |
| `FilterBar` | none | reads `selections` | `children?`, `hideSummary?`, `className?` |

```tsx
<DropdownSlicer label="Category" field="Product[Category]" options={categoryOptions} multiple={false} />
<ListSlicer title="Categories" label="Category" field="Product[Category]" options={categoryOptions} maxHeight={320} />
<SearchSlicer field="Customer[Name]" placeholder="Find customer" />
<DateRangeSlicer label="Order date" field="Sales[Order Date]" />
<RangeSlicer label="Sales" field="Sales[Amount]" min={0} max={100000} step={1000} />
```

`FilterBar` renders slicers plus active-filter chips and a `Clear all` button
unless `hideSummary` is true.

## Querying slicer options

`useSlicerOptions({ connection, field, measure?, orderBy?, top? })` returns
`{ options, isLoading, error }`. Each option is
`SlicerOption = { value: string | number; label: string; count?: number }`.
The hook issues a `SUMMARIZECOLUMNS` + `TOPN` DAX query for distinct values.

```tsx
import { DropdownSlicer, useSlicerOptions } from "@/components/dashboard";

const field = "Product[Category]";
const { options, isLoading, error } = useSlicerOptions({
  connection,
  field,
  measure: "[Total Sales]",
  orderBy: "count",
  top: 25,
});

<DropdownSlicer label="Category" field={field} options={options} isLoading={isLoading} error={error} />;
```

## Applying selections

Client-side: filter already mapped chart/table rows.

```tsx
import { applyFilters, matchesSelection, useFilterState } from "@/components/dashboard";

const { selections } = useFilterState();
const filteredRows = applyFilters(rows, selections, {
  fieldMap: { "Product[Category]": "categoryName" },
});

matchesSelection(
  { Category: "Bikes", Revenue: 42 },
  { kind: "in", field: "Product[Category]", values: ["Bikes"] },
  "Category",
);
```

Server-side: turn selections into DAX fragments. See the `dax` skill for
where to splice these into `SUMMARIZECOLUMNS` vs. `CALCULATETABLE`.

```tsx
import { toDaxFilters } from "@/components/dashboard";

const filters = toDaxFilters(selections);
const query = `
DEFINE
${filters.defines}
EVALUATE
SUMMARIZECOLUMNS(
  'Product'[Category],
  ${filters.vars.join(",\n  ")},
  "Revenue", [Total Revenue]
)`;
```

`toDaxFilters(...)` returns `{ defines, vars, predicates }`: `in` selections
become `TREATAS(...)` vars; ranges become `>=` / `<=` predicates (dates use
`DATE(y, m, d)`); `contains` becomes `SEARCH(...) > 0`. Helpers exported for
custom query assembly: `daxEscape`, `daxValueList`, `daxDateLiteral`.

## Field references

Use model-field syntax (`Table[Column]`) in `field` props.

```tsx
import { fieldShortName, parseField, quoteFieldRef } from "@/components/dashboard";

fieldShortName("Product[Category]"); // "Category"
parseField("'Sales Order'[Order Date]");
// { table: "Sales Order", column: "Order Date" }
quoteFieldRef("Product[Category]");  // "'Product'[Category]"
quoteFieldRef("Category");           // "[Category]"
```

## Connected vs controlled

- Connected: pass `field`; the slicer reads/writes shared provider state.
- Controlled: pass `value` and/or `onChange`; the caller owns state.
- Both use the same value shapes: arrays, text, or `{ min, max }` ranges.


## Chart selections as filters

Chart marks can also publish Graphein selections (`params`) and feed the **same**
shared filter state via `useSelectionFilterBridge(store, { fieldMap })`; see
[interactions](interactions.md). This lets a chart click drive the existing
slicer/DAX path while React slicers remain the primary server-side filter surface.
Graphein also has native slicer specs (`dropdown` / `list` / `search` / `range` /
`dateRange`) for optional client-only dashboards.
