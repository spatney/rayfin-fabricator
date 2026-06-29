---
name: build-workflow
description: >
  START HERE when building, modifying, or iterating on a data app or dashboard.
  Defines the fast, iterative "time to wow" workflow: ship one real hero visual
  first, preview every visual against live data, then expand breadth and polish.
  Fabricator automatically deploys after the turn for user review. Orchestrates
  the dax, fabric-data, visuals, headless-preview, and app-design skills so you
  don't front-load all of them.
---

# Build Workflow — Ship fast, then iterate

Optimize **time to wow**: the time until the user sees a real, compelling result
in the automatically deployed app. Build a thin vertical slice, preview it, then
iterate. Do **not** front-load exhaustive schema discovery, perfect DAX, or
perfect theming before anything is visible — that is the slowest possible path.

> **Headless preview is the agent validation loop.** Preview each visual
> against live data (`npm run preview` → PNG + report), wire it into the app, and
> let Fabricator's automatic after-turn deploy ship the result for user review.

## The loop

**Edit → preview each visual → wire it in → auto-deploy after the turn →
user review → refine.** Keep each loop small. One reviewed change beats a
big-bang build every time.

- **All visuals:** render the spec **headlessly against live data** to a PNG +
  report — `npm run preview` — and critique it before it ships. Use it to choose
  a visual type, check the data fits, and catch clipping/overlap/contrast.
  (→ `headless-preview`)

## Phases

### Phase 1 — Hero slice (time to wow)

Get ONE compelling, real visual wired to live data, previewed, and on screen —
as fast as possible.

0. **Pick an archetype** — decide the dashboard's shape from the request: executive
   summary, operational monitoring, or analytical deep-dive. This frames the hero
   tile and the breadth that follows. Default to executive summary when unsure.
   (→ `app-design`: Dashboard archetypes)
1. **Minimum schema scan** — discover just enough to find one compelling metric:
   one scope probe + the one or two tables/measures behind your hero visual.
   Don't enumerate the whole model. (→ `dax`: Fast path)
2. **One hero query** — write a single DAX query at the visual's grain,
   quick-test it once, ship it. (→ `dax`: Fast path)
3. **One hero visual** — render it the simplest way: map the hero query with
   `toChartData`, author one Graphein spec, and pass it to a `ChartCard` (or render a
   `KpiCard` / `DataTableCard` with a `table` / `matrix` spec) — pass the mapped spec + `loading`/`error`, don't
   hand-write chart code. (→ `visuals`: Fast path)
4. **Preview it against live data** — `npm run preview --
   --spec hero.json --query <alias> --dax-file q.dax`, view the PNG + report, and
   tune the spec until it reads well. KPI/table/matrix/slicers/dashboard
   rasterize to PNG too, so preview them before shipping. (→ `headless-preview`)
5. **Sensible default theme** — pick a characterful font pairing + a primary
   color and move on. Do **not** perfect theming yet. (→ `app-design`: Fast path)
6. **Drop the hero tile into `src/App.tsx`** — replace the starter placeholder
   grid with your hero visual. Fabricator automatically deploys after the turn
   for user review.

Stop after the hero slice and use user feedback before going further.

### Phase 2 — Breadth

Add the rest of what the user asked for — more KPIs, charts, table/matrix specs, filters.
**Preview each new visual** against live data as you author it — not once
at the end. Pull in interactivity (cross-filtering / cross-highlighting) only
when the user actually needs it. (→ `dax`, `visuals`, `headless-preview`)

### Phase 3 — Polish

Now refine, driven by what the running app actually shows:

- Theme/typography depth, layout rhythm, and the `app-design` **Final Audit**.
- Loading / empty / error states for every async visual.
- Edge-case DAX correctness, number/date formatting, dark mode.

(→ `app-design` and `dax` reference files — read on demand.)

## Rules

- **Preview every visual before it ships.** A `npm run preview` against
  live data is the validation loop for getting one visual right.
- **Do not use manual app deployment as validation.** Fabricator automatically
  deploys after the turn; validate visuals headlessly before that ship.
- **One reviewed change at a time.** Small loops surface problems immediately.
- **Read references lazily.** The sibling skills carry deep references (DAX
  patterns, visual recipes, style recipes). Open them only when a specific
  problem demands it — not as upfront reading.
- **Don't gold-plate Phase 1.** Exhaustive discovery and perfect theming are
  Phase 3 concerns; they must never block the first ship.

## Skill read order

Don't load every skill upfront. Pull each one in as its phase needs it, and stop
at its **Fast path** section until you genuinely need more.

| When | Skill | How much |
|---|---|---|
| Phase 1 — pick a shape | `app-design` | Dashboard archetypes |
| Phase 1 — find a metric | `dax` | Fast path only |
| Phase 1 — write the hero query | `dax` | Fast path only |
| Phase 1 — render it | `visuals` | Fast path only |
| Phase 1 — check it vs live data | `headless-preview` | for each visual |
| Phase 1 — quick default look | `app-design` | Fast path only |
| Phase 2 — breadth & interactivity | `dax`, `visuals` | deeper sections |
| Phase 2 — vet each new visual | `headless-preview` | per visual |
| Phase 3 — polish & correctness | `app-design`, `dax` | references, on demand |
| Connections / data plumbing | `fabric-data` | only if not already wired |
