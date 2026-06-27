# Design Reference

DAX computes and fetches. TypeScript maps and renders. Use this reference when a visual needs filters, multiple grains, highlight overlays, format handling, or anti-pattern review.

## Responsibility matrix

| Concern | Owner |
|---|---|
| Semantic measures (SUM, DISTINCTCOUNT, ratios, model measures) | DAX |
| Grouping grain (`SUMMARIZECOLUMNS`) | DAX |
| Time intelligence (YTD, YoY, rolling windows) | DAX |
| TopN and payload reduction | DAX |
| Filters and slicers | DAX or TypeScript; see strategy below |
| Debug/diff row ordering | DAX `ORDER BY` |
| User-facing sorting | TypeScript / DataGrid sort |
| Merging aligned result sets | TypeScript |
| Totals derivable from detail rows (SUM, COUNT, MIN, MAX) | TypeScript |
| Non-derivable totals (DISTINCTCOUNT, ratios, AVERAGEX, complex measures) | DAX summary query |
| Filling bounded dimension gaps | TypeScript stitch of dimension list + sparse result |
| Reshaping (pivot/unpivot) | TypeScript |
| Display names | `columnMetadata` / mapping |
| Formatting | Chart spec `format`, card formatter, or DataGrid metadata |
| Labels, icons, badges, null placeholders | Component rendering / mapped display fields |

## Filter strategy

| Approach | How | Best when |
|---|---|---|
| Widen the grain | Include the filter dimension as a group-by column, fetch values once, filter mapped rows client-side | Low-cardinality dimensions and cheap measures |
| Push filter to DAX | Build filter fragments from selection state and re-query | High-cardinality dimensions, expensive measures, or large result multiplication |

Client-side filtering example:

```dax
EVALUATE
SUMMARIZECOLUMNS(
  'Region'[Name],
  'Product'[Category],
  "Revenue", [Total Revenue]
)
ORDER BY 'Region'[Name], 'Product'[Category]
```

```ts
const rows = toChartData(data, {
  columns: { Region: "Region[Name]", Category: "Product[Category]", Revenue: "Revenue" },
});
const filteredRows = rows.filter(row => row.Region === selectedRegion);
```

For shared slicers, prefer the kit state helpers: slicers write selections, visuals apply them with `applyFilters(rows, selections)`. If mapped keys differ, supply a `fieldMap`.

DAX filtering example:

```dax
DEFINE
  VAR _DateFilter = TREATAS({DATE(2024, 3, 15)}, 'Calendar'[Date])

EVALUATE
  SUMMARIZECOLUMNS(
    'Product'[Category],
    _DateFilter,
    "Revenue", [Total Revenue],
    "Units Sold", [Total Quantity]
  )
ORDER BY 'Product'[Category]
```

When building DAX from shared selections, categorical `in` filters become `TREATAS` variables; numeric/date ranges become predicates wrapped in `FILTER(...)`.

```dax
VAR __f_Category_1 = TREATAS({"Bikes", "Accessories"}, 'Product'[Category])
FILTER(ALL('Calendar'[Date]), 'Calendar'[Date] >= DATE(2024, 1, 1) && 'Calendar'[Date] <= DATE(2024, 3, 31))
```

Choose by cardinality, measure cost, interaction frequency, and result size.

## Multi-grain patterns

One visual sometimes needs detail plus a summary (bars + grand total, monthly trend + YTD). Use separate `.dax` files and separate hook calls; do not mix grains with `UNION`.

```
src/queries/sales/
├── revenue-by-region.dax      # detail grain
├── revenue-by-region.ts       # detail query + metadata
├── revenue-total.dax          # summary grain
└── revenue-total.ts
```

```ts
const detail = useSemanticModelQuery({ connection, query: detailQuery });
const summary = useSemanticModelQuery({ connection, query: totalQuery });
const detailRows = toChartData(detail.data, { columns: { Region: "Region[Name]", Revenue: "Revenue" } });
const grandTotal = toChartData(summary.data, { columns: { Revenue: "Revenue" } })[0]?.Revenue;
```

Keep split queries consistent:

- Same filters and scope.
- Same measure definitions.
- Only the grouping grain changes.

If a summary is a safe rollup of fetched detail (SUM, COUNT, MIN, MAX), derive it in TypeScript. For DISTINCTCOUNT, ratios, AVERAGEX, or complex model measures, issue a separate DAX summary query.

## Cross-highlight overlays

A cross-highlight keeps baseline context visible and overlays a selected subset. The subset is a fresh DAX query scoped by selection, not a client-side filter of the baseline.

