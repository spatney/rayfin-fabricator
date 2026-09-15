# Discovery Reference

Read-only DAX metadata discovery uses `INFO.VIEW.*` first and `INFO.*` only for deeper metadata.

## Scope estimation

```dax
EVALUATE
ROW(
    "TableCount", COUNTROWS(INFO.VIEW.TABLES()),
    "ColumnCount", COUNTROWS(INFO.VIEW.COLUMNS()),
    "MeasureCount", COUNTROWS(INFO.VIEW.MEASURES()),
    "RelationshipCount", COUNTROWS(INFO.VIEW.RELATIONSHIPS())
)
```

## INFO function map

| Metadata object | Primary functions | Access |
|---|---|---|
| Tables | `INFO.VIEW.TABLES()` | Read |
| Columns | `INFO.VIEW.COLUMNS()` | Read |
| Measures | `INFO.VIEW.MEASURES()` | Read |
| Relationships | `INFO.VIEW.RELATIONSHIPS()` | Read |
| Model config | `INFO.MODEL()` | May need elevated |
| Calculation groups/items | `INFO.CALCULATIONGROUPS()`, `INFO.CALCULATIONITEMS()` | May need elevated |
| Calendars | `INFO.CALENDARS()`, `INFO.CALENDARCOLUMNGROUPS()`, `INFO.CALENDARCOLUMNREFERENCES()` | May need elevated |
| User-defined functions | `INFO.USERDEFINEDFUNCTIONS()` | May need elevated |
| Variations | `INFO.VARIATIONS()` | May need elevated |

## High-value output columns

| Function | Useful columns | Use |
|---|---|---|
| `INFO.VIEW.TABLES()` | `Name`, `DataCategory`, `StorageMode`, `IsHidden`, `Expression`, `CalculationGroupPrecedence`, `LineageTag` | Table inventory, calculated tables, storage mode, lineage. |
| `INFO.VIEW.COLUMNS()` | `Table`, `Name`, `DataType`, `DataCategory`, `IsHidden`, `SummarizeBy`, `Expression`, `SortByColumn`, `FormatString`, `LineageTag` | Column dictionary, semantic typing, sort/summarization checks. |
| `INFO.VIEW.MEASURES()` | `Table`, `Name`, `Expression`, `FormatString`, `State`, `DisplayFolder`, `KPIID`, `LineageTag` | Measure inventory, formula review, formatting/state validation. |
| `INFO.VIEW.RELATIONSHIPS()` | `Relationship`, `IsActive`, `FromTable`, `FromColumn`, `ToTable`, `ToColumn`, `FromCardinality`, `ToCardinality`, `CrossFilteringBehavior`, `SecurityFilteringBehavior` | Join topology, filter direction, RLS behavior. |
| `INFO.MODEL()` | `Name`, `DefaultMode`, `Culture`, `Collation`, `ModifiedTime`, `Version`, `DirectLakeBehavior`, `ValueFilterBehavior`, `SelectionExpressionBehavior` | Model policy/config audits. |

Probe an output schema without returning data:

```dax
EVALUATE TOPN(0, INFO.VIEW.COLUMNS())
```

## Narrowing patterns

```dax
-- Columns for one table
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
-- Measures for one table
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
-- Relationships touching one table
EVALUATE
FILTER(
    INFO.VIEW.RELATIONSHIPS(),
    [FromTable] = "YourTableName" || [ToTable] = "YourTableName"
)
```

## Advanced metadata

These may require elevated permissions. If one fails with a permission error after `INFO.VIEW.*` succeeds, skip all elevated discoveries for the session.

```dax
EVALUATE INFO.CALCULATIONGROUPS()
EVALUATE INFO.CALCULATIONITEMS()
EVALUATE INFO.CALENDARS()
EVALUATE INFO.CALENDARCOLUMNGROUPS()
EVALUATE INFO.CALENDARCOLUMNREFERENCES()
EVALUATE INFO.USERDEFINEDFUNCTIONS()
EVALUATE INFO.VARIATIONS()
```

Enumerate available INFO functions when supported:

```dax
EVALUATE
SELECTCOLUMNS(
    INFO.STORAGEFUNCTIONS(),
    "FunctionName", [Name],
    "Description", [Description]
)
ORDER BY [FunctionName] ASC
```
