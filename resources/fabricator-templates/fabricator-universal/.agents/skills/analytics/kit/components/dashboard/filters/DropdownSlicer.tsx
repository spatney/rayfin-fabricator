//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ChangeEvent, JSX, ReactNode } from "react";
import { useId, useMemo, useState } from "react";

import type { FilterField } from "@/components/dashboard/filters/filter-state";
import { useFilterState } from "@/components/dashboard/filters/filter-state";
import type { SlicerOption } from "@/hooks/use-slicer-options";
import { cn } from "@/lib/utils";

import { Popover } from "./Popover";

/**
 * Props for a popover-backed categorical slicer.
 *
 * @example
 * ```tsx
 * <DropdownSlicer
 *   label="Region"
 *   field="Sales[Region]"
 *   options={[{ value: "West", label: "West" }]}
 * />
 * ```
 */
export interface DropdownSlicerProps {
    /** Small field label shown in the trigger. */
    label: ReactNode;
    /** Selectable values (caller fetches via useSlicerOptions or builds statically). */
    options: ReadonlyArray<SlicerOption>;
    /** Connected mode: the model field to read/write in shared filter state. */
    field?: FilterField;
    /** Controlled mode: selected values. */
    value?: Array<string | number>;
    /** Controlled mode: change handler. */
    onChange?: (values: Array<string | number>) => void;
    /** Single vs multi select (default true = multi). */
    multiple?: boolean;
    /** Show a search box filtering options (default: auto — true when options.length > 8). */
    searchable?: boolean;
    /** Loading + error passthrough (e.g. from useSlicerOptions). */
    isLoading?: boolean;
    error?: unknown;
    align?: "start" | "end";
    className?: string;
}

function ChevronDownIcon(): JSX.Element {
    return (
        <svg
            width={14}
            height={14}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
        >
            <path d="m6 9 6 6 6-6" />
        </svg>
    );
}

function SearchIcon(): JSX.Element {
    return (
        <svg
            width={14}
            height={14}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
        >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
        </svg>
    );
}

function valuesMatch(left: string | number, right: string | number): boolean {
    return String(left) === String(right);
}

function selectedOptionLabel(
    options: ReadonlyArray<SlicerOption>,
    value: string | number,
): string {
    return options.find((option) => valuesMatch(option.value, value))?.label ?? String(value);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Power BI-style dropdown slicer for categorical values, in connected or controlled mode.
 *
 * @example
 * ```tsx
 * const { options, isLoading, error } = useSlicerOptions({ connection, field: "Product[Category]" });
 * <DropdownSlicer
 *   label="Category"
 *   field="Product[Category]"
 *   options={options}
 *   isLoading={isLoading}
 *   error={error}
 * />
 * ```
 */
export function DropdownSlicer({
    label,
    options,
    field,
    value,
    onChange,
    multiple = true,
    searchable,
    isLoading,
    error,
    align,
    className,
}: DropdownSlicerProps): JSX.Element {
    const filters = useFilterState();
    const [query, setQuery] = useState("");
    const radioName = useId();
    const connectedSelection = field ? filters.getSelection(field) : undefined;
    const selectedValues =
        value ??
        (connectedSelection?.kind === "in" ? connectedSelection.values : []);
    const showSearch = searchable ?? options.length > 8;
    const normalizedQuery = query.trim().toLowerCase();
    const filteredOptions = useMemo(
        () =>
            normalizedQuery.length === 0
                ? options
                : options.filter((option) =>
                      option.label.toLowerCase().includes(normalizedQuery),
                  ),
        [normalizedQuery, options],
    );
    const summary =
        selectedValues.length === 0
            ? "All"
            : selectedValues.length === 1
              ? selectedOptionLabel(options, selectedValues[0])
              : `${selectedValues.length} selected`;

    const setValues = (nextValues: Array<string | number>) => {
        if (value !== undefined || onChange !== undefined) {
            onChange?.(nextValues);
            return;
        }
        if (!field) return;
        if (nextValues.length === 0) {
            filters.clearFilter(field);
        } else {
            filters.setFilter({ kind: "in", field, values: nextValues });
        }
    };
    const toggleValue = (nextValue: string | number) => {
        if (value !== undefined || onChange !== undefined) {
            const exists = selectedValues.some((item) => valuesMatch(item, nextValue));
            setValues(
                multiple
                    ? exists
                        ? selectedValues.filter((item) => !valuesMatch(item, nextValue))
                        : [...selectedValues, nextValue]
                    : [nextValue],
            );
            return;
        }
        if (!field) return;
        if (multiple) filters.toggleValue(field, nextValue);
        else filters.setFilter({ kind: "in", field, values: [nextValue] });
    };
    const allValues = options.map((option) => option.value);

    return (
        <Popover
            align={align}
            className={className}
            trigger={
                <>
                    <span className="font-medium text-foreground">{label}</span>
                    <span className="max-w-36 truncate text-muted-foreground">{summary}</span>
                    <ChevronDownIcon />
                </>
            }
        >
            <div className="flex flex-col gap-2 text-sm text-foreground">
                {showSearch && (
                    <label className="flex items-center gap-2 rounded-lg border border-border bg-card px-2 py-1.5 text-muted-foreground focus-within:ring-2 focus-within:ring-ring">
                        <SearchIcon />
                        <input
                            type="search"
                            value={query}
                            onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                setQuery(event.target.value)
                            }
                            placeholder="Search"
                            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                        />
                    </label>
                )}
                {multiple && (
                    <div className="flex items-center justify-between gap-2 border-b border-border pb-2 text-xs">
                        <button
                            type="button"
                            onClick={() => setValues(allValues)}
                            className="rounded-md px-2 py-1 font-medium text-foreground-secondary hover:bg-accent hover:text-foreground"
                        >
                            Select all
                        </button>
                        <button
                            type="button"
                            onClick={() => setValues([])}
                            className="rounded-md px-2 py-1 font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                        >
                            Clear
                        </button>
                    </div>
                )}
                {isLoading && <p className="px-2 py-1 text-xs text-muted-foreground">Loading…</p>}
                {error != null && (
                    <p className="px-2 py-1 text-xs text-muted-foreground">{errorMessage(error)}</p>
                )}
                <div className="max-h-64 overflow-auto pr-1">
                    {filteredOptions.map((option) => {
                        const checked = selectedValues.some((item) =>
                            valuesMatch(item, option.value),
                        );
                        return (
                            <label
                                key={String(option.value)}
                                className={cn(
                                    "flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-accent",
                                    checked && "bg-muted/50",
                                )}
                            >
                                <input
                                    type={multiple ? "checkbox" : "radio"}
                                    name={multiple ? undefined : radioName}
                                    checked={checked}
                                    onChange={() => toggleValue(option.value)}
                                    className="h-4 w-4 accent-primary"
                                />
                                <span className="min-w-0 flex-1 truncate text-foreground">
                                    {option.label}
                                </span>
                                {option.count != null && (
                                    <span className="text-xs tabular-nums text-muted-foreground">
                                        {option.count}
                                    </span>
                                )}
                            </label>
                        );
                    })}
                    {!isLoading && filteredOptions.length === 0 && (
                        <p className="px-2 py-3 text-xs text-muted-foreground">No options</p>
                    )}
                </div>
            </div>
        </Popover>
    );
}
