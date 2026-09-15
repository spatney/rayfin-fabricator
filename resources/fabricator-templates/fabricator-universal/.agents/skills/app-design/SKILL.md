---
name: app-design
description: >
  Use when building or modifying the app layout, dashboard kit visuals, UI
  components, or making any visual design decisions. Ensures a polished,
  distinctive, cohesive app — not a generic template.
---

# App Design

Build dashboards with a **point of view**. The default kit ships an *editorial*
look — warm paper canvas, ink text, one confident indigo accent, a geometric
display face (Space Grotesk) over Inter, flat surfaces with hairline borders and
a faint dot-grid. Correct-but-generic is failure; commit to a direction and make
every choice serve it.

## The one rule that kills "generic"

A dashboard looks templated when it does three things: shows raw numbers
(`12000000`), uses four identical KPI boxes, and lays out a uniform chart grid.
The kit fixes all three for you — **use them**:

1. **Format every number** in the spec (`format: "$,.2s"` → `$12M`). Never ship
   a raw axis. → see Formatting below.
2. **One `StatStrip`**, not four look-alike cards, for the metric band.
3. **Vary `Tile` sizes** (`hero` + `md` + `full`) — never a same-size grid.

If you do nothing else, do these. Everything below is how to go from clean to
distinctive.

## Fast path — time to wow

Ship a working vertical slice fast, then iterate.

- **Phase 1 — Hero slice.** Use the default theme as-is (it's already
  distinctive). Wire ONE real, formatted visual to live data and preview it
  (`npm run preview`). Don't theme yet.
- **Phase 2 — Breadth.** Add the rest of the band + tiles, previewing each
  against live data. Keep one `hero`, mix `md`/`full`.
- **Phase 3 — Polish.** Set the aesthetic direction, refine tokens/type,
  loading/empty/error states, run the Final Audit.

## Aesthetic direction

Pick a **tone** (one word) and a **signature detail** (the first thing someone
notices). The default tone is *editorial*; the signature is the indigo accent on
warm paper. Reskin both if the app calls for it — but pick something specific and
bold, never "safe corporate." A few directions: editorial, brutalist, organic,
technical/console, museum, neon. Match execution to direction: minimal needs
precise spacing + restraint; maximal needs layered detail. Commit fully.

### Typography
Fonts are the strongest signal of intent. The default pairs **Space Grotesk**
(display) + **Inter** (sans) + **JetBrains Mono** (mono/eyebrow). To rebrand,
swap `--font-display` first. Load via `@fontsource-variable` in `main.tsx` (or a
Google Fonts `<link>` in `index.html`), then set the font tokens in `global.css`.

### Theming — `global.css` is the single source of truth
Every component + chart reads these tokens, so set them first and the whole app
shifts together.
1. **Color** — set `--color-primary` (+ `--color-chart-1`, `--color-ring`) to one
   accent family; tune `--color-background`/`-card`/`-border`. Light values in
   `@theme static`, dark in `.dark`. Defaults: bone paper, indigo, accent-first
   10-hue chart palette.
2. **Radius** — `--radius` sets the tone: low = sharp/technical, high = soft.
   Default is generous (14px).
3. **Fonts** — per above.
4. **Build components** — focus on layout/spacing, not re-coloring.
5. **Selective overrides last.**

Principles: semantic tokens only (so light/dark just work), strong contrast, min
text size `text-200`, token spacing not arbitrary px, keyboard-accessible focus
on every control. **No drop shadows, no gradient fills** — depth comes from
surface, border, accent edge, type. The dot-grid (`bg-dotgrid`) is the canvas.

Polish-pass references (read on demand):
- [Dashboard Archetypes](references/dashboard-archetypes.md) — pick a shape first.
- [UI Style Recipes](references/ui-style-recipes.md) — per-element styling.
- [Visual Style Recipes](references/visual-style-recipes.md) — chart/table/theme.

---

## App layout

### Golden path
**Pick an archetype** (executive / operational / analytical) → [archetypes
ref](references/dashboard-archetypes.md). Default to executive summary. Then:

