//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { accentEdgeStyle, cardClass, type CardVariant } from "./card-style";

export type { CardVariant } from "./card-style";

export interface CardProps {
    /** Small mono kicker above the title. */
    eyebrow?: ReactNode;
    title?: ReactNode;
    subtitle?: ReactNode;
    /** Right-aligned header slot. */
    action?: ReactNode;
    /** Flat surface treatment (default `"surface"`). */
    variant?: CardVariant;
    /** Thin accent spine on the left edge — a chart token, role, `var(--…)`, or hex. */
    accent?: string;
    /** Optional footer (separated by a hairline rule). */
    footer?: ReactNode;
    children?: ReactNode;
    className?: string;
}

/**
 * A general flat content tile with the kit's signature look. Use it for custom
 * content that isn't a chart, KPI, or table (chart/KPI/table tiles have their
 * own cards). Pass a `variant` and optional `accent` for hierarchy.
 *
 * @example
 * ```tsx
 * <Card eyebrow="Getting started" title="Connect a model" variant="feature" accent="chart-1">
 *   <p className="text-sm text-muted-foreground">Declare a connection in fabric.yaml…</p>
 * </Card>
 * ```
 */
export function Card({
    eyebrow,
    title,
    subtitle,
    action,
    variant = "surface",
    accent,
    footer,
    children,
    className,
}: CardProps) {
    const hasHeader =
        eyebrow != null || title != null || subtitle != null || action != null;
    return (
        <section
            className={cn("flex min-w-0 flex-col gap-4", cardClass(variant, className))}
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
            {children}
            {footer != null && (
                <footer className="border-t border-border pt-3 text-xs text-muted-foreground">
                    {footer}
                </footer>
            )}
        </section>
    );
}
