---
name: query-design
description: >
  Separates DAX data-fetching from TypeScript presentation. Guides when to use 
  DAX vs. TypeScript vs. Vega-Lite for aggregation, total rows, FORMAT(), SELECTCOLUMNS, 
  BLANK handling, filtering, multi-grain queries, cross-filtering and
  cross-highlight subset/overlay queries, and format strings.
---

# Query Design — Separation of Data and Presentation

**DAX computes and fetches data. TypeScript shapes it for display. VegaVisual and DataGrid render it.**

Aggregate in DAX to the visual's grain — never fetch lower-grain rows to roll up client-side. Once at the visual's grain, TypeScript can derive simple totals (SUM, COUNT, MIN, MAX) from the already-fetched detail rows. When a visual layout changes, only the TypeScript or spec layer should change — not the DAX query.

## Responsibility Matrix

| Concern | Owner |
|---|---|
| Semantic measures (SUM, DISTINCTCOUNT, etc.) | DAX |
| Filters and slicers | DAX or TypeScript ([see Filter Strategy](references/filter-strategy.md)) |
| Grouping grain (SUMMARIZECOLUMNS) | DAX |
| Time intelligence (YTD, YoY) | DAX |
| TopN / payload reduction | DAX |
| Deterministic row ordering (ORDER BY) | DAX (for debugging — not presentation sort) |
| Merging multiple result sets | TypeScript |
| Totals derivable from detail rows (SUM, COUNT, MIN, MAX) | TypeScript (roll up from already-fetched detail) |
| Totals NOT derivable from detail (DISTINCTCOUNT, ratios, AVERAGEX, complex measures) | DAX (separate summary query) |
| Filling dimension gaps | TypeScript (stitch dimension list into sparse results) |
| Reshaping (pivot, unpivot) | TypeScript |
| Column display names | `columnMetadata` in factory file |
| Number/date formatting | `columnMetadata.format` / Vega-Lite spec |
| User-facing sort order | TypeScript / Vega-Lite `sort` / DataGrid `sort` |
| Decorative labels, icons | DataGrid `cellRenderer` or Vega-Lite condition |
| Axis titles, legends, color encoding | Vega-Lite spec |

## Rules

### Must

- Aggregate in DAX to the visual's grain — never fetch lower-grain rows just to roll them up to that grain in TypeScript
- One grain per `.dax` file (one `EVALUATE` per file); separate grains → separate files + separate `useSemanticModelQuery` calls
- `ORDER BY` in DAX for stable, diffable results — not presentation sort
- Same filters/measures across related split-grain queries to prevent drift
- For totals from already-fetched detail rows: if the rollup is safe (SUM, COUNT, MIN, MAX), compute in TypeScript; otherwise (DISTINCTCOUNT, ratios, AVERAGEX, complex measures) issue a separate DAX summary query

### Prefer

- `SUMMARIZECOLUMNS` for grouped aggregation — it also drops BLANK-measure rows, keeping payloads small
- DAX's natural column names (`'Table'[Column]`, `[Measure]`) mapped via `columnMetadata.displayName`
- Raw typed values from DAX — format via `columnMetadata.format` or Vega-Lite, never `FORMAT()`
- Model-defined format strings (from `INFO.VIEW.MEASURES()`) over invented ones
- Multiple lightweight queries over one monolithic query
- User-facing sort in TypeScript / Vega-Lite / DataGrid — never re-query for sort

### Avoid

- `SELECTCOLUMNS` solely for renaming — use `columnMetadata.displayName` instead
- `UNION` to mix different grains (detail + total) — use separate queries
- `FORMAT()` in DAX — converts to text, breaks sorting and charting
- Converting BLANK to `0` / `""` / `"N/A"` in DAX — causes result-set explosion
- `CONCATENATEX`, `UNICHAR`, emoji prefixes — decorative text belongs in `cellRenderer` or Vega-Lite
- Fetching all members of high-cardinality dimensions just to fill gaps

