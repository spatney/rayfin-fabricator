//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/**
 * Dev-only component gallery. Renders the kit's visuals — Graphein chart specs in
 * `ChartCard`s, `KpiCard`s, slicers, and the state tiles — with static sample
 * data so the look + behavior can be eyeballed (and AI-reviewed) without a live
 * semantic model. Excluded from the production build — see `gallery.html`.
 */

import { useEffect, useState } from "react";

import {
    Card,
    ChartCard,
    ChartSkeleton,
    DashboardGrid,
    DataTableCard,
    DateRangeSlicer,
    DropdownSlicer,
    EmptyTile,
    ErrorTile,
    FilterBar,
    KpiCard,
    ListSlicer,
    RangeSlicer,
    SearchSlicer,
    SelectionStoreProvider,
    SidebarShell,
    Sparkline,
    Stat,
    StatStrip,
    SectionBand,
    PageShell,
    Tile,
    useFilterState,
    useSelectionFilterBridge,
    useSelectionStore,
    type ChartSpec,
    type FilterSelection,
    type FunnelSpec,
    type MatrixSpec,
    type SelectionValue,
    type SlicerOption,
    type TableSpec,
} from "@/components/dashboard";
import { useThemeContext } from "@/hooks/theme.context";

import {
    categoryShare,
    channelLong,
    funnelStages,
    monthlyRevenue,
    priceVsUnits,
    regionPerformance,
    regionQuarter,
    regionRevenue,
    revenueProfitLong,
} from "./sample-data";

function Section({
    title,
    children,
}: {
    title: string;
    children: React.ReactNode;
}) {
    return (
        <section className="flex flex-col gap-4">
            <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-foreground-secondary">
                {title}
            </h2>
            {children}
        </section>
    );
}

/* ----------------------------- Chart specs ------------------------------ *
 * One JSON spec per visual. Authored WITHOUT a `theme` — `ChartCard` injects
 * the app's CSS-token theme (and re-themes on the toggle below). Module-level
 * constants keep their identity stable across renders, so toggling the theme
 * cross-fades instead of replaying the entrance animation.
 * ------------------------------------------------------------------------ */

const lineSpec: ChartSpec = {
    type: "line",
    data: revenueProfitLong,
    points: true,
    encoding: {
        x: { field: "month", type: "temporal" },
        y: { field: "value", type: "quantitative", format: "$,.0f" },
        series: { field: "metric" },
    },
};

const areaSpec: ChartSpec = {
    type: "area",
    data: channelLong,
    stack: true,
    encoding: {
        x: { field: "quarter", type: "ordinal" },
        y: { field: "revenue", type: "quantitative", format: "$,.0f" },
        series: { field: "channel" },
    },
};

const barGroupedSpec: ChartSpec = {
    type: "bar",
    data: channelLong,
    encoding: {
        x: { field: "quarter" },
        y: { field: "revenue", type: "quantitative", format: "$,.0f" },
        series: { field: "channel" },
    },
};

const barStackedSpec: ChartSpec = {
    type: "bar",
    data: channelLong,
    stack: true,
    encoding: {
        x: { field: "quarter" },
        y: { field: "revenue", type: "quantitative", format: "$,.0f" },
        series: { field: "channel" },
    },
};

const barRankedSpec: ChartSpec = {
    type: "bar",
    data: regionRevenue,
    encoding: {
        x: { field: "region", type: "nominal" },
        y: { field: "revenue", type: "quantitative", format: "$,.2s" },
    },
};

const scatterSpec: ChartSpec = {
    type: "scatter",
    data: priceVsUnits,
    encoding: {
        x: { field: "price", type: "quantitative", format: "$,.0f" },
        y: { field: "units", type: "quantitative" },
        size: { field: "margin", title: "Margin" },
    },
};

const donutSpec: ChartSpec = {
    type: "pie",
    data: categoryShare,
    donut: 0.6,
    encoding: {
        theta: { field: "value", type: "quantitative", format: "$,.0f" },
        color: { field: "category" },
    },
};

