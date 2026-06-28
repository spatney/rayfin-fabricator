//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo, type CSSProperties } from "react";

import type { ChartSpec, SelectionChangeListener, SelectionStore } from "graphein";

import { useGrapheinTheme } from "@/lib/graphein-theme";

import { useChart } from "./use-chart";

/**
 * Declarative React wrapper around the Graphein runtime — `<Chart spec={…} />`.
 *
 * The published `graphein` package ships the framework-agnostic core, so the
 * app owns this thin binding instead of pulling in `@graphein/react`. Renders a
 * container `<div>` that fills its parent (override via `style`) and draws
 * `spec` into it; pass a new spec to update.
 *
 * `Chart` injects the app's CSS-token theme automatically, so every chart is
 * on-brand and dark-mode aware. Author specs WITHOUT a `theme` and let the tile
 * own it; recolor via `src/global.css` tokens, not per-spec hex. (Set
 * `spec.theme` yourself only as a deliberate escape hatch.)
 *
 * Interactivity (Graphein): pass a shared `store` so several charts
 * cross-highlight / cross-filter (see `SelectionStoreProvider`), and
 * `onSelectionChange` to observe selections (e.g. bridge them into slicer state).
 */

export interface ChartProps {
    /** The Graphein chart spec to render. */
    spec: ChartSpec;
    /** Shared selection bus linking this chart with others (cross-interaction). */
    store?: SelectionStore;
    /** Fired whenever a selection this chart publishes or consumes changes. */
    onSelectionChange?: SelectionChangeListener;
    className?: string;
    style?: CSSProperties;
}

const FILL: CSSProperties = { width: "100%", height: "100%" };

export function Chart({
    spec,
    store,
    onSelectionChange,
    className,
    style,
}: ChartProps) {
    const appTheme = useGrapheinTheme();
    // Inject the app theme unless the spec opts out with its own `theme`.
    const themed = useMemo<ChartSpec>(
        () => (spec.theme != null ? spec : { ...spec, theme: appTheme }),
        [spec, appTheme],
    );
    const ref = useChart<HTMLDivElement>(themed, { store, onSelectionChange });
    return (
        <div
            ref={ref}
            className={className}
            style={style ? { ...FILL, ...style } : FILL}
        />
    );
}
