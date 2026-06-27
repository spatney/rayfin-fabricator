---
name: dax
description: >
  Discover Power BI semantic model schemas with DAX INFO functions, decide what
  belongs in DAX versus TypeScript, and author/test DAX queries for Fabric
  analytics dashboards. Covers progressive discovery, query design, filters,
  multi-grain patterns, time intelligence, format strings, and DAX guardrails.
---

# DAX — Discover, Design, Author

Use this skill for every data-shape decision: find the model objects, decide the query grain, write DAX, test it, then map the result into visuals.

## Fast path: Phase 1 hero slice

1. **Minimal discovery** — run one scope probe, then inspect only the one or two tables/measures behind the hero metric.
   ```sh
   npx fabric-app-data query <alias> --query "EVALUATE ROW(\"TableCount\", COUNTROWS(INFO.VIEW.TABLES()), \"ColumnCount\", COUNTROWS(INFO.VIEW.COLUMNS()), \"MeasureCount\", COUNTROWS(INFO.VIEW.MEASURES()), \"RelationshipCount\", COUNTROWS(INFO.VIEW.RELATIONSHIPS()))"
   ```
2. **Pick one visual grain** — one DAX query should return exactly the rows the hero visual needs.
3. **Prefer model measures** — use `[Measure]` before re-aggregating raw columns.
4. **Write and quick-test one query** — `npx fabric-app-data query <alias> --query '<DAX>'`; fix blocking syntax/data-shape errors only.
5. **Map in TypeScript** — DAX computes/fetches; `toChartData` / `toDataTable` maps positional rows; the visual spec handles display.

Do not enumerate the whole model, implement full interaction strategy, or perfect edge-case time intelligence before the first deployed visual.

## Table of contents

| Need | Read |
|---|---|
| Progressive schema discovery, INFO functions, scope/narrowing queries | [Discovery reference](references/discovery.md) |
| DAX vs TypeScript responsibility matrix, filters, multi-grain, highlighting, format strings, anti-pattern corrections | [Design reference](references/design.md) |
| DAX syntax, core functions, query patterns, BLANK semantics, time intelligence | [DAX reference](references/dax-reference.md) |
| CLI connection/query details | [`fabric-data`](../fabric-data/SKILL.md) |

## Progressive discovery

Start small and fetch metadata on demand.

```
User asks for a metric or visual
  -> Know relevant tables?
     -> No: INFO.VIEW.TABLES()
     -> Yes: Know columns/measures?
        -> No: filtered INFO.VIEW.COLUMNS() and INFO.VIEW.MEASURES()
        -> Yes: Need relationship/filter path?
           -> Yes: filtered INFO.VIEW.RELATIONSHIPS()
           -> No: write the visual-grain DAX
```

Rules:

- Use `INFO.VIEW.*` first; it is read-access friendly.
- Narrow metadata with `SELECTCOLUMNS` + `FILTER`.
- Cache discovered schema mentally; do not re-fetch the same inventory in the same task.
- Use elevated `INFO.*` only when needed for calculation groups, calendars, UDFs, or variations. If one elevated query fails with permissions after `INFO.VIEW.*` succeeds, skip the rest for the session.
- Run discovery and test queries with `npx fabric-app-data query <alias>`; see `fabric-data` for profiles, files, and result caps.

## DAX vs TypeScript: responsibility split

| Concern | Owner |
|---|---|
| Semantic measures, aggregations, grouping grain, time intelligence | DAX |
| TopN and payload reduction | DAX |
| Filters/slicers | DAX or TypeScript depending on cardinality/cost |
| Deterministic debug ordering | DAX `ORDER BY` |
| Merging multiple result sets, safe totals from fetched detail (SUM/COUNT/MIN/MAX), reshaping/pivoting | TypeScript |
| Non-additive totals (DISTINCTCOUNT, ratios, AVERAGEX, complex measures) | DAX separate summary query |
| Column display names | `columnMetadata` / mapping |
| Number/date formatting | Chart spec `format`, card props, or DataGrid metadata |
| Decorative labels/icons/null placeholders | Component rendering or mapped display fields |

Decision check: if it changes data meaning, filter context, measure definition, or grain, do it in DAX. If it only changes presentation, do it in TypeScript or the visual spec.

## Authoring rules

### Must

- Use fully qualified columns: `'Table'[Column]`.
- Use simple measure names: `[Measure]`.
- Return a table after `EVALUATE`; wrap scalar results in `ROW(...)`.
- Use one `DEFINE` block; separate `VAR` / `MEASURE` declarations by newlines, not commas.
- Aggregate in DAX to the visual's grain; never fetch low-grain rows just to roll them up client-side.
- Quick-test DAX with `fabric-app-data query` before wiring it into app code.

### Prefer

- Existing model measures over raw aggregations.
- `SUMMARIZECOLUMNS` for grouped aggregations.
- `TREATAS` as filter arguments in `SUMMARIZECOLUMNS`.
- Variables for readability and repeated filters.
- Raw typed values plus separate format metadata; never pre-format values into text.
- Multiple small queries over one monolithic mixed-grain query.

### Avoid

- SQL syntax (`SELECT`, `WHERE`, `HAVING`) inside DAX.
- `FORMAT()` in query output; it breaks numeric/date sorting and charting.
- `UNION` to mix detail and total rows.
- `SELECTCOLUMNS` solely for friendly names.
- Converting BLANK to `0`, `""`, or `"N/A"` in DAX.
- Decorative text, emoji, or concatenated UI labels in DAX.
- Fetching full high-cardinality dimensions to fill visual gaps.

## Core query pattern

```dax
DEFINE
  VAR _CategoryFilter = TREATAS({"Bikes", "Accessories"}, 'Product'[Category])
  VAR _YearFilter = FILTER(ALL('Calendar'[Year]), 'Calendar'[Year] >= 2024)

EVALUATE
  SUMMARIZECOLUMNS(
    'Calendar'[Year],
    'Product'[Category],
    _CategoryFilter,
    _YearFilter,
    "Revenue", [Total Revenue],
    "Margin %", [Margin %]
  )
ORDER BY 'Calendar'[Year], [Revenue] DESC
```

For TopN, time intelligence, BLANK behavior, highlight overlays, filter fragments, and anti-pattern corrections, open the references only when that problem appears.