const heatmapSpec: ChartSpec = {
    type: "heatmap",
    data: regionQuarter,
    scheme: "teal",
    encoding: {
        x: { field: "quarter" },
        y: { field: "region" },
        color: { field: "revenue", type: "quantitative", format: "$,.2s" },
    },
};

/* ---------------------- Interactivity (Graphein) -------------------- *
 * `params` PUBLISH a selection on click; `highlight` CONSUMES one (emphasize
 * matches, dim the rest). Sibling cards sharing one `SelectionStore` cross-
 * interact. Here the bar publishes `region`; both the bar (self) and the
 * region-series line highlight on it. The pair is seeded below so the static
 * gallery screenshot shows the highlight without a click.
 * ------------------------------------------------------------------------ */

const regionBarSpec: ChartSpec = {
    type: "bar",
    data: regionRevenue,
    params: [{ name: "region", select: { type: "point", fields: ["region"] } }],
    highlight: { param: "region" },
    encoding: {
        x: { field: "region", type: "nominal" },
        y: { field: "revenue", type: "quantitative", format: "$,.2s" },
    },
};

const regionTrendSpec: ChartSpec = {
    type: "line",
    data: regionQuarter,
    points: true,
    highlight: { param: "region" },
    encoding: {
        x: { field: "quarter", type: "ordinal" },
        y: { field: "revenue", type: "quantitative", format: "$,.2s" },
        series: { field: "region" },
    },
};

/** Seed `region` so the linked pair (and the bridge) show a result statically. */
const seededRegion: SelectionValue = {
    kind: "point",
    fields: ["region"],
    tuples: [["North America"]],
};

/* -------------------- Formatting (Graphein) ------------------------- *
 * A funnel (native), pie callout labels, a `table` with conditional
 * formatting (data bar / color scale / icon), and a pivot `matrix`.
 * ------------------------------------------------------------------------ */

const funnelSpec: FunnelSpec = {
    type: "funnel",
    data: funnelStages,
    percent: "first",
    encoding: {
        stage: { field: "stage" },
        value: { field: "count", format: ",.0f" },
    },
};

const pieCalloutSpec: ChartSpec = {
    type: "pie",
    data: categoryShare,
    labels: { placement: "outside", content: "category-percent", connector: "slice" },
    encoding: {
        theta: { field: "value", type: "quantitative", format: "$,.0f" },
        color: { field: "category" },
    },
};

const perfTableSpec: TableSpec = {
    type: "table",
    data: regionPerformance,
    totals: { label: "Total" },
    sort: { field: "revenue", order: "desc" },
    columns: [
        { field: "region", title: "Region" },
        {
            field: "revenue",
            title: "Revenue",
            format: "$,.0f",
            align: "right",
            total: "sum",
            conditionalFormat: { type: "bar", showValue: true },
        },
        {
            field: "margin",
            title: "Margin",
            format: ".0%",
            align: "right",
            total: false,
            conditionalFormat: { type: "colorScale", scheme: "teal", target: "background" },
        },
        {
            field: "yoy",
            title: "YoY",
            format: "+.1%",
            align: "right",
            total: false,
            negativeStyle: "red",
            conditionalFormat: { type: "icon", set: "arrows" },
        },
    ],
};

const channelMatrixSpec: MatrixSpec = {
    type: "matrix",
    data: channelLong,
    rows: ["channel"],
    columns: ["quarter"],
    values: [{ field: "revenue", op: "sum", format: "$,.0s" }],
    subtotals: false,
    grandTotals: true,
};

const categoryOptions: SlicerOption[] = categoryShare.map((row) => ({
    value: row.category,
    label: row.category,
    count: row.value,
}));
const regionOptions: SlicerOption[] = regionRevenue.map((row) => ({
    value: row.region,
    label: row.region,
}));

