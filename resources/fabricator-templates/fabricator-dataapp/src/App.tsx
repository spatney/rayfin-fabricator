//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import {
    Card,
    ChartCard,
    DashboardGrid,
    DateRangeSlicer,
    EmptyTile,
    FilterBar,
    FilterStateProvider,
    PageShell,
    SelectionStoreProvider,
    Stat,
    StatStrip,
    ThemeToggle,
    Tile,
} from "@/components/dashboard";

/**
 * Starter dashboard — your canvas, kept deliberately simple.
 *
 * It models the **executive-summary** archetype: a small KPI band, one hero trend,
 * two breakdowns. Each visual is one Graphein `ChartSpec` dropped into
 * `<ChartCard spec={…} />`; the card owns theme, axes, formatting, dark mode, and
 * loading/empty/error states. Tiles start empty (no mock data) — wire a query, map
 * it with `toChartData`, author a spec, drop it in. Rebrand via `src/global.css`.
 *
 * One slicer ships wired to shared filter state; add more from `useSlicerOptions`.
 * Switch archetypes (operational / analytical) via the commented examples below.
 * Full recipe: `AGENTS.md` + the `app-design` / `visuals` skills.
 */
function Dashboard() {
    return (
        <PageShell
            eyebrow="Your workspace"
            title="Your data app"
            subtitle="One JSON spec per visual — wire your model, drop in tiles"
            actions={<ThemeToggle />}
            toolbar={
                // One slicer to start. Swap options={[]} for
                // useSlicerOptions({ connection, field }); selections drive every tile.
                <FilterBar>
                    <DateRangeSlicer label="Date" field="Date[Date]" />
                </FilterBar>
            }
        >
            {/* One-line starter hint — delete once you wire real tiles. */}
            <Card variant="feature" accent="brand">
                <p className="text-sm text-muted-foreground">
                    Connect a model in <code className="font-mono">fabric.yaml</code>,
                    query it with DAX, then author a Graphein spec per tile. The cards
                    below stay empty until you pass them <code className="font-mono">spec</code>.
                </p>
            </Card>

            {/* Metric band — one strip, not four look-alike boxes. */}
            <StatStrip>
                {KPI_PLACEHOLDERS.map((kpi) => (
                    <Stat key={kpi.label} label={kpi.label} value="—" accent={kpi.accent} />
                ))}
            </StatStrip>

            {/* Varied grid — one hero + two breakdowns. Add a `full` table tile later. */}
            <DashboardGrid>
                <Tile size="hero">
                    <ChartCard
                        title="Trend"
                        accent="chart-1"
                        className="h-full"
                        bodyClassName="flex flex-1 flex-col"
                    >
                        <EmptyTile message="Pass a line/area spec" className="flex-1" />
                    </ChartCard>
                </Tile>
                <Tile size="md">
                    <ChartCard title="Breakdown">
                        <EmptyTile message="Pass a bar spec" height={200} />
                    </ChartCard>
                </Tile>
                <Tile size="md">
                    <ChartCard title="Composition">
                        <EmptyTile message="Pass a pie spec" height={200} />
                    </ChartCard>
                </Tile>
            </DashboardGrid>
        </PageShell>
    );
}

const KPI_PLACEHOLDERS = [
    { label: "Metric one", accent: "chart-1" },
    { label: "Metric two", accent: "chart-2" },
    { label: "Metric three", accent: "chart-3" },
] as const;

function App() {
    return (
        <FilterStateProvider>
            <SelectionStoreProvider>
                <Dashboard />
            </SelectionStoreProvider>
        </FilterStateProvider>
    );
}

