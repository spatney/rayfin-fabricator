//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ChangeEvent, CSSProperties, JSX, ReactNode } from "react";

import type { FilterField } from "@/components/dashboard/filters/filter-state";
import { useFilterState } from "@/components/dashboard/filters/filter-state";
import { cn } from "@/lib/utils";

interface NumericRangeValue {
    min: number | null;
    max: number | null;
}

/**
 * Props for a numeric dual-thumb range slicer.
 *
 * @example
 * ```tsx
 * <RangeSlicer label="Sales" field="Sales[Amount]" min={0} max={100000} step={1000} />
 * ```
 */
export interface RangeSlicerProps {
    label?: ReactNode;
    field?: FilterField;
    min: number;
    max: number;
    step?: number;
    value?: NumericRangeValue;
    onChange?: (range: NumericRangeValue) => void;
    className?: string;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

function toPercent(value: number, min: number, max: number): number {
    if (max === min) return 0;
    return ((value - min) / (max - min)) * 100;
}

function formatNumber(value: number): string {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

function normalizeRange(range: NumericRangeValue, min: number, max: number): NumericRangeValue {
    const lower = range.min == null ? null : clamp(range.min, min, max);
    const upper = range.max == null ? null : clamp(range.max, min, max);
    if (lower != null && upper != null && lower > upper) return { min: upper, max: lower };
    return { min: lower, max: upper };
}

/**
 * Flat, token-themed dual-thumb numeric range slicer.
 *
 * @example
 * ```tsx
 * <RangeSlicer
 *   label="Discount"
 *   min={0}
 *   max={1}
 *   step={0.01}
 *   value={discountRange}
 *   onChange={setDiscountRange}
 * />
 * ```
 */
export function RangeSlicer({
    label,
    field,
    min,
    max,
    step = (max - min) / 100 || 1,
    value,
    onChange,
    className,
}: RangeSlicerProps): JSX.Element {
    const filters = useFilterState();
    const connectedSelection = field ? filters.getSelection(field) : undefined;
    const rawRange =
        value ??
        (connectedSelection?.kind === "range"
            ? { min: connectedSelection.min, max: connectedSelection.max }
            : { min: null, max: null });
    const range = normalizeRange(rawRange, min, max);
    const lower = range.min ?? min;
    const upper = range.max ?? max;
    const lowerPercent = toPercent(lower, min, max);
    const upperPercent = toPercent(upper, min, max);
    const fillStyle: CSSProperties = {
        left: `${lowerPercent}%`,
        right: `${100 - upperPercent}%`,
    };
    const inputClassName =
        "pointer-events-none absolute inset-0 h-2 w-full appearance-none bg-transparent accent-primary [&::-moz-range-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:pointer-events-auto";

    const commitRange = (nextLower: number, nextUpper: number) => {
        const clampedLower = clamp(Math.min(nextLower, nextUpper), min, max);
        const clampedUpper = clamp(Math.max(nextLower, nextUpper), min, max);
        const nextRange =
            clampedLower === min && clampedUpper === max
                ? { min: null, max: null }
                : { min: clampedLower, max: clampedUpper };

        if (value !== undefined || onChange !== undefined) {
            onChange?.(nextRange);
            return;
        }
        if (field) filters.setRange(field, nextRange.min, nextRange.max, "number");
    };

    return (
        <section className={cn("flex flex-col gap-3 text-sm", className)}>
            <div className="flex items-center justify-between gap-3">
                {label != null && <h3 className="font-medium text-foreground">{label}</h3>}
                <div className="text-xs tabular-nums text-muted-foreground">
                    {formatNumber(lower)} – {formatNumber(upper)}
                </div>
            </div>
            <div className="px-1 py-3">
                <div className="relative h-2 rounded-full bg-muted">
                    <div
                        className="absolute top-0 h-2 rounded-full bg-primary"
                        style={fillStyle}
                    />
                    <input
                        type="range"
                        min={min}
                        max={max}
                        step={step}
                        value={lower}
                        onChange={(event: ChangeEvent<HTMLInputElement>) =>
                            commitRange(Number(event.target.value), upper)
                        }
                        aria-label="Minimum value"
                        className={inputClassName}
                    />
                    <input
                        type="range"
                        min={min}
                        max={max}
                        step={step}
                        value={upper}
                        onChange={(event: ChangeEvent<HTMLInputElement>) =>
                            commitRange(lower, Number(event.target.value))
                        }
                        aria-label="Maximum value"
                        className={inputClassName}
                    />
                </div>
            </div>
            <div className="flex items-center justify-between text-xs tabular-nums text-muted-foreground">
                <span>{formatNumber(min)}</span>
                <span>{formatNumber(max)}</span>
            </div>
        </section>
    );
}
