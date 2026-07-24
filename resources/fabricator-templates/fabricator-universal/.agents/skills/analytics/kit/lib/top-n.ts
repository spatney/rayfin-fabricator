//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/**
 * Rank + trim already-mapped chart rows for "top N" breakdowns (ranked bars,
 * leaderboards). Bars/lines plot in row order, so sorting here also fixes the
 * draw order — no `ORDER BY` round-trip needed once the data is in hand.
 */

export interface TopNOptions {
    /** Keep the smallest instead of the largest (default `false`). */
    ascending?: boolean;
    /** Roll the remainder into a single aggregate row. `true` labels it
     *  "Other"; pass a string for a custom label (default `false`). */
    other?: boolean | string;
    /** Category-label key the rollup row should carry (so it shows on the
     *  axis). Defaults to any string key found on the first row. */
    labelKey?: string;
    /** Numeric keys to sum into the rollup row (default: just `valueKey`). */
    sumKeys?: string[];
}

function toNumber(value: unknown): number {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : 0;
}

/**
 * Sort `rows` by `valueKey` and keep the top (or bottom) `n`, optionally
 * rolling the remainder into an "Other" row.
 *
 * @example
 * ```tsx
 * // Ranked bars — top 8 regions, rest grouped as "Other":
 * const ranked = topN(rows, "revenue", 8, { other: true });
 *
 * <ChartCard
 *   title="Top regions"
 *   spec={{
 *     type: "bar",
 *     data: ranked,
 *     encoding: {
 *       x: { field: "region", type: "nominal" },
 *       y: { field: "revenue", type: "quantitative", format: "$,.0f" },
 *     },
 *   }}
 * />
 * ```
 */
export function topN<T extends Record<string, unknown>>(
    rows: readonly T[] | undefined,
    valueKey: string,
    n: number,
    options?: TopNOptions,
): T[] {
    if (!rows || rows.length === 0) return [];
    const { ascending = false, other = false, labelKey, sumKeys } = options ?? {};

    const sorted = [...rows].sort((a, b) => {
        const diff = toNumber(a[valueKey]) - toNumber(b[valueKey]);
        return ascending ? diff : -diff;
    });

    const limit = Math.max(0, Math.floor(n));
    const head = sorted.slice(0, limit);
    const rest = sorted.slice(limit);

    if (!other || rest.length === 0) return head;

    // Discover the label key (first string-valued property) when not given.
    const sample = sorted[0] ?? {};
    const resolvedLabelKey =
        labelKey ??
        Object.keys(sample).find((key) => typeof sample[key] === "string");

    const keysToSum =
        sumKeys ?? [valueKey];

    const otherRow: Record<string, unknown> = {};
    if (resolvedLabelKey) {
        otherRow[resolvedLabelKey] =
            typeof other === "string" ? other : "Other";
    }
    for (const key of keysToSum) {
        otherRow[key] = rest.reduce((sum, row) => sum + toNumber(row[key]), 0);
    }

    return [...head, otherRow as T];
}
