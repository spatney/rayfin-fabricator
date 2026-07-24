//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { CachedQueryResult, QueryTable } from "@microsoft/fabric-app-data";

import { buildColumnIndex, coerceNumber, resolveTable } from "./query-table";

/**
 * Collapses a small time-series DAX result into the three things a `KpiCard`
 * wants — the latest value, its change vs the prior period, and a trend array
 * for an inline `<Sparkline />` — in one call. The query should already be
 * ordered oldest → newest (an `ORDER BY` in the DAX), since the latest point
 * is taken from the last row.
 */

export interface DeriveKpiOptions {
    /** Source column holding the numeric measure (name `Table[Col]` / short
     *  `Col`, or a 0-based index). */
    valueKey: string | number;
    /** `delta` as a signed percent change (default) or an absolute difference. */
    deltaAsPercent?: boolean;
}

export interface DerivedKpi {
    /** Latest period's value (last row), or `null` when there's no data. */
    value: number | null;
    /** Prior period's value (second-to-last row), or `null`. */
    previous: number | null;
    /** Signed change from `previous` to `value` — percent by default, absolute
     *  when `deltaAsPercent` is `false`. `null` when it can't be computed. */
    delta: number | null;
    /** Every period's value (nulls coerced to 0) for a `<Sparkline />`. */
    trend: number[];
}

const EMPTY: DerivedKpi = {
    value: null,
    previous: null,
    delta: null,
    trend: [],
};

/**
 * Derive `{ value, previous, delta, trend }` from a time-series query result.
 *
 * @example
 * ```tsx
 * // EVALUATE SUMMARIZECOLUMNS('Date'[Month], "Revenue", [Total Revenue])
 * //   ORDER BY 'Date'[Month]
 * const { data, isLoading, error } = useSemanticModelQuery({ connection, query });
 * const kpi = deriveKpi(data, { valueKey: "Revenue" });
 *
 * <KpiCard
 *   label="Revenue"
 *   value={kpi.value ?? undefined}
 *   valueFormat="currency"
 *   delta={kpi.delta ?? undefined}
 *   deltaLabel="vs last month"
 *   trend={kpi.trend}
 *   loading={isLoading}
 *   error={error}
 * />
 * ```
 */
export function deriveKpi(
    input: CachedQueryResult | QueryTable | undefined,
    options: DeriveKpiOptions,
): DerivedKpi {
    const table = resolveTable(input);
    if (!table || table.rows.length === 0) return EMPTY;

    const valueIndex = buildColumnIndex(table)(options.valueKey);
    if (valueIndex < 0) return EMPTY;

    const trend = table.rows.map((row) => coerceNumber(row[valueIndex]) ?? 0);
    const value = trend.length ? trend[trend.length - 1] : null;
    const previous = trend.length >= 2 ? trend[trend.length - 2] : null;

    let delta: number | null = null;
    if (value != null && previous != null) {
        if (options.deltaAsPercent === false) {
            delta = value - previous;
        } else if (previous !== 0) {
            delta = ((value - previous) / Math.abs(previous)) * 100;
        }
    }

    return { value, previous, delta, trend };
}
