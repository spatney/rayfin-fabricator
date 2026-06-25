# Power BI Semantic Model Discovery Queries

Read-only DAX queries for metadata exploration using `INFO.VIEW.*` and `INFO.*` rowsets.

## Scope Estimation Queries

```dax
// Probe object counts to estimate metadata scope before deep discovery
EVALUATE
ROW(
    "TableCount", COUNTROWS(INFO.VIEW.TABLES()),
    "ColumnCount", COUNTROWS(INFO.VIEW.COLUMNS()),
    "MeasureCount", COUNTROWS(INFO.VIEW.MEASURES()),
    "RelationshipCount", COUNTROWS(INFO.VIEW.RELATIONSHIPS())
)
```

## INFO Output Columns

### INFO.VIEW.* (preferred first-pass metadata)

| Function | High-value columns | What to use them for |
|---|---|---|
| `INFO.VIEW.TABLES()` | `Name`, `DataCategory`, `StorageMode`, `IsHidden`, `Expression`, `CalculationGroupPrecedence`, `LineageTag` | Table inventory, calculated-table detection, storage-mode audits, lineage tracking. |
| `INFO.VIEW.COLUMNS()` | `Table`, `Name`, `DataType`, `DataCategory`, `IsHidden`, `SummarizeBy`, `Expression`, `SortByColumn`, `FormatString`, `LineageTag` | Column dictionary, semantic typing, sort/summarization checks, calculated column review. |
| `INFO.VIEW.MEASURES()` | `Table`, `Name`, `Expression`, `FormatString`, `State`, `DisplayFolder`, `KPIID`, `LineageTag` | Measure inventory, formula review, formatting/state validation, KPI linkage. |
| `INFO.VIEW.RELATIONSHIPS()` | `Relationship`, `IsActive`, `FromTable`, `FromColumn`, `ToTable`, `ToColumn`, `FromCardinality`, `ToCardinality`, `CrossFilteringBehavior`, `SecurityFilteringBehavior` | Join topology, cardinality validation, filter-direction and RLS behavior checks. |

### Critical INFO.* (deep metadata / diagnostics)

| Function | High-value columns | What to use them for |
|---|---|---|
| `INFO.MODEL()` | `Name`, `DefaultMode`, `Culture`, `Collation`, `ModifiedTime`, `Version`, `DirectLakeBehavior`, `ValueFilterBehavior`, `SelectionExpressionBehavior` | Model policy/config audits and environment baseline. |

```dax
// Probe output schema of an INFO function (returns column names and types with zero data rows)
EVALUATE
TOPN(0, INFO.VIEW.COLUMNS())
```

## Narrowing Results (Projection + Filtering)

```dax
// Pull only needed columns for a single table to reduce output volume
EVALUATE
SELECTCOLUMNS(
    FILTER(INFO.VIEW.COLUMNS(), [Table] = "YourTableName"),
    "Column", [Name],
    "DataType", [DataType],
    "Format", [FormatString]
)
ORDER BY [Column] ASC
```

```dax
// Get measures for a specific table
EVALUATE
SELECTCOLUMNS(
    FILTER(INFO.VIEW.MEASURES(), [Table] = "YourTableName"),
    "Measure", [Name],
    "Expression", [Expression],
    "Format", [FormatString]
)
ORDER BY [Measure] ASC
```

```dax
// Get relationships involving a specific table
EVALUATE
FILTER(
    INFO.VIEW.RELATIONSHIPS(),
    [FromTable] = "YourTableName" || [ToTable] = "YourTableName"
)
```

## Advanced Metadata Queries

These INFO functions may require elevated permissions. If any fail with a permission error after INFO.VIEW.* functions succeeded, skip all remaining elevated queries for this session.

### Calculation Groups

```dax
// List all calculation groups in the model
EVALUATE
INFO.CALCULATIONGROUPS()
```

```dax
// List all calculation items (the individual items within calculation groups)
EVALUATE
INFO.CALCULATIONITEMS()
```

### Calendars

```dax
// List calendar objects defined in the model
EVALUATE
INFO.CALENDARS()
```

```dax
// List calendar column groups
EVALUATE
INFO.CALENDARCOLUMNGROUPS()
```

```dax
// List calendar column references
EVALUATE
INFO.CALENDARCOLUMNREFERENCES()
```

### User-Defined Functions

```dax
// List user-defined functions in the model
EVALUATE
INFO.USERDEFINEDFUNCTIONS()
```

### Variations

```dax
// List variations (alternate groupings/display hierarchies)
EVALUATE
INFO.VARIATIONS()
```

## Complete INFO Function Catalog (Dynamic)

Use this query to enumerate all INFO functions available in the current engine at runtime:

```dax
EVALUATE
SELECTCOLUMNS(
    INFO.STORAGEFUNCTIONS(),
    "FunctionName", [Name],
    "Description", [Description]
)
ORDER BY [FunctionName] ASC
```

If `INFO.STORAGEFUNCTIONS()` is not available, probe individual functions with `TOPN(0, <function>())` to check availability without returning data.
