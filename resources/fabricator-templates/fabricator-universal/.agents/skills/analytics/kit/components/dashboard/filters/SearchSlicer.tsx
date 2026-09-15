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

/**
 * Props for a text contains slicer.
 *
 * @example
 * ```tsx
 * <SearchSlicer field="Customer[Name]" placeholder="Find customer" />
 * ```
 */
export interface SearchSlicerProps {
    label?: ReactNode;
    field?: FilterField;
    value?: string;
    onChange?: (text: string) => void;
    placeholder?: string;
    className?: string;
}

function SearchIcon(): JSX.Element {
    return (
        <svg
            width={16}
            height={16}
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

function XIcon(): JSX.Element {
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
            <path d="M18 6 6 18M6 6l12 12" />
        </svg>
    );
}

/**
 * Text search slicer that writes a shared `contains` filter or behaves as a controlled input.
 *
 * @example
 * ```tsx
 * <SearchSlicer
 *   label="Search products"
 *   field="Product[Product Name]"
 *   placeholder="Type a product name"
 * />
 * ```
 */
export function SearchSlicer({
    label,
    field,
    value,
    onChange,
    placeholder = "Search",
    className,
}: SearchSlicerProps): JSX.Element {
    const filters = useFilterState();
    const connectedSelection = field ? filters.getSelection(field) : undefined;
    const text =
        value ??
        (connectedSelection?.kind === "contains" ? connectedSelection.text : "");
    const setText = (nextText: string) => {
        if (value !== undefined || onChange !== undefined) {
            onChange?.(nextText);
            return;
        }
        if (!field) return;
        if (nextText.trim().length === 0) filters.clearFilter(field);
        else filters.setSearch(field, nextText);
    };

    return (
        <label className={cn("flex flex-col gap-1.5 text-sm", className)}>
            {label != null && <span className="font-medium text-foreground">{label}</span>}
            <span className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-muted-foreground focus-within:ring-2 focus-within:ring-ring">
                <SearchIcon />
                <input
                    type="search"
                    value={text}
                    onChange={(event: ChangeEvent<HTMLInputElement>) =>
                        setText(event.target.value)
                    }
                    placeholder={placeholder}
                    className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                />
                {text.length > 0 && (
                    <button
                        type="button"
                        aria-label="Clear search"
                        onClick={() => setText("")}
                        className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                        <XIcon />
                    </button>
                )}
            </span>
        </label>
    );
}
