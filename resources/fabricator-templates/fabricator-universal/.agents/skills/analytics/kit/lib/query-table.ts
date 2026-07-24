//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { CachedQueryResult, QueryTable } from "@microsoft/fabric-app-data";

/**
 * Small, shared helpers for reading a DAX `QueryTable` — used by the kit's
 * data-mapping helpers (`toChartData`, `pivotChartData`, `deriveKpi`, …) so
 * column resolution and number coercion behave identically everywhere.
 */

/** DAX `dataType` names that should be coerced to JS numbers. */
export const NUMERIC_DAX_TYPES = new Set([
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
 * Normalize a query result, a raw `QueryTable`, or `undefined` into a
 * `QueryTable` (or `undefined`). Lets every helper accept the hook's `data`
 * straight through with no `status` check.
 */
export function resolveTable(
    input: CachedQueryResult | QueryTable | undefined,
): QueryTable | undefined {
    if (!input) return undefined;
    // QueryTable has columns+rows; CachedQueryResult has a status discriminant.
    if ("rows" in input && "columns" in input) return input as QueryTable;
    return input.status === "success" ? input.table : undefined;
}

/**
 * Short, chart-friendly key for a DAX column. Measures come back as
 * `[Total Revenue]` and grouped columns as `Date[Month]`; both reduce to the
 * bracketed leaf (`Total Revenue`, `Month`). Unbracketed names pass through.
 */
export function shortName(name: string): string {
    const matches = name.match(/\[([^\]]+)\]/g);
    if (matches && matches.length > 0) {
        const last = matches[matches.length - 1];
        return last.slice(1, -1);
    }
    return name;
}

/** Coerce a raw cell value to a finite number, or `null` when it isn't one. */
export function coerceNumber(value: unknown): number | null {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string" && value.trim() !== "") {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
    }
    return null;
}

/**
 * Build a resolver that maps a source column reference — a full `Table[Col]`
 * name, a short `Col` name, or a 0-based index — to its column index in the
 * table (or `-1` when it can't be found). Short names resolve to the first
 * column that carries them; full names always resolve uniquely.
 */
export function buildColumnIndex(
    table: QueryTable,
): (source: string | number) => number {
    const indexByName = new Map<string, number>();
    table.columns.forEach((col, i) => {
        indexByName.set(col.name, i);
    });
    table.columns.forEach((col, i) => {
        const short = shortName(col.name);
        if (!indexByName.has(short)) indexByName.set(short, i);
    });
    return (source: string | number): number => {
        if (typeof source === "number") return source;
        return indexByName.get(source) ?? -1;
    };
}

/** True when the column at `index` holds a numeric DAX type. */
export function isNumericColumn(table: QueryTable, index: number): boolean {
    const col = table.columns[index];
    return col ? NUMERIC_DAX_TYPES.has(col.dataType.toLowerCase()) : false;
}
