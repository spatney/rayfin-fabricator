//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type {
    MatrixSpec,
    SelectionChangeListener,
    SelectionStore,
    TableSpec,
} from "graphein";

import { Chart } from "./Chart";
import { ChartCard, type ChartCardCommonProps } from "./ChartCard";
import { TileBody } from "./states";

export interface DataTableCardProps extends ChartCardCommonProps {
    /**
     * The Graphein `table` or `matrix` spec to render. Build a table with
     * `toTable(result, { columns })`, or author a `matrix` spec over
     * `toChartData(result)` rows for a pivot/cross-tab. Graphein owns sorting,
     * virtualization, conditional formatting, totals, and theming.
     */
    spec?: TableSpec | MatrixSpec;
    /** Fixed body height in px (default 360). The table scrolls within it. */
    height?: number;
    /** Force the empty state (defaults to detecting empty `spec.data`). */
    isEmpty?: boolean;
    /** Shared selection bus for cross-interaction (Graphein). */
    store?: SelectionStore;
    /** Fired whenever a selection this table publishes or consumes changes. */
    onSelectionChange?: SelectionChangeListener;
}

/** True when a spec carries an explicitly empty `data` array. */
function specIsEmpty(spec: TableSpec | MatrixSpec): boolean {
    const data = (spec as { data?: unknown }).data;
    return Array.isArray(data) && data.length === 0;
}

/**
 * A Graphein `table` / `matrix` inside the kit's card shell — virtualized, sortable,
 * themed from the CSS tokens (light/dark aware), with conditional formatting,
 * groups, and totals. Build the spec with `toTable(result, { columns })` (or
 * author a `matrix` over `toChartData(result)` rows).
 *
 * @example
 * ```tsx
 * const spec = data
 *   ? toTable(data, {
 *       columns: [
 *         { field: "account", title: "Account" },
 *         { field: "revenue", title: "Revenue", format: "$,.0f", align: "right",
 *           conditionalFormat: { type: "bar", showValue: true } },
 *       ],
 *       sort: { field: "revenue", order: "desc" },
 *     })
 *   : undefined;
 *
 * <DataTableCard
 *   title="Top accounts"
 *   loading={isLoading}
 *   error={error}
 *   spec={spec}
 * />
 * ```
 */
export function DataTableCard({
    title,
    subtitle,
    action,
    className,
    loading,
    error,
    emptyMessage,
    onRetry,
    spec,
    height = 360,
    isEmpty,
    store,
    onSelectionChange,
}: DataTableCardProps) {
    const empty = isEmpty ?? (spec == null || specIsEmpty(spec));

    return (
        <ChartCard
            title={title}
            subtitle={subtitle}
            action={action}
            className={className}
        >
            <TileBody
                loading={loading}
                error={error}
                isEmpty={empty}
                height={height}
                emptyMessage={emptyMessage}
                onRetry={onRetry}
            >
                <div
                    className="overflow-hidden rounded-xl border border-border"
                    style={{ height }}
                >
                    {spec != null && (
                        <Chart
                            spec={spec}
                            store={store}
                            onSelectionChange={onSelectionChange}
                        />
                    )}
                </div>
            </TileBody>
        </ChartCard>
    );
}
