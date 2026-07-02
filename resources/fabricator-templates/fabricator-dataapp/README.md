# Data App

A **Fabric Analytics** React + Vite app: connect a Power BI semantic model,
query it with DAX, and **compose stunning dashboards from a pre-built component
kit** powered by Graphein specs (charts plus `table` / `matrix`) — tuned for the
**Fabricator** deploy-to-test workflow.

> This is a Fabricator template: there is **no local backend, dev server, or
> test harness**. You build your app and deploy it to a Fabric test workspace —
> the Fabricator agent does this for you and validates the running app in its
> built-in browser.

## The dashboard kit

You rarely hand-write chart code. The kit in `src/components/dashboard/` gives
you ready-made, themed building blocks — you **author specs and pass them to
cards**:

- **Cards** — `KpiCard`, `ChartCard`, `DataTableCard`
- **Graphein visuals** — `line`, `area`, `bar`, `scatter`, `pie` / donut,
  `heatmap`, `funnel`, `table`, `matrix`, plus specialty specs like `box`,
  `sankey`, and `choropleth`
- **Slicers** (shared filter state) — `FilterStateProvider`, `FilterBar`,
  `DropdownSlicer`, `ListSlicer`, `SearchSlicer`, `DateRangeSlicer`, `RangeSlicer`
- **Interactions** — Graphein selections with a shared `SelectionStore`, plus
  `useSelectionFilterBridge` to feed chart clicks into the slicer/DAX path
- **Layout** — `PageShell`, `KpiGrid`, `ChartGrid`, `BentoGrid`, `Section`, `ThemeToggle`
- **Controls** — `SegmentedControl`, `FilterChips`
- **State tiles** — `EmptyTile`, `ErrorTile`, `ChartSkeleton`, `KpiSkeleton`
- **Helpers** — `toChartData` / `toTable` (map DAX results), `formatNumber` /
  `formatCurrency` / … , and chart color tokens

Everything is exported from one barrel: `@/components/dashboard`. Each card owns
its theme, axes, tooltip, dark mode, and loading/empty/error states — so you
write *data + specs*, not chart code. Start at the kit catalog skill
(`.agents/skills/visuals/SKILL.md`). Graphein is installed from npm as
`graphein` (`^0.8.0`); the app uses its own thin React `<Chart>` wrapper instead
of `@graphein/react`.

## Getting started

In Fabricator, just describe the dashboard you want. The agent ships with skills
for schema discovery, DAX authoring, query design, the dashboard kit (`visuals`),
and app design — plus an `AGENTS.md` orientation at the project root. To deploy
from the CLI:

```bash
npm run rayfin:up
```

The app authenticates through Fabric and renders inside the Fabric portal shell,
so it is meant to be opened from a deployed Fabric workspace (not `localhost`).

## Project structure

```text
├── AGENTS.md               # Orientation for coding agents — start here
├── .agents/
│   └── skills/             # Copilot skills (build-workflow, visuals, app-design,
│                           # dax, fabric-data)
├── rayfin/
│   └── rayfin.yml          # Fabric service configuration (Fabric auth + static hosting)
├── fabric.yaml             # Fabric data connections (semantic model profiles)
├── src/
│   ├── main.tsx            # Entry point: fonts, theme, auth provider, auth gate
│   ├── App.tsx             # Your dashboard — ships a kit-composed starter
│   ├── global.css          # Design system: tokens, palette, fonts, dark mode
│   ├── components/
│   │   ├── dashboard/      # The dashboard kit (cards, Graphein wrapper, layout, states)
│   │   └── auth-gate.component.tsx  # Blocks use outside the Fabric portal
│   ├── hooks/
│   │   ├── use-auth.tsx / auth.context.ts   # Fabric auth context
│   │   ├── use-theme.ts / theme.context.ts  # Light/dark theme
│   │   └── use-semantic-model-query.ts      # Query the connected semantic model
│   ├── lib/
│   │   ├── fabric client module     # connections from fabric.generated.ts
│   │   ├── rayfin-client.ts        # Rayfin client singleton
│   │   ├── to-chart-data.ts        # Map a query result → chart row objects
│   │   ├── to-table.ts             # Map a query result → Graphein table spec
│   │   ├── selection-bridge.ts     # Graphein selections → slicer state
│   │   ├── graphein-theme.ts       # CSS-token theme bridge for Graphein
│   │   ├── chartTokens.ts          # Chart color / theme helpers
│   │   ├── format.ts               # Number / date / percent formatters
│   │   └── utils.ts                # cn()
│   └── services/
│       └── rayfin-auth.service.ts  # Reads VITE_* env, builds Fabric auth
└── package.json
```

## Building a dashboard

1. **Connect a semantic model** — add a connection profile to `fabric.yaml`
   (the Fabricator agent wires this up when you point it at a model).
2. **Discover the schema** — list tables, columns, and measures.
3. **Write DAX queries** with `use-semantic-model-query`, aggregated to the
   visual's grain.
4. **Compose the kit** — map each result with `toChartData` (charts) or
   `toTable` (tables), then drop the spec into a kit card inside `PageShell` +
   `KpiGrid` / `ChartGrid`. Pass specs and query state, not chart code.
5. **Make `src/App.tsx` yours** — replace the starter placeholder grid with your
   real tiles.

`npm run build:fabric` runs `fabric-app-data generate` to produce
`src/fabric.generated.ts` (typed connection aliases) before the Vite build.

## Charts vs. tables

- **Charts are Graphein specs**, rendered by the kit's `<Chart>` wrapper inside
  `ChartCard`. Need something exotic (radar, treemap, waterfall)? Re-express it
  with the closest supported Graphein type or use `ChartCard` children mode for a
  truly one-off React visual (see the `visuals` skill).
- **Tables are Graphein `table` / `matrix` specs**, wrapped by `DataTableCard` —
  map detail results with `toTable(result, { columns })`, or author a `matrix`
  spec over `toChartData(result)` rows for a pivot/cross-tab.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Production build |
| `npm run build:fabric` | Build for Fabric deployment (entrypoint for `rayfin up`) |
| `npm run lint` | Lint with ESLint |
| `npm run rayfin:up` | Deploy the app to a Fabric test workspace |