## Decision Flowchart

```
Need to add something to the query result?
  |-- Calculation / aggregation / filter?
  |     -> DAX (measures, CALCULATE, SUMMARIZECOLUMNS)
  |-- Interactive filter the user controls?
  |     -> Low-cardinality: widen grain, filter in TypeScript or Vega-Lite transform
  |     -> High-cardinality: push filter to DAX, re-query
  |-- Merging datasets or adding synthetic rows?
  |     -> Charts: pass multiple DataTables to VegaVisual, layer in spec
  |     -> Grids: append rows in TypeScript, style via cellRenderer
  |-- Renaming a column for display?
  |     -> columnMetadata in the factory file (displayName)
  |-- Formatting, labeling, or encoding?
  |     -> Vega-Lite spec or DataGrid cellRenderer
  |-- Decorating values (icons, status badges, null placeholders)?
  |     -> DataGrid cellRenderer or Vega-Lite condition encoding
  |-- Not sure?
        -> Does it change what the data *means* (filter, measure, grain)? -> DAX
           Does it change only how data is *rendered* (labels, icons, layout)? -> TypeScript / Vega-Lite spec / DataGrid cellRenderer
           Still unclear? -> Read the relevant reference above
```

## Interactivity

Reports coordinate multiple visuals: a selection in one changes what the others show. Two distinct behaviors, with different data work behind them:

- **Cross-filtering** — a selection in one visual constrains the data shown in another, removing or narrowing the non-matching rows from the target's view. The target shows *less*. Applying that constraint is a cost/cardinality tradeoff — widen the grain and filter client-side, or push the filter into DAX and re-query. See [Filter strategy](references/filter-strategy.md).
- **Cross-highlighting** — a selection in one visual emphasizes the matching subset *within* another while the full context stays visible. The target keeps its baseline (dimmed) and draws the selected subset bright on top. The subset is a separate aggregation aligned to the baseline's grouping, measures, and row set — not a client-side filter of the baseline. See [Highlight queries](references/highlight-queries.md).

Both consume the predicate-based selection events the visual components emit (`onInteraction`). The components render only the `DataTable`s they are handed; this skill produces those tables. For how a spec binds and layers multiple datasets, see the visuals skill's [multi-data input](../visuals/references/multi-data-input.md) reference.

## Reference Materials

Read these when working on a specific topic:

- **[Anti-patterns and corrections](references/anti-patterns.md)** — Open when reviewing a query that uses `UNION` for totals, `FORMAT()`, `SELECTCOLUMNS` for renaming, `CONCATENATEX`/emoji decoration, BLANK-to-`0` conversion, or `GENERATE`/`CROSSJOIN` for gap-filling.
- **[Multi-grain patterns](references/multi-grain-patterns.md)** — Open when a single visualization needs data at two grains (e.g., bars + grand-total reference line, region detail + total row, monthly trend + YTD).
- **[Filter strategy](references/filter-strategy.md)** — Open when adding a user-controlled filter or implementing cross-filtering, and deciding whether to widen the grain (filter client-side) or push the filter into DAX (re-query on each change).
- **[Highlight queries](references/highlight-queries.md)** — Open when writing the "selected subset" overlay query for a cross-highlight visual: an aligned `CALCULATETABLE` / `TREATAS` query whose rows match the baseline.
- **[Format strings](references/format-strings.md)** — Open when picking a `columnMetadata.format` value, when a measure has a dynamic format string, or when formatting needs to flow into a Vega-Lite axis.

## Integration with Sibling Skills

- **[schema-discovery](../schema-discovery/SKILL.md)** — Schema exploration; discover tables, columns, and relationships before writing queries.
- **[dax-authoring](../dax-authoring/SKILL.md)** — DAX syntax, query patterns, and testing workflow. Apply this skill's principles when deciding what DAX should compute.
- **[visuals](../visuals/SKILL.md)** — Vega-Lite specs and DataGrid configuration. Push formatting and labels into specs, not DAX.