//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/**
 * Chart color tokens.
 *
 * Every color resolves from the `--color-*` CSS custom properties in
 * `src/global.css`, so colors re-theme automatically when the `.dark` class
 * flips on `<html>`. Use these helpers (`seriesColor(0)`, `roleColor("success")`,
 * `resolveColor("chart-1")`) for the small surfaces the app still styles itself
 * (KPI accents, sparklines). Graphein charts are themed separately via
 * `lib/graphein-theme.ts`, which bridges the same tokens into the Graphein runtime.
 */

/** Ordered chart series palette (CSS variable names, without `var()`). */
export const CHART_SERIES_VARS = [
    "--color-chart-1",
    "--color-chart-2",
    "--color-chart-3",
    "--color-chart-4",
    "--color-chart-5",
    "--color-chart-6",
    "--color-chart-7",
    "--color-chart-8",
    "--color-chart-9",
    "--color-chart-10",
] as const;

/** Semantic chart roles → CSS variable name (without `var()`). */
export type ChartRole =
    | "brand"
    | "success"
    | "danger"
    | "warning"
    | "info"
    | "neutral";

const ROLE_VARS: Record<ChartRole, string> = {
    brand: "--color-primary",
    success: "--color-success",
    danger: "--color-destructive",
    warning: "--color-warning",
    info: "--color-info",
    neutral: "--color-chart-2",
};

/** Wrap a CSS variable name in `var(...)` for inline-style / SVG props. */
export function cssVar(name: string): string {
    return `var(${name})`;
}

/** Color for the Nth series, cycling through the chart palette. */
export function seriesColor(index: number): string {
    const len = CHART_SERIES_VARS.length;
    return cssVar(CHART_SERIES_VARS[((index % len) + len) % len]);
}

/** Color for a semantic role (brand / success / danger / …). */
export function roleColor(role: ChartRole): string {
    return cssVar(ROLE_VARS[role]);
}

/**
 * Resolve a caller-supplied color token into a usable CSS color string.
 * Accepts a raw CSS color or `var(...)`, a `--color-*` variable name, a
 * `chart-1`..`chart-10` shorthand, or a {@link ChartRole}. Falls back to the
 * Nth series color when nothing is supplied.
 */
export function resolveColor(input?: string, fallbackIndex = 0): string {
    if (!input) return seriesColor(fallbackIndex);
    if (input.startsWith("var(") || input.startsWith("#") || input.includes("("))
        return input;
    if (input.startsWith("--")) return cssVar(input);
    if (/^chart-(?:[1-9]|10)$/.test(input)) return cssVar(`--color-${input}`);
    if (input in ROLE_VARS) return roleColor(input as ChartRole);
    return input;
}
