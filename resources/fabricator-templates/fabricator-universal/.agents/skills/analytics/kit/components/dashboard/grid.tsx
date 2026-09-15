//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ReactNode } from "react";
import { useMemo } from "react";

import { resolveColor } from "@/lib/chartTokens";
import { formatDelta, resolveFormat, type ValueFormat } from "@/lib/format";
import { cn } from "@/lib/utils";

import { ArrowDownRightIcon, ArrowUpRightIcon } from "./icons";

/* ============================ DashboardGrid =========================== *
 * The dashboard canvas: one responsive 12-column grid that every tile drops
 * into. Vary tile sizes with `<Tile size="…">` to get an editorial, non-uniform
 * layout — that is the default path, not a special case.
 *
 * Static span class maps below so Tailwind v4's content scanner emits every
 * span utility (it can't see dynamically built class strings).
 * ===================================================================== */

const LG_COL_SPAN: Record<number, string> = {
    1: "lg:col-span-1",
    2: "lg:col-span-2",
    3: "lg:col-span-3",
    4: "lg:col-span-4",
    5: "lg:col-span-5",
    6: "lg:col-span-6",
    7: "lg:col-span-7",
    8: "lg:col-span-8",
    9: "lg:col-span-9",
    10: "lg:col-span-10",
    11: "lg:col-span-11",
    12: "lg:col-span-12",
};

const LG_ROW_SPAN: Record<number, string> = {
    1: "lg:row-span-1",
    2: "lg:row-span-2",
    3: "lg:row-span-3",
};

const SM_COL_SPAN: Record<number, string> = {
    1: "sm:col-span-1",
    2: "sm:col-span-2",
};

/**
 * The dashboard canvas: one responsive 12-column grid (1 col → `sm:2` →
 * `lg:12`). Drop {@link Tile}s inside and vary their `size` for an editorial,
 * non-uniform layout — that varied path is the default, not a special case.
 *
 * @example
 * ```tsx
 * <DashboardGrid>
 *   <Tile size="hero"><ChartCard title="Revenue" className="h-full" spec={lineSpec} /></Tile>
 *   <Tile size="md"><ChartCard title="By region" spec={barSpec} /></Tile>
 *   <Tile size="md"><ChartCard title="Mix" spec={pieSpec} /></Tile>
 * </DashboardGrid>
 * ```
 */
export function DashboardGrid({
    children,
    className,
}: {
    children: ReactNode;
    className?: string;
}) {
    return (
        <div
            className={cn(
                "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-12 lg:auto-rows-[minmax(0,auto)]",
                className,
            )}
        >
            {children}
        </div>
    );
}

/** Semantic tile sizes → column / row spans on the 12-col `lg` grid. */
export type TileSize = "sm" | "md" | "lg" | "wide" | "hero" | "full";

const TILE_SIZES: Record<TileSize, { col: number; row?: number }> = {
    sm: { col: 3 },
    md: { col: 4 },
    lg: { col: 6 },
    wide: { col: 8 },
    hero: { col: 8, row: 2 },
    full: { col: 12 },
};

const clampInt = (n: number, lo: number, hi: number) =>
    Math.min(hi, Math.max(lo, Math.round(n)));

export interface TileProps {
    /**
     * Semantic size preset — the easy way to vary tiles (no span math):
     * `sm` (3) · `md` (4) · `lg` (6) · `wide` (8) · `hero` (8×2) · `full` (12).
     * Mix sizes for an editorial layout instead of a uniform spreadsheet grid.
     */
    size?: TileSize;
    /** Explicit column span (1–12 on `lg`) — overrides `size`. */
    colSpan?: number;
    /** Explicit row span (1–3 on `lg`) for taller tiles — overrides `size`. */
    rowSpan?: number;
    children: ReactNode;
    className?: string;
}

/**
 * A cell in a {@link DashboardGrid}. Pick a `size` preset (or set `colSpan` /
 * `rowSpan`) to span the 12-col grid on `lg`; tiles stack responsively on
 * smaller screens. Add `className="h-full"` to the card inside a `hero` (tall)
 * tile so it fills the extra row.
 *
 * @example
 * ```tsx
 * <DashboardGrid>
 *   <Tile size="hero"><ChartCard title="Revenue" className="h-full" spec={lineSpec} /></Tile>
 *   <Tile size="md"><ChartCard title="By region" spec={barSpec} /></Tile>
 *   <Tile size="md"><ChartCard title="Channel mix" spec={pieSpec} /></Tile>
 *   <Tile size="full"><DataTableCard title="Detail" spec={tableSpec} /></Tile>
 * </DashboardGrid>
 * ```
 */