```tsx
import {
  PageShell, ThemeToggle, StatStrip, Stat, DashboardGrid, Tile,
  ChartCard, DataTableCard, FilterStateProvider, FilterBar,
  DropdownSlicer, DateRangeSlicer,
} from "@/components/dashboard";

<FilterStateProvider>
  <PageShell eyebrow="Sales" title="Revenue overview" subtitle="FY24"
    actions={<ThemeToggle />}
    toolbar={<FilterBar><DropdownSlicer label="Region" field="Geography[Region]" options={r} /><DateRangeSlicer label="Date" field="Date[Date]" /></FilterBar>}>
    <StatStrip>{/* one band, 2–5 metrics */}
      <Stat label="Revenue" data={rows} valueKey="rev" valueFormat="currency" accent="chart-1" delta={12.4} />
      <Stat label="Orders" data={rows} valueKey="orders" delta={3.1} />
    </StatStrip>
    <DashboardGrid>{/* vary sizes for rhythm */}
      <Tile size="hero"><ChartCard title="Revenue trend" variant="feature" accent="chart-1" className="h-full" spec={lineSpec} /></Tile>
      <Tile size="md"><ChartCard title="By region" spec={barSpec} /></Tile>
      <Tile size="md"><ChartCard title="Mix" spec={pieSpec} /></Tile>
      <Tile size="full"><DataTableCard title="Detail" spec={tableSpec} /></Tile>
    </DashboardGrid>
  </PageShell>
</FilterStateProvider>
```

### Frames
- **`PageShell`** — masthead + centered column. Filters go in `toolbar`, not beside the title.
- **`SidebarShell`** — adds a persistent filter rail (analytical). Don't make it route nav; the Fabric shell owns nav.
- **`AppShell`** — escape hatch for a custom frame.
Don't ship the same frame every time — the structure should serve the tone.

### Grid sizing
`sm`=3 · `md`=4 · `lg`=6 · `wide`=8 · `hero`=8×2 · `full`=12 cols. Mix sizes
(editorial default); only operational monitoring uses a uniform grid. A `hero`
needs `className="h-full"` on its card; the 4-col gap beside it fits two `md`s.
`StatStrip`+`Stat` for KPIs; `SectionBand` to zone a long page; `Card` for custom
tiles. `KpiGrid`/`ChartGrid`/`BentoGrid` are legacy — prefer `StatStrip` +
`DashboardGrid`.

### Container sizing
Cards fill their container; the wrapper controls width. `PageShell` sets
`maxWidth` — don't pin individual chart widths.

### States
Every async tile shows **loading** (skeleton), **empty** (muted message), and
**error** (destructive banner). The cards do this — pass `loading`/`error`.

### Dark mode
Ship the `ThemeToggle` in `actions`. Both modes are defined in `global.css`.

---

## Formatting (don't ship raw numbers)
Format **in the spec** — never `FORMAT()` in DAX. Axis/label `format: "$,.2s"`
→ `$12M`, `".1%"` → `12.4%`, `"%b %Y"` → `Mar 2024`. KPIs use
`valueFormat="currency"|"percent"|"compact"`. A bare `8000000` axis is the #1
generic tell.

## Coding conventions
- Tailwind v4 utilities; tokens from `global.css` (`bg-card`, `text-300`, `gap-m`,
  `rounded-2xl`, `icon-size-200`) — never raw hex/px/font. `cn()` for merging.
- Lucide icons; Radix primitives styled with Tailwind for interactive bits.
- For `text-*` size+color in `cn()`, use `text-[length:var(--text-300)]` to avoid
  merge conflicts. Form controls inherit the font via `global.css`.

## Final Audit (Phase 3)
After it's built + deployed: is every number formatted and legible? One band, not
four boxes? Varied tiles, not a uniform grid? Toolbar aligned on one edge? Charts
fill their cards? Per-visual, `npm run preview` returns a report flagging
clipping, overlap, low contrast, excess colors — fix `ok:false` diagnostics.
