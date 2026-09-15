//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/* eslint-disable react-refresh/only-export-components -- This provider module also exports the paired hook and field helpers as its public contract. */

import type React from "react";
import type { JSX } from "react";
import { createContext, useCallback, useContext, useMemo, useReducer } from "react";

import { fieldShortName, parseField } from "@/lib/filter-field";

/**
 * Model field name, preferably canonical (`"Table[Column]"`) but bare short names are accepted.
 *
 * @example
 * ```ts
 * const field: FilterField = "Product[Category]";
 * ```
 */
export type FilterField = string;

/**
 * One active filter selection in the shared dashboard filter model.
 *
 * @example
 * ```ts
 * const selection: FilterSelection = {
 *   kind: "in",
 *   field: "Product[Category]",
 *   values: ["Bikes", "Accessories"],
 * };
 * ```
 */
export type FilterSelection =
    | { kind: "in"; field: FilterField; values: Array<string | number> }
    | {
          kind: "range";
          field: FilterField;
          min: number | null;
          max: number | null;
          dataType?: "number" | "date";
      }
    | { kind: "contains"; field: FilterField; text: string };

/**
 * Shared dashboard filter API consumed by slicers, chart clicks, and drilldown hooks.
 *
 * @example
 * ```tsx
 * const filters = useFilterState();
 *
 * filters.toggleValue("Product[Category]", "Bikes");
 * const activeCategory = filters.getSelection("Product[Category]");
 * ```
 */
export interface FilterStateApi {
    /** All active selections, keyed by field. Empty `in`/`contains` and fully-open ranges are pruned (treated as inactive). */
    selections: Record<FilterField, FilterSelection>;
    /** Read one active selection by model field. */
    getSelection: (field: FilterField) => FilterSelection | undefined;
    /** Set or replace a selection; inactive selections are pruned. */
    setFilter: (selection: FilterSelection) => void;
    /** Toggle one categorical value in an `"in"` selection. */
    toggleValue: (field: FilterField, value: string | number) => void;
    /** Set a numeric or date range selection. */
    setRange: (
        field: FilterField,
        min: number | null,
        max: number | null,
        dataType?: "number" | "date",
    ) => void;
    /** Set a case-insensitive text search selection. */
    setSearch: (field: FilterField, text: string) => void;
    /** Clear one field's active selection. */
    clearFilter: (field: FilterField) => void;
    /** Clear every active selection. */
    clearAll: () => void;
    /** True when at least one selection is active. */
    isActive: boolean;
    /** Generic per-id path store (e.g. a breadcrumb / drill path). */
    drillPath: (id: string) => Array<string | number>;
    /** Store the drill path for one drilldown id. */
    setDrillPath: (id: string, path: Array<string | number>) => void;
}

interface FilterProviderState {
    selections: Record<FilterField, FilterSelection>;
    drillPaths: Record<string, Array<string | number>>;
}

type FilterAction =
    | { type: "set-filter"; selection: FilterSelection }
    | { type: "toggle-value"; field: FilterField; value: string | number }
    | {
          type: "set-range";
          field: FilterField;
          min: number | null;
          max: number | null;
          dataType?: "number" | "date";
      }
    | { type: "set-search"; field: FilterField; text: string }
    | { type: "clear-filter"; field: FilterField }
    | { type: "clear-all" }
    | { type: "set-drill-path"; id: string; path: Array<string | number> };

const EMPTY_SELECTIONS: Record<FilterField, FilterSelection> = {};
const EMPTY_PATH: Array<string | number> = [];

const noop = (): void => undefined;

const NOOP_FILTER_STATE: FilterStateApi = {
    selections: EMPTY_SELECTIONS,
    getSelection: () => undefined,
    setFilter: noop,
    toggleValue: noop,
    setRange: noop,
    setSearch: noop,
    clearFilter: noop,
    clearAll: noop,
    isActive: false,
    drillPath: () => EMPTY_PATH,
    setDrillPath: noop,
};

const FilterStateContext = createContext<FilterStateApi>(NOOP_FILTER_STATE);

function isSelectionActive(selection: FilterSelection): boolean {
    switch (selection.kind) {
        case "in":
            return selection.values.length > 0;
        case "range":
            return selection.min !== null || selection.max !== null;
        case "contains":
            return selection.text.trim().length > 0;
    }
}

function withSelection(
    selections: Record<FilterField, FilterSelection>,
    selection: FilterSelection,
): Record<FilterField, FilterSelection> {
    if (!isSelectionActive(selection)) {
        const rest = { ...selections };
        delete rest[selection.field];
        return rest;
    }

    return { ...selections, [selection.field]: selection };
}

