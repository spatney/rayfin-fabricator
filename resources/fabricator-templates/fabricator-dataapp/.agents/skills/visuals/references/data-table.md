# DataTable — Shared `data` Prop

Both `VegaVisual` and `DataGrid` accept an optional `data` prop of type `DataTable`. This is a row-major tabular JSON format.

```tsx
import { VegaVisual, useCssTheme } from "@microsoft/fabric-visuals";
import { DataGrid } from "@microsoft/fabric-datagrid";
import { isDataTable } from "@microsoft/fabric-visuals-core";

const theme = useCssTheme();

const data = {
  columns: [
    { name: "month", displayName: "Month" },
    { name: "revenue", displayName: "Revenue", format: "$#,0.00" },
  ],
  rows: [
    ["January", 12500],
    ["February", 18300],
    ["March", 15700],
  ],
};

<VegaVisual spec={spec} data={data} theme={theme} />
<DataGrid columns={gridColumns} data={data} theme={theme} />
```

## Props

Refer to the package README.md for detailed information about the component api including exported types, functions, and properties.

## Schema

```json
{
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "data-table.schema.json",
    "$comment": "JSON Schema for the DataTable interface defined in types.ts. Enforces the row-major tabular format shared between VegaVisual and DataGrid.",
    "title": "DataTable",
    "description": "Structured tabular data input shared between VegaVisual and DataGrid. This is a JSON format, not an Arrow format. If Arrow format is used, it is the consumer's responsibility to convert it to this format.",
    "type": "object",
    "required": [
        "columns",
        "rows"
    ],
    "additionalProperties": false,
    "properties": {
        "$schema": {
            "description": "Optional reference to this JSON Schema for editor validation and intellisense.",
            "type": "string"
        },
        "columns": {
            "description": "Column definitions describing each field.",
            "type": "array",
            "items": {
                "$ref": "#/$defs/ColumnDef"
            }
        },
        "rows": {
            "$comment": "Row-major data. Each inner array corresponds to one row; values align positionally with `columns`. For example, 3 items in `columns` means each row can have up to 3 items.",
            "description": "Row-major data. Column values are provided in the order of the column definitions. null values for columns are allowed.",
            "type": "array",
            "items": {
                "type": "array",
                "$comment": "Each cell value can be any JSON-representable type (string, number, boolean, null, object, array). The schema does not constrain cell types because the TypeScript source uses `unknown`.",
                "items": {}
            }
        }
    },
    "$defs": {
        "ColumnDef": {
            "title": "ColumnDef",
            "description": "Column definition describing a single data field.",
            "type": "object",
            "required": [
                "name"
            ],
            "additionalProperties": false,
            "properties": {
                "name": {
                    "description": "Slug identifier for column name, e.g. to name column values in Vega row-major data.",
                    "type": "string"
                },
                "displayName": {
                    "description": "Display name to represent field's data in output visualization/table, e.g., in axis titles, legend titles, column headers.",
                    "type": "string"
                },
                "format": {
                    "$comment": "A VBA/ECMA-376 format string (e.g., `#,##0.00`, `0.00%`, and `mm/dd/yyyy`).  May be converted to another representation (e.g., D3.js format string) by leaf components as needed.",
                    "description": "A VBA/ECMA-376 format string for formatting data for output, e.g., in tooltips, data labels, DataGrid table cells.",
                    "type": "string"
                }
            }
        }
    }
}
```