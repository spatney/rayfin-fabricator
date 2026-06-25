---
name: schema-discovery
description: >
  Explore Power BI semantic model schemas using DAX INFO functions.
  Progressive metadata discovery strategy, scope estimation, and
  narrowing techniques for tables, columns, measures, and relationships.
---

# Schema Discovery

## Table of Contents

| Task | Reference | Notes |
|---|---|---|
| Must/Prefer/Avoid | [SKILL.md: Must/Prefer/Avoid](#must--prefer--avoid) | Guardrails for schema discovery |
| Progressive Discovery Strategy | [SKILL.md: Progressive Schema Discovery](#progressive-schema-discovery) | Decision tree for on-demand metadata fetching |
| Recommended Discovery Order | [SKILL.md: Recommended Discovery Order](#recommended-discovery-order) | Start with scope estimation → tables → columns → measures → relationships |
| Metadata Object → INFO Function Map | [SKILL.md: Metadata Object → INFO Function Map](#metadata-object---info-function-map) | Tables, columns, measures, relationships, calc groups, calendars, UDFs, variations |
| Scope Estimation Queries | [discovery-queries.md: Scope Estimation Queries](./references/discovery-queries.md#scope-estimation-queries) | Probe table/column/measure/relationship counts before deep discovery |
| INFO Output Columns | [discovery-queries.md: INFO Output Columns](./references/discovery-queries.md#info-output-columns) | INFO.VIEW.* (read access); INFO.* (may need elevated access) |
| Narrowing Results (Projection + Filtering) | [discovery-queries.md: Narrowing Results](./references/discovery-queries.md#narrowing-results-projection--filtering) | SELECTCOLUMNS + FILTER to reduce output volume |
| Advanced Metadata (Calc Groups, Calendars, UDFs) | [discovery-queries.md: Advanced Metadata Queries](./references/discovery-queries.md#advanced-metadata-queries) | INFO.CALCULATIONGROUPS, INFO.CALENDARS, INFO.USERDEFINEDFUNCTIONS, INFO.VARIATIONS |
| Complete INFO Function Catalog | [discovery-queries.md: Complete INFO Function Catalog](./references/discovery-queries.md#complete-info-function-catalog-dynamic) | Dynamic query to enumerate all INFO functions in the engine |

## Must / Prefer / Avoid

### Must
- Use fully-qualified `'Table'[Column]` for column references
- Use simple `[Measure]` for measure references

### Prefer
- INFO.VIEW functions for initial metadata discovery (read access, lightweight)
- Progressive schema discovery over full schema dumps
- SELECTCOLUMNS + FILTER to narrow INFO results

### Avoid
- Fetching full schema upfront — discover incrementally based on need
- Re-fetching metadata already discovered in this conversation
- Using GetSemanticModelSchema, DiscoverArtifacts, or GenerateQuery MCP tools (these are not available)

## Progressive Schema Discovery

Discover metadata incrementally based on what the user actually needs.

### Strategy (Decision Tree)

```
User asks a question
  → Do I know which tables are relevant?
    → NO: Run INFO.VIEW.TABLES() to get table inventory
    → YES: Do I know the columns/measures for those tables?
      → NO: Run filtered INFO.VIEW.COLUMNS() and INFO.VIEW.MEASURES() for those tables
      → YES: Do I need relationships?
        → YES: Run INFO.VIEW.RELATIONSHIPS() filtered to those tables
        → NO: Do I need advanced metadata?
          → Have elevated INFO functions already failed in this session?
            → YES: Skip — assume no permission for all elevated queries
            → NO: Try the relevant elevated query:
              → Calculation groups: INFO.CALCULATIONGROUPS() + INFO.CALCULATIONITEMS()
              → Calendars: INFO.CALENDARS()
              → User-defined functions: INFO.USERDEFINEDFUNCTIONS()
              → Variations: INFO.VARIATIONS()
              → If query fails with permission error: mark elevated access as unavailable
  → Use discovered schema to write DAX queries (see dax-authoring skill)
```

### Rules

- **Start with scope estimation** — Run the scope probe query first to understand model size
- **Discover on demand** — Only fetch tables/columns/measures relevant to the current user request
- **Use INFO.VIEW functions first** (read access) — tables, columns, measures, relationships
- **Use INFO functions** (may need elevated access) for: calculation groups, calculation items, variations, user-defined functions, calendars
- **Handle permission failures gracefully** — If an elevated INFO function fails but INFO.VIEW.* functions succeeded, assume the user lacks elevated permissions and skip all elevated discoveries entirely
- **Always narrow results** — Use SELECTCOLUMNS + FILTER to fetch only needed columns and rows
- **Cache discovered schema mentally** — Don't re-fetch what you've already discovered in this conversation

### Recommended Discovery Order

1. **Scope estimation** — Count tables, columns, measures, relationships
2. **Tables** — Get table names, identify relevant ones
3. **Columns** — Get columns for relevant tables only
4. **Measures** — Get measures (prefer using these over raw aggregations)
5. **Relationships** — Get relationships between relevant tables
6. **Advanced metadata** (if needed) — Calculation groups, calendars, UDFs, variations

### Scope Estimation Query

```dax
EVALUATE
ROW(
    "TableCount", COUNTROWS(INFO.VIEW.TABLES()),
    "ColumnCount", COUNTROWS(INFO.VIEW.COLUMNS()),
    "MeasureCount", COUNTROWS(INFO.VIEW.MEASURES()),
    "RelationshipCount", COUNTROWS(INFO.VIEW.RELATIONSHIPS())
)
```

### Metadata Object → INFO Function Map

| Metadata Object | Primary INFO Functions | Access Level |
|---|---|---|
| Tables | `INFO.VIEW.TABLES()` | Read |
| Columns | `INFO.VIEW.COLUMNS()` | Read |
| Measures | `INFO.VIEW.MEASURES()` | Read |
| Relationships | `INFO.VIEW.RELATIONSHIPS()` | Read |
| Model config | `INFO.MODEL()` | May need elevated |
| Calculation groups | `INFO.CALCULATIONGROUPS()`, `INFO.CALCULATIONITEMS()` | May need elevated |
| Calendars | `INFO.CALENDARS()`, `INFO.CALENDARCOLUMNGROUPS()`, `INFO.CALENDARCOLUMNREFERENCES()` | May need elevated |
| User-defined functions | `INFO.USERDEFINEDFUNCTIONS()` | May need elevated |
| Variations | `INFO.VARIATIONS()` | May need elevated |

For the full query catalog and output column details, see [discovery-queries.md](./references/discovery-queries.md).

## Running Discovery Queries

Use `npx fabric-app-data query <alias> --query '<DAX>'` to execute INFO queries against a semantic model. For full CLI options (profiles, file input, result limits), see the `fabric-cli` skill.

```bash
npx fabric-app-data query <alias> --query "EVALUATE INFO.VIEW.TABLES()"
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| INFO functions return permission errors | Fall back to INFO.VIEW functions; mark elevated access as unavailable for this session |
| Metadata output too large | Use scope estimation + narrowing patterns from [discovery-queries.md](./references/discovery-queries.md) |
