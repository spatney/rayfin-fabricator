//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/**
 * Display formatters shared across the dashboard kit. All are pure,
 * dependency-free, and null/NaN-safe (non-finite input renders as an em dash).
 */

const DASH = "\u2014";

/**
 * Format a number for display: compact (K/M/B/T) for large magnitudes,
 * grouped locale string otherwise. Pass `unit` to append a suffix (e.g. "CU").
 */
export function formatNumber(
    value: number,
    options?: { unit?: string; compact?: boolean },
): string {
    if (!Number.isFinite(value)) return DASH;
    const { unit, compact } = options ?? {};
    const out =
        compact || Math.abs(value) >= 10_000
            ? formatCompact(value)
            : value.toLocaleString();
    return unit ? `${out} ${unit}` : out;
}

/**
 * Compact magnitude formatter — scales into K / M / B / T so large numbers
 * stay legible (e.g. 2.21e14 → "221.0T"). Values under 1000 read exact.
 */
export function formatCompact(value: number, decimals = 1): string {
    if (!Number.isFinite(value)) return DASH;
    const abs = Math.abs(value);
    const sign = value < 0 ? "-" : "";
    if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(decimals)}T`;
    if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(decimals)}B`;
    if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(decimals)}M`;
    if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(decimals)}K`;
    return value.toLocaleString();
}

/**
 * Format a percentage value (already on a 0–100 scale). Pass `signed` for a
 * leading `+` on positives — useful for trend deltas.
 */
export function formatPercent(
    value: number,
    options?: { fractionDigits?: number; signed?: boolean },
): string {
    if (!Number.isFinite(value)) return DASH;
    const { fractionDigits = 1, signed = false } = options ?? {};
    const sign = signed && value > 0 ? "+" : "";
    return `${sign}${value.toFixed(fractionDigits)}%`;
}

/** Signed percent delta for KPI cards (e.g. `+12.4%`, `-3.1%`). */
export function formatDelta(value: number, fractionDigits = 1): string {
    return formatPercent(value, { fractionDigits, signed: true });
}

/** Format a value as a ratio (0–1) into a percentage string (e.g. 0.42 → "42%"). */
export function formatRatio(value: number, fractionDigits = 0): string {
    if (!Number.isFinite(value)) return DASH;
    return formatPercent(value * 100, { fractionDigits });
}

/** Format a currency amount (defaults to USD). */
export function formatCurrency(
    value: number,
    currency = "USD",
    options?: Intl.NumberFormatOptions,
): string {
    if (!Number.isFinite(value)) return DASH;
    return value.toLocaleString("en-US", {
        style: "currency",
        currency,
        maximumFractionDigits: 2,
        ...options,
    });
}

/** Format a date/timestamp for axis ticks and labels. */
export function formatDate(
    value: string | number | Date,
    style: "short" | "medium" | "long" = "medium",
): string {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const options: Intl.DateTimeFormatOptions =
        style === "short"
            ? { month: "short", day: "numeric" }
            : style === "long"
              ? { year: "numeric", month: "long", day: "numeric" }
              : { year: "numeric", month: "short", day: "numeric" };
    return date.toLocaleDateString("en-US", options);
}

/** Declarative value-format spec accepted by the kit's chart components. */
export type ValueFormat =
    | "number"
    | "compact"
    | "currency"
    | "percent"
    | "ratio"
    | ((value: number) => string);

/** Resolve a {@link ValueFormat} into a concrete formatter function. */
export function resolveFormat(format?: ValueFormat): (value: number) => string {
    if (typeof format === "function") return format;
    switch (format) {
        case "compact":
            return (value) => formatCompact(value);
        case "currency":
            return (value) => formatCurrency(value);
        case "percent":
            return (value) => formatPercent(value);
        case "ratio":
            return (value) => formatRatio(value);
        case "number":
        default:
            return (value) => formatNumber(value);
    }
}
