//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/**
 * Dashboard kit — a small, spec-first component library.
 *
 * The common path: map your DAX result into plain rows, author one Graphein
 * `ChartSpec` (a single JSON object — see the `visuals` skill / Graphein spec
 * reference), and drop it into `<ChartCard spec={…} />`. The card owns the
 * loading / empty / error states and bridges the app theme. KPIs use
 * `<KpiCard>`, tabular data uses `<DataTableCard>` (a Graphein `table` / `matrix`
 * spec via `toTable`), and slicers / `FilterBar` drive re-queries.
 * `validateSpec` (re-exported from `graphein`) checks a spec before render.
 *
 *   import {
 *     PageShell, SidebarShell, DashboardGrid, Tile, StatStrip, Stat,
 *     ChartCard, KpiCard, DataTableCard, ThemeToggle,
 *     FilterStateProvider, FilterBar, DropdownSlicer,
 *     toChartData, deriveKpi, validateSpec, type ChartSpec,
 *   } from "@/components/dashboard";
 */

/* ------------------------------- Layout -------------------------------- */
export { AppShell, PageShell, SidebarShell, Section } from "./AppShell";
export type {
    AppShellProps,
    PageShellProps,
    SidebarShellProps,
    SectionProps,
} from "./AppShell";
export {
    DashboardGrid,
    Tile,
    StatStrip,
    Stat,
    SectionBand,
    KpiGrid,
    ChartGrid,
    BentoGrid,
    BentoItem,
} from "./grid";
export type {
    TileProps,
    TileSize,
    StatProps,
    SectionBandProps,
    BentoItemProps,
} from "./grid";
export { Card } from "./Card";
export type { CardProps, CardVariant } from "./Card";
export { ThemeToggle } from "./ThemeToggle";
export { SketchToggle } from "./SketchToggle";
export { SegmentedControl, FilterChips } from "./controls";
export type {
    SegmentedControlProps,
    SegmentedOption,
    FilterChipsProps,
    FilterChipOption,
} from "./controls";

/* -------------------------------- Cards -------------------------------- */
export { ChartCard } from "./ChartCard";
export type { ChartCardProps, ChartCardCommonProps } from "./ChartCard";
export { KpiCard } from "./KpiCard";
export type { KpiCardProps } from "./KpiCard";
export { DataTableCard } from "./DataTableCard";
export type { DataTableCardProps } from "./DataTableCard";

/* --------------------------- Graphein runtime -------------------------- */
export { Chart } from "./Chart";
export type { ChartProps } from "./Chart";
export { useChart } from "./use-chart";
export type { UseChartOptions } from "./use-chart";
export { useGrapheinTheme, readGrapheinTheme } from "@/lib/graphein-theme";
export { validateSpec, createSelectionStore } from "graphein";
export type {
    ChartSpec,
    ChartInstance,
    SelectionStore,
    SelectionValue,
    SelectionChangeListener,
    SelectionParam,
    SelectionDef,
    HighlightConfig,
    FilterClause,
    PointSelection,
    SetSelection,
    RangeSelection,
    TextSelection,
    TableSpec,
    TableColumn,
    MatrixSpec,
    MatrixValueDef,
    ConditionalFormat,
    FunnelSpec,
    PieLabels,
} from "graphein";

/* ------------------- Selection store + interactivity ------------------- */
export {
    SelectionStoreProvider,
    useSelectionStore,
    useSelection,
} from "./selection";
export {
    selectionToFilters,
    filterToSelection,
    useSelectionFilterBridge,
    selectionsExcept,
    crossHighlightParams,
    useCrossHighlight,
} from "@/lib/selection-bridge";
export type {
    FieldMap,
    SelectionFilterBridgeOptions,
    CrossHighlight,
} from "@/lib/selection-bridge";

/* ------------------------------ Sparkline ------------------------------ */
export { Sparkline } from "./Sparkline";
export type { SparklineProps } from "./Sparkline";
export { AnimatedNumber } from "./AnimatedNumber";
export type { AnimatedNumberProps } from "./AnimatedNumber";

