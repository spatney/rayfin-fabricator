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

/**
 * Props for an inline categorical slicer.
 *
 * @example
 * ```tsx
 * <ListSlicer
 *   label="Region"
 *   title="Regions"
 *   field="Sales[Region]"
 *   options={[{ value: "West", label: "West" }]}
 * />
 * ```
 */
export interface ListSlicerProps {
    /** Small field label for assistive text and fallback title. */
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
    /** Optional title shown above the list. */
    title?: ReactNode;
    /** Maximum list height in pixels (default 240). */
    maxHeight?: number;
    className?: string;
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

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function OptionRow({
    option,
    checked,
    multiple,
    name,
    onToggle,
}: {
    option: SlicerOption;
    checked: boolean;
    multiple: boolean;
    name: string;
    onToggle: (value: string | number) => void;
}): JSX.Element {
    return (
        <label
            className={cn(
                "flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-accent",
                checked && "bg-muted/50",
            )}
        >
            <input
                type={multiple ? "checkbox" : "radio"}
                name={multiple ? undefined : name}
                checked={checked}
                onChange={() => onToggle(option.value)}
                className="h-4 w-4 accent-primary"
            />
            <span className="min-w-0 flex-1 truncate text-foreground">{option.label}</span>
            {option.count != null && (
                <span className="text-xs tabular-nums text-muted-foreground">
                    {option.count}
                </span>
            )}
        </label>
    );
}

/**
 * Inline checkbox or radio list slicer for sidebars and filter panes.
 *
 * @example
 * ```tsx
 * <ListSlicer
 *   title="Categories"
 *   label="Category"
 *   field="Product[Category]"
 *   options={categoryOptions}
 *   maxHeight={320}
 * />
 * ```
 */
export function ListSlicer({
    label,
    options,
    field,
    value,
    onChange,
    multiple = true,
    searchable,
    isLoading,
    error,
    title,
    maxHeight = 240,
    className,
}: ListSlicerProps): JSX.Element {
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
    const setValues = (nextValues: Array<string | number>) => {
        if (value !== undefined || onChange !== undefined) {
            onChange?.(nextValues);
            return;
        }
        if (!field) return;
        if (nextValues.length === 0) filters.clearFilter(field);
        else filters.setFilter({ kind: "in", field, values: nextValues });
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

    return (
        <section
            className={cn(
                "flex flex-col gap-3 rounded-xl border border-border bg-card p-3 text-sm",
                className,
            )}
        >
            <div className="flex items-center justify-between gap-2">
                <h3 className="font-medium text-foreground">{title ?? label}</h3>
                {multiple && (
                    <div className="flex items-center gap-1 text-xs">
                        <button
                            type="button"
                            onClick={() => setValues(options.map((option) => option.value))}
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
            </div>
            {showSearch && (
                <label className="flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-2 py-1.5 text-muted-foreground focus-within:ring-2 focus-within:ring-ring">
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
            {isLoading && <p className="text-xs text-muted-foreground">Loading…</p>}
            {error != null && (
                <p className="text-xs text-muted-foreground">{errorMessage(error)}</p>
            )}
            <div className="overflow-auto pr-1" style={{ maxHeight }}>
                {filteredOptions.map((option) => (
                    <OptionRow
                        key={String(option.value)}
                        option={option}
                        checked={selectedValues.some((item) => valuesMatch(item, option.value))}
                        multiple={multiple}
                        name={radioName}
                        onToggle={toggleValue}
                    />
                ))}
                {!isLoading && filteredOptions.length === 0 && (
                    <p className="px-2 py-3 text-xs text-muted-foreground">No options</p>
                )}
            </div>
        </section>
    );
}
