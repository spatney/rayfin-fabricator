//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/**
 * Starter demo dashboard — **all visuals are Graphein specs**, powered by a
 * bundled real public dataset (Gapminder, see `./global-development.ts`).
 *
 * It exists so a freshly scaffolded app renders a complete, interactive dashboard
 * with no data connection. Every tile is one Graphein `ChartSpec` dropped into
 * `<ChartCard spec={…} />` — KPIs (`kpi`), a regional trend (`line`), a Gapminder
 * bubble chart (`scatter`), a most-populous ranking (`bar`, horizontal), a
 * population-share donut (`pie`), and a detail `table`. There are no bespoke React
 * chart components; the card owns theme, axes, formatting, and dark mode.
 *
 * Interactivity is 100% client-side (no Fabric / DAX): two slicers (year, region)
 * plus Power BI-style cross-filtering — click a donut slice or a bar and every
 * other tile re-filters through {@link applyFilters}, while the clicked chart
 * self-dims its unpicked marks. Swap the bundled data for a real semantic model to
 * ship your own app (see `AGENTS.md`); the wiring pattern is the same, only the
 * rows change from a static import to a DAX query.
 *
 * TIP — validate visuals headlessly: every spec here renders to a PNG + report
 * with `npm run preview -- --spec <file>` (via `@graphein/node`, no browser). Use
 * it to check each visual, and re-run it after you point the specs at real data.
 */

import { useMemo, useState } from "react";

import {
    applyFilters,
    ChartCard,
    crossHighlightParams,
    DashboardGrid,
    DropdownSlicer,
    FilterBar,
    PageShell,
    selectionsExcept,
    ThemeToggle,
    Tile,
    topN,
    useFilterState,
    useSelectionFilterBridge,
    useSelectionStore,
    type ChartSpec,
    type FilterSelection,
    type TableSpec,
} from "@/components/dashboard";

import {
    byRegionYear,
    byYear,
    DEV_DATA,
    LATEST_YEAR,
    popShareByRegion,
    regionOptions,
    topCountriesLimit,
    yearOptions,
} from "./global-development";

/* Field names double as row-object keys — `applyFilters` reads a filter on
 * `"region"` from each row's `region` property, `"country"` → `country`, etc. */
const FIELD_REGION = "region";
const FIELD_COUNTRY = "country";
const FIELD_YEAR = "year";

/** Signed fractional change `a` vs `b` (drives a KPI ▲/▼), or `undefined` if unknown. */
function pctChange(a: number | undefined, b: number | undefined): number | undefined {
    if (a == null || b == null || b === 0) return undefined;
    return (a - b) / b;
}

