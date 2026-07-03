//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { FilterStateProvider, SelectionStoreProvider } from "@/components/dashboard";

import { DemoDashboard } from "./demo/DemoDashboard";

/**
 * App entry.
 *
 * The scaffold ships a complete, interactive **demo dashboard built entirely from
 * Graphein specs** on a bundled real public dataset (Gapminder — life expectancy,
 * income, population by country × year). See `src/demo/DemoDashboard.tsx` and
 * `src/demo/global-development.ts`. It renders with **no data connection**, so a
 * freshly scaffolded app looks alive immediately and demonstrates the golden path:
 * one Graphein `ChartSpec` per tile (KPIs, line, scatter, horizontal bar, donut,
 * table), slicers over shared filter state, and Power BI-style click cross-filtering.
 *
 * To build YOUR app: delete `src/demo/**`, connect a Power BI semantic model in
 * `fabric.yaml`, query it with DAX, map the result with `toChartData` / `toTable`,
 * and author one spec per tile. The demo's structure is exactly the pattern you'll
 * use — only the data source changes (static import → DAX query). The fully-wired
 * real-data reference lives in the comment block below and in `AGENTS.md` + the
 * `app-design` / `visuals` / `build-workflow` skills.
 *
 * Validate every visual **headlessly** with `npm run preview` (Graphein renders via
 * `@graphein/node`, no browser) — before AND after you switch to real data. See the
 * `headless-preview` skill.
 */
function App() {
    return (
        <FilterStateProvider>
            <SelectionStoreProvider>
                <DemoDashboard />
            </SelectionStoreProvider>
        </FilterStateProvider>
    );
}

/*
 * ───────────────────────────────────────────────────────────────────────────
 * REAL-DATA GOLDEN PATH (replaces the bundled `DemoDashboard`): the same layout,
 * fully wired (fetch → map → spec) against a Power BI semantic model, with slicers
 * over shared filter state AND Power BI–style cross-filtering on by default —
 * clicking a bar dims that chart's unpicked marks while every OTHER tile re-queries
 * (server-side DAX) for the click. Replace the connection alias, DAX, and column
 * names with your model's, then render <Dashboard /> instead of <DemoDashboard />.
 * The cards own loading/empty/error.
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
