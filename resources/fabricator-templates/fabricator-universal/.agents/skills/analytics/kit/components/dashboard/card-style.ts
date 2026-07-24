//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { CSSProperties } from "react";

import { resolveColor } from "@/lib/chartTokens";
import { cn } from "@/lib/utils";

/**
 * Shared card surface styling — the single source of truth for the kit's tile
 * look so `Card`, `ChartCard`, and `KpiCard` stay visually consistent.
 *
 * Hierarchy is **flat + editorial**: a bone canvas, white cards, a hairline
 * border, and an optional accent top-rule for the hero tile. No drop shadows.
 */
export type CardVariant = "surface" | "feature" | "outline" | "ghost";

const VARIANT_CLASS: Record<CardVariant, string> = {
    /** Default tile — card surface + hairline border. */
    surface: "border border-border bg-card p-5",
    /** Emphasized tile — stronger border + raised surface for the hero. */
    feature: "border border-border-strong bg-surface-1 p-5",
    /** Quiet tile — outline only, transparent fill. */
    outline: "border border-border bg-transparent p-5",
    /** Frameless — no border/fill/padding, for embedding inside a band. */
    ghost: "border border-transparent bg-transparent p-0",
};

/** Tailwind classes for a card surface of the given `variant`. */
export function cardClass(variant: CardVariant = "surface", className?: string) {
    return cn("relative overflow-hidden rounded-2xl", VARIANT_CLASS[variant], className);
}

/**
 * Inline style for an optional accent top-rule on a card — marks the hero /
 * primary tile without the dated left spine. `accent` is any chart token,
 * role, `var(--…)`, or hex (resolved via `resolveColor`).
 */
export function accentEdgeStyle(accent?: string): CSSProperties | undefined {
    return accent
        ? { borderTopWidth: 2, borderTopColor: resolveColor(accent) }
        : undefined;
}
