//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useEffect, useRef } from "react";

import {
    render,
    type ChartInstance,
    type ChartSpec,
    type SelectionChangeListener,
    type SelectionStore,
} from "graphein";

/** Options for {@link useChart} — interactivity wiring is all optional. */
export interface UseChartOptions {
    /**
     * A shared selection bus. Pass the *same* store to several charts (via
     * {@link SelectionStoreProvider} / `useSelectionStore`) to link them —
     * clicking a mark in one cross-highlights / cross-filters the others. Must be
     * stable across renders; changing its identity remounts the chart.
     */
    store?: SelectionStore;
    /** Called whenever any selection this chart publishes or consumes changes. */
    onSelectionChange?: SelectionChangeListener;
    /** Called with the live instance after each mount and update. */
    onReady?: (instance: ChartInstance) => void;
}

/**
 * Headless Graphein binding: mount a chart into a DOM node and keep it in sync with
 * `spec`.
 *
 * Returns a ref to attach to the container element (give it an explicit size).
 * The chart is created on mount, re-rendered via `instance.update()` whenever
 * `spec` changes identity, and torn down on unmount. StrictMode-safe (double
 * mount → destroy → mount leaks nothing and never double-renders).
 *
 * Pass a *stable* (memoized or module-constant) `spec`; a fresh object every
 * render replays the entrance/crossfade animation.
 *
 * Interactivity (Graphein): author `params` / `highlight` / `filter` on the
 * spec and pass a shared `store` so several charts cross-interact. Subscribe to
 * changes with `onSelectionChange`, or bridge them into the app's slicer state
 * with `useSelectionFilterBridge`.
 */
export function useChart<T extends HTMLElement = HTMLDivElement>(
    spec: ChartSpec,
    options: UseChartOptions = {},
) {
    const ref = useRef<T | null>(null);
    const instanceRef = useRef<ChartInstance | null>(null);
    // Hold the latest spec / callbacks in refs so the mount effect (which runs
    // once per store identity) always reads current values without resubscribing.
    // Kept in sync by the effect below — never written during render.
    const specRef = useRef(spec);
    const onReadyRef = useRef(options.onReady);
    const onSelectionChangeRef = useRef(options.onSelectionChange);
    const { store } = options;
    const skipNextUpdate = useRef(true);

    useEffect(() => {
        specRef.current = spec;
        onReadyRef.current = options.onReady;
        onSelectionChangeRef.current = options.onSelectionChange;
    });

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const instance = render(
            el,
            specRef.current,
            store ? { store } : undefined,
        );
        instanceRef.current = instance;
        const offSelection = instance.on("selectionchange", (name, value) =>
            onSelectionChangeRef.current?.(name, value),
        );
        // The update effect fires once right after mount; skip that pass so we
        // don't redundantly re-render the freshly created chart.
        skipNextUpdate.current = true;
        onReadyRef.current?.(instance);
        return () => {
            offSelection();
            instance.destroy();
            instanceRef.current = null;
        };
        // Mount once per store identity; the sync effects above/below handle
        // later spec & callback changes.
    }, [store]);

    useEffect(() => {
        if (skipNextUpdate.current) {
            skipNextUpdate.current = false;
            return;
        }
        const instance = instanceRef.current;
        if (!instance) return;
        instance.update(spec);
        onReadyRef.current?.(instance);
    }, [spec]);

    return ref;
}