```dax
-- Baseline
EVALUATE
  SUMMARIZECOLUMNS('Product'[Category], "Sales", [Total Sales])
ORDER BY 'Product'[Category]
```

```dax
-- Selected subset
EVALUATE
  CALCULATETABLE(
    SUMMARIZECOLUMNS('Product'[Category], "Sales", [Total Sales]),
    TREATAS({"PG", "PG-13"}, 'Movie'[Rating])
  )
ORDER BY 'Product'[Category]
```

Every baseline axis key needs a subset counterpart. If blanks would drop rows, either coalesce the overlay measure to zero when that is semantically correct, or left-join the baseline group list:

```dax
EVALUATE
  VAR Categories = SUMMARIZECOLUMNS('Product'[Category])
  VAR Filtered =
    CALCULATETABLE(
      SUMMARIZECOLUMNS('Product'[Category], "Sales", [Total Sales]),
      TREATAS({"PG", "PG-13"}, 'Movie'[Rating])
    )
  RETURN NATURALLEFTOUTERJOIN(Categories, Filtered)
ORDER BY 'Product'[Category]
```

Merge aligned baseline/subset results in TypeScript into tidy rows and use `encoding.series`.

## Format strings

Power BI semantic models store `FormatString` on columns and measures. Honor model-defined formats.

| Source | How to use |
|---|---|
| Static `FormatString` from `INFO.VIEW.COLUMNS()` / `INFO.VIEW.MEASURES()` | Copy VBA/ECMA-376 format into DataGrid `columnMetadata.format`; choose matching chart spec/card formatter. |
| Dynamic format string measure | Query resolved format alongside raw value using `IGNORE(...)`; apply per-row in TypeScript when needed. |
| Chart axes/tooltips | Use Envy spec `format` such as `$,.0f`, `.1%`, `%b %Y`. |

```dax
EVALUATE
SELECTCOLUMNS(
  FILTER(INFO.VIEW.MEASURES(), [Table] = "Sales"),
  "Measure", [Name],
  "Format", [FormatString]
)
ORDER BY [Measure]
```

```ts
export const columnMetadata = {
  "[Total Revenue]": { name: "Total Revenue", displayName: "Revenue", format: "$#,##0.00" },
  "[Margin %]": { name: "Margin", displayName: "Margin", format: "0.00%" },
  "'Calendar'[Date]": { name: "CalendarDate", displayName: "Date", format: "yyyy-mm-dd" },
};
```

```dax
-- Dynamic format string alongside raw value
EVALUATE
  SUMMARIZECOLUMNS(
    'Region'[Name],
    "Revenue", [Total Revenue],
    "Revenue Format", IGNORE([Total Revenue Format String])
  )
ORDER BY 'Region'[Name]
```

Never use DAX `FORMAT()` just to display values; it returns text.

## Anti-patterns and corrections

### `UNION` to mix detail and total rows

Problem: one result set mixes grains and forces downstream row detection.

```dax
-- Avoid
EVALUATE UNION(ROW("Region", "All", "Revenue", [Revenue]), SUMMARIZECOLUMNS('Region'[Name], "Revenue", [Revenue]))
```

Fix: detail only plus TypeScript rollup for additive totals, or a separate summary query for non-additive totals.

### `FORMAT()` for display labels or dates

Problem: strings cannot sort/chart as numbers or dates.

```dax
-- Avoid
EVALUATE SUMMARIZECOLUMNS('Calendar'[Month], "Revenue", FORMAT([Revenue], "$#,##0"))
```

Fix: return raw values; format via metadata or spec.

### Complex DAX to force dimension completeness

Problem: `GENERATE`, `CROSSJOIN`, or broad `ADDMISSINGITEMS` can explode result size.

Fix: fetch sparse detail plus a bounded dimension list and stitch in TypeScript. Do not use this for high-cardinality dimensions.

### Decorative text in DAX

Problem: emoji/prefixes/concatenated labels put presentation in the data layer.

Fix: return raw status/value fields and decorate with `cellRenderer` or mapped display fields.

### `SELECTCOLUMNS` only for friendly names

Problem: cosmetic renaming duplicates `columnMetadata` and can break `ORDER BY` references.

Fix: return natural names and map display names in metadata. Use `SELECTCOLUMNS` for projection, computed columns, or reshaping—not cosmetic aliases.

### Converting BLANK to placeholders

Problem: `+ 0`, `DIVIDE(x, y, 0)`, `"N/A"`, or empty strings defeat `SUMMARIZECOLUMNS` non-empty elimination and can multiply row counts.

Fix: let BLANK flow through; handle display placeholders in components. Use `DIVIDE(num, den)` without an alternate result unless zero is mathematically required.