/*
 * ───────────────────────────────────────────────────────────────────────────
 * COPY-PASTE STARTER: the golden-path layout, fully wired (fetch → map → spec)
 * with slicers over shared filter state AND Power BI–style cross-filtering on by
 * default — clicking a bar dims that chart's unpicked marks while every OTHER
 * tile re-queries (server-side DAX) for the click. Replace the connection alias,
 * DAX, and column names for your model's. The cards own loading/empty/error.
 *
 * Keep DAX results LONG (tidy): one row per category/time point. For multiple
 * series, add a category column and set `encoding.series` — no client-side
 * pivot needed. For ranked bars use `topN(...)`. See the `visuals` skill for the
 * full spec reference and examples.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * import { useMemo } from "react";
 * import { useSemanticModelQuery } from "@/hooks/use-semantic-model-query";
 * import {
 *   PageShell, ThemeToggle, StatStrip, Stat,
 *   DashboardGrid, Tile, ChartCard, toChartData, applyFilters,
 *   FilterStateProvider, FilterBar, DropdownSlicer, DateRangeSlicer,
 *   SelectionStoreProvider, useFilterState, useSlicerOptions,
 *   useCrossHighlight, crossHighlightParams, toDaxFilters,
 * } from "@/components/dashboard";
 *
 * const REGION = "Geography[Region]";
 * const REVENUE_BY_REGION = `
 *   EVALUATE
 *   SUMMARIZECOLUMNS('Geography'[Region], "Revenue", [Total Revenue], "Orders", [Order Count])
 *   ORDER BY 'Geography'[Region]
 * `;
 *
 * function Dashboard() {
 *   const filters = useFilterState();
 *   const region = useSlicerOptions({ connection: "sales", field: REGION });
 *   // Power BI–style source: clicks dim THIS chart's bars, cross-filter the rest.
 *   const pick = useCrossHighlight(REGION);
 *
 *   // OTHER tiles filter to the click + slicers (server-side DAX re-query).
 *   const dax = toDaxFilters(filters.selections);
 *   const { data, isLoading, error, refetch } = useSemanticModelQuery({
 *     connection: "sales", query: REVENUE_BY_REGION, filters: dax,
 *   });
 *   const rows = toChartData(data, { columns: { Region: REGION, revenue: "Revenue", orders: "Orders" } });
 *   // The SOURCE bar keeps ALL bars (dims unpicked) — exclude its own field:
 *   const barRows = useMemo(() => applyFilters(rows, pick.own(filters.selections)), [rows, filters.selections]);
 *
 *   return (
 *     <PageShell eyebrow="Sales" title="Revenue overview" subtitle="FY24"
 *       actions={<ThemeToggle />}
 *       toolbar={
 *         <FilterBar>
 *           <DropdownSlicer label="Region" field={REGION}
 *             options={region.options} isLoading={region.isLoading} error={region.error} />
 *           <DateRangeSlicer label="Date" field="Date[Date]" />
 *         </FilterBar>
 *       }
 *     >
 *       <StatStrip>
 *         <Stat label="Revenue" data={rows} valueKey="revenue" valueFormat="currency" accent="chart-1" loading={isLoading} />
 *         <Stat label="Orders" data={rows} valueKey="orders" loading={isLoading} />
 *       </StatStrip>
 *
 *       <DashboardGrid>
 *         <Tile size="hero">
 *           <ChartCard title="Revenue by region" className="h-full" store={pick.store}
 *             loading={isLoading} error={error} onRetry={refetch}
 *             spec={{ type: "bar", data: barRows,
 *               encoding: { x: { field: "Region" }, y: { field: "revenue", type: "quantitative", format: "$,.0f" } },
 *               ...crossHighlightParams(REGION, [REGION]) }} />
 *         </Tile>
 *         <Tile size="md">
 *           <ChartCard title="Orders by region" store={pick.store}
 *             loading={isLoading} error={error} onRetry={refetch}
 *             spec={{ type: "bar", data: rows,
 *               encoding: { x: { field: "Region" }, y: { field: "orders", type: "quantitative" } } }} />
 *         </Tile>
 *       </DashboardGrid>
 *     </PageShell>
 *   );
 * }
 *
 * function App() {
 *   return (
 *     <FilterStateProvider>
 *       <SelectionStoreProvider>
 *         <Dashboard />
 *       </SelectionStoreProvider>
 *     </FilterStateProvider>
 *   );
 * }
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ARCHETYPE ALTERNATES — the starter above is EXECUTIVE SUMMARY. Two other
 * shapes fit different jobs (see app-design → dashboard-archetypes.md):
 *
 * // OPERATIONAL MONITORING — dense, UNIFORM grid; status colors; live detail.
 * <PageShell eyebrow="Operations" title="Service health" subtitle="Last 24h" actions={<ThemeToggle />}>
 *   <StatStrip>
 *     <Stat label="Open" data={s} valueKey="open" accent="chart-3" />
 *     <Stat label="SLA breaches" data={s} valueKey="breaches" delta={4.2} invertDelta accent="chart-6" />
 *   </StatStrip>
 *   <DashboardGrid>{queues.map((q) => <Tile key={q.id} size="sm"><ChartCard title={q.name} spec={q.spec} /></Tile>)}</DashboardGrid>
 *   <DataTableCard title="Active incidents" spec={incidentTable} height={420} />
 * </PageShell>
 *
 * // ANALYTICAL DEEP-DIVE — SidebarShell filter rail + cross-filtered grid.
 * <SidebarShell eyebrow="Analytics" title="Sales explorer" actions={<ThemeToggle />}
 *   rail={<FilterBar><DropdownSlicer label="Region" field="Geography[Region]" options={r} /><ListSlicer label="Category" field="Product[Category]" options={c} /></FilterBar>}>
 *   <DashboardGrid>
 *     <Tile size="hero"><ChartCard title="By region" className="h-full" store={pick.store} spec={barSpec} /></Tile>
 *     <Tile size="md"><ChartCard title="Trend" spec={lineSpec} /></Tile>
 *     <Tile size="full"><DataTableCard title="Detail" spec={tableSpec} /></Tile>
 *   </DashboardGrid>
 * </SidebarShell>
 */

export default App;
