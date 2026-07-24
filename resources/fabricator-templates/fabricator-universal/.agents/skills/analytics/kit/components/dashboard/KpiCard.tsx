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
import { warnMissingKeys } from "@/lib/validate";

import { AnimatedNumber } from "./AnimatedNumber";
import { cardClass, type CardVariant } from "./card-style";
import { ArrowDownRightIcon, ArrowUpRightIcon } from "./icons";
import { Sparkline } from "./Sparkline";
import { EmptyTile, ErrorTile, KpiSkeleton } from "./states";

export interface KpiCardProps {
    /** Metric name (rendered as a small uppercase label). */
    label: ReactNode;
    /** The metric value — numbers are formatted with `valueFormat`. */
    value?: number | string;
    /** Query rows used to derive the metric when `value` is not provided. */
    data?: Array<Record<string, unknown>>;
    /** Property read from the first row in `data` when deriving the metric. */
    valueKey?: string;
    /** Format applied when `value` is a number (default `"number"`). */
    valueFormat?: ValueFormat;
    /** Optional small, muted value rendered below the primary metric. */
    secondary?: ReactNode;
    /** Percent change vs a baseline; its sign drives the colored pill. */
    delta?: number;
    /** Caption under the value, e.g. "vs last month". */
    deltaLabel?: ReactNode;
    /** Flip delta colors when down-is-good (cost, latency, churn…). */
    invertDelta?: boolean;
    /** Accent dot color — a chart token, role, `var(--…)`, or hex. */
    accent?: string;
    /** Flat surface treatment (default `"surface"`). Use `"feature"` for a hero metric. */
    variant?: CardVariant;
    /** Optional trailing icon. */
    icon?: ReactNode;
    /** Optional small badge by the label. */
    badge?: ReactNode;
    loading?: boolean;
    error?: unknown;
    /** Message for the empty (no value) state. */
    emptyMessage?: ReactNode;
    /** Retry handler shown on the error tile. */
    onRetry?: () => void;
    className?: string;
    /** Inline trend values — renders a `<Sparkline />` under the value and,
     *  when `delta` is omitted, auto-derives the delta from first → last. */
    trend?: ReadonlyArray<number>;
    /** Optional chart slot under the value — typically a `<Sparkline />`.
     *  Overrides `trend` when both are set. */
    children?: ReactNode;
}

/**
 * Hero metric tile: big formatted value, a colored delta pill, optional
 * accent dot / badge / icon, and an optional sparkline slot. Pass raw
 * query state via `loading` / `error` and the card renders the right state.
 *
 * @example
 * ```tsx
 * <KpiCard
 *   label="Revenue"
 *   data={rows}
 *   valueKey="revenue"
 *   valueFormat="currency"
 *   secondary="($1,284,000)"
 *   delta={12.4}
 *   deltaLabel="vs last month"
 *   accent="chart-1"
 * >
 *   <Sparkline data={trend} />
 * </KpiCard>
 * ```
 */
export function KpiCard({
    label,
    value,
    data,
    valueKey,
    valueFormat,
    secondary,
    delta,
    deltaLabel,
    invertDelta,
    accent,
    icon,
    badge,
    loading,
    error,
    emptyMessage,
    onRetry,
    className,
    trend,
    variant,
    children,
}: KpiCardProps) {
    const derived = data && valueKey ? data[0]?.[valueKey] : undefined;
    const metricValue = value ?? derived;
    const isEmpty = value === undefined && (data?.length === 0 || derived == null);
    const format = useMemo(() => resolveFormat(valueFormat), [valueFormat]);

    if (value === undefined && !loading && error == null) {
        // Loud, actionable hint instead of a silently empty tile — the most
        // common KpiCard mistake is a `valueKey` that doesn't match a column
        // (wrong casing, an un-aliased DAX name, or forgetting `toChartData`).
        warnMissingKeys("KpiCard", data, [valueKey]);
    }

    if (loading) return <KpiSkeleton className={className} />;
    if (error != null)
        return (
            <div
                className={cardClass(variant, className)}
            >
                <ErrorTile
                    error={error}
                    title="Couldn't load"
                    height={96}
                    onRetry={onRetry}
                />
            </div>
        );
    if (isEmpty)
        return (
            <div
                className={cardClass(variant, className)}
            >
                <EmptyTile message={emptyMessage} height={96} />
            </div>
        );

    const isNumericValue = typeof metricValue === "number";
    const valueText = isNumericValue
        ? format(metricValue)
        : String(metricValue ?? "");

    // Auto-derive the delta from the trend (first → last) when not supplied.
    const finiteTrend = trend?.filter((n) => Number.isFinite(n)) ?? [];
    const autoDelta =
        delta === undefined && finiteTrend.length >= 2 && finiteTrend[0] !== 0
            ? ((finiteTrend[finiteTrend.length - 1] - finiteTrend[0]) /
                  Math.abs(finiteTrend[0])) *
              100
            : undefined;
    const effectiveDelta = delta ?? autoDelta;

    const showDelta =
        typeof effectiveDelta === "number" && Number.isFinite(effectiveDelta);
    const direction =
        !showDelta || effectiveDelta === 0
            ? "flat"
            : (effectiveDelta as number) > 0
              ? "up"
              : "down";
    const good =
        direction === "flat"
            ? null
            : (direction === "up") !== Boolean(invertDelta);
    const accentColor = accent ? resolveColor(accent) : undefined;

    const sparkline =
        children ??
        (trend && trend.length > 1 ? (
            <Sparkline data={trend} color={accent} height={36} />
        ) : null);

    return (
        <section
            className={cn("flex flex-col gap-3", cardClass(variant, className))}
        >
            <div className="flex items-center justify-between gap-2">
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
                {(icon || badge) && (
                    <div className="flex shrink-0 items-center gap-2 text-foreground-muted">
                        {badge}
                        {icon}
                    </div>
                )}
            </div>

            <div className="flex items-end justify-between gap-3">
                <div className="min-w-0">
                    <span className="block truncate font-display text-[32px] font-bold leading-none tracking-tight text-foreground tabular-nums">
                        {isNumericValue ? (
                            <AnimatedNumber value={metricValue} format={format} />
                        ) : (
                            valueText
                        )}
                    </span>
                    {secondary && (
                        <span className="mt-1 block truncate font-numeric text-sm text-muted-foreground tabular-nums">
                            {secondary}
                        </span>
                    )}
                </div>
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
                        {formatDelta(effectiveDelta as number)}
                    </span>
                )}
            </div>

            {sparkline && <div className="mt-1 -mb-1">{sparkline}</div>}
            {deltaLabel && (
                <p className="text-xs text-muted-foreground">{deltaLabel}</p>
            )}
        </section>
    );
}
