# Data App — agent guide

> **You're an agent** working on a React-based **Fabric Analytics** data app:
> connect a Power BI semantic model, query it with DAX, and build a dashboard by
> **authoring Graphein chart specs** and dropping them into a small set of kit tiles
> (including Graphein `table` / `matrix` specs for tabular data). This file is your
> top-level orientation.
>
> **Two things to internalize before writing code:**
> 1. **Author a spec, don't hand-write a chart.** A chart is one JSON
>    `ChartSpec` (the `graphein` npm package, `^0.13.0`) passed to
>    `<ChartCard spec={…} />`. Map your DAX result into rows, author the spec,
>    drop it in. Hand-writing SVG/JSX or wiring a chart library yourself is the
>    slow, expensive path. The spec model is the `visuals` skill — read it first.
> 2. **Ship fast, then iterate.** Follow the `build-workflow` skill: one real
>    hero tile → preview → ship automatically → user review → expand. Don't
>    front-load schema discovery or theming.
>
> **Agent context lives in `.agents/skills/`** (build-workflow, visuals,
> headless-preview, app-design, dax, fabric-data). Pull each skill in as its phase
> needs it — start at its **Fast path** and read deeper references only on demand.

---

## What this app is

A read-only analytics dashboard over a Power BI semantic model. It authenticates
through Fabric and renders **inside the Fabric portal shell** — it is meant to be
opened from a deployed Fabric workspace, not `localhost`. There is **no local
backend or dev server** for app validation: preview every visual headlessly, then
let Fabricator's automatic after-turn deploy ship the app for user review.

**The scaffold ships a complete, interactive demo dashboard** (`src/demo/`,
rendered by `App.tsx`) built **entirely from Graphein specs** on a small bundled
**real public dataset** (Gapminder — life expectancy, income, population). It
needs no data connection, so a fresh app is alive on first run and demonstrates
the golden path end to end: one spec per tile (KPIs, line, scatter, horizontal
bar, donut, table), slicers over shared filter state, and click cross-filtering.
**When you build the real app, delete `src/demo/**` and replace `<DemoDashboard/>`
with your own page wired to the semantic model** (the wiring pattern is identical
— only the data source changes from a static import to a DAX query).

**Graphein renders headlessly** — the same engine that draws in the browser also
rasterizes a spec to a PNG in Node (`@graphein/node`), so `npm run preview -- --spec
<file>` renders any Graphein chart spec to a **PNG + a machine-readable report**
(clipping / overlap / contrast / counts) with **no browser and no Fabric**:

> - **Offline (inlined `spec.data`)** — validates the bundled demo specs, and any
>   spec whose rows you paste in. This is how you eyeball a visual right now.
> - **Live (`--query` / `--data`)** — injects rows from a real `fabric-app-data
>   query` before rendering, to validate visuals once you're on the model.

KPI/table/matrix/slicers/dashboard rasterize to PNG too. **Preview-validate every
visual this way** — the demo specs today, your real specs after you swap the data.
See the `headless-preview` skill.

> **Never ship mock/fake data or "under construction" tiles in the real app.** The
> only sanctioned placeholder is the clearly-labeled starter data under
> `src/demo/**`, shipped so the template looks alive on first run — **delete it when
> you wire real data.** After that it's real data or an honest empty/loading/error
> state, nothing in between. A tile with no data shows the card's empty state.

---

## Architecture at a glance

```
Power BI semantic model (Fabric)
  └─→ DAX query (useSemanticModelQuery)
        └─→ map the result (toChartData / toTable / deriveKpi)
              └─→ author a Graphein ChartSpec → <ChartCard spec={…} />
                    (or <KpiCard …> / <DataTableCard spec={…} />)
```

