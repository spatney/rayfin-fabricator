//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useEffect, useRef } from "react";

import type { SelectionStore, SelectionValue } from "graphein";

import {
    useFilterState,
    type FilterField,
    type FilterSelection,
} from "@/components/dashboard/filters/filter-state";

/**
 * Bridge Graphein's chart-side selection model into the app's shared slicer state.
 *
 * Graphein charts publish a {@link SelectionValue} when clicked/brushed; the
 * app's slicers drive **server-side DAX** re-queries via `toDaxFilters`. This
 * module maps between the two so a chart click can re-query the model just like
 * moving a slicer — keeping per-tile DAX + server-side filtering as the source of
 * truth while gaining Power BI-style cross-filtering.
 *
 * Use {@link useSelectionFilterBridge} to wire a shared store to the slicer state;
 * {@link selectionToFilters} / {@link filterToSelection} are the pure mappers.
 */

/** Map a selection's data field → the app's canonical `Table[Column]` field. */
export type FieldMap = Record<string, FilterField>;

function mapField(field: string, fieldMap?: FieldMap): FilterField {
    return fieldMap?.[field] ?? field;
}

function uniqueValues(values: unknown[]): Array<string | number> {
    const seen = new Set<string>();
    const out: Array<string | number> = [];
    for (const v of values) {
        if (v == null) continue;
        const scalar = typeof v === "number" ? v : String(v);
        const key = String(scalar);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(scalar);
    }
    return out;
}

/** Coerce a Graphein range bound (number or ISO string) to the app's numeric bound. */
function toBound(value: number | string | undefined): number | null {
    if (value == null) return null;
    if (typeof value === "number") return value;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
}

/**
 * Convert a Graphein {@link SelectionValue} into the app's {@link FilterSelection}s.
 *
 * Returns an array because a multi-field `point` selection (e.g. clicking a
 * grouped bar keyed by region × product) maps to one `in` filter per field. A
 * `null`/empty selection returns `[]`.
 */
export function selectionToFilters(
    value: SelectionValue | null | undefined,
    fieldMap?: FieldMap,
): FilterSelection[] {
    if (!value) return [];
    switch (value.kind) {
        case "set":
            return [
                {
                    kind: "in",
                    field: mapField(value.field, fieldMap),
                    values: uniqueValues(value.values),
                },
            ];
        case "point": {
            const { fields, tuples } = value;
            return fields.map((field, i) => ({
                kind: "in",
                field: mapField(field, fieldMap),
                values: uniqueValues(tuples.map((tuple) => tuple[i])),
            }));
        }
        case "range": {
            const isDate =
                typeof value.min === "string" || typeof value.max === "string";
            return [
                {
                    kind: "range",
                    field: mapField(value.field, fieldMap),
                    min: toBound(value.min),
                    max: toBound(value.max),
                    dataType: isDate ? "date" : "number",
                },
            ];
        }
        case "text":
            return [
                {
                    kind: "contains",
                    field: mapField(value.field, fieldMap),
                    text: value.query,
                },
            ];
    }
}

/**
 * Convert one app {@link FilterSelection} back into a Graphein {@link SelectionValue}
 * — e.g. to seed a store from active slicers so charts highlight on first paint.
 */
export function filterToSelection(selection: FilterSelection): SelectionValue {
    switch (selection.kind) {
        case "in":
            return {
                kind: "set",
                field: selection.field,
                values: selection.values,
            };
        case "range": {
            const asIso = selection.dataType === "date";
            const fromBound = (n: number | null): number | string | undefined => {
                if (n == null) return undefined;
                return asIso ? new Date(n).toISOString() : n;
            };
            return {
                kind: "range",
                field: selection.field,
                min: fromBound(selection.min),
                max: fromBound(selection.max),
            };
        }
        case "contains":
            return {
                kind: "text",
                field: selection.field,
                query: selection.text,
            };
    }
}

/** Options for {@link useSelectionFilterBridge}. */
export interface SelectionFilterBridgeOptions {
    /**
     * Map each selection's field name to the app's canonical `Table[Column]`
     * field (defaults to identity). Author chart encodings with the canonical
     * field name to skip this.
     */
    fieldMap?: FieldMap;
    /** Restrict bridging to these param names (default: every changed param). */
    params?: string[];
}

/**
 * Subscribe a shared selection {@link SelectionStore} to the app's slicer state:
 * whenever a chart publishes a selection, apply the equivalent slicer filter (so
 * `toDaxFilters` re-queries the model). One-way (chart → slicer/DAX) to avoid
 * feedback loops.
 *
 * @example
 * ```tsx
 * const store = useSelectionStore();
 * useSelectionFilterBridge(store, {
 *   fieldMap: { region: "Geography[Region]" },
 * });
 * // a bar with params:[{ name:"region", select:{ type:"point" } }] now re-queries.
 * ```
 */
export function useSelectionFilterBridge(
    store: SelectionStore,
    options: SelectionFilterBridgeOptions = {},
): void {
    const filters = useFilterState();
    // Keep latest filters/options in refs so the subscription (one per store)
    // always sees current values without resubscribing. Synced in the effect
    // below — never written during render.
    const filtersRef = useRef(filters);
    const optionsRef = useRef(options);
    useEffect(() => {
        filtersRef.current = filters;
        optionsRef.current = options;
    });

    useEffect(() => {
        // Remember which fields each param last wrote, so clearing a param
        // (value → null) can clear exactly those fields.
        const lastFields = new Map<string, FilterField[]>();

        return store.subscribe((name, value) => {
            const { params, fieldMap } = optionsRef.current;
            if (params && !params.includes(name)) return;
            const api = filtersRef.current;

            if (value == null) {
                for (const field of lastFields.get(name) ?? []) {
                    api.clearFilter(field);
                }
                lastFields.delete(name);
                return;
            }

            const next = selectionToFilters(value, fieldMap);
            // Clear fields this param previously set but no longer does.
            const nextFields = next.map((f) => f.field);
            for (const field of lastFields.get(name) ?? []) {
                if (!nextFields.includes(field)) api.clearFilter(field);
            }
            for (const selection of next) api.setFilter(selection);
            lastFields.set(name, nextFields);
        });
    }, [store]);
}
