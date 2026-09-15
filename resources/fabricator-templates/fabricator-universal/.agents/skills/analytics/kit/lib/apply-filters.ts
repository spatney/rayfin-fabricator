//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { FilterField, FilterSelection } from "@/components/dashboard/filters/filter-state";
import { fieldShortName } from "@/lib/filter-field";

/**
 * Options for client-side filtering of mapped rows.
 *
 * @example
 * ```ts
 * const options: ApplyFiltersOptions = {
 *   fieldMap: { "Product[Category]": "categoryName" },
 * };
 * ```
 */
export interface ApplyFiltersOptions {
    /** Map a model field to the row property key emitted by custom mapping code. */
    fieldMap?: Record<FilterField, string>;
}

function selectionList(
    selections: Record<FilterField, FilterSelection> | ReadonlyArray<FilterSelection>,
): FilterSelection[] {
    return Array.isArray(selections) ? [...selections] : Object.values(selections);
}

function comparisonText(value: string | number): string {
    return String(value);
}

function isDateLike(value: unknown): boolean {
    return (
        value instanceof Date ||
        (typeof value === "string" &&
            /\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(value) &&
            Number.isFinite(Date.parse(value)))
    );
}

function comparableValue(value: unknown, dataType?: "number" | "date"): number | null {
    if (value == null) return null;
    if (dataType === "date" || isDateLike(value)) {
        const time = value instanceof Date ? value.getTime() : Date.parse(String(value));
        return Number.isFinite(time) ? time : null;
    }
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string" && value.trim() !== "") {
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    }
    return null;
}

/**
 * Does a single mapped row satisfy one filter selection?
 *
 * @example
 * ```ts
 * matchesSelection(
 *   { Category: "Bikes", Revenue: 42 },
 *   { kind: "in", field: "Product[Category]", values: ["Bikes"] },
 *   "Category",
 * ); // true
 * ```
 */
export function matchesSelection(
    row: Record<string, unknown>,
    selection: FilterSelection,
    rowKey: string,
): boolean {
    const rowValue = row[rowKey];

    switch (selection.kind) {
        case "in": {
            if (selection.values.length === 0) return true;
            if (rowValue == null) return false;
            const actual = comparisonText(
                typeof rowValue === "number" ? rowValue : String(rowValue),
            );
            return selection.values.some((value) => comparisonText(value) === actual);
        }
        case "range": {
            if (selection.min === null && selection.max === null) return true;
            const actual = comparableValue(rowValue, selection.dataType);
            if (actual === null) return false;
            if (selection.min !== null && actual < selection.min) return false;
            if (selection.max !== null && actual > selection.max) return false;
            return true;
        }
        case "contains":
            return selection.text.trim().length === 0
                ? true
                : String(rowValue ?? "")
                      .toLocaleLowerCase()
                      .includes(selection.text.toLocaleLowerCase());
    }
}

/**
 * Filter already-mapped chart or table rows by the active shared selections.
 *
 * @example
 * ```ts
 * const { selections } = useFilterState();
 * const filteredRows = applyFilters(rows, selections);
 *
 * <ChartCard
 *   spec={{
 *     type: "bar",
 *     data: filteredRows,
 *     encoding: {
 *       x: { field: "Category", type: "nominal" },
 *       y: { field: "Sales", type: "quantitative" },
 *     },
 *   }}
 * />
 * ```
 */
export function applyFilters<T extends Record<string, unknown>>(
    rows: ReadonlyArray<T>,
    selections: Record<FilterField, FilterSelection> | ReadonlyArray<FilterSelection>,
    options?: ApplyFiltersOptions,
): T[] {
    const activeSelections = selectionList(selections);
    if (activeSelections.length === 0) return [...rows];

    return rows.filter((row) =>
        activeSelections.every((selection) => {
            const rowKey = options?.fieldMap?.[selection.field] ?? fieldShortName(selection.field);
            return matchesSelection(row, selection, rowKey);
        }),
    );
}