- **DAX computes and fetches**, aggregated to the visual's grain.
- **TypeScript maps** the positional query result into the shape a tile wants —
  `toChartData(result)` for charts (an array of plain row objects you pass as
  `spec.data`), or `toTable(result, { columns })` for a Graphein `table` spec.
  Hand-author a `matrix` spec over `toChartData(result)` rows for pivots. Helpers
  accept the query result, a raw table, or `undefined` — no `status` check needed.
- **You author one `ChartSpec`** — a single JSON object describing the visual
  (`type` + `data` + `encoding`). `validateSpec(spec)` (re-exported from the kit)
  checks it before render.
- **`ChartCard` renders the spec.** The card owns the loading / empty / error
  states and bridges the app's CSS theme into Graphein; Graphein owns axes,
  tooltip, legend, number/date formatting, responsive sizing, animation, dark
  mode, and optional selections.

`fabric.yaml` declares the semantic-model connection; `src/fabric.generated.ts`
is regenerated from it by `build:fabric` (`fabric-app-data generate`). Don't
hand-edit the generated file — edit `fabric.yaml`.

---

## Layout

```
.
├── AGENTS.md                       ← you are here
├── .agents/skills/                 ← build-workflow, visuals, headless-preview,
│                                     app-design, dax, fabric-data
├── fabric.yaml                     ← Fabric data connections (semantic model profiles)
├── rayfin/rayfin.yml               ← Fabric service config (auth + static hosting)
├── src/
│   ├── App.tsx                     ← your dashboard (renders the src/demo/ starter; replace it)
│   ├── demo/                       ← bundled all-Graphein demo on real public data
│   │                                 (Gapminder) — delete when you wire the real model
│   ├── main.tsx                    ← entry: fonts, theme, auth provider, auth gate
│   ├── global.css                  ← design system: tokens, palette, fonts, dark mode
│   ├── components/dashboard/       ← THE KIT — PageShell, StatStrip, DashboardGrid,
│   │                                 Tile, ChartCard, KpiCard, DataTableCard, controls,
│   │                                 slicers, states, Graphein <Chart>
│   │   └── selection.tsx           ← shared Graphein selection store provider/hooks
│   ├── hooks/
│   │   ├── use-semantic-model-query.ts   ← run a DAX query → { data, isLoading, error }
│   │   ├── use-theme.ts / theme.context.ts
│   │   └── use-auth.tsx / auth.context.ts
│   ├── lib/
│   │   ├── to-chart-data.ts        ← query result → chart row objects (spec `data`)
│   │   ├── to-table.ts             ← query result → Graphein table spec
│   │   ├── selection-bridge.ts     ← chart selections → shared slicer state / DAX path
│   │   ├── derive-kpi.ts / top-n.ts / pivot-chart-data.ts ← shape rows for KPIs / ranking / series
│   │   ├── graphein-theme.ts       ← bridges CSS tokens → Graphein chart theme
│   │   ├── chartTokens.ts          ← KPI accent / semantic-role color helpers
│   │   ├── format.ts               ← number / date / percent formatters
│   │   └── utils.ts                ← cn()
│   └── services/                   ← Fabric auth wiring
└── package.json
```

The kit is exported from one barrel: **`@/components/dashboard`** — frames
(`PageShell`, `SidebarShell`, `AppShell`), layout (`StatStrip` / `Stat`,
`DashboardGrid` / `Tile`, `SectionBand`; legacy grids still exist), `ChartCard`,
`KpiCard`, `DataTableCard`, controls,
slicers + filter helpers, `validateSpec` + the `ChartSpec` type (re-exported from
`graphein`), selection helpers (`createSelectionStore`, `SelectionStoreProvider`,
`useSelectionStore`, `useSelection`, `useSelectionFilterBridge`,
`selectionToFilters`, `filterToSelection`), and mapping helpers (`toChartData` /
`toTable` / `deriveKpi` / `topN` / `pivotChartData` / `format`).

---

## Quick commands

