# Vega-Lite Visual

A React component from the `@microsoft/fabric-visuals` package for rendering Vega-Lite visuals.

```tsx
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { VegaVisual, useCssTheme } from "@microsoft/fabric-visuals";
import type { VisualizationSpec, VegaLiteConfig } from "@microsoft/fabric-visuals";

const theme = useCssTheme();

const spec: VisualizationSpec = {
  $schema: "https://vega.github.io/schema/vega-lite/v6.json",
  description: "An example vega-lite spec",
  data: { }, // filled in by the `DataTable` below
  mark: "bar",
  encoding: {
    x: { field: "category", type: "nominal" },
    y: { field: "\\[value\\]", type: "quantitative" },
  },
};

const data: DataTable = {
  columns: [
    { name: "category", displayName: "Category" },
    { name: "[value]", displayName: "Value" },
  ],
  rows: [
    ["A", 28],
    ["B", 55],
    ["C", 43],
  ]
}

<VegaVisual spec={spec} data={data} theme={theme} style={{ height: 400 }} />
```

## Valid spec structures

### Use a unit spec for a single mark

```json
{
  "mark": "bar",
  "encoding": {
    "x": { "field": "category", "type": "nominal" },
    "y": { "field": "value", "type": "quantitative" }
  }
}
```

### Use `layer` for composite visuals

When you need multiple marks (e.g., bars with text labels), put **all** marks inside the `layer` array. An optional shared `encoding` at the same level as `layer` is inherited by every layer entry, so you only need to specify mark-specific encodings inside each entry:

```json
{
  "encoding": {
    "x": { "field": "category", "type": "nominal" },
    "y": { "field": "value", "type": "quantitative" }
  },
  "layer": [
    {
      "mark": "bar"
    },
    {
      "mark": { "type": "text", "align": "center", "dy": -5 },
      "encoding": {
        "text": { "field": "value", "type": "quantitative" }
      }
    }
  ]
}
```

### Rules

1. **Never combine `mark` with `layer`** at the same level.
2. **Each layer entry must define a valid spec at its own level** — it may be a unit spec with its own `mark` (and optional `encoding`), or a nested composition such as another `layer` spec.

## Encoding Type Selection

### When to use `temporal` vs `quantitative` for date/year fields

Vega-Lite's `"temporal"` type interprets raw numeric values as **Unix epoch milliseconds** (milliseconds since Jan 1, 1970). This means plain year integers like `1900` or `2023` will be misinterpreted as timestamps within the first few seconds of 1970, producing garbled axis labels (e.g., ".905" instead of "1905").

**Use `"temporal"` only when** the data contains actual date/time values:
- ISO 8601 strings (e.g., `"2023-06-15"`, `"2023-06-15T10:30:00Z"`)
- Unix timestamps in milliseconds (e.g., `1686816000000`)

**Use `"quantitative"` when** the data contains plain year integers (e.g., `1900`, `2017`). If the column metadata omits `format` (or uses `"0"` to suppress grouping separators), the axis will display clean integer years.

**How to decide:** Before setting the encoding type, check what the DAX query actually returns. If the column is an integer year (no date parts like month/day), use `"quantitative"`. If the column is a full date or datetime value, use `"temporal"`.

## Props

Refer to the package README.md for detailed information about the component api including exported types, functions, and properties.