/** Slicer toolbar + an inline list slicer, all driving shared filter state. */
function SlicersDemo() {
    return (
        <div className="flex flex-col gap-4 lg:flex-row">
            <div className="flex-1">
                <FilterBar>
                    <DropdownSlicer
                        label="Category"
                        field="Product[Category]"
                        options={categoryOptions}
                    />
                    <DropdownSlicer
                        label="Region"
                        field="Geography[Region]"
                        options={regionOptions}
                        multiple={false}
                    />
                    <SearchSlicer
                        label="Product"
                        field="Product[Name]"
                        placeholder="Search products…"
                    />
                    <DateRangeSlicer label="Date" field="Date[Date]" />
                    <RangeSlicer
                        label="Price"
                        field="Product[Price]"
                        min={0}
                        max={1000}
                    />
                </FilterBar>
            </div>
            <div className="w-full lg:w-56">
                <ChartCard title="Inline list slicer">
                    <ListSlicer
                        label="Category"
                        field="Product[Category]"
                        options={categoryOptions}
                    />
                </ChartCard>
            </div>
        </div>
    );
}

/** Two cards sharing one selection store: the bar publishes, both highlight. */
function CrossHighlightDemo() {
    const store = useSelectionStore();
    return (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ChartCard
                title="Revenue by region"
                subtitle="Click a bar to pick a region · publishes `region`"
                spec={regionBarSpec}
                store={store}
            />
            <ChartCard
                title="Quarterly trend"
                subtitle="Emphasizes the picked region · consumes `region`"
                spec={regionTrendSpec}
                store={store}
            />
        </div>
    );
}

/** Render one active app filter selection as a short, readable line. */
function describeSelection(sel: FilterSelection): string {
    switch (sel.kind) {
        case "in":
            return `${sel.field} in ${sel.values.join(", ")}`;
        case "range":
            return `${sel.field} ∈ [${sel.min ?? "−∞"}, ${sel.max ?? "∞"}]`;
        case "contains":
            return `${sel.field} contains “${sel.text}”`;
    }
}

/**
 * Bridge a chart selection into the app's slicer/DAX filter state: clicking a
 * bar publishes `region`, which `useSelectionFilterBridge` maps to a
 * `Geography[Region]` slicer filter (re-queried server-side via `toDaxFilters`).
 * Seeded on mount so the static screenshot shows the bridged filter.
 */
function BridgeDemo() {
    const store = useSelectionStore();
    useSelectionFilterBridge(store, { fieldMap: { region: "Geography[Region]" } });
    const { selections } = useFilterState();
    useEffect(() => {
        store.set("region", seededRegion);
    }, [store]);

    const active = Object.values(selections);
    return (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ChartCard
                title="Revenue by region"
                subtitle="A click re-queries via toDaxFilters (server-side)"
                spec={regionBarSpec}
                store={store}
            />
            <ChartCard
                title="Bridged DAX filters"
                subtitle="useSelectionFilterBridge → useFilterState"
            >
                <div className="flex h-[260px] flex-col gap-2 p-1 text-sm">
                    {active.length === 0 ? (
                        <p className="text-muted-foreground">
                            No active filters — click a bar to cross-filter.
                        </p>
                    ) : (
                        active.map((sel) => (
                            <span
                                key={sel.field}
                                className="rounded-lg border border-border bg-card-hover px-2.5 py-1.5 font-mono text-xs text-foreground-secondary"
                            >
                                {describeSelection(sel)}
                            </span>
                        ))
                    )}
                </div>
            </ChartCard>
        </div>
    );
}