```bash
npm run build:fabric    # fabric-app-data generate + tsc + vite build
npm run preview -- --spec <file>   # render a spec headlessly → PNG + report — offline (inlined data) or --query/--data for live (see headless-preview)
npm run lint            # ESLint
npm run gallery         # dev-only component gallery (visual validation, no Fabric)
```

There is no meaningful `npm run dev` workflow — outside the Fabric embed the app
has no auth host and KPIs render error tiles. Use `npm run preview` for every
visual validation before Fabricator's automatic after-turn deploy ships the app.

---

## Conventions you'll hit

### Author a spec, drop it in a tile (the main cost lever)
The flow is always: **fetch** with `useSemanticModelQuery` → **map** with
`toChartData` / `toTable` → **author** one Graphein `ChartSpec` → **pass** `spec`
+ `loading` + `error` to `<ChartCard>` or `<DataTableCard>` (KPIs use
`<KpiCard>`). Don't pre-render skeletons/empty states yourself; the cards do it.
If a chart type isn't in Graphein, re-express it with the closest Graphein type —
there is no custom-chart escape hatch (see `visuals` → Gotchas).

### Multi-series comes from the data, not from pre-pivoting
Keep query rows **long/tidy** (one row per category × series) and point
`encoding.series` at the series column. Don't pivot into wide columns; only reach
for `pivotChartData` when a helper genuinely needs a wide shape.

### Formatting lives in the spec; color lives in the tokens
Emit raw typed numbers from DAX (never `FORMAT()` to text). Format **inside the
spec** with Graphein's format mini-language (axis/label `format: "$,.0f"`, `".1%"`,
`"%b %Y"`), use `KpiCard`'s `valueFormat`, and use table/matrix column/value
`format` plus `conditionalFormat` for tabular visuals. **Don't put `theme` or
per-series colors in a spec** — `ChartCard` auto-bridges the app theme, so recolor
by editing `--color-chart-1..10` in `src/global.css`. See the `visuals` skill's
`formatting.md`.

### Interactivity is additive
React slicers + shared filter state + server-side DAX re-query are the primary
filter path. **The bundled demo (`src/demo/DemoDashboard.tsx`) is a complete,
working example** — slicers over shared filter state in the `PageShell` toolbar
(wrapped in `FilterStateProvider`) plus Power BI–style click cross-filtering; copy
its wiring, then point the rows at your model. Graphein selections cross-highlight
via a shared `store`, and `useSelectionFilterBridge` bridges chart clicks into the
same slicer/DAX path — or, simplest, `useCrossHighlight` (the clicked source dims
its own marks while the page filters).

### Theming is token-driven
`src/global.css` is the single source of truth: a semantic palette,
`--color-chart-1..10`, display/sans/mono fonts, a radius scale, dark-mode
overrides under `.dark`. The defaults mirror **Graphein's native theme** (teal
accent, slate neutrals, Inter, the 10-hue palette) so chrome and charts ship
unified. The accent is one swappable family (`--color-primary` +
`--color-chart-1` + `--color-brand` + `--color-ring`). Restyle by editing
tokens, not by hardcoding values in components or specs.

### Connection IDs have one source
Edit `fabric.yaml`; let `build:fabric` regenerate `src/fabric.generated.ts`.
Never hand-edit the generated file.

---

## If you're asked to…