export function DemoDashboard() {
    // Year is a local parameter for the single-year snapshots (scatter / bar /
    // donut / table / KPI value). Region + country live in shared filter state so
    // the slicer AND chart cross-filtering drive them together.
    const [year, setYear] = useState<number>(LATEST_YEAR);
    const filters = useFilterState();
    const selections = filters.selections;

    // One shared selection bus for cross-filtering; the bridge maps chart clicks
    // (region / country) into the shared filter state so every tile re-filters.
    const store = useSelectionStore();
    useSelectionFilterBridge(store);

    const view = useMemo(() => {
        const yearSel: FilterSelection = {
            kind: "in",
            field: FIELD_YEAR,
            values: [year],
        };
        const regionCountry = Object.values(selections); // region + country picks
        // Base row sets, each honoring a different slice of the active selections:
        const rowsForYear = applyFilters(DEV_DATA, [...regionCountry, yearSel]);
        const rowsAllYears = applyFilters(DEV_DATA, regionCountry);
        // Cross-filter sources keep every mark (self-dim) by dropping their OWN field:
        const barBase = applyFilters(DEV_DATA, [
            ...Object.values(selectionsExcept(selections, FIELD_COUNTRY)),
            yearSel,
        ]);
        const donutBase = applyFilters(DEV_DATA, [
            ...Object.values(selectionsExcept(selections, FIELD_REGION)),
            yearSel,
        ]);

        const series = byYear(rowsAllYears);
        const currentIndex = series.findIndex((point) => point.year === year);
        const current = currentIndex >= 0 ? series[currentIndex] : undefined;
        const previous = currentIndex > 0 ? series[currentIndex - 1] : undefined;

        return {
            regionTrend: byRegionYear(rowsAllYears),
            scatterRows: rowsForYear,
            barRows: topN(barBase, "pop", topCountriesLimit),
            donutRows: popShareByRegion(donutBase),
            tableRows: [...rowsForYear].sort((a, b) => b.pop - a.pop),
            series,
            current,
            previous,
        };
    }, [selections, year]);

    const { current, previous, series } = view;

    /* ------------------------------- KPI band ------------------------------- *
     * Four Graphein `kpi` specs. Value = the selected year; delta = vs. the prior
     * available year; the sparkline traces the full trajectory from `series`.    */
    const kpiSpecs = useMemo<ChartSpec[]>(() => {
        const sparkFrom = (pick: (p: (typeof series)[number]) => number) =>
            series.map((point) => ({ year: point.year, value: pick(point) }));
        // A labeled "vs prior year" comparison row (signed percent) — omitted at
        // the earliest year, where there is no prior point to compare against.
        const comparison = (a: number | undefined, b: number | undefined) => {
            const change = pctChange(a, b);
            if (change == null || previous == null) return undefined;
            return [{ label: `vs ${previous.year}`, delta: change, format: ".1%" }];
        };

        const lifeExp: ChartSpec = {
            type: "kpi",
            label: "Life expectancy",
            value: current?.lifeExp ?? 0,
            format: ".1f",
            unit: " yrs",
            align: "start",
            comparisons: comparison(current?.lifeExp, previous?.lifeExp),
            data: sparkFrom((p) => p.lifeExp),
            sparkline: { field: "value", markers: true },
            description: `Population-weighted life expectancy in ${year}`,
        };
        const population: ChartSpec = {
            type: "kpi",
            label: "Total population",
            value: (current?.pop ?? 0) / 1e9,
            format: ",.2f",
            unit: "B",
            align: "start",
            comparisons: comparison(current?.pop, previous?.pop),
            data: sparkFrom((p) => p.pop / 1e9),
            sparkline: { field: "value", markers: true },
            description: `Total population in view in ${year}`,
        };
        const gdp: ChartSpec = {
            type: "kpi",
            label: "GDP per capita",
            value: current?.gdpPercap ?? 0,
            format: "$,.0f",
            align: "start",
            comparisons: comparison(current?.gdpPercap, previous?.gdpPercap),
            data: sparkFrom((p) => p.gdpPercap),
            sparkline: { field: "value", markers: true },
            description: `Population-weighted GDP per capita in ${year}`,
        };
        const countries: ChartSpec = {
            type: "kpi",
            label: "Countries in view",
            value: current?.countries ?? 0,
            format: ",.0f",
            align: "start",
            description: `Number of countries in view in ${year}`,
        };
        return [lifeExp, population, gdp, countries];
    }, [series, current, previous, year]);

    /* ------------------------------- Visuals -------------------------------- */
    const trendSpec = useMemo<ChartSpec>(
        () => ({
            type: "line",
            data: view.regionTrend,
            points: true,
            encoding: {
                x: { field: "year", type: "ordinal", title: "Year" },
                y: {
                    field: "lifeExp",
                    type: "quantitative",
                    title: "Life expectancy",
                    format: ".0f",
                },
                series: { field: "region" },
            },
            legend: true,
            description: "Population-weighted life expectancy by region, 1952–2007",
        }),
        [view.regionTrend],
    );

    const scatterSpec = useMemo<ChartSpec>(
        () => ({
            type: "scatter",
            data: view.scatterRows,
            encoding: {
                x: {
                    field: "gdpPercap",
                    type: "quantitative",
                    title: "GDP per capita",
                    format: "$,.0s",
                    scale: { type: "log" },
                },
                y: { field: "lifeExp", type: "quantitative", title: "Life expectancy" },
                size: { field: "pop", title: "Population" },
                color: { field: "region", title: "Region" },
            },
            legend: true,
            description: `Income vs. life expectancy by country in ${year} (bubble size = population)`,
        }),
        [view.scatterRows, year],
    );

    const barSpec = useMemo<ChartSpec>(
        () => ({
            type: "bar",
            data: view.barRows,
            orientation: "horizontal",
            cornerRadius: 4,
            ...crossHighlightParams(FIELD_COUNTRY, [FIELD_COUNTRY]),
            encoding: {
                x: { field: "country", type: "nominal" },
                y: {
                    field: "pop",
                    type: "quantitative",
                    title: "Population",
                    format: ",.2s",
                },
            },
            description: `Most populous countries in view in ${year} — click a bar to filter`,
        }),
        [view.barRows, year],
    );

    const donutSpec = useMemo<ChartSpec>(
        () => ({
            type: "pie",
            data: view.donutRows,
            donut: 0.62,
            ...crossHighlightParams(FIELD_REGION, [FIELD_REGION]),
            encoding: {
                theta: { field: "pop", type: "quantitative", format: ",.2s" },
                color: { field: "region" },
            },
            legend: true,
            description: `Population share by region in ${year} — click a slice to filter`,
        }),
        [view.donutRows, year],
    );

    const tableSpec = useMemo<TableSpec>(
        () => ({
            type: "table",
            data: view.tableRows,
            sort: { field: "pop", order: "desc" },
            columns: [
                { field: "country", title: "Country" },
                { field: "region", title: "Region" },
                {
                    field: "lifeExp",
                    title: "Life expectancy",
                    format: ".1f",
                    align: "right",
                    conditionalFormat: { type: "bar", showValue: true },
                },
                {
                    field: "gdpPercap",
                    title: "GDP per capita",
                    format: "$,.0f",
                    align: "right",
                    conditionalFormat: {
                        type: "colorScale",
                        scheme: "teal",
                        target: "background",
                    },
                },
                { field: "pop", title: "Population", format: ",.0f", align: "right" },
            ],
        }),
        [view.tableRows],
    );

    return (
        <PageShell
            eyebrow="Gapminder · 1952–2007"
            title="Global development explorer"
            subtitle={`Life expectancy, income, and population — ${year}`}
            actions={<ThemeToggle />}
            toolbar={
                <FilterBar>
                    <DropdownSlicer
                        label="Year"
                        options={yearOptions}
                        value={[year]}
                        onChange={(values) => {
                            const next = values[0];
                            if (next != null) setYear(Number(next));
                        }}
                        multiple={false}
                        searchable={false}
                    />
                    <DropdownSlicer
                        label="Region"
                        field={FIELD_REGION}
                        options={regionOptions}
                    />
                </FilterBar>
            }
        >
            {/* KPI band — four Graphein `kpi` scorecards. */}
            <DashboardGrid>
                {kpiSpecs.map((spec, index) => (
                    <Tile key={index} size="sm">
                        <ChartCard spec={spec} height={150} />
                    </Tile>
                ))}
            </DashboardGrid>

            {/* Trend + composition. */}
            <DashboardGrid>
                <Tile size="wide">
                    <ChartCard
                        title="Life expectancy by region"
                        subtitle="Population-weighted, 1952–2007"
                        accent="chart-1"
                        spec={trendSpec}
                        height={360}
                    />
                </Tile>
                <Tile size="md">
                    <ChartCard
                        title="Population share"
                        subtitle={`${year} · click a region to filter`}
                        spec={donutSpec}
                        store={store}
                        height={360}
                    />
                </Tile>
            </DashboardGrid>

            {/* Bubble + ranking. */}
            <DashboardGrid>
                <Tile size="md">
                    <ChartCard
                        title="Income vs. life expectancy"
                        subtitle={`${year} · bubble = population`}
                        spec={scatterSpec}
                        height={360}
                    />
                </Tile>
                <Tile size="wide">
                    <ChartCard
                        title="Most populous countries"
                        subtitle={`${year} · click a bar to filter`}
                        spec={barSpec}
                        store={store}
                        height={360}
                    />
                </Tile>
            </DashboardGrid>

            {/* Detail table. */}
            <DashboardGrid>
                <Tile size="full">
                    <ChartCard
                        title="Country detail"
                        subtitle={`${year} · sorted by population`}
                        spec={tableSpec}
                    />
                </Tile>
            </DashboardGrid>
        </PageShell>
    );
}
