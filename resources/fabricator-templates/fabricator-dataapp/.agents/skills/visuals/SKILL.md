---
name: visuals
description: >
  Use when user wants to incorporate charts, graphs, data grid, 
  or other visual representations of data into their project.
  Use VegaVisual and DataGrid components to create these visuals, 
  utilizing the shared DataTable input, formatting, theme, and interactivity.
  Covers the onInteraction selection/click events host apps consume, named
  multi-table data input for layered overlays and reference lines, and
  Vega-Lite native selections.
---

# Visuals

## Types of visuals
There are 2 different types of visuals that can be used in a project:
1. Charts and Graphs: These are used to represent data in a visual format, such as bar charts, line charts, pie charts, etc. These are built using vega-lite, see [references/vega-lite-visual.md](references/vega-lite-visual.md) for more details.
2. Data Grids: These are used to display tabular data in a structured format, allowing for sorting, filtering, and pagination. See [references/data-grid-visual.md](references/data-grid-visual.md) for more details.

## Packages & Imports

The visual components are provided by three packages. **Always use these package imports when creating visuals.**

| Package | Primary exports | Example import |
|---|---|---|
| `@microsoft/fabric-visuals` | `VegaVisual`, types: `VisualizationSpec`, `VegaLiteConfig`, `VegaVisualProps` | `import { VegaVisual } from "@microsoft/fabric-visuals"` |
| `@microsoft/fabric-datagrid` | `DataGrid`, types: `GridColumnDef`, `Row`, `CellValue`, `DataGridProps`, `DataGridTheme`, `SortConfig` | `import { DataGrid } from "@microsoft/fabric-datagrid"` |
| `@microsoft/fabric-visuals-core` | `isDataTable`, `convertDataTableToRows`, design tokens | `import { isDataTable } from "@microsoft/fabric-visuals-core"` |

The `DataTable` type (used by both components) is defined in `@microsoft/fabric-visuals-core` and re-exported by the visual packages' type definitions.

## Data Format
The chart and data grid components share a unified `data` prop of type `DataTable` (from `@microsoft/fabric-visuals-core`). This structured format carries column metadata (`displayName`, `format`, `semanticType`) that the components use for axis titles, grid headers, number formatting, and tooltips.

**Using `DataTable`**: Pass a `DataTable` via the `data` prop. The visual uses its column metadata for formatting, axis titles, and tooltips.

**Static/inline data**: For static data, transformed data, or plain arrays, put `data: { values: [...] }` directly in the Vega-Lite spec and omit the `data` prop.

**Multiple tables in one visual**: the `data` prop also accepts a `Record<string, DataTable>` for specs that bind separate layers to more than one dataset by name such as layered overlays, reference lines, and axis spines. See [references/multi-data-input.md](references/multi-data-input.md).

```tsx
import { VegaVisual, useCssTheme } from "@microsoft/fabric-visuals";
import { DataGrid } from "@microsoft/fabric-datagrid";
import type { DataTable } from "@microsoft/fabric-visuals-core";

// useCssTheme() reads --color-* vars from the page and updates automatically
// when the theme changes (e.g. dark-mode toggle adds/removes the .dark class).
const theme = useCssTheme();

// Charts — pass a DataTable and Vega-Lite spec
<VegaVisual spec={vegaLiteSpec} data={dataTable} theme={theme} />

// Grids — displayName becomes column headers, format applies to cells
<DataGrid data={dataTable} theme={theme} />

// Static/inline data — no data prop needed
const inlineSpec = {
  data: { values: [{ x: 1, y: 2 }, { x: 3, y: 4 }] },
  mark: "point",
  encoding: { ... },
};

<VegaVisual spec={inlineSpec} theme={theme} />
```

For the `DataTable` schema and `ColumnDef` fields, see [references/data-table.md](references/data-table.md).

## Formatting & Theme
- **Formatting rules**: Number formatting, color palettes, chart-specific encoding rules, highlighting guidelines, and a default theme. See [references/formatting.md](references/formatting.md).

## Custom visuals
Always use the above mentioned ways to create visual when possible. If the user's request doesn't allow creation using the above methods, ask the user if they are ok with using another library for creating the visual. If they are ok with it, use the library to create the visual. If they are not ok with it, then build that visual from scratch using HTML, CSS, and JS/TS. Make sure to ask the user for any specific requirements they have for the visual, such as colors, labels, etc.

## Container Layout

- **`DataGrid`** — the direct parent must apply `overflow-auto` so content remains scrollable when it exceeds the container bounds (many rows).

## Interactivity

Both `VegaVisual` and `DataGrid` expose an `onInteraction` prop that emits structured, predicate-based events when the user clicks a data point or row.

**Always use the `onInteraction` prop** on `VegaVisual` and `DataGrid` to surface user selections. The component only emits the selection; the host app decides what it does — e.g. coordinating other visuals or queries on the page.

> A visual renders a layered subset by binding two named datasets to two layers (`data={{ all, highlighted }}`) — see [references/multi-data-input.md](references/multi-data-input.md). The component renders whatever tables it is handed.

```tsx
import type { InteractionEvent } from "@microsoft/fabric-visuals-core";

function handleInteraction(source: string, events: InteractionEvent[]) {
    for (const event of events) {
        if (event.action === "select") {
            // event.selections describes the clicked data as predicates
        } else if (event.action === "clear") {
            // user deselected (re-clicked same item or clicked empty space)
        }
    }
}

<VegaVisual spec={spec} data={dataTable} theme={theme}
    onInteraction={(events) => handleInteraction("salesChart", events)} />
<DataGrid data={dataTable} theme={theme}
    onInteraction={(events) => handleInteraction("detailTable", events)} />
```
**Key concepts**:
- Clicking a different data point emits a new `select` (replaces the prior selection — no preceding `clear`).
- Re-clicking the same item or background space in a vega-lite visual emits `clear`.
- Predicates include all fields from the datum; consumers filter to the ones that are relevant to them.