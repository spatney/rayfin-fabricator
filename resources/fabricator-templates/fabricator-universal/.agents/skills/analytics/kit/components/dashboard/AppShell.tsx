//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/* ============================== AppShell =============================== *
 * The page frame. One flexible shell with an editorial masthead (eyebrow +
 * title + actions), an optional toolbar row (filters / segmented controls on
 * their own line), and an optional left context/filter rail. `PageShell` and
 * `SidebarShell` are thin presets over it.
 *
 * Flat by design: a hairline border + a thin accent rule, no shadows. All
 * styling references design tokens from `global.css` (never raw hex/px/fonts).
 * ====================================================================== */

export interface AppShellProps {
    /** Small mono kicker above the title (e.g. a workspace / section name). */
    eyebrow?: ReactNode;
    /** Dashboard title (rendered in the display font). */
    title?: ReactNode;
    /** One-line subtitle under the title. */
    subtitle?: ReactNode;
    /** Right side of the masthead — e.g. `<ThemeToggle />`, a primary action. */
    actions?: ReactNode;
    /**
     * Second masthead row for filters / segmented controls — kept on its own
     * line so the title row stays clean. Typically a `FilterBar` or
     * `SegmentedControl`.
     */
    toolbar?: ReactNode;
    /**
     * Optional left context/filter rail (sticky on `lg+`, stacks above the
     * content on small screens). Fill it with a brand block, slicers, or a
     * `FilterBar`. Omit for a single-column layout.
     */
    rail?: ReactNode;
    children: ReactNode;
    className?: string;
    /** Max content-width utility for the main column (default `"max-w-7xl"`). */
    maxWidth?: string;
    /** Stick the masthead to the top on scroll (default `true`). */
    sticky?: boolean;
    /** Thin brand accent rule along the top of the masthead (default `true`). */
    accent?: boolean;
}

interface MastheadProps
    extends Pick<
        AppShellProps,
        | "eyebrow"
        | "title"
        | "subtitle"
        | "actions"
        | "toolbar"
        | "sticky"
        | "accent"
        | "maxWidth"
    > {
    /** Center the masthead content with the main column (no-rail layouts). */
    centered: boolean;
}

function Masthead({
    eyebrow,
    title,
    subtitle,
    actions,
    toolbar,
    sticky = true,
    accent = true,
    maxWidth = "max-w-7xl",
    centered,
}: MastheadProps) {
    const hasTitleRow =
        eyebrow != null || title != null || subtitle != null || actions != null;
    if (!hasTitleRow && toolbar == null) return null;

    return (
        <header
            className={cn(
                "z-20 border-b border-border bg-background/80 backdrop-blur",
                accent && "border-t-2 border-t-primary",
                sticky && "sticky top-0",
            )}
        >
            <div
                className={cn(
                    "flex flex-col gap-3 px-6 py-4",
                    centered && "mx-auto",
                    centered && maxWidth,
                )}
            >
                {hasTitleRow && (
                    <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                            {eyebrow != null && (
                                <span className="block truncate font-mono text-[11px] uppercase tracking-[0.18em] text-primary-strong">
                                    {eyebrow}
                                </span>
                            )}
                            {title != null && (
                                <h1 className="truncate font-display text-[26px] font-bold leading-tight tracking-tight text-foreground">
                                    {title}
                                </h1>
                            )}
                            {subtitle != null && (
                                <p className="truncate text-sm text-muted-foreground">
                                    {subtitle}
                                </p>
                            )}
                        </div>
                        {actions != null && (
                            <div className="flex shrink-0 items-center gap-2">
                                {actions}
                            </div>
                        )}
                    </div>
                )}
                {toolbar != null && (
                    <div className="flex flex-wrap items-center gap-2">
                        {toolbar}
                    </div>
                )}
            </div>
        </header>
    );
}

/**
 * Flexible full-page dashboard frame: an editorial masthead (eyebrow / title /
 * subtitle / actions) over a centered, max-width content column, with an
 * optional `toolbar` row and an optional left `rail`. Compose `DashboardGrid`,
 * `Tile`, `StatStrip`, and `Section` inside it.
 *
 * Prefer the presets for the common cases: {@link PageShell} (single column)
 * and {@link SidebarShell} (with a filter/context rail).
 *
 * @example
 * ```tsx
 * <AppShell
 *   eyebrow="Sales"
 *   title="Revenue overview"
 *   subtitle="FY24"
 *   actions={<ThemeToggle />}
 *   toolbar={<SegmentedControl value={range} onChange={setRange} options={ranges} />}
 * >
 *   <StatStrip>{stats}</StatStrip>
 *   <DashboardGrid>{tiles}</DashboardGrid>
 * </AppShell>
 * ```
 */
