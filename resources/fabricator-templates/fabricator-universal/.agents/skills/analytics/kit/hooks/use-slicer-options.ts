//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";

import type { FilterField } from "@/components/dashboard/filters/filter-state";
import { useSemanticModelQuery } from "@/hooks/use-semantic-model-query";
import { fieldShortName, quoteFieldRef } from "@/lib/filter-field";
import { toChartData } from "@/lib/to-chart-data";

/**
 * One selectable value for a slicer control.
 *
 * @example
 * ```ts
 * const option: SlicerOption = {
 *   value: "Bikes",
 *   label: "Bikes",
 *   count: 123,
 * };
 * ```
 */
export interface SlicerOption {
    /** Raw value to pass to `setFilter` or `toggleValue`. */
    value: string | number;
    /** Display label for the slicer UI. */
    label: string;
    /** Optional per-value count from the supplied measure. */
    count?: number;
}

/**
 * Result returned by `useSlicerOptions`.
 *
 * @example
 * ```tsx
 * const { options, isLoading, error } = useSlicerOptions({
 *   connection: "salesModel",
 *   field: "Product[Category]",
 * });
 * ```
 */
export interface UseSlicerOptionsResult {
    /** Distinct slicer values mapped from the semantic model. */
    options: SlicerOption[];
    /** True while the underlying DAX query is running. */
    isLoading: boolean;
    /** Query error, if the Fabric SDK or semantic model returned one. */
    error: Error | undefined;
}

function orderExpression(fieldRef: string, orderBy: "value" | "count", hasMeasure: boolean): string {
    return orderBy === "count" && hasMeasure ? "[Count]" : fieldRef;
}

function orderDirection(orderBy: "value" | "count", hasMeasure: boolean): "ASC" | "DESC" {
    return orderBy === "count" && hasMeasure ? "DESC" : "ASC";
}

function optionValue(value: unknown): string | number | undefined {
    if (typeof value === "string" || typeof value === "number") return value;
    if (value == null) return undefined;
    return String(value);
}

/**
 * Query distinct values for a model field to power a slicer.
 *
 * @example
 * ```tsx
 * const { options, isLoading } = useSlicerOptions({
 *   connection: "salesModel",
 *   field: "Product[Category]",
 *   measure: "[Total Sales]",
 *   orderBy: "count",
 *   top: 25,
 * });
 * ```
 */
export function useSlicerOptions(params: {
    connection: string;
    field: FilterField;
    /** Optional measure expression to compute a per-value count (also used to sort when orderBy:"count"). */
    measure?: string;
    /** Cap the number of distinct values (default 1000). */
    top?: number;
    /** Sort by the value (default) or by count desc. */
    orderBy?: "value" | "count";
}): UseSlicerOptionsResult {
    const { connection, field, measure, top = 1000, orderBy = "value" } = params;
    const fieldRef = useMemo(() => quoteFieldRef(field), [field]);
    const query = useMemo(() => {
        const hasMeasure = Boolean(measure);
        const summarize = `SUMMARIZECOLUMNS(${fieldRef}${
            measure ? `, "Count", ${measure}` : ""
        })`;
        const sortBy = orderExpression(fieldRef, orderBy, hasMeasure);
        const direction = orderDirection(orderBy, hasMeasure);

        return `EVALUATE TOPN(${top}, ${summarize}, ${sortBy}, ${direction}) ORDER BY ${fieldRef}`;
    }, [fieldRef, measure, orderBy, top]);

    const { data, isLoading, error } = useSemanticModelQuery({ connection, query });
    const valueKey = useMemo(() => fieldShortName(field), [field]);
    const semanticError = useMemo(
        () => (data?.status === "error" ? new Error(data.error.message) : undefined),
        [data],
    );
    const options = useMemo<SlicerOption[]>(() => {
        return toChartData(data).flatMap((row) => {
            const value = optionValue(row[valueKey]);
            if (value === undefined) return [];
            const count = row.Count;
            return {
                value,
                label: String(value),
                ...(typeof count === "number" ? { count } : {}),
            };
        });
    }, [data, valueKey]);

    return {
        options,
        isLoading,
        error: error ?? semanticError,
    };
}
