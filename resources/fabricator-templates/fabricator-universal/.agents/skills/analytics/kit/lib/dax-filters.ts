//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { FilterField, FilterSelection } from "@/components/dashboard/filters/filter-state";
import { fieldShortName, quoteFieldRef } from "@/lib/filter-field";

/**
 * DAX fragments generated from the shared filter model.
 *
 * @example
 * ```ts
 * const filters = toDaxFilters(selections);
 * const query = `
 * DEFINE
 * ${filters.defines}
 * EVALUATE
 * SUMMARIZECOLUMNS(
 *   'Product'[Category],
 *   ${filters.vars.join(",\n  ")},
 *   "Sales", [Sales]
 * )`;
 * ```
 */
export interface DaxFilters {
    /** A `DEFINE`-ready block of `VAR __f_x = TREATAS(...)` lines (may be ""). */
    defines: string;
    /** The VAR names to drop into SUMMARIZECOLUMNS as filter args. */
    vars: string[];
    /** Boolean predicate expressions (for CALCULATETABLE/FILTER), e.g. "'Sales'[Amount] >= 10". */
    predicates: string[];
}

function selectionList(
    selections: Record<FilterField, FilterSelection> | ReadonlyArray<FilterSelection>,
): FilterSelection[] {
    return Array.isArray(selections) ? [...selections] : Object.values(selections);
}

function isActive(selection: FilterSelection): boolean {
    switch (selection.kind) {
        case "in":
            return selection.values.length > 0;
        case "range":
            return selection.min !== null || selection.max !== null;
        case "contains":
            return selection.text.trim().length > 0;
    }
}

function daxValue(value: string | number): string {
    return typeof value === "number" ? String(value) : `"${daxEscape(value)}"`;
}

function safeVarName(prefix: string, field: FilterField, index: number): string {
    const base = fieldShortName(field)
        .replace(/[^A-Za-z0-9_]/g, "_")
        .replace(/^([^A-Za-z_])/, "_$1");
    return `${prefix}_${base || "Filter"}_${index + 1}`;
}

/**
 * Escape embedded double quotes for use inside DAX string literals.
 *
 * @example
 * ```ts
 * daxEscape('Bob "The Buyer"'); // Bob ""The Buyer""
 * ```
 */
export function daxEscape(text: string): string {
    return text.replace(/"/g, '""');
}

/**
 * Render a DAX list literal for TREATAS values.
 *
 * @example
 * ```ts
 * daxValueList(["A", "B", 3]); // {"A", "B", 3}
 * ```
 */
export function daxValueList(values: ReadonlyArray<string | number>): string {
    return `{${values.map(daxValue).join(", ")}}`;
}

/**
 * Render a JavaScript date-like value as a DAX `DATE(y, m, d)` literal.
 *
 * @example
 * ```ts
 * daxDateLiteral("2025-01-31"); // DATE(2025, 1, 31)
 * ```
 */
export function daxDateLiteral(value: string | number | Date): string {
    if (value instanceof Date) {
        return `DATE(${value.getFullYear()}, ${value.getMonth() + 1}, ${value.getDate()})`;
    }

    if (
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 10_000_000 &&
        value <= 99_991_231
    ) {
        const text = String(value);
        const year = Number(text.slice(0, 4));
        const month = Number(text.slice(4, 6));
        const day = Number(text.slice(6, 8));
        if (Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)) {
            return `DATE(${year}, ${month}, ${day})`;
        }
    }

    const text = String(value);
    const match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (match) {
        return `DATE(${Number(match[1])}, ${Number(match[2])}, ${Number(match[3])})`;
    }

    const parsed = new Date(value);
    return `DATE(${parsed.getFullYear()}, ${parsed.getMonth() + 1}, ${parsed.getDate()})`;
}

/**
 * Convert shared filter selections into DAX fragments for server-side filtering.
 *
 * @example
 * ```ts
 * const filters = toDaxFilters(selections);
 * const query = `
 * DEFINE
 * ${filters.defines}
 * EVALUATE
 * SUMMARIZECOLUMNS(
 *   'Product'[Category],
 *   ${filters.vars.join(",\n  ")},
 *   "Revenue", [Total Revenue]
 * )`;
 * ```
 *
 * @example
 * ```ts
 * const filters = toDaxFilters(selections);
 * const query = `
 * EVALUATE
 * CALCULATETABLE(
 *   SUMMARIZECOLUMNS('Date'[Month], "Revenue", [Total Revenue]),
 *   FILTER(ALL('Sales'), ${filters.predicates.join(" && ") || "TRUE()"})
 * )`;
 * ```
 */
export function toDaxFilters(
    selections: Record<FilterField, FilterSelection> | ReadonlyArray<FilterSelection>,
    options?: { varPrefix?: string },
): DaxFilters {
    const prefix = options?.varPrefix ?? "__f";
    const defines: string[] = [];
    const vars: string[] = [];
    const predicates: string[] = [];

    selectionList(selections)
        .filter(isActive)
        .forEach((selection, index) => {
            const fieldRef = quoteFieldRef(selection.field);

            if (selection.kind === "in") {
                const varName = safeVarName(prefix, selection.field, index);
                defines.push(
                    `VAR ${varName} = TREATAS(${daxValueList(selection.values)}, ${fieldRef})`,
                );
                vars.push(varName);
                return;
            }

            if (selection.kind === "range") {
                const lower =
                    selection.min === null
                        ? undefined
                        : `${fieldRef} >= ${
                              selection.dataType === "date"
                                  ? daxDateLiteral(selection.min)
                                  : selection.min
                          }`;
                const upper =
                    selection.max === null
                        ? undefined
                        : `${fieldRef} <= ${
                              selection.dataType === "date"
                                  ? daxDateLiteral(selection.max)
                                  : selection.max
                          }`;
                const predicate = [lower, upper].filter(Boolean).join(" && ");
                if (predicate) predicates.push(predicate);
                return;
            }

            predicates.push(`SEARCH("${daxEscape(selection.text)}", ${fieldRef}, 1, 0) > 0`);
        });

    return {
        defines: defines.join("\n"),
        vars,
        predicates,
    };
}
