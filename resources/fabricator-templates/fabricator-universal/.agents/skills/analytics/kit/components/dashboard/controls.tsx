//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string = string> {
    label: ReactNode;
    value: T;
}

export interface SegmentedControlProps<T extends string = string> {
    options: SegmentedOption<T>[];
    value: T;
    onChange: (value: T) => void;
    size?: "sm" | "md";
    className?: string;
}

/**
 * Single-select pill group for switching a dashboard view (e.g. a date
 * range or metric). Controlled — own the `value` in `useState`.
 *
 * @example
 * ```tsx
 * const [range, setRange] = useState("30d");
 * <SegmentedControl
 *   value={range}
 *   onChange={setRange}
 *   options={[
 *     { label: "7D", value: "7d" },
 *     { label: "30D", value: "30d" },
 *     { label: "90D", value: "90d" },
 *   ]}
 * />
 * ```
 */
export function SegmentedControl<T extends string = string>({
    options,
    value,
    onChange,
    size = "md",
    className,
}: SegmentedControlProps<T>) {
    return (
        <div
            role="tablist"
            className={cn(
                "inline-flex items-center gap-1 rounded-lg border border-border bg-muted/50 p-1",
                className,
            )}
        >
            {options.map((option) => {
                const active = option.value === value;
                return (
                    <button
                        key={option.value}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        onClick={() => onChange(option.value)}
                        className={cn(
                            "rounded-md font-medium transition-colors",
                            size === "sm"
                                ? "px-2.5 py-1 text-xs"
                                : "px-3 py-1.5 text-sm",
                            active
                                ? "bg-card text-foreground"
                                : "text-muted-foreground hover:text-foreground",
                        )}
                    >
                        {option.label}
                    </button>
                );
            })}
        </div>
    );
}

export interface FilterChipOption<T extends string = string> {
    label: ReactNode;
    value: T;
}

export interface FilterChipsProps<T extends string = string> {
    options: FilterChipOption<T>[];
    /** Selected values (multi-select). */
    value: T[];
    onChange: (value: T[]) => void;
    className?: string;
}

/**
 * Multi-select chip row for filtering by category. Controlled — own the
 * selected `value` array in `useState`.
 *
 * @example
 * ```tsx
 * const [regions, setRegions] = useState<string[]>([]);
 * <FilterChips
 *   value={regions}
 *   onChange={setRegions}
 *   options={[
 *     { label: "EMEA", value: "emea" },
 *     { label: "AMER", value: "amer" },
 *   ]}
 * />
 * ```
 */
export function FilterChips<T extends string = string>({
    options,
    value,
    onChange,
    className,
}: FilterChipsProps<T>) {
    const toggle = (next: T) =>
        onChange(
            value.includes(next)
                ? value.filter((item) => item !== next)
                : [...value, next],
        );

    return (
        <div className={cn("flex flex-wrap items-center gap-2", className)}>
            {options.map((option) => {
                const active = value.includes(option.value);
                return (
                    <button
                        key={option.value}
                        type="button"
                        aria-pressed={active}
                        onClick={() => toggle(option.value)}
                        className={cn(
                            "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                            active
                                ? "border-transparent bg-primary text-primary-foreground"
                                : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
                        )}
                    >
                        {option.label}
                    </button>
                );
            })}
        </div>
    );
}
