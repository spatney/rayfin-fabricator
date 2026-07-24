//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { CSSProperties, ReactNode } from "react";

import { cn } from "@/lib/utils";

import { AlertTriangleIcon, InboxIcon } from "./icons";

/** Default width:height ratio for responsive chart bodies. */
export const DEFAULT_ASPECT = 2.2;
/** Lower clamp (px) for responsive chart bodies. */
export const MIN_CHART_HEIGHT = 200;
/** Upper clamp (px) for responsive chart bodies. */
export const MAX_CHART_HEIGHT = 360;

const RESPONSIVE_CHART_STATE_STYLE: CSSProperties = {
    aspectRatio: String(DEFAULT_ASPECT),
    minHeight: MIN_CHART_HEIGHT,
    maxHeight: MAX_CHART_HEIGHT,
};

/** Returns fixed or responsive sizing for chart skeleton placeholders. */
function getChartSkeletonStyle(height?: number): CSSProperties {
    return height != null ? { height } : RESPONSIVE_CHART_STATE_STYLE;
}

/** Returns fixed or responsive sizing for centered chart state tiles. */
function getChartStateTileStyle(height?: number): CSSProperties {
    return height != null ? { minHeight: height } : RESPONSIVE_CHART_STATE_STYLE;
}

/* ------------------------------- Skeletons ------------------------------- */

export interface ChartSkeletonProps {
    height?: number;
    className?: string;
}

/** Shimmering faux-bar placeholder shown while a chart's data loads. */
export function ChartSkeleton({
    height,
    className,
}: ChartSkeletonProps) {
    const sizeStyle = getChartSkeletonStyle(height);

    return (
        <div
            className={cn("flex items-end gap-2", className)}
            style={sizeStyle}
            aria-hidden
        >
            {[62, 84, 48, 96, 70, 58, 88, 52].map((h, i) => (
                <div
                    key={i}
                    className="flex-1 animate-shimmer rounded-md"
                    style={{ height: `${h}%` }}
                />
            ))}
        </div>
    );
}

/** Card-shaped shimmer placeholder for a KPI tile. */
export function KpiSkeleton({ className }: { className?: string }) {
    return (
        <div
            className={cn(
                "flex flex-col gap-3 rounded-2xl border border-border bg-card p-5",
                className,
            )}
            aria-hidden
        >
            <div className="h-3 w-24 animate-shimmer rounded-full" />
            <div className="h-8 w-32 animate-shimmer rounded-md" />
            <div className="h-3 w-20 animate-shimmer rounded-full" />
        </div>
    );
}

/* -------------------------------- Tiles --------------------------------- */

export interface EmptyTileProps {
    message?: ReactNode;
    icon?: ReactNode;
    height?: number;
    className?: string;
}

/** Friendly "no data" state for a chart/table body. */
export function EmptyTile({
    message = "No data to display",
    icon,
    height,
    className,
}: EmptyTileProps) {
    const sizeStyle = getChartStateTileStyle(height);

    return (
        <div
            className={cn(
                "flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-center",
                className,
            )}
            style={sizeStyle}
        >
            <span className="text-foreground-muted">
                {icon ?? <InboxIcon size={28} />}
            </span>
            <p className="text-sm text-muted-foreground">{message}</p>
        </div>
    );
}

export interface ErrorTileProps {
    error?: unknown;
    title?: ReactNode;
    onRetry?: () => void;
    height?: number;
    className?: string;
}

/** Error state for a chart/table body, with an optional retry action. */
export function ErrorTile({
    error,
    title = "Something went wrong",
    onRetry,
    height,
    className,
}: ErrorTileProps) {
    const sizeStyle = getChartStateTileStyle(height);
    const message =
        error == null
            ? null
            : error instanceof Error
              ? error.message
              : String(error);
    return (
        <div
            className={cn(
                "flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-destructive/40 text-center",
                className,
            )}
            style={sizeStyle}
        >
            <span className="text-destructive">
                <AlertTriangleIcon size={28} />
            </span>
            <p className="text-sm font-medium text-foreground">{title}</p>
            {message && (
                <p className="max-w-xs px-4 text-xs text-muted-foreground">
                    {message}
                </p>
            )}
            {onRetry && (
                <button
                    type="button"
                    onClick={onRetry}
                    className="mt-1 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                >
                    Try again
                </button>
            )}
        </div>
    );
}

/* ------------------------------- Resolver ------------------------------- */

export interface TileBodyProps {
    /** Render the skeleton while truthy. */
    loading?: boolean;
    /** Render the error tile when set (non-null). */
    error?: unknown;
    /** Render the empty tile when true. */
    isEmpty?: boolean;
    height?: number;
    emptyMessage?: ReactNode;
    /** Override the default skeleton (e.g. `<KpiSkeleton />`). */
    skeleton?: ReactNode;
    onRetry?: () => void;
    children: ReactNode;
}

/**
 * Switchboard the chart/table cards use to render the right state:
 * error → loading → empty → content. Lets callers pass raw query state
 * (`loading`, `error`, `isEmpty`) and never hand-write the conditionals.
 */
export function TileBody({
    loading,
    error,
    isEmpty,
    height,
    emptyMessage,
    skeleton,
    onRetry,
    children,
}: TileBodyProps) {
    if (error != null)
        return <ErrorTile error={error} onRetry={onRetry} height={height} />;
    if (loading) return <>{skeleton ?? <ChartSkeleton height={height} />}</>;
    if (isEmpty) return <EmptyTile message={emptyMessage} height={height} />;
    return <>{children}</>;
}