export function Gallery() {
    const { isDark, toggleTheme } = useThemeContext();
    const [showStates, setShowStates] = useState(true);
    const latestMonth = monthlyRevenue[monthlyRevenue.length - 1];
    const priorMonth = monthlyRevenue[monthlyRevenue.length - 2];
    const latestRevenue = latestMonth?.revenue ?? 0;
    const latestOrders = latestMonth?.orders ?? 0;
    const priorRevenue = priorMonth?.revenue ?? latestRevenue;
    const priorOrders = priorMonth?.orders ?? latestOrders;
    const avgOrder = latestOrders > 0 ? latestRevenue / latestOrders : 0;
    const conversion =
        (funnelStages[funnelStages.length - 1]?.count ?? 0) /
        (funnelStages[0]?.count ?? 1);
    const revenueDelta =
        priorRevenue > 0 ? ((latestRevenue - priorRevenue) / priorRevenue) * 100 : 0;
    const ordersDelta =
        priorOrders > 0 ? ((latestOrders - priorOrders) / priorOrders) * 100 : 0;

    return (
        <div className="min-h-screen bg-background px-6 py-8 text-foreground">
            <div className="mx-auto flex max-w-6xl flex-col gap-10">
                <header className="flex items-center justify-between">
                    <div>
                        <h1 className="font-display text-2xl font-semibold tracking-tight">
                            Data app kit gallery
                        </h1>
                        <p className="mt-1 text-sm text-muted-foreground">
                            Graphein chart specs · KPI cards · slicers · state tiles
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={toggleTheme}
                        className="rounded-lg border border-border px-3 py-1.5 text-sm text-foreground-secondary hover:bg-card-hover"
                    >
                        {isDark ? "☀ Light" : "☾ Dark"}
                    </button>
                </header>

                <Section title="KPIs">
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                        <KpiCard
                            label="Revenue"
                            value={341_500}
                            valueFormat="currency"
                            delta={9.2}
                            deltaLabel="vs last month"
                            trend={monthlyRevenue.map((row) => row.revenue)}
                        />
                        <KpiCard
                            label="Profit"
                            value={95_700}
                            valueFormat="currency"
                            delta={10.8}
                            trend={monthlyRevenue.map((row) => row.profit)}
                        />
                        <KpiCard
                            label="Orders"
                            value={2_233}
                            delta={8.2}
                            trend={monthlyRevenue.map((row) => row.orders)}
                        />
                        <KpiCard
                            label="Conversion"
                            value={0.051}
                            valueFormat="ratio"
                            delta={-0.4}
                            invertDelta
                            secondary={
                                <Sparkline
                                    data={monthlyRevenue}
                                    dataKey="orders"
                                />
                            }
                        />
                    </div>
                </Section>

                <Section title="Layout — metric strip">
                    <StatStrip>
                        <Stat
                            label="Revenue"
                            value={latestRevenue}
                            valueFormat="currency"
                            delta={revenueDelta}
                            secondary={latestMonth?.month}
                            accent="chart-1"
                        />
                        <Stat
                            label="Orders"
                            value={latestOrders}
                            valueFormat="number"
                            delta={ordersDelta}
                            accent="chart-2"
                        />
                        <Stat
                            label="Avg order"
                            value={avgOrder}
                            valueFormat="currency"
                            delta={0.9}
                            accent="chart-3"
                        />
                        <Stat
                            label="Conversion"
                            value={conversion}
                            valueFormat="ratio"
                            delta={-0.4}
                            invertDelta
                            secondary="Renewed / visited"
                            accent="chart-4"
                        />
                    </StatStrip>
                </Section>

                <Section title="Layout — tile sizes">
                    <p className="text-sm text-muted-foreground">
                        One responsive 12-column canvas with a hero tile, supporting
                        tiles, and a full-width detail row.
                    </p>
                    <DashboardGrid>
                        <Tile size="hero">
                            <ChartCard
                                className="h-full"
                                eyebrow="Hero"
                                title="Revenue & profit"
                                subtitle="Tall 8-column tile"
                                spec={lineSpec}
                                variant="feature"
                                accent="chart-1"
                            />
                        </Tile>
                        <Tile size="md">
                            <ChartCard
                                title="Region rank"
                                subtitle="Medium tile"
                                spec={barRankedSpec}
                            />
                        </Tile>
                        <Tile size="md">
                            <ChartCard
                                title="Category mix"
                                subtitle="Medium tile"
                                spec={donutSpec}
                            />
                        </Tile>
                        <Tile size="full">
                            <DataTableCard
                                title="Region performance"
                                subtitle="Full-width detail"
                                spec={perfTableSpec}
                                height={280}
                            />
                        </Tile>
                    </DashboardGrid>
                </Section>

                <Section title="Layout — card variants">
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                        <Card
                            eyebrow="Surface"
                            title="Default tile"
                            variant="surface"
                        >
                            <p className="text-sm text-muted-foreground">
                                Bordered card surface for everyday dashboard content.
                            </p>
                        </Card>
                        <Card
                            eyebrow="Feature"
                            title="Primary tile"
                            variant="feature"
                            accent="chart-1"
                        >
                            <p className="text-sm text-muted-foreground">
                                Stronger surface plus an accent spine for emphasis.
                            </p>
                        </Card>
                        <Card
                            eyebrow="Outline"
                            title="Quiet frame"
                            variant="outline"
                        >
                            <p className="text-sm text-muted-foreground">
                                Transparent fill keeps secondary content light.
                            </p>
                        </Card>
                        <Card eyebrow="Ghost" title="Embedded" variant="ghost">
                            <p className="text-sm text-muted-foreground">
                                Frameless content for bands and nested compositions.
                            </p>
                        </Card>
                    </div>
                    <ChartCard
                        eyebrow="ChartCard"
                        title="Feature chart"
                        subtitle="New card hierarchy props"
                        spec={areaSpec}
                        variant="feature"
                        accent="chart-1"
                    />
                </Section>

                <Section title="Layout — section band">
                    <SectionBand title="This quarter" subtitle="vs. last">
                        <DashboardGrid>
                            <Tile size="md">
                                <ChartCard
                                    title="Channel mix"
                                    subtitle="Stacked area"
                                    spec={areaSpec}
                                />
                            </Tile>
                            <Tile size="md">
                                <ChartCard
                                    title="Quarterly bars"
                                    subtitle="Grouped channel revenue"
                                    spec={barGroupedSpec}
                                />
                            </Tile>
                        </DashboardGrid>
                    </SectionBand>
                </Section>

                <Section title="Layout — shells">
                    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                        <div className="relative h-[420px] overflow-auto rounded-2xl border border-border">
                            <PageShell
                                eyebrow="Preview"
                                title="Page shell"
                                subtitle="Single-column frame"
                                maxWidth="max-w-none"
                                actions={
                                    <button
                                        type="button"
                                        className="rounded-lg border border-border px-2.5 py-1 text-xs text-foreground-secondary"
                                    >
                                        Export
                                    </button>
                                }
                                toolbar={
                                    <FilterBar>
                                        <DropdownSlicer
                                            label="Region"
                                            field="Geography[Region]"
                                            options={regionOptions}
                                            multiple={false}
                                        />
                                    </FilterBar>
                                }
                            >
                                <StatStrip>
                                    <Stat
                                        label="Revenue"
                                        value={latestRevenue}
                                        valueFormat="currency"
                                        accent="chart-1"
                                    />
                                    <Stat
                                        label="Orders"
                                        value={latestOrders}
                                        accent="chart-2"
                                    />
                                </StatStrip>
                                <DashboardGrid>
                                    <Tile size="lg">
                                        <ChartCard
                                            title="Revenue trend"
                                            spec={lineSpec}
                                        />
                                    </Tile>
                                    <Tile size="lg">
                                        <ChartCard
                                            title="Category share"
                                            spec={donutSpec}
                                        />
                                    </Tile>
                                </DashboardGrid>
                            </PageShell>
                        </div>
                        <div className="relative h-[420px] overflow-auto rounded-2xl border border-border">
                            <SidebarShell
                                eyebrow="Preview"
                                title="Sidebar shell"
                                subtitle="Left rail plus content"
                                maxWidth="max-w-none"
                                rail={
                                    <>
                                        <div>
                                            <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-primary-strong">
                                                Filters
                                            </span>
                                            <p className="mt-1 text-sm text-muted-foreground">
                                                Persistent context rail.
                                            </p>
                                        </div>
                                        <ListSlicer
                                            label="Category"
                                            field="Product[Category]"
                                            options={categoryOptions}
                                        />
                                    </>
                                }
                                actions={
                                    <button
                                        type="button"
                                        className="rounded-lg border border-border px-2.5 py-1 text-xs text-foreground-secondary"
                                    >
                                        Refresh
                                    </button>
                                }
                            >
                                <DashboardGrid>
                                    <Tile size="full">
                                        <ChartCard
                                            title="Region performance"
                                            spec={barRankedSpec}
                                        />
                                    </Tile>
                                    <Tile size="full">
                                        <DataTableCard
                                            title="Detail table"
                                            spec={perfTableSpec}
                                            height={220}
                                        />
                                    </Tile>
                                </DashboardGrid>
                            </SidebarShell>
                        </div>
                    </div>
                </Section>

                <Section title="Slicers & filters">
                    <SlicersDemo />
                </Section>

                <Section title="Line & area">
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                        <ChartCard
                            title="Revenue & profit"
                            subtitle="Monthly, 2024 · multi-series line"
                            spec={lineSpec}
                        />
                        <ChartCard
                            title="Channel mix"
                            subtitle="Quarterly revenue · stacked area"
                            spec={areaSpec}
                        />
                    </div>
                </Section>

                <Section title="Bars">
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                        <ChartCard
                            title="Grouped"
                            subtitle="By quarter & channel"
                            spec={barGroupedSpec}
                        />
                        <ChartCard
                            title="Stacked"
                            subtitle="By quarter & channel"
                            spec={barStackedSpec}
                        />
                        <ChartCard
                            title="Ranked by region"
                            subtitle="Single measure"
                            spec={barRankedSpec}
                        />
                    </div>
                </Section>

                <Section title="Scatter & pie">
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                        <ChartCard
                            title="Price vs units"
                            subtitle="Bubble size = margin"
                            spec={scatterSpec}
                        />
                        <ChartCard
                            title="Category share"
                            subtitle="Donut"
                            spec={donutSpec}
                        />
                    </div>
                </Section>

                <Section title="Heatmap">
                    <ChartCard
                        title="Revenue by region & quarter"
                        subtitle="Category × category → color"
                        spec={heatmapSpec}
                        height={280}
                    />
                </Section>

                <Section title="Interactivity · cross-highlight">
                    <SelectionStoreProvider initial={{ region: seededRegion }}>
                        <CrossHighlightDemo />
                    </SelectionStoreProvider>
                </Section>

                <Section title="Interactivity · chart → DAX filter bridge">
                    <SelectionStoreProvider>
                        <BridgeDemo />
                    </SelectionStoreProvider>
                </Section>

                <Section title="Formatting · funnel & pie callouts">
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                        <ChartCard
                            title="Conversion funnel"
                            subtitle="Native funnel · % retained vs first"
                            spec={funnelSpec}
                        />
                        <ChartCard
                            title="Category share"
                            subtitle="Pie · outside callout labels"
                            spec={pieCalloutSpec}
                        />
                    </div>
                </Section>

                <Section title="Tables · Graphein table & matrix">
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                        <DataTableCard
                            title="Region performance"
                            subtitle="Conditional formatting · bar / scale / icon"
                            spec={perfTableSpec}
                            height={300}
                        />
                        <DataTableCard
                            title="Revenue by channel × quarter"
                            subtitle="Pivot matrix · grand totals"
                            spec={channelMatrixSpec}
                            height={300}
                        />
                    </div>
                </Section>

                <Section title="States">
                    <label className="flex items-center gap-2 text-sm text-foreground-secondary">
                        <input
                            type="checkbox"
                            checked={showStates}
                            onChange={(event) =>
                                setShowStates(event.target.checked)
                            }
                        />
                        Show loading / empty / error tiles
                    </label>
                    {showStates && (
                        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                            <ChartCard title="Loading">
                                <ChartSkeleton />
                            </ChartCard>
                            <ChartCard title="Empty">
                                <EmptyTile message="No rows match the current filters" />
                            </ChartCard>
                            <ChartCard title="Error">
                                <ErrorTile
                                    error={new Error("Query failed: timeout")}
                                    onRetry={() => undefined}
                                />
                            </ChartCard>
                        </div>
                    )}
                </Section>
            </div>
        </div>
    );
}
