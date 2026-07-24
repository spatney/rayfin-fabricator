//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/**
 * Parsed parts of a model field reference.
 *
 * @example
 * ```ts
 * const parsed: ParsedFilterField = {
 *   table: "Product",
 *   column: "Category",
 * };
 * ```
 */
export interface ParsedFilterField {
    /** Optional model table name for canonical fields such as `"Product[Category]"`. */
    table?: string;
    /** Model column name, or the bare field name when no table is supplied. */
    column: string;
}

function unquoteTable(table: string): string {
    const trimmed = table.trim();
    if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
        return trimmed.slice(1, -1).replace(/''/g, "'");
    }
    return trimmed;
}

function quoteTable(table: string): string {
    return `'${table.replace(/'/g, "''")}'`;
}

function quoteColumn(column: string): string {
    return `[${column.replace(/\]/g, "]]")}]`;
}

/**
 * Parse a model field into its optional table and required column parts.
 *
 * @example
 * ```ts
 * parseField("Product[Category]");
 * // → { table: "Product", column: "Category" }
 *
 * parseField("Category");
 * // → { column: "Category" }
 * ```
 */
export function parseField(field: string): ParsedFilterField {
    const trimmed = field.trim();
    const bracketStart = trimmed.lastIndexOf("[");
    const bracketEnd = trimmed.endsWith("]") ? trimmed.length - 1 : -1;

    if (bracketStart >= 0 && bracketEnd > bracketStart) {
        const table = trimmed.slice(0, bracketStart).trim();
        const column = trimmed.slice(bracketStart + 1, bracketEnd).replace(/\]\]/g, "]");
        return table
            ? { table: unquoteTable(table), column }
            : { column };
    }

    return { column: trimmed };
}

/**
 * Return the row-object key used by `toChartData` for a model field.
 *
 * @example
 * ```ts
 * fieldShortName("Product[Category]"); // "Category"
 * fieldShortName("Category");          // "Category"
 * ```
 */
export function fieldShortName(field: string): string {
    return parseField(field).column;
}

/**
 * Quote a field reference for insertion into a DAX string.
 *
 * @example
 * ```ts
 * quoteFieldRef("Product[Category]"); // "'Product'[Category]"
 * quoteFieldRef("Category");          // "[Category]"
 * ```
 */
export function quoteFieldRef(field: string): string {
    const parsed = parseField(field);
    const column = quoteColumn(parsed.column);
    return parsed.table ? `${quoteTable(parsed.table)}${column}` : column;
}