/* -------------------------------- States ------------------------------- */
export {
    ChartSkeleton,
    KpiSkeleton,
    EmptyTile,
    ErrorTile,
    TileBody,
    DEFAULT_ASPECT,
    MIN_CHART_HEIGHT,
    MAX_CHART_HEIGHT,
} from "./states";
export type {
    ChartSkeletonProps,
    EmptyTileProps,
    ErrorTileProps,
    TileBodyProps,
} from "./states";

/* -------------------------------- Icons -------------------------------- */
export {
    SunIcon,
    MoonIcon,
    PenIcon,
    ArrowUpRightIcon,
    ArrowDownRightIcon,
    ChevronRightIcon,
    ChevronDownIcon,
    AlertTriangleIcon,
    InboxIcon,
} from "./icons";
export type { IconProps } from "./icons";

/* ----------------------- Filters + slicers ----------------------------- */
export {
    FilterStateProvider,
    useFilterState,
    fieldShortName,
    parseField,
} from "./filters/filter-state";
export type {
    FilterField,
    FilterSelection,
    FilterStateApi,
} from "./filters/filter-state";
export { Popover } from "./filters/Popover";
export type { PopoverProps } from "./filters/Popover";
export { DropdownSlicer } from "./filters/DropdownSlicer";
export type { DropdownSlicerProps } from "./filters/DropdownSlicer";
export { ListSlicer } from "./filters/ListSlicer";
export type { ListSlicerProps } from "./filters/ListSlicer";
export { SearchSlicer } from "./filters/SearchSlicer";
export type { SearchSlicerProps } from "./filters/SearchSlicer";
export { DateRangeSlicer } from "./filters/DateRangeSlicer";
export type { DateRangeSlicerProps } from "./filters/DateRangeSlicer";
export { RangeSlicer } from "./filters/RangeSlicer";
export type { RangeSlicerProps } from "./filters/RangeSlicer";
export { FilterBar } from "./filters/FilterBar";
export type { FilterBarProps } from "./filters/FilterBar";
export { useSlicerOptions } from "@/hooks/use-slicer-options";
export type {
    SlicerOption,
    UseSlicerOptionsResult,
} from "@/hooks/use-slicer-options";

/* ----------------- Filter application (client + DAX) ------------------- */
export { applyFilters, matchesSelection } from "@/lib/apply-filters";
export type { ApplyFiltersOptions } from "@/lib/apply-filters";
export {
    toDaxFilters,
    daxEscape,
    daxValueList,
    daxDateLiteral,
} from "@/lib/dax-filters";
export type { DaxFilters } from "@/lib/dax-filters";
export { quoteFieldRef } from "@/lib/filter-field";
export type { ParsedFilterField } from "@/lib/filter-field";

/* --------------------------- Helpers (re-exports) ---------------------- */
export {
    formatNumber,
    formatCompact,
    formatPercent,
    formatDelta,
    formatRatio,
    formatCurrency,
    formatDate,
    resolveFormat,
} from "@/lib/format";
export type { ValueFormat } from "@/lib/format";
export {
    seriesColor,
    roleColor,
    resolveColor,
    cssVar,
} from "@/lib/chartTokens";
export type { ChartRole } from "@/lib/chartTokens";
export { toTable } from "@/lib/to-table";
export type { TableColumnDef, ToTableOptions } from "@/lib/to-table";
export { toChartData } from "@/lib/to-chart-data";
export type { ToChartDataOptions } from "@/lib/to-chart-data";

/* ----------------------- Data mapping (DAX → specs) -------------------- */
export { pivotChartData } from "@/lib/pivot-chart-data";
export type {
    PivotChartDataOptions,
    PivotChartDataResult,
    PivotSeries,
} from "@/lib/pivot-chart-data";
export { topN } from "@/lib/top-n";
export type { TopNOptions } from "@/lib/top-n";
export { deriveKpi } from "@/lib/derive-kpi";
export type { DeriveKpiOptions, DerivedKpi } from "@/lib/derive-kpi";
export { warnMissingKeys } from "@/lib/validate";
