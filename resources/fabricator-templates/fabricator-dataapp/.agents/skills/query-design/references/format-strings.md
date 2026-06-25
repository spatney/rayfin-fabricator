# Format Strings

Power BI semantic models store format strings on columns and measures (`FormatString` in `INFO.VIEW.COLUMNS()` and `INFO.VIEW.MEASURES()`). Honor these model-defined formats rather than inventing your own.

## Static Format Strings

Most model format strings are static (e.g., `"$#,##0.00"`, `"0.0%"`, `"yyyy-MM-dd"`). The `ColumnDef.format` field in `@microsoft/fabric-visuals-core` accepts VBA/ECMA-376 format strings — the same syntax used in Power BI semantic models. **No translation is needed**: copy the model's `FormatString` value directly into `columnMetadata.format`.

```dax
// Discovery: fetch measure format strings
EVALUATE
  SELECTCOLUMNS(
    FILTER(INFO.VIEW.MEASURES(), [Table] = "Sales"),
    "Measure", [Name],
    "Format", [FormatString]
  )
ORDER BY [Measure]
```

```typescript
// Factory file: use the model's FormatString directly (no conversion)
export const columnMetadata: ColumnMetadataMap = {
  "[Total Revenue]": { name: "Total Revenue", displayName: "Revenue", format: "$#,##0.00" },
  "[Margin %]":      { name: "Margin",        displayName: "Margin",  format: "0.00%" },
  "'Calendar'[Date]": { name: "CalendarDate", displayName: "Date",    format: "yyyy-mm-dd" },
};
```

VegaVisual and DataGrid each handle their own VBA→d3 conversion internally at ingestion time, so authors only ever work in VBA format.

## Dynamic Format Strings

Some models use dynamic format strings — DAX expressions that produce different format strings depending on context (e.g., switching between "0.0 M" and "0.0 K" based on magnitude).

Fetch the resolved format string alongside the measure value using `IGNORE()`:

```dax
// Fetch measure value + resolved dynamic format string
EVALUATE
  SUMMARIZECOLUMNS(
    'Region'[Name],
    "Revenue", [Total Revenue],
    "Revenue Format", IGNORE([Total Revenue Format String])
  )
ORDER BY 'Region'[Name]
```

The resolved format string arrives as a per-row VBA/ECMA-376 string. Because the visual components expect VBA format strings, the per-row value can be passed through directly — no translation needed. Components that don't natively accept per-row formats (e.g., when injecting into a Vega-Lite axis spec) may require converting to d3 syntax at render time using helpers from `@microsoft/fabric-visuals-core`.

## Pipeline Summary

```
Semantic Model (FormatString)
  ├── static: read at discovery time via INFO.VIEW.*
  └── dynamic: query alongside measure values via IGNORE()
        ↓
Factory file (columnMetadata.format) — or per-row format values for dynamic
        ↓
TypeScript / Vega-Lite spec — render formatted output
```

> **Key principle:** DAX returns raw typed values. Format strings travel separately — either as static metadata in `columnMetadata` or as per-row data values for dynamic formats. Never use the `FORMAT()` DAX function to pre-render formatted strings in query results.
