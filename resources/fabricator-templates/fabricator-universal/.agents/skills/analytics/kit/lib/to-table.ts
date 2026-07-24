//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { CachedQueryResult, QueryTable } from "@microsoft/fabric-app-data";
import type { TableColumn, TableSpec } from "graphein";

import { toChartData } from "./to-chart-data";

/**
 * Build a Graphein `table` spec from a DAX query result.
 *
 * Graphein's `table` is the kit's single table engine (the Fabric `DataGrid` was
 * retired): virtualized + sortable, with rich conditional formatting (data bars,
 * icons, color scales, value rules), column groups, totals, and number/date
 * formatting — all declared in the spec. Map a DAX result here, then drop the
 * result into `<DataTableCard spec={…} />`.
 *
 * Rows are produced by {@link toChartData} (numeric DAX columns are coerced to JS
 * numbers); columns inherit Graphein's `TableColumn` formatting. Omit `columns` to
 * infer every column from the data keys.
 */

/** A table column whose `field` may pull from a differently-named source column. */
export interface TableColumnDef extends TableColumn {
    /**
     * Source column to read from: a full `Table[Col]` name, a short `Col` name,
     * or a 0-based result index. Defaults to {@link TableColumn.field}.
     */
    source?: string | number;
}

export interface ToTableOptions {
    /**
     * Ordered column definitions (display order). Each `field` is the output key;
     * set `source` to pull from a differently-named result column. Omit to infer
     * every column from the result under its short name.
     */
    columns?: TableColumnDef[];
    /** Output keys to force to `Number` (in addition to numeric DAX types). */
    numeric?: string[];
    /** Output keys to force to `string`. */
    text?: string[];
    /** Initial sort. */
    sort?: TableSpec["sort"];
    /** Footer totals row. */
    totals?: TableSpec["totals"];
    /** Row density. */
    density?: TableSpec["density"];
    /** Zebra striping (off by default — flat aesthetic). */
    striped?: boolean;
}

/**
 * Convert a DAX `QueryTable` / `CachedQueryResult` into a Graphein `table` spec.
 *
 * @example
 * ```tsx
 * const table = toTable(data, {
 *   columns: [
 *     { field: "region", source: "Geography[Region]", title: "Region" },
 *     { field: "revenue", source: "Total Revenue", title: "Revenue",
 *       format: "$,.0f", align: "right",
 *       conditionalFormat: { type: "bar", showValue: true } },
 *     { field: "margin", source: "Margin %", title: "Margin", format: ".1%",
 *       align: "right", conditionalFormat: { type: "icon", set: "trafficLights" } },
 *   ],
 *   sort: { field: "revenue", order: "desc" },
 *   totals: { label: "Total" },
 * });
 *
 * <DataTableCard title="Revenue by region" loading={isLoading} error={error} spec={table} />
 * ```
 */
export function toTable(
    input: CachedQueryResult | QueryTable | undefined,
    options: ToTableOptions = {},
): TableSpec {
    const { columns, numeric, text, sort, totals, density, striped } = options;

    // Pull only the requested source columns under their output keys (or every
    // column under its short name when no columns are specified).
    const select = columns
        ? Object.fromEntries(
              columns.map((col) => [col.field, col.source ?? col.field]),
          )
        : undefined;

    const data = toChartData(input, { columns: select, numeric, text });

    const spec: TableSpec = { type: "table", data };
    if (columns) {
        // Strip the `source` hint; the rest is a valid Graphein TableColumn.
        spec.columns = columns.map((col): TableColumn => {
            const column: TableColumnDef = { ...col };
            delete column.source;
            return column;
        });
    }
    if (sort) spec.sort = sort;
    if (totals != null) spec.totals = totals;
    if (density) spec.density = density;
    if (striped != null) spec.striped = striped;
    return spec;
}