export function AppShell({
    eyebrow,
    title,
    subtitle,
    actions,
    toolbar,
    rail,
    children,
    className,
    maxWidth = "max-w-7xl",
    sticky = true,
    accent = true,
}: AppShellProps) {
    const masthead = (
        <Masthead
            eyebrow={eyebrow}
            title={title}
            subtitle={subtitle}
            actions={actions}
            toolbar={toolbar}
            sticky={sticky}
            accent={accent}
            maxWidth={maxWidth}
            centered={rail == null}
        />
    );

    const main = (
        <main
            className={cn(
                "flex flex-col gap-6 px-6 py-6",
                rail == null && "mx-auto",
                rail == null && maxWidth,
                className,
            )}
        >
            {children}
        </main>
    );

    if (rail == null) {
        return (
            <div className="min-h-screen bg-background text-foreground">
                {masthead}
                {main}
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-background text-foreground lg:grid lg:grid-cols-[16rem_minmax(0,1fr)]">
            <aside
                className={cn(
                    "border-b border-border bg-surface-1 lg:sticky lg:top-0 lg:h-screen lg:overflow-y-auto lg:border-b-0 lg:border-r",
                    accent && "border-t-2 border-t-primary lg:border-t-0",
                )}
            >
                <div className="flex flex-col gap-4 px-5 py-5">{rail}</div>
            </aside>
            <div className="min-w-0">
                {masthead}
                {main}
            </div>
        </div>
    );
}

/* ============================== Presets ================================ */

export interface PageShellProps {
    /** Small mono kicker above the title. */
    eyebrow?: ReactNode;
    /** Dashboard title (rendered in the display font). */
    title?: ReactNode;
    /** One-line subtitle under the title. */
    subtitle?: ReactNode;
    /** Right side of the sticky header — e.g. `<ThemeToggle />`, filters. */
    actions?: ReactNode;
    /** Optional second masthead row for filters / segmented controls. */
    toolbar?: ReactNode;
    children: ReactNode;
    className?: string;
    /** Max content width utility (default `"max-w-7xl"`). */
    maxWidth?: string;
}

/**
 * Single-column dashboard frame (the default): a sticky, blurred masthead over
 * a centered, max-width content column. The most common starting point — drop
 * a `StatStrip` and a `DashboardGrid` inside.
 *
 * @example
 * ```tsx
 * <PageShell title="Sales overview" subtitle="FY24" actions={<ThemeToggle />}>
 *   <StatStrip>{stats}</StatStrip>
 *   <DashboardGrid>
 *     <Tile size="hero"><ChartCard title="Revenue" spec={lineSpec} /></Tile>
 *     <Tile size="md"><ChartCard title="By region" spec={barSpec} /></Tile>
 *     <Tile size="md"><ChartCard title="Mix" spec={pieSpec} /></Tile>
 *   </DashboardGrid>
 * </PageShell>
 * ```
 */
export function PageShell({
    eyebrow,
    title,
    subtitle,
    actions,
    toolbar,
    children,
    className,
    maxWidth = "max-w-7xl",
}: PageShellProps) {
    return (
        <AppShell
            eyebrow={eyebrow}
            title={title}
            subtitle={subtitle}
            actions={actions}
            toolbar={toolbar}
            className={className}
            maxWidth={maxWidth}
        >
            {children}
        </AppShell>
    );
}

export interface SidebarShellProps extends PageShellProps {
    /** Left context/filter rail — a brand block, slicers, or a `FilterBar`. */
    rail: ReactNode;
}

/**
 * Two-column dashboard frame: a persistent left context/filter rail beside the
 * main content. Reach for it on filter-heavy analytics where slicers deserve a
 * permanent home. The rail stacks above the content on small screens.
 *
 * @example
 * ```tsx
 * <SidebarShell
 *   title="Operations"
 *   actions={<ThemeToggle />}
 *   rail={
 *     <FilterStateProvider fields={fields}>
 *       <DropdownSlicer field="Region" options={regions} />
 *       <DateRangeSlicer field="Date" />
 *     </FilterStateProvider>
 *   }
 * >
 *   <DashboardGrid>{tiles}</DashboardGrid>
 * </SidebarShell>
 * ```
 */
export function SidebarShell({ rail, ...props }: SidebarShellProps) {
    return <AppShell rail={rail} {...props} />;
}

/* =============================== Section ============================== */

export interface SectionProps {
    title?: ReactNode;
    subtitle?: ReactNode;
    /** Right-aligned slot (filters, a link). */
    action?: ReactNode;
    children: ReactNode;
    className?: string;
}

/** Titled grouping of dashboard content with an optional action slot. */
export function Section({
    title,
    subtitle,
    action,
    children,
    className,
}: SectionProps) {
    const hasHeader = title != null || subtitle != null || action != null;
    return (
        <section className={cn("flex flex-col gap-4", className)}>
            {hasHeader && (
                <div className="flex items-end justify-between gap-3">
                    <div className="min-w-0">
                        {title != null && (
                            <h2 className="font-display text-base font-semibold tracking-tight text-foreground">
                                {title}
                            </h2>
                        )}
                        {subtitle != null && (
                            <p className="text-sm text-muted-foreground">
                                {subtitle}
                            </p>
                        )}
                    </div>
                    {action != null && <div className="shrink-0">{action}</div>}
                </div>
            )}
            {children}
        </section>
    );
}
