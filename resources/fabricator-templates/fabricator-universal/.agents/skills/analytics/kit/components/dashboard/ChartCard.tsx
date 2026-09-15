//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { CSSProperties, ReactNode } from "react";

import type { ChartSpec, SelectionChangeListener, SelectionStore } from "graphein";

import { cn } from "@/lib/utils";

import { accentEdgeStyle, cardClass, type CardVariant } from "./card-style";
import { Chart } from "./Chart";
import {
    DEFAULT_ASPECT,
    MAX_CHART_HEIGHT,
    MIN_CHART_HEIGHT,
    TileBody,
} from "./states";

/** Props shared by every card shell (title, header slot, query state). */
export interface ChartCardCommonProps {
    /** Small mono kicker above the title (e.g. a metric family or unit). */
    eyebrow?: ReactNode;
    /** Card title (rendered in the display font). */
    title?: ReactNode;
    /** Optional one-line subtitle under the title. */
    subtitle?: ReactNode;
    /** Right-aligned header slot — filters, a legend, a menu, etc. */
    action?: ReactNode;
    /** Flat surface treatment (default `"surface"`). Use `"feature"` for a hero tile. */
    variant?: CardVariant;
    /** Thin accent spine on the left edge — a chart token, role, `var(--…)`, or hex. */
    accent?: string;
    className?: string;
    /** Render the loading skeleton. */
    loading?: boolean;
    /** Render the error tile when set (non-null). */
    error?: unknown;
    /** Message for the empty (no-rows) state. */
    emptyMessage?: ReactNode;
    /** Retry handler shown on the error tile. */
    onRetry?: () => void;
}

export interface ChartCardProps extends ChartCardCommonProps {
    /**
     * The Graphein chart spec to render — the common case. Author one JSON object
     * (see the `visuals` skill / Graphein spec reference) and pass it here; the card
     * owns the loading / empty / error states and bridges the app theme.
     */
    spec?: ChartSpec;
    /** Fixed body height in px. Omit for responsive aspect-based height. */
    height?: number;
    /** Force the empty state (defaults to detecting an empty `spec.data`). */
    isEmpty?: boolean;
    /**
     * Shared selection bus (Graphein). Pass the same store to several cards (via
     * `SelectionStoreProvider` / `useSelectionStore`) so clicking a mark in one
     * cross-highlights / cross-filters the others. Only meaningful in spec mode.
     */
    store?: SelectionStore;
    /** Fired whenever a selection this card's chart publishes or consumes changes. */
    onSelectionChange?: SelectionChangeListener;
    /** Optional footer (separated by a hairline rule). */
    footer?: ReactNode;
    /** Extra classes for the body wrapper. */
    bodyClassName?: string;
    /** Arbitrary content (escape hatch) when not using `spec`. */
    children?: ReactNode;
}

const RESPONSIVE_BODY_STYLE: CSSProperties = {
    aspectRatio: String(DEFAULT_ASPECT),
    minHeight: MIN_CHART_HEIGHT,
    maxHeight: MAX_CHART_HEIGHT,
};

/** Default body height (px) for virtualized `table` / `matrix` specs. */
const DEFAULT_TABLE_HEIGHT = 360;

/** True when a spec is a virtualized tabular view that owns its own scroll. */
function specIsTabular(spec: ChartSpec): boolean {
    return spec.type === "table" || spec.type === "matrix";
}

/** True when a spec carries an explicitly empty `data` array. */
function specIsEmpty(spec: ChartSpec): boolean {
    const data = (spec as { data?: unknown }).data;
    return Array.isArray(data) && data.length === 0;
}

/**
 * Titled card shell around a chart or content. Provides the kit's signature
 * look — rounded-2xl, hairline border, no shadow, generous padding.
 *
 * Two modes:
 *  - **Spec mode** (the common case): pass `spec` (+ `loading` / `error` /
 *    `data`-driven empty). The card renders a Graphein `<Chart>` and the matching
 *    state tile for you. A `table` / `matrix` spec is auto-sized to a fixed,
 *    scrollable height; everything else uses a responsive aspect ratio.
 *  - **Children mode**: pass arbitrary `children` and own the body yourself.
 *
 * @example
 * ```tsx
 * <ChartCard
 *   title="Revenue"
 *   subtitle="Last 12 months"
 *   loading={isLoading}
 *   error={error}
 *   spec={{
 *     type: "line",
 *     data: toChartData(data),
 *     encoding: { x: { field: "month", type: "temporal" }, y: { field: "revenue" } },
 *   }}
 * />
 * ```
 */
export function ChartCard({
    eyebrow,
    title,
    subtitle,
    action,
    variant,
    accent,
    footer,
    className,
    bodyClassName,
    spec,
    height,
    loading,
    error,
    isEmpty,
    store,
    onSelectionChange,
    emptyMessage,
    onRetry,
    children,
}: ChartCardProps) {
    const hasHeader =
        eyebrow != null || title != null || subtitle != null || action != null;
    const empty = isEmpty ?? (spec != null && specIsEmpty(spec));
    const tabular = spec != null && specIsTabular(spec);
    // Virtualized table/matrix specs need a fixed, scrollable host — fall back to
    // a sensible height instead of the chart aspect ratio when none is given.
    const effectiveHeight = height ?? (tabular ? DEFAULT_TABLE_HEIGHT : undefined);
    const bodyStyle =
        effectiveHeight != null ? { height: effectiveHeight } : RESPONSIVE_BODY_STYLE;

    return (
        <section
            className={cn(
                "flex min-w-0 flex-col gap-4",
                cardClass(variant, className),
            )}
            style={accentEdgeStyle(accent)}
        >
            {hasHeader && (
                <header className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        {eyebrow != null && (
                            <span className="block truncate font-mono text-[11px] uppercase tracking-[0.18em] text-primary-strong">
                                {eyebrow}
                            </span>
                        )}
                        {title != null && (
                            <h3 className="truncate font-display text-[15px] font-semibold tracking-tight text-foreground">
                                {title}
                            </h3>
                        )}
                        {subtitle != null && (
                            <p className="mt-0.5 truncate text-xs text-muted-foreground">
                                {subtitle}
                            </p>
                        )}
                    </div>
                    {action != null && <div className="shrink-0">{action}</div>}
                </header>
            )}
            <div className={cn("min-w-0", bodyClassName)}>
                {spec != null ? (
                    <TileBody
                        loading={loading}
                        error={error}
                        isEmpty={empty}
                        height={effectiveHeight}
                        emptyMessage={emptyMessage}
                        onRetry={onRetry}
                    >
                        {tabular ? (
                            <div
                                className="overflow-hidden rounded-xl border border-border"
                                style={bodyStyle}
                            >
                                <Chart
                                    spec={spec}
                                    store={store}
                                    onSelectionChange={onSelectionChange}
                                />
                            </div>
                        ) : (
                            // A `position:relative` box of definite width with an
                            // `absolute inset-0` chart mount. This forces the chart to
                            // measure the container's WIDTH (never derive width from the
                            // aspect-ratio + min-height, which overflows narrow tiles).
                            <div
                                className="relative w-full overflow-hidden"
                                style={bodyStyle}
                            >
                                <div className="absolute inset-0">
                                    <Chart
                                        spec={spec}
                                        store={store}
                                        onSelectionChange={onSelectionChange}
                                    />
                                </div>
                            </div>
                        )}
                    </TileBody>
                ) : (
                    children
                )}
            </div>
            {footer != null && (
                <footer className="border-t border-border pt-3 text-xs text-muted-foreground">
                    {footer}
                </footer>
            )}
        </section>
    );
}
