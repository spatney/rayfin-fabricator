//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/* eslint-disable react-refresh/only-export-components -- This provider module also exports its paired hooks as part of one public contract. */

import type React from "react";
import type { JSX } from "react";
import {
    createContext,
    useCallback,
    useContext,
    useMemo,
    useSyncExternalStore,
} from "react";

import {
    createSelectionStore,
    type SelectionStore,
    type SelectionValue,
} from "graphein";

/**
 * Shared Graphein selection bus (Graphein).
 *
 * A *selection* is the unit of cross-chart interactivity: a named, JSON value a
 * visual publishes (clicking a mark, brushing) that other visuals consume as a
 * `highlight` (emphasize matches, dim the rest) or a `filter` (subset rows).
 * Pass the same {@link SelectionStore} to several charts to link them.
 *
 * Wrap a page (or a sub-dashboard) in {@link SelectionStoreProvider}, then hand
 * `useSelectionStore()` to each `ChartCard` / `Chart` `store` prop so the cards
 * cross-interact. To drive the app's server-side DAX slicers from chart clicks,
 * pair the store with `useSelectionFilterBridge`.
 */

/** A process-wide fallback store so `useSelectionStore()` works without a provider. */
let defaultStore: SelectionStore | undefined;
function getDefaultStore(): SelectionStore {
    return (defaultStore ??= createSelectionStore());
}

const SelectionStoreContext = createContext<SelectionStore | null>(null);

/**
 * Provide a shared selection store to descendant charts. Creates a fresh store
 * per provider (so each sub-dashboard is isolated), or wraps an external one.
 *
 * @example
 * ```tsx
 * <SelectionStoreProvider>
 *   <DashboardPage />
 * </SelectionStoreProvider>
 * ```
 */
export function SelectionStoreProvider(props: {
    children: React.ReactNode;
    /** Use this store instead of creating one (e.g. to share across providers). */
    store?: SelectionStore;
    /** Seed initial param values when creating the store. */
    initial?: Record<string, SelectionValue | null>;
}): JSX.Element {
    const { children, store: external, initial } = props;
    // Create once; identity is stable for the provider's lifetime.
    const created = useMemo(
        () => external ?? createSelectionStore(initial),
        // Intentionally mount-stable: changing `initial`/`external` later does not
        // recreate the bus (which would remount every linked chart).
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [],
    );
    return (
        <SelectionStoreContext.Provider value={external ?? created}>
            {children}
        </SelectionStoreContext.Provider>
    );
}

/**
 * Return the nearest shared selection store, falling back to a stable
 * process-wide store when used outside a {@link SelectionStoreProvider}.
 *
 * @example
 * ```tsx
 * const store = useSelectionStore();
 * <ChartCard spec={barSpec} store={store} />
 * <ChartCard spec={lineSpec} store={store} />
 * ```
 */
export function useSelectionStore(): SelectionStore {
    return useContext(SelectionStoreContext) ?? getDefaultStore();
}

/**
 * Read and write a named selection as React state.
 *
 * Returns the current value and a setter that publishes to the bus — driving
 * cross-highlight / cross-filter across every visual bound to the same store.
 * Uses the context store by default; pass an explicit `store` to override.
 *
 * @example
 * ```tsx
 * const [region, setRegion] = useSelection("region");
 * <button onClick={() => setRegion({ kind: "set", field: "region", values: ["West"] })}>
 *   West
 * </button>
 * ```
 */
export function useSelection(
    name: string,
    store?: SelectionStore,
): [SelectionValue | null, (value: SelectionValue | null) => void] {
    const ctx = useSelectionStore();
    const bus = store ?? ctx;

    const subscribe = useCallback(
        (onStoreChange: () => void) =>
            bus.subscribe((changed) => {
                if (changed === name) onStoreChange();
            }),
        [bus, name],
    );
    const getSnapshot = useCallback(
        (): SelectionValue | null => bus.get(name) ?? null,
        [bus, name],
    );
    // Subscribe to the external selection bus the idiomatic way — no
    // setState-in-effect. `bus.get` returns a stable reference until the value
    // structurally changes, so the snapshot compare won't loop.
    const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    const set = useCallback(
        (next: SelectionValue | null) => bus.set(name, next ?? null),
        [bus, name],
    );

    return [value, set];
}
