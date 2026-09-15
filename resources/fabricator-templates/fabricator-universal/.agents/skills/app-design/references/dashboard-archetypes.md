---
name: dashboard-archetypes
description: Use when starting a dashboard, before composing tiles, to choose a layout shape that fits the user's intent. Defines the three core BI archetypes (executive summary, operational monitoring, analytical deep-dive) — when to use each, its layout shape, a kit composition recipe, sizing rhythm, and pitfalls.
---

# Dashboard Archetypes — pick a shape before you place tiles

A dashboard is not "some charts on a page." A **strong** dashboard answers one
audience's questions in a recognizable shape. Before composing tiles, decide which
archetype the request maps to — it determines the frame, the KPI treatment, the grid
rhythm, and what to leave out. These are starting points, not a cage: most real apps
lean on one archetype and borrow a section from another.

## Pick one

| If the user wants… | Archetype | Frame | Signature |
|---|---|---|---|
| "How's the business?" — a glanceable summary for a leader | **Executive summary** | `PageShell` | KPI band → one hero trend → 2–3 breakdowns |
| "What's happening *now*?" — monitor status, catch problems | **Operational monitoring** | `PageShell` | Dense uniform grid, status colors, lots of detail |
| "Why did this happen?" — slice and explore | **Analytical deep-dive** | `SidebarShell` | Filter rail + cross-filtered exploration grid |

Quick heuristics: a CEO/board audience → executive; an ops/support/on-call screen →
operational; an analyst who wants to ask follow-up questions → analytical. Default to
**executive summary** when unsure — it's the most common and reads well at a glance.

---

## 1. Executive summary (default)

**Audience:** leaders who scan, don't drill. **Job:** the top metrics + the one trend
that explains them, in <10 seconds. Few visuals, high polish, ruthless hierarchy.

**Shape:** KPI band → one **hero** trend → 2–3 supporting breakdowns → optional detail.

```tsx
<PageShell eyebrow="Sales" title="Revenue overview" subtitle="FY24" actions={<ThemeToggle />}
  toolbar={<FilterBar><DropdownSlicer label="Region" field="Geography[Region]" options={regions} /><DateRangeSlicer label="Date" field="Date[Date]" /></FilterBar>}>
  <StatStrip>{/* 3–5 metrics, one band */}
    <Stat label="Revenue" data={kpi} valueKey="revenue" valueFormat="currency" accent="chart-1" delta={12.4} />
    <Stat label="Orders" data={kpi} valueKey="orders" delta={3.1} />
    <Stat label="Avg order" data={kpi} valueKey="aov" valueFormat="currency" delta={-1.2} />
  </StatStrip>
  <DashboardGrid>
    <Tile size="hero"><ChartCard title="Revenue trend" variant="feature" accent="chart-1" className="h-full" spec={lineSpec} /></Tile>
    <Tile size="md"><ChartCard title="By region" spec={barSpec} /></Tile>
    <Tile size="md"><ChartCard title="Channel mix" spec={pieSpec} /></Tile>
    <Tile size="full"><DataTableCard title="Top accounts" spec={tableSpec} /></Tile>
  </DashboardGrid>
</PageShell>
```

- **Rhythm:** vary tile sizes (one `hero`, two `md`, one `full`). Never a uniform grid.
- **Hierarchy:** mark the hero with `variant="feature"` + `accent`; everything else is plain.
- **Pitfalls:** too many tiles (cap ~6); look-alike KPI boxes instead of one `StatStrip`; >6 pie slices.

## 2. Operational monitoring

**Audience:** people watching live state (ops, support, fulfillment). **Job:** show
many metrics at once, flag what's off. Density and status legibility beat editorial polish.

**Shape:** thin status band → **uniform** grid of small same-size tiles → detail table.

```tsx
<PageShell eyebrow="Operations" title="Service health" subtitle="Last 24h" actions={<ThemeToggle />}>
  <StatStrip>{/* live counters; invertDelta where down-is-good */}
    <Stat label="Open tickets" data={s} valueKey="open" accent="chart-3" />
    <Stat label="SLA breaches" data={s} valueKey="breaches" delta={4.2} invertDelta accent="chart-6" />
    <Stat label="Avg handle" data={s} valueKey="aht" valueFormat={(s) => `${Math.round(s / 60)}m`} />
  </StatStrip>
  <DashboardGrid>{/* uniform sm/md grid — density is the point */}
    {queues.map((q) => <Tile key={q.id} size="sm"><ChartCard title={q.name} spec={q.spec} /></Tile>)}
  </DashboardGrid>
  <DataTableCard title="Active incidents" spec={incidentTable} height={420} />
</PageShell>
```

- **Status color:** drive cells/KPIs with semantic chart tokens; tables use `conditionalFormat`.
- **Rhythm:** uniform `sm`/`md` tiles — this is the one case where a uniform grid is correct.
- **Pitfalls:** decorative hero tiles (waste space); hidden alarms; tables without conditional formatting.

## 3. Analytical deep-dive

**Audience:** analysts asking "why." **Job:** filter + cross-filter to chase a cause.
Built around a persistent filter rail and tightly cross-linked visuals.

**Shape:** `SidebarShell` rail of slicers → exploration grid where clicks cross-filter.

```tsx
<SidebarShell eyebrow="Analytics" title="Sales explorer" actions={<ThemeToggle />}
  rail={<FilterBar><DropdownSlicer label="Region" field="Geography[Region]" options={regions} /><ListSlicer label="Category" field="Product[Category]" options={cats} /><RangeSlicer label="Price" field="Product[Price]" /></FilterBar>}>
  <DashboardGrid>
    <Tile size="hero"><ChartCard title="Revenue by region" className="h-full" store={pick.store} spec={barSpec} /></Tile>
    <Tile size="md"><ChartCard title="Trend" spec={lineSpec} /></Tile>
    <Tile size="md"><ChartCard title="Scatter" spec={scatterSpec} /></Tile>
    <Tile size="full"><DataTableCard title="Detail" spec={tableSpec} /></Tile>
  </DashboardGrid>
</SidebarShell>
```

- **Cross-filter:** wrap in `SelectionStoreProvider`; `useCrossHighlight(field)` + `crossHighlightParams` so a click dims the source and re-queries the rest (`visuals` → Interactivity).
- **Pitfalls:** rail as route nav (it isn't — the Fabric shell owns nav); too many starting tiles; no empty-state when filters exclude everything.

---

## Build order
Pick the archetype, ship its **hero** tile first (`build-workflow` Phase 1), then fill the
rest of the shape. Keep tiles empty (the card's empty state) until wired to live data —
never mock rows. Theme stays token-driven in `src/global.css`.
