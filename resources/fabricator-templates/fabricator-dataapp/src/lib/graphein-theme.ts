//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useEffect, useState } from "react";

import type { ThemeColors, ThemeInput } from "graphein";

/**
 * Bridge from the app's CSS design tokens to a Graphein `ThemeInput`.
 *
 * Graphein paints to a `<canvas>`, which cannot resolve CSS `var(...)` — so we
 * read the concrete `--color-*` values via `getComputedStyle` and hand Graphein
 * a fully resolved palette. This keeps every chart on-brand and dark-mode aware
 * without the agent ever touching a color: restyle by editing `src/global.css`
 * tokens, not by hardcoding hex in a spec.
 *
 * The map below is the single source of truth for which token feeds which
 * Graphein color role. All tokens are hex / rgba (never `oklch`) so Graphein's
 * color parser can derive ramps, area fills, and hover tints from them.
 */

const PALETTE_VARS = [
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

/** Graphein-default fallback used before styles resolve (SSR / first paint). */
const FALLBACK_COLORS: ThemeColors = {
    background: "#111a2e",
    surface: "#16223c",
    text: "#f1f5f9",
    textMuted: "#94a3b8",
    axis: "#334155",
    grid: "#1c2740",
    border: "#1e293b",
    accent: "#2dd4bf",
    palette: [
        "#3b82f6",
        "#14b8a6",
        "#f59e0b",
        "#ef4444",
        "#8b5cf6",
        "#ec4899",
        "#10b981",
        "#f97316",
        "#6366f1",
        "#84cc16",
    ],
    positive: "#22c55e",
    negative: "#f87171",
};

function resolveColors(styles: CSSStyleDeclaration): ThemeColors {
    const get = (name: string): string | undefined =>
        styles.getPropertyValue(name).trim() || undefined;
    const palette = PALETTE_VARS.map((v) =>
        styles.getPropertyValue(v).trim(),
    ).filter(Boolean);

    return {
        background: get("--color-card") ?? FALLBACK_COLORS.background,
        surface: get("--color-popover") ?? FALLBACK_COLORS.surface,
        text: get("--color-foreground") ?? FALLBACK_COLORS.text,
        textMuted:
            get("--color-foreground-secondary") ?? FALLBACK_COLORS.textMuted,
        axis: get("--color-chart-axis") ?? FALLBACK_COLORS.axis,
        grid: get("--color-chart-grid") ?? FALLBACK_COLORS.grid,
        border: get("--color-border") ?? FALLBACK_COLORS.border,
        accent: get("--color-primary") ?? FALLBACK_COLORS.accent,
        palette: palette.length ? palette : FALLBACK_COLORS.palette,
        positive: get("--color-success") ?? FALLBACK_COLORS.positive,
        negative: get("--color-destructive") ?? FALLBACK_COLORS.negative,
    };
}

/** Read the current Graphein theme from the live CSS tokens (non-reactive). */
export function readGrapheinTheme(): ThemeInput {
    if (typeof window === "undefined" || typeof document === "undefined") {
        return { base: "dark", color: FALLBACK_COLORS };
    }
    const root = document.documentElement;
    return {
        base: root.classList.contains("dark") ? "dark" : "light",
        color: resolveColors(window.getComputedStyle(root)),
    };
}

/**
 * Reactive Graphein theme: resolves the CSS tokens into a Graphein `ThemeInput`
 * and re-resolves whenever the `.dark` class on `<html>` flips, so charts
 * re-theme with the rest of the app. `Chart` injects this automatically — most
 * code never calls it directly.
 */
export function useGrapheinTheme(): ThemeInput {
    const [theme, setTheme] = useState<ThemeInput>(readGrapheinTheme);
    useEffect(() => {
        if (typeof window === "undefined") return;
        const observer = new MutationObserver(() =>
            setTheme(readGrapheinTheme()),
        );
        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["class", "data-appearance"],
        });
        return () => observer.disconnect();
    }, []);
    return theme;
}
