---
name: dax
description: >
  Discover Power BI semantic model schemas with DAX INFO functions, decide what
  belongs in DAX versus TypeScript, and author/test DAX queries for Fabric
  analytics dashboards.
---

# DAX — Discover, Design, Author

Use this skill for data-shape decisions: find the model objects, pick the query grain, write DAX, preview the visual, then iterate.

## Fast path: Phase 1 hero slice

1. **Minimal discovery** — run one scope probe, then inspect only the tables/measures behind the hero metric.
   ```sh
   npx fabric-app-data query <alias> --query "EVALUATE ROW(\"TableCount\", COUNTROWS(INFO.VIEW.TABLES()), \"ColumnCount\", COUNTROWS(INFO.VIEW.COLUMNS()), \"MeasureCount\", COUNTROWS(INFO.VIEW.MEASURES()), \"RelationshipCount\", COUNTROWS(INFO.VIEW.RELATIONSHIPS()))"
   ```
2. **Pick one visual grain** — one DAX query should return exactly the rows the hero visual needs.
3. **Prefer model measures** — use `[Measure]` before re-aggregating raw columns.
4. **Write one query, optionally sanity-test it** — `npx fabric-app-data query <alias> --query '<DAX>'`; fix blocking syntax/shape errors only.
5. **Map in TypeScript** — DAX computes/fetches; `toChartData` / `toTable` maps positional rows; the visual spec handles display.

Do not over-tune the query first: write it, render with `npm run preview`, then fix shape/grain from the report (→ `headless-preview`).

## Table of contents

| Need | Read |
|---|---|
| Progressive schema discovery, INFO functions, scope/narrowing queries | [Discovery reference](references/discovery.md) |
| DAX vs TypeScript matrix, filters, multi-grain, highlighting, format strings, anti-patterns | [Design reference](references/design.md) |
| DAX syntax, core functions, query patterns, BLANK semantics, time intelligence | [DAX reference](references/dax-reference.md) |
| CLI connection/query details | [`fabric-data`](../fabric-data/SKILL.md) |

## Progressive discovery

Start small; fetch metadata on demand.

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
- Reuse discovered schema; do not re-fetch the same inventory in one task.
- Use elevated `INFO.*` only for calculation groups, calendars, UDFs, or variations; skip if permissions fail after `INFO.VIEW.*` works.
- Run discovery and optional sanity queries with `npx fabric-app-data query <alias>`; see `fabric-data` for details.

## DAX vs TypeScript: responsibility split

| Concern | Owner |
|---|---|
| Measures, aggregations, grouping grain, time intelligence | DAX |
| TopN, high-cardinality filters, payload reduction | DAX |
| Small UI filters/slicers | TypeScript or DAX depending on cost |
| Deterministic debug ordering | DAX `ORDER BY` |
| Merging result sets, safe totals from fetched detail, reshaping/pivoting | TypeScript |
| Non-additive totals (DISTINCTCOUNT, ratios, AVERAGEX, complex measures) | DAX separate summary query |
| Column display names | `toChartData` aliases / `toTable` columns |
| Number/date formatting | Chart spec `format`, card props, or table/matrix `format` |
| Decorative labels/icons/null placeholders | Component rendering or mapped display fields |

Decision check: if it changes meaning, filter context, measure definition, or grain, do it in DAX. If it changes presentation, use TypeScript or the visual spec.

## Authoring rules

### Must

- Use fully qualified columns: `'Table'[Column]`.
- Use simple measure names: `[Measure]`.
- Return a table after `EVALUATE`; wrap scalar results in `ROW(...)`.
- Use one `DEFINE` block; separate `VAR` / `MEASURE` declarations by newlines, not commas.
- Aggregate in DAX to the visual's grain; never fetch low-grain rows just to roll them up client-side.
- Prefer existing model measures over raw aggregations.
- Optionally quick-test DAX with `fabric-app-data query` for syntax/shape sanity, then use `npm run preview` as the visual feedback loop.

### Prefer / avoid

- `SUMMARIZECOLUMNS` for grouped aggregations.
- `TREATAS` as filter arguments in `SUMMARIZECOLUMNS`.
- Variables for readability and repeated filters; multiple small queries over one mixed-grain query.
- Raw typed values; avoid `FORMAT()`, UI labels, SQL syntax, and friendly-name-only projections in query output.
- Leave BLANKs and visual gap-filling to the app/spec unless the model semantics require otherwise.

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

For TopN, time intelligence, BLANK behavior, highlight overlays, filter fragments, and detailed anti-pattern corrections, open the references only when that problem appears.