export function Tile({ size = "md", colSpan, rowSpan, children, className }: TileProps) {
    const preset = TILE_SIZES[size];
    const col = clampInt(colSpan ?? preset.col, 1, 12);
    const row = clampInt(rowSpan ?? preset.row ?? 1, 1, 3);
    const sm = col >= 6 ? 2 : 1;
    return (
        <div
            className={cn(
                "flex min-w-0 flex-col",
                SM_COL_SPAN[sm],
                LG_COL_SPAN[col],
                row > 1 && LG_ROW_SPAN[row],
                className,
            )}
        >
            {children}
        </div>
    );
}

/* ============================== StatStrip ============================= *
 * A single bordered band of metrics divided by hairlines — the editorial
 * alternative to a row of identical KPI boxes. Put `<Stat>` items inside.
 * ===================================================================== */

/**
 * A flat, hairline-divided band of metrics. One card, internal dividers — a
 * distinctive header strip that reads as a single unit instead of four
 * look-alike boxes. Put 2–5 {@link Stat} items inside.
 *
 * @example
 * ```tsx
 * <StatStrip>
 *   <Stat label="Revenue" data={rows} valueKey="revenue" valueFormat="currency" accent="chart-1" delta={12.4} />
 *   <Stat label="Orders" data={rows} valueKey="orders" delta={3.1} />
 *   <Stat label="Avg. order" value={84.2} valueFormat="currency" delta={-1.2} />
 * </StatStrip>
 * ```
 */
export function StatStrip({
    children,
    className,
}: {
    children: ReactNode;
    className?: string;
}) {
    return (
        <div
            className={cn(
                "grid grid-cols-1 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card sm:auto-cols-fr sm:grid-flow-col sm:divide-x sm:divide-y-0",
                className,
            )}
        >
            {children}
        </div>
    );
}

export interface StatProps {
    /** Metric name (small uppercase label). */
    label: ReactNode;
    /** The metric value — numbers are formatted with `valueFormat`. */
    value?: number | string;
    /** Query rows used to derive the metric when `value` is not provided. */
    data?: Array<Record<string, unknown>>;
    /** Property read from the first row in `data` when deriving the metric. */
    valueKey?: string;
    /** Format applied when the value is a number (default `"number"`). */
    valueFormat?: ValueFormat;
    /** Percent change vs a baseline; its sign drives the colored delta. */
    delta?: number;
    /** Flip delta colors when down-is-good (cost, latency, churn…). */
    invertDelta?: boolean;
    /** Small muted caption under the value. */
    secondary?: ReactNode;
    /** Accent dot color — a chart token, role, `var(--…)`, or hex. */
    accent?: string;
    loading?: boolean;
    className?: string;
}

/**
 * A single metric inside a {@link StatStrip}: label, big value, and an optional
 * colored delta. Provide `value`, or `data` + `valueKey` to read the first row.
 */
export function Stat({
    label,
    value,
    data,
    valueKey,
    valueFormat,
    delta,
    invertDelta,
    secondary,
    accent,
    loading,
    className,
}: StatProps) {
    const format = useMemo(() => resolveFormat(valueFormat), [valueFormat]);
    const derived = data && valueKey ? data[0]?.[valueKey] : undefined;
    const metricValue = value ?? derived;

    const showDelta = typeof delta === "number" && Number.isFinite(delta);
    const direction = !showDelta || delta === 0 ? "flat" : delta > 0 ? "up" : "down";
    const good =
        direction === "flat" ? null : (direction === "up") !== Boolean(invertDelta);
    const accentColor = accent ? resolveColor(accent) : undefined;

    const valueText =
        typeof metricValue === "number" ? format(metricValue) : String(metricValue ?? "—");

    return (
        <div className={cn("flex flex-col gap-2 p-5", className)}>
            <div className="flex min-w-0 items-center gap-2">
                {accentColor && (
                    <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ background: accentColor }}
                    />
                )}
                <span className="truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {label}
                </span>
            </div>
            {loading ? (
                <div className="h-7 w-24 animate-shimmer rounded-md" aria-hidden />
            ) : (
                <div className="flex items-end justify-between gap-2">
                    <span className="block truncate font-display text-[26px] font-bold leading-none tracking-tight text-foreground tabular-nums">
                        {valueText}
                    </span>
                    {showDelta && (
                        <span
                            className={cn(
                                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
                                good === null
                                    ? "bg-muted text-muted-foreground"
                                    : good
                                      ? "text-success"
                                      : "text-destructive",
                            )}
                            style={
                                good === null
                                    ? undefined
                                    : {
                                          background: good
                                              ? "var(--color-success-soft)"
                                              : "var(--color-destructive-soft)",
                                      }
                            }
                        >
                            {direction === "up" && <ArrowUpRightIcon size={12} />}
                            {direction === "down" && <ArrowDownRightIcon size={12} />}
                            {formatDelta(delta as number)}
                        </span>
                    )}
                </div>
            )}
            {secondary && (
                <span className="truncate text-xs text-muted-foreground">{secondary}</span>
            )}
        </div>
    );
}

