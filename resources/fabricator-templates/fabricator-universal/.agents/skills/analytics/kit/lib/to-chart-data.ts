//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { CachedQueryResult, QueryTable } from "@microsoft/fabric-app-data";

/**
 * Bridges a DAX `QueryTable` (positional `unknown[][]` rows) into the keyed,
 * number-coerced row objects the kit's chart cards expect — so you never
 * hand-write the row-mapping loop.
 */

/** DAX `dataType` names that should be coerced to JS numbers. */
const NUMERIC_DAX_TYPES = new Set([
    "int64",
    "double",
    "decimal",
    "currency",
    "money",
    "single",
    "float",
    "number",
]);

/**
 * Short, chart-friendly key for a DAX column. Measures come back as
 * `[Total Revenue]` and grouped columns as `Date[Month]`; both reduce to the
 * bracketed leaf (`Total Revenue`, `Month`). Unbracketed names pass through.
 */
function shortName(name: string): string {
    const matches = name.match(/\[([^\]]+)\]/g);
    if (matches && matches.length > 0) {
        const last = matches[matches.length - 1];
        return last.slice(1, -1);
    }
    return name;
}

function resolveTable(input: CachedQueryResult | QueryTable | undefined): QueryTable | undefined {
    if (!input) return undefined;
    // QueryTable has columns+rows; CachedQueryResult has a status discriminant.
    if ("rows" in input && "columns" in input) return input as QueryTable;
    return input.status === "success" ? input.table : undefined;
}

export interface ToChartDataOptions {
    /**
     * Select + rename columns: `{ outKey: sourceColumn }` where `sourceColumn`
     * is a column name (full `Table[Col]` or short `Col`) or a 0-based index.
     * When omitted, every column is emitted under its short name.
     */
    columns?: Record<string, string | number>;
    /** Output keys to force to `Number` (in addition to numeric DAX types). */
    numeric?: string[];
    /** Output keys to force to `string`. */
    text?: string[];
}

function coerceNumber(value: unknown): number | null {
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim() !== "") {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
    }
    return null;
}

/**
 * Convert a DAX `QueryTable` into chart-ready row objects keyed by column
 * name, coercing numeric columns to JS numbers. Pass the result straight to a
 * chart card's `data` prop.
 *
 * @example
 * ```tsx
 * // EVALUATE SUMMARIZECOLUMNS('Date'[Month], "Revenue", [Total Revenue])
 * const { data, isLoading, error } = useSemanticModelQuery({ connection, query });
 * const rows = toChartData(data);
 * // rows → [{ Month: "Jan", Revenue: 84200 }, …]
 *
 * <ChartCard
 *   title="Revenue"
 *   loading={isLoading}
 *   error={error}
 *   spec={{
 *     type: "line",
 *     data: rows,
 *     encoding: {
 *       x: { field: "Month", type: "temporal" },
 *       y: { field: "Revenue", type: "quantitative", format: "$,.0f" },
 *     },
 *   }}
 * />
 * ```
 *
 * @example
 * ```tsx
 * // Rename/select columns explicitly when names are ambiguous:
 * const rows = toChartData(data, {
 *   columns: { month: "Date[Month]", revenue: "Total Revenue", cost: 2 },
 * });
 * ```
 */
export function toChartData<T extends Record<string, unknown> = Record<string, unknown>>(
    input: CachedQueryResult | QueryTable | undefined,
    options?: ToChartDataOptions,
): T[] {
    const table = resolveTable(input);
    if (!table || table.rows.length === 0) return [];

    const { columns: select, numeric, text } = options ?? {};
    const forceNumeric = new Set(numeric ?? []);
    const forceText = new Set(text ?? []);

    // Resolve a source column (by full name, short name, or index) to its index.
    const indexByName = new Map<string, number>();
    table.columns.forEach((col, i) => {
        indexByName.set(col.name, i);
    });
    table.columns.forEach((col, i) => {
        const short = shortName(col.name);
        // Keep the first duplicate short name; full names still resolve uniquely.
        if (!indexByName.has(short)) indexByName.set(short, i);
    });
    const resolveIndex = (source: string | number): number => {
        if (typeof source === "number") return source;
        const idx = indexByName.get(source);
        return idx ?? -1;
    };

    const shortNames = table.columns.map((col) => shortName(col.name));
    const shortNameCounts = shortNames.reduce((counts, name) => {
        counts.set(name, (counts.get(name) ?? 0) + 1);
        return counts;
    }, new Map<string, number>());
    const collidingShortNames = new Set(
        [...shortNameCounts.entries()]
            .filter(([, count]) => count > 1)
            .map(([name]) => name),
    );

    if (!select && collidingShortNames.size > 0 && import.meta.env.DEV) {
        console.warn(
            `toChartData: duplicate short column name(s) ${[...collidingShortNames]
                .map((name) => `"${name}"`)
                .join(", ")} detected; using full column names as keys for those columns instead.`,
        );
    }

    // Build the ordered list of [outputKey, sourceIndex] to emit.
    const fields: Array<{ key: string; index: number }> = select
        ? Object.entries(select).map(([key, source]) => ({
              key,
              index: resolveIndex(source),
          }))
        : table.columns.map((col, index) => ({
              key: collidingShortNames.has(shortNames[index]) ? col.name : shortNames[index],
              index,
          }));

    const isNumericField = (field: { key: string; index: number }): boolean => {
        if (forceText.has(field.key)) return false;
        if (forceNumeric.has(field.key)) return true;
        const col = table.columns[field.index];
        return col ? NUMERIC_DAX_TYPES.has(col.dataType.toLowerCase()) : false;
    };

    return table.rows.map((row) => {
        const out: Record<string, unknown> = {};
        for (const field of fields) {
            if (field.index < 0) {
                out[field.key] = null;
                continue;
            }
            const raw = row[field.index];
            out[field.key] = isNumericField(field) ? coerceNumber(raw) : raw;
        }
        return out as T;
    });
}
