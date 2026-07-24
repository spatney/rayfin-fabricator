//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ChangeEvent, JSX, ReactNode } from "react";

import type { FilterField } from "@/components/dashboard/filters/filter-state";
import { useFilterState } from "@/components/dashboard/filters/filter-state";
import { cn } from "@/lib/utils";

interface DateRangeValue {
    min: number | null;
    max: number | null;
}

/**
 * Props for a date range slicer.
 *
 * @example
 * ```tsx
 * <DateRangeSlicer label="Order date" field="Sales[Order Date]" />
 * ```
 */
export interface DateRangeSlicerProps {
    label?: ReactNode;
    field?: FilterField;
    /** Controlled value as epoch-ms (or null for open-ended). */
    value?: DateRangeValue;
    onChange?: (range: DateRangeValue) => void;
    className?: string;
}

function utcDayStart(year: number, month: number, day: number): number {
    return Date.UTC(year, month, day, 0, 0, 0, 0);
}

function utcDayEnd(year: number, month: number, day: number): number {
    return Date.UTC(year, month, day, 23, 59, 59, 999);
}

function dateInputToEpoch(value: string, endOfDay: boolean): number | null {
    if (!value) return null;
    const [year, month, day] = value.split("-").map(Number);
    if (!year || !month || !day) return null;
    return endOfDay
        ? utcDayEnd(year, month - 1, day)
        : utcDayStart(year, month - 1, day);
}

function epochToDateInput(value: number | null): string {
    if (value == null) return "";
    const date = new Date(value);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function todayUtcParts(): { year: number; month: number; day: number } {
    const now = new Date();
    return {
        year: now.getUTCFullYear(),
        month: now.getUTCMonth(),
        day: now.getUTCDate(),
    };
}

function relativePreset(days: number): DateRangeValue {
    const { year, month, day } = todayUtcParts();
    const max = utcDayEnd(year, month, day);
    const min = utcDayStart(year, month, day - (days - 1));
    return { min, max };
}

function monthToDatePreset(): DateRangeValue {
    const { year, month, day } = todayUtcParts();
    return {
        min: utcDayStart(year, month, 1),
        max: utcDayEnd(year, month, day),
    };
}

function yearToDatePreset(): DateRangeValue {
    const { year, month, day } = todayUtcParts();
    return {
        min: utcDayStart(year, 0, 1),
        max: utcDayEnd(year, month, day),
    };
}

/**
 * Date range slicer with from/to inputs and common relative presets.
 *
 * @example
 * ```tsx
 * <DateRangeSlicer
 *   label="Invoice date"
 *   value={range}
 *   onChange={setRange}
 * />
 * ```
 */
export function DateRangeSlicer({
    label,
    field,
    value,
    onChange,
    className,
}: DateRangeSlicerProps): JSX.Element {
    const filters = useFilterState();
    const connectedSelection = field ? filters.getSelection(field) : undefined;
    const range =
        value ??
        (connectedSelection?.kind === "range"
            ? { min: connectedSelection.min, max: connectedSelection.max }
            : { min: null, max: null });
    const setRange = (nextRange: DateRangeValue) => {
        if (value !== undefined || onChange !== undefined) {
            onChange?.(nextRange);
            return;
        }
        if (field) filters.setRange(field, nextRange.min, nextRange.max, "date");
    };
    const presets: Array<{ label: string; range: DateRangeValue }> = [
        { label: "Last 7", range: relativePreset(7) },
        { label: "Last 30", range: relativePreset(30) },
        { label: "Last 90", range: relativePreset(90) },
        { label: "MTD", range: monthToDatePreset() },
        { label: "YTD", range: yearToDatePreset() },
        { label: "All", range: { min: null, max: null } },
    ];

    return (
        <section className={cn("flex flex-col gap-3 text-sm", className)}>
            {label != null && <h3 className="font-medium text-foreground">{label}</h3>}
            <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    From
                    <input
                        type="date"
                        value={epochToDateInput(range.min)}
                        onChange={(event: ChangeEvent<HTMLInputElement>) =>
                            setRange({
                                min: dateInputToEpoch(event.target.value, false),
                                max: range.max,
                            })
                        }
                        className="rounded-lg border border-border bg-card px-2 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
                    />
                </label>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    To
                    <input
                        type="date"
                        value={epochToDateInput(range.max)}
                        onChange={(event: ChangeEvent<HTMLInputElement>) =>
                            setRange({
                                min: range.min,
                                max: dateInputToEpoch(event.target.value, true),
                            })
                        }
                        className="rounded-lg border border-border bg-card px-2 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
                    />
                </label>
            </div>
            <div className="flex flex-wrap items-center gap-1">
                {presets.map((preset) => (
                    <button
                        key={preset.label}
                        type="button"
                        onClick={() => setRange(preset.range)}
                        className="rounded-full border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                        {preset.label}
                    </button>
                ))}
            </div>
        </section>
    );
}
