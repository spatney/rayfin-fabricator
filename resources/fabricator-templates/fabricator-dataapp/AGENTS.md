# Data App — agent guide

> **You're an agent** working on a React-based **Fabric Analytics** data app:
> connect a Power BI semantic model, query it with DAX, and build a dashboard by
> **authoring Graphein chart specs** and dropping them into a small set of kit tiles
> (including Graphein `table` / `matrix` specs for tabular data). This file is your
> top-level orientation.
>
> **Two things to internalize before writing code:**
> 1. **Author a spec, don't hand-write a chart.** A chart is one JSON
>    `ChartSpec` (the `graphein` npm package, `^0.3.0`) passed to
>    `<ChartCard spec={…} />`. Map your DAX result into rows, author the spec,
>    drop it in. Hand-writing SVG/JSX or wiring a chart library yourself is the
>    slow, expensive path. The spec model is the `visuals` skill — read it first.
> 2. **Ship fast, then iterate.** Follow the `build-workflow` skill: one real
>    hero tile → deploy → review → expand. Don't front-load schema discovery or
>    theming.
>
> **Agent context lives in `.agents/skills/`** (build-workflow, visuals, app-design, dax, fabric-data). Pull each skill in as its phase needs it — start at its **Fast
> path** and read deeper references only on demand.

---

## What this app is

A read-only analytics dashboard over a Power BI semantic model. It authenticates
through Fabric and renders **inside the Fabric portal shell** — it is meant to be
opened from a deployed Fabric workspace, not `localhost`. There is **no local
backend, dev server, or test harness**: you build, deploy to a Fabric test
workspace, and review the running app. In Rayfin Fabricator that deploy +
screenshot loop is fast and automatic — use it constantly.

> **Never ship mock/fake data or "under construction" tiles.** A tile with no
> data shows the card's empty state. Real data or an honest empty/loading/error
> state — nothing in between.

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
├── .agents/skills/                 ← build-workflow, visuals, app-design,
│                                     dax, fabric-data
├── fabric.yaml                     ← Fabric data connections (semantic model profiles)
├── rayfin/rayfin.yml               ← Fabric service config (auth + static hosting)
├── src/
│   ├── App.tsx                     ← your dashboard (ships a spec-first starter)
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
npm run build:fabric    # fabric-app-data generate + tsc + vite build (deploy entrypoint)
npm run lint            # ESLint
npm run gallery         # dev-only component gallery (visual validation, no Fabric)
npm run rayfin:up       # deploy the app to a Fabric test workspace
```

There is no meaningful `npm run dev` workflow — outside the Fabric embed the app
has no auth host and KPIs render error tiles. Deploy and review instead.

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
filter path. **The starter already ships a `FilterBar` of slicers in the
`PageShell` toolbar, wrapped in `FilterStateProvider`** — populate their options
and every tile reads the same selections. Graphein 0.3 selections can also
cross-highlight via a shared `store`, or bridge chart clicks into the same
slicer/DAX path with `useSelectionFilterBridge`.

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
| Build a dashboard from scratch | `build-workflow` skill (ship one hero tile, then iterate) |
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
| Add chart-click cross-highlight/filter | `visuals` skill → **Interactivity** (`SelectionStoreProvider` + `useSelectionFilterBridge`) |
| Preview/validate visuals locally without Fabric | run the dev-only component gallery (`npm run gallery`) |
| Show many series / a target line | `visuals` skill → **Multi-series** (long rows + `encoding.series`; target = a constant series) |
| Add a page frame | `app-design` skill → `PageShell` (or `SidebarShell` for filter-heavy analytics) |
| Vary card sizes / non-uniform layout | `visuals` skill → `DashboardGrid` + `Tile size="…"` (`hero` cards need `className="h-full"`) |
| Break a long dashboard into zones | `app-design` skill → `SectionBand` |
| Update legacy uniform grids | Replace `KpiGrid`/`ChartGrid`/`BentoGrid` with `StatStrip` and `DashboardGrid` + `Tile` where practical |
| Build a chart Graphein lacks (radar/treemap/…) | `visuals` skill → **Gotchas** — re-express with the closest Graphein type |
| Wire/connect a semantic model | `fabric-data` skill; edit `fabric.yaml`. If only workspace + item id is known, use `fabric-app-data add <alias> -w <ws> -i <item>`. |
| Deploy to test | `npm run rayfin:up` (or let Fabricator deploy + screenshot) |

---

## Pointers, not duplication

- **`.agents/skills/build-workflow/SKILL.md`** — START HERE; the fast,
  iterative "time to wow" loop that orchestrates the other skills.
- **`.agents/skills/visuals/SKILL.md`** — the spec model: map data → author a
  Graphein `ChartSpec` → drop into a tile; the type-picker, recipes, gotchas,
  `KpiCard` / table-matrix visuals, slicers, interactivity, and formatting/color.
- **`.agents/skills/dax/SKILL.md`** — progressive schema discovery, DAX-vs-TypeScript ownership, query authoring/testing, filters, time intelligence, and anti-patterns.
- **`.agents/skills/fabric-data/SKILL.md`** — semantic-model connection management, `fabric.yaml`/generated config, CLI query testing, and runtime query-result handling.
- **`.agents/skills/app-design/SKILL.md`** — aesthetic direction, typography,
  layout, and the Final Audit.

If your task is purely UI, this file + the `visuals` skill are enough. If you're
touching DAX, read `dax`; if you're wiring data, read `fabric-data`.
