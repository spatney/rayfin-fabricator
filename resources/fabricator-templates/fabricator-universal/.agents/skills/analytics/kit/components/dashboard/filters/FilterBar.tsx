//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { JSX, ReactNode } from "react";

import type { FilterSelection } from "@/components/dashboard/filters/filter-state";
import { useFilterState } from "@/components/dashboard/filters/filter-state";
import { fieldShortName } from "@/lib/filter-field";
import { cn } from "@/lib/utils";

/**
 * Props for the dashboard filter toolbar.
 *
 * @example
 * ```tsx
 * <FilterBar>
 *   <DropdownSlicer label="Region" field="Sales[Region]" options={regions} />
 * </FilterBar>
 * ```
 */
export interface FilterBarProps {
    /** The slicer controls. */
    children?: ReactNode;
    /** Hide the active-filter summary chips (default false = shown). */
    hideSummary?: boolean;
    className?: string;
}

function XIcon(): JSX.Element {
    return (
        <svg
            width={12}
            height={12}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
        >
            <path d="M18 6 6 18M6 6l12 12" />
        </svg>
    );
}

function formatValue(value: string | number | null): string {
    if (value == null) return "Any";
    if (typeof value === "number") {
        return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
    }
    return value;
}

function formatDateValue(value: number | null): string {
    if (value == null) return "Any";
    return new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
    }).format(new Date(value));
}

function describeSelection(selection: FilterSelection): string {
    const field = fieldShortName(selection.field);
    switch (selection.kind) {
        case "in": {
            const [first, second, ...rest] = selection.values;
            const shown = [first, second].filter((value) => value != null).map(String);
            const suffix = rest.length > 0 ? ` (+${rest.length})` : "";
            return `${field}: ${shown.join(", ")}${suffix}`;
        }
        case "range": {
            const min =
                selection.dataType === "date"
                    ? formatDateValue(selection.min)
                    : formatValue(selection.min);
            const max =
                selection.dataType === "date"
                    ? formatDateValue(selection.max)
                    : formatValue(selection.max);
            return `${field}: ${min}–${max}`;
        }
        case "contains":
            return `${field}: "${selection.text}"`;
    }
}

/**
 * Wrapping slicer toolbar with optional active-filter summary chips.
 *
 * @example
 * ```tsx
 * <FilterBar>
 *   <SearchSlicer field="Customer[Name]" />
 *   <DateRangeSlicer field="Sales[Order Date]" />
 * </FilterBar>
 * ```
 */
export function FilterBar({
    children,
    hideSummary = false,
    className,
}: FilterBarProps): JSX.Element {
    const filters = useFilterState();
    const selections = Object.values(filters.selections);

    return (
        <div className={cn("flex flex-col gap-2", className)}>
            <div className="flex flex-wrap items-center gap-2">{children}</div>
            {!hideSummary && filters.isActive && (
                <div className="flex flex-wrap items-center gap-2">
                    {selections.map((selection) => (
                        <span
                            key={selection.field}
                            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2.5 py-1 text-xs font-medium text-foreground-secondary"
                        >
                            <span>{describeSelection(selection)}</span>
                            <button
                                type="button"
                                aria-label={`Clear ${fieldShortName(selection.field)} filter`}
                                onClick={() => filters.clearFilter(selection.field)}
                                className="rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                            >
                                <XIcon />
                            </button>
                        </span>
                    ))}
                    <button
                        type="button"
                        onClick={filters.clearAll}
                        className="rounded-full border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                        Clear all
                    </button>
                </div>
            )}
        </div>
    );
}