| Task | Start here |
|---|---|
| Build a dashboard from scratch | `build-workflow` skill (preview one hero tile, then ship and iterate) |
| Pick a dashboard layout / shape | `app-design` skill → **Dashboard archetypes** (executive / operational / analytical) |
| Add a chart | `visuals` skill — map data, author a Graphein spec, drop into `<ChartCard spec={…}>` |
| Add a KPI header / metric strip | `visuals` skill → `StatStrip` + `Stat` (one band, 2–5 metrics) |
| Add a standalone KPI / metric tile | `visuals` skill → `KpiCard` (+ `deriveKpi`) |
| Add a table | `visuals` skill → `DataTableCard` (+ `toTable`) |
| Find a metric / explore the model | `dax` skill (progressive discovery, then query authoring) |
| Write or fix a DAX query | `dax` skill |
| Decide DAX vs. TypeScript for a transform | `dax` skill (responsibility matrix) |
| Make it look stunning / theme it | `app-design` skill + edit `src/global.css` tokens |
| Add a lightweight filter / segmented control | `visuals` skill (Controls) — own the value in React state |
| Add Power BI-style slicers (shared filter state) | `visuals` skill → **Slicers & shared filter state** (`FilterStateProvider` + `FilterBar`/`DropdownSlicer`/…) |
| Add chart-click cross-highlight/filter | `visuals` skill → **Interactivity** — Power BI–style by default (`useCrossHighlight` + `crossHighlightParams`: source dims, page filters) |
| Preview/critique a visual vs live data (no deploy) | `headless-preview` skill — `npm run preview` renders a spec to a PNG + report |
| Validate/repair a spec | `visuals` skill — `validateSpec` / `repairSpec` (graphein 0.13); or `npm run preview` (does it for you) |
| Visually validate kit components without Fabric | run the dev-only component gallery (`npm run gallery`) |
| Show many series / a target line | `visuals` skill → **Multi-series** (long rows + `encoding.series`; target line = `annotations: [{ type:"line", value }]`) |
| Show two measures on different scales | `visuals` skill → `combo` (dual-axis) |
| Add a page frame | `app-design` skill → `PageShell` (or `SidebarShell` for filter-heavy analytics) |
| Vary card sizes / non-uniform layout | `visuals` skill → `DashboardGrid` + `Tile size="…"` (`hero` cards need `className="h-full"`) |
| Break a long dashboard into zones | `app-design` skill → `SectionBand` |
| Update legacy uniform grids | Replace `KpiGrid`/`ChartGrid`/`BentoGrid` with `StatStrip` and `DashboardGrid` + `Tile` where practical |
| Build a chart Graphein lacks (radar/sunburst/…) | `visuals` skill → **Gotchas** + `custom-charts` ref — re-express with the closest type (0.13 includes treemap/gauge/bullet/waterfall/funnel/combo/horizontal bars/…) |
| Wire/connect a semantic model | `fabric-data` skill; edit `fabric.yaml`. If only workspace + item id is known, use `fabric-app-data add <alias> -w <ws> -i <item>`. |
| Ship for review | Let Fabricator's automatic after-turn deploy publish the app; do not use manual app deployment as validation. |

---

## Pointers, not duplication

- **`.agents/skills/build-workflow/SKILL.md`** — START HERE; the fast,
  iterative "time to wow" loop that orchestrates the other skills.
- **`.agents/skills/visuals/SKILL.md`** — the spec model: map data → author a
  Graphein `ChartSpec` → drop into a tile; the type-picker, recipes, declarative
  features (transform/annotations/insights/trendline/facet), gotchas,
  `KpiCard` / table-matrix visuals, slicers, interactivity, and formatting/color.
- **`.agents/skills/headless-preview/SKILL.md`** — render one spec headlessly
  against live data (`npm run preview`) → PNG + report; the query→render→critique
  validation loop, reading the report, and validate→repair.
- **`.agents/skills/dax/SKILL.md`** — progressive schema discovery, DAX-vs-TypeScript ownership, query authoring/testing, filters, time intelligence, and anti-patterns.
- **`.agents/skills/fabric-data/SKILL.md`** — semantic-model connection management, `fabric.yaml`/generated config, CLI query testing, and runtime query-result handling.
- **`.agents/skills/app-design/SKILL.md`** — aesthetic direction, typography,
  layout, and the Final Audit.

If your task is purely UI, this file + the `visuals` skill are enough. If you're
touching DAX, read `dax`; if you're wiring data, read `fabric-data`.