/* ============================== SectionBand =========================== */

export interface SectionBandProps {
    title?: ReactNode;
    subtitle?: ReactNode;
    /** Right-aligned slot (filters, a link). */
    action?: ReactNode;
    children: ReactNode;
    className?: string;
}

/**
 * A grouped "zone" rendered on an alternate surface (`surface-2`) with a
 * hairline border — use it to break a long single-surface column into rhythmic
 * bands (e.g. an overview band, then a detail band). Flat, no shadow.
 *
 * @example
 * ```tsx
 * <SectionBand title="This quarter" subtitle="vs. last">
 *   <DashboardGrid>{tiles}</DashboardGrid>
 * </SectionBand>
 * ```
 */
export function SectionBand({
    title,
    subtitle,
    action,
    children,
    className,
}: SectionBandProps) {
    const hasHeader = title != null || subtitle != null || action != null;
    return (
        <section
            className={cn(
                "flex flex-col gap-4 rounded-2xl border border-border bg-surface-2 p-5 sm:p-6",
                className,
            )}
        >
            {hasHeader && (
                <div className="flex items-end justify-between gap-3">
                    <div className="min-w-0">
                        {title != null && (
                            <h2 className="font-display text-base font-semibold tracking-tight text-foreground">
                                {title}
                            </h2>
                        )}
                        {subtitle != null && (
                            <p className="text-sm text-muted-foreground">{subtitle}</p>
                        )}
                    </div>
                    {action != null && <div className="shrink-0">{action}</div>}
                </div>
            )}
            {children}
        </section>
    );
}

/* ===================== Legacy grids (back-compat) ===================== *
 * Kept so existing code + skill examples keep working. Prefer DashboardGrid +
 * Tile (size presets) and StatStrip for new dashboards.
 * ===================================================================== */

/** @deprecated Prefer {@link StatStrip} (or {@link DashboardGrid} + {@link Tile}). Fluid auto-fit grid for KPI cards. */
export function KpiGrid({
    children,
    className,
}: {
    children: ReactNode;
    className?: string;
}) {
    return (
        <div
            className={cn(
                "grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))]",
                className,
            )}
        >
            {children}
        </div>
    );
}

/** @deprecated Prefer {@link DashboardGrid} + {@link Tile} (vary sizes). Fluid auto-fit grid for chart cards. */
export function ChartGrid({
    children,
    className,
}: {
    children: ReactNode;
    className?: string;
}) {
    return (
        <div
            className={cn(
                "grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(380px,100%),1fr))]",
                className,
            )}
        >
            {children}
        </div>
    );
}

/** @deprecated Alias of {@link DashboardGrid}. */
export function BentoGrid({
    children,
    className,
}: {
    children: ReactNode;
    className?: string;
}) {
    return <DashboardGrid className={className}>{children}</DashboardGrid>;
}

export interface BentoItemProps {
    /** Columns to span on `lg` (1–12, default 4). */
    colSpan?: number;
    /** Rows to span on `lg` (1–3, default 1) for taller tiles. */
    rowSpan?: number;
    children: ReactNode;
    className?: string;
}

/** @deprecated Prefer {@link Tile} with a `size` preset. A cell in a {@link BentoGrid}. */
export function BentoItem({
    colSpan = 4,
    rowSpan = 1,
    children,
    className,
}: BentoItemProps) {
    return (
        <Tile colSpan={colSpan} rowSpan={rowSpan} className={className}>
            {children}
        </Tile>
    );
}