function valuesMatch(left: string | number, right: string | number): boolean {
    return String(left) === String(right);
}

function reducer(state: FilterProviderState, action: FilterAction): FilterProviderState {
    switch (action.type) {
        case "set-filter":
            return {
                ...state,
                selections: withSelection(state.selections, action.selection),
            };
        case "toggle-value": {
            const existing = state.selections[action.field];
            const values =
                existing?.kind === "in"
                    ? existing.values.filter((value) => !valuesMatch(value, action.value))
                    : [];
            const nextValues =
                existing?.kind === "in" &&
                existing.values.some((value) => valuesMatch(value, action.value))
                    ? values
                    : [...values, action.value];

            return {
                ...state,
                selections: withSelection(state.selections, {
                    kind: "in",
                    field: action.field,
                    values: nextValues,
                }),
            };
        }
        case "set-range":
            return {
                ...state,
                selections: withSelection(state.selections, {
                    kind: "range",
                    field: action.field,
                    min: action.min,
                    max: action.max,
                    dataType: action.dataType,
                }),
            };
        case "set-search":
            return {
                ...state,
                selections: withSelection(state.selections, {
                    kind: "contains",
                    field: action.field,
                    text: action.text,
                }),
            };
        case "clear-filter": {
            const rest = { ...state.selections };
            delete rest[action.field];
            return { ...state, selections: rest };
        }
        case "clear-all":
            return { ...state, selections: EMPTY_SELECTIONS };
        case "set-drill-path":
            return {
                ...state,
                drillPaths: {
                    ...state.drillPaths,
                    [action.id]: action.path,
                },
            };
    }
}

/**
 * Provide the shared filter state for slicers, chart-click filters, and drilldown.
 *
 * @example
 * ```tsx
 * <FilterStateProvider>
 *   <DashboardPage />
 * </FilterStateProvider>
 * ```
 */
export function FilterStateProvider(props: { children: React.ReactNode }): JSX.Element {
    const [state, dispatch] = useReducer(reducer, {
        selections: EMPTY_SELECTIONS,
        drillPaths: {},
    });

    const getSelection = useCallback(
        (field: FilterField) => state.selections[field],
        [state.selections],
    );
    const setFilter = useCallback(
        (selection: FilterSelection) => dispatch({ type: "set-filter", selection }),
        [],
    );
    const toggleValue = useCallback(
        (field: FilterField, value: string | number) =>
            dispatch({ type: "toggle-value", field, value }),
        [],
    );
    const setRange = useCallback(
        (
            field: FilterField,
            min: number | null,
            max: number | null,
            dataType?: "number" | "date",
        ) => dispatch({ type: "set-range", field, min, max, dataType }),
        [],
    );
    const setSearch = useCallback(
        (field: FilterField, text: string) =>
            dispatch({ type: "set-search", field, text }),
        [],
    );
    const clearFilter = useCallback(
        (field: FilterField) => dispatch({ type: "clear-filter", field }),
        [],
    );
    const clearAll = useCallback(() => dispatch({ type: "clear-all" }), []);
    const drillPath = useCallback(
        (id: string) => state.drillPaths[id] ?? EMPTY_PATH,
        [state.drillPaths],
    );
    const setDrillPath = useCallback(
        (id: string, path: Array<string | number>) =>
            dispatch({ type: "set-drill-path", id, path }),
        [],
    );

    const value = useMemo<FilterStateApi>(
        () => ({
            selections: state.selections,
            getSelection,
            setFilter,
            toggleValue,
            setRange,
            setSearch,
            clearFilter,
            clearAll,
            isActive: Object.keys(state.selections).length > 0,
            drillPath,
            setDrillPath,
        }),
        [
            state.selections,
            getSelection,
            setFilter,
            toggleValue,
            setRange,
            setSearch,
            clearFilter,
            clearAll,
            drillPath,
            setDrillPath,
        ],
    );

    return (
        <FilterStateContext.Provider value={value}>
            {props.children}
        </FilterStateContext.Provider>
    );
}

/**
 * Return the nearest shared filter-state API, or a stable no-op API outside a provider.
 *
 * @example
 * ```tsx
 * const { selections, clearAll } = useFilterState();
 *
 * if (Object.keys(selections).length > 0) {
 *   clearAll();
 * }
 * ```
 */
export function useFilterState(): FilterStateApi {
    return useContext(FilterStateContext);
}

export { fieldShortName, parseField };
