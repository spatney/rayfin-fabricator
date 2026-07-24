//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { CachedQueryResult, QueryTable } from "@microsoft/fabric-app-data";

import {
    buildColumnIndex,
    coerceNumber,
    resolveTable,
    shortName,
} from "./query-table";

/**
 * Reshapes a **long / tidy** DAX result (one row per x × category, with the
 * measure in a single column) into the **wide** row objects a multi-series
 * chart card wants — AND hands back the matching `series[]` config, so you
 * never hand-write the pivot loop or enumerate categories yourself.
 *
 * Long DAX results are the common case: `SUMMARIZECOLUMNS('Date'[Month],
 * 'Product'[Category], "Revenue", [Total Revenue])` returns
 * `(Month, Category, Revenue)` rows — feed that straight to `pivotChartData`.
 */

/** A chart `series` entry produced by {@link pivotChartData}. */
export interface PivotSeries {
    /** Row property to plot (the category value). */
    key: string;
    /** Legend / tooltip label (defaults to `key`). */
    label: string;
    /** Optional explicit color; omit to fall back to the palette by order. */
    color?: string;
}

export interface PivotChartDataOptions {
    /** Source column for the X axis — a column name (`Table[Col]` or short
     *  `Col`) or a 0-based index. */
    x: string | number;
    /** Source column whose **distinct values become the series** (one line /
     *  bar group per value). Name or index. */
    series: string | number;
    /** Source column holding the numeric measure to plot. Name or index. */
    value: string | number;
    /** Output key for the X value (defaults to the X column's short name). */
    xKey?: string;
    /** Order the series: by descending/ascending total, by name, or an
     *  explicit list of category values (default: first-seen order). */
    order?: "total-desc" | "total-asc" | "name" | string[];
    /** Explicit colors — an array (by series order) or a `{ category: color }`
     *  map. Omit to let the chart card assign palette colors by order. */
    colors?: string[] | Record<string, string>;
    /** Value for (x, category) combinations absent from the result
     *  (default `0`; pass `null` to leave gaps in lines). */
    fill?: number | null;
}

export interface PivotChartDataResult<
    T extends Record<string, unknown> = Record<string, unknown>,
> {
    /** Wide rows: one object per X value, a property per category. */
    rows: T[];
    /** Discovered series (one per category), in the resolved order. */
    series: PivotSeries[];
    /** The output key holding the X value (e.g. the spec's x `field`). */
    xKey: string;
    /** Distinct category values, in the resolved series order. */
    categories: string[];
}

function resolveSeriesColor(
    colors: PivotChartDataOptions["colors"],
    category: string,
    index: number,
): string | undefined {
    if (!colors) return undefined;
    if (Array.isArray(colors)) return colors[index];
    return colors[category];
}

/**
 * Pivot a long DAX result into wide rows (one column per series value) plus the
 * discovered `series[]`.
 *
 * In the Graphein spec model you usually DON'T need this: keep rows long and point
 * `encoding.series` at the series column. Reach for `pivotChartData` only when a
 * consumer specifically needs a wide, one-column-per-series shape.
 *
 * @example
 * ```ts
 * // EVALUATE SUMMARIZECOLUMNS('Date'[Month], 'Product'[Category],
 * //   "Revenue", [Total Revenue])
 * const { data, isLoading, error } = useSemanticModelQuery({ connection, query });
 * const { rows, series, xKey } = pivotChartData(data, {
 *   x: "Date[Month]",
 *   series: "Product[Category]",
 *   value: "Revenue",
 *   order: "total-desc",
 * });
 * // rows → [{ Month: "Jan", Bikes: 50, Gear: 20 }, …]; series → ["Bikes", "Gear"]
 * ```
 */
export function pivotChartData<
    T extends Record<string, unknown> = Record<string, unknown>,
>(
    input: CachedQueryResult | QueryTable | undefined,
    options: PivotChartDataOptions,
): PivotChartDataResult<T> {
    const table = resolveTable(input);
    const xKey =
        options.xKey ??
        (typeof options.x === "string" ? shortName(options.x) : "x");

    if (!table || table.rows.length === 0) {
        return { rows: [], series: [], xKey, categories: [] };
    }

    const indexOf = buildColumnIndex(table);
    const xIndex = indexOf(options.x);
    const seriesIndex = indexOf(options.series);
    const valueIndex = indexOf(options.value);
    const fill = options.fill === undefined ? 0 : options.fill;

    // Build wide rows keyed by stringified x, preserving first-seen order.
    const rowByX = new Map<string, Record<string, unknown>>();
    const categoryTotals = new Map<string, number>();
    const categoryOrder: string[] = [];

    for (const row of table.rows) {
        const xRaw = xIndex < 0 ? null : row[xIndex];
        const xId = String(xRaw);
        let outRow = rowByX.get(xId);
        if (!outRow) {
            outRow = { [xKey]: xRaw };
            rowByX.set(xId, outRow);
        }

        const category =
            seriesIndex < 0 ? "" : String(row[seriesIndex] ?? "");
        if (!categoryTotals.has(category)) {
            categoryTotals.set(category, 0);
            categoryOrder.push(category);
        }

        const value = valueIndex < 0 ? null : coerceNumber(row[valueIndex]);
        if (value != null) {
            outRow[category] = ((outRow[category] as number) ?? 0) + value;
            categoryTotals.set(category, (categoryTotals.get(category) ?? 0) + value);
        }
    }

    // Resolve the category (series) order.
    let categories = categoryOrder;
    const { order } = options;
    if (Array.isArray(order)) {
        const known = new Set(categoryOrder);
        categories = order.filter((name) => known.has(name));
        for (const name of categoryOrder) {
            if (!categories.includes(name)) categories.push(name);
        }
    } else if (order === "name") {
        categories = [...categoryOrder].sort((a, b) => a.localeCompare(b));
    } else if (order === "total-desc") {
        categories = [...categoryOrder].sort(
            (a, b) => (categoryTotals.get(b) ?? 0) - (categoryTotals.get(a) ?? 0),
        );
    } else if (order === "total-asc") {
        categories = [...categoryOrder].sort(
            (a, b) => (categoryTotals.get(a) ?? 0) - (categoryTotals.get(b) ?? 0),
        );
    }

    // Fill missing (x, category) combinations so every row carries every key.
    const rows = [...rowByX.values()].map((outRow) => {
        for (const category of categories) {
            if (outRow[category] === undefined) outRow[category] = fill;
        }
        return outRow as T;
    });

    const series: PivotSeries[] = categories.map((category, index) => ({
        key: category,
        label: category,
        color: resolveSeriesColor(options.colors, category, index),
    }));

    return { rows, series, xKey, categories };
}
