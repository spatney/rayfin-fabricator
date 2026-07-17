---
name: match-source-report
description: >
  Use ONLY when a `source-report/` folder is present in the project — that marks
  this app as a MIGRATION of an existing Power BI report, not a greenfield build.
  For a migration the report's existing look IS the design direction: match its
  palette, typography, layout, and chart types up front. This supersedes the
  "sensible default theme / defer theming" guidance in build-workflow and
  app-design. If there is no `source-report/` folder, ignore this skill entirely.
---

# Match the Source Report

A `source-report/` folder means Fabricator imported an existing Power BI report
and this app is a **migration** of it. The user already has a look they like — the
one in the report. Your job is to **rebuild that report as a Rayfin data app that
looks like the original**, not to invent a fresh aesthetic.

> **This skill only applies when `source-report/` exists.** For a normal
> greenfield app, it does not apply — follow `build-workflow` / `app-design` as
> written. A user can turn this behavior off by deleting this skill file (or the
> `source-report/` folder).

## What overrides what

For a migration, this skill **takes precedence** over the default theming advice:

- `build-workflow` Phase 1 step 5 says *"sensible default theme… do not perfect
  theming yet."* → **Not for a migration.** The theme is not yours to pick; it's
  given by the report. Establish it in Phase 1, up front.
- `app-design` says *"the default kit ships an editorial look… commit to a
  direction"* and *"Don't theme yet."* → **The direction is already chosen** — it's
  the source report. Do **not** impose the editorial default; extract the report's
  direction and match it.

Everything else in `build-workflow` (ship a hero slice, preview every visual
against live data, iterate) and `visuals` / `dax` / `fabric-data` still applies
unchanged. This skill only changes *where the design direction comes from* and
*when you establish it* (up front, not deferred).

## Your inputs (read these first)

| Input | What it is | Use it for |
|---|---|---|
| `source-report/pages/page-01.png`, `page-02.png`, … | Each report page rendered as an image | **Primary visual ground truth** — palette, typography, layout grid, spacing, chart types, density. Open every one with your file `view` tool. |
| `source-report/report.pdf` | The full report export | Higher-fidelity fallback if a page image is unclear. |
| `source-report/**` (PBIR: `report.json`, pages, visuals) | The report definition | The structural spec — which pages exist, which visuals, their arrangement and roles. |
| `source-model/**` (TMDL) | The semantic model schema + DAX measures | The data layer — reuse the exact measure names so numbers match. (→ `dax`, `fabric-data`) |

The page images are the reliable visual channel — **look at them directly**. The
PBIR JSON tells you *what* the visuals are; the images tell you *how they look*.

## Phase 1 for a migration — establish the look, then ship the hero

Do this **before** you settle the hero tile, folding it into the Phase 1 loop:

1. **Study the report.** Open every `source-report/pages/*.png` (fall back to
   `source-report/report.pdf` if needed). Note, per page:
   - **Palette** — background, surface, text, and the accent/brand color(s), plus
     the chart color sequence. Pull approximate hex values from what you see.
   - **Typography** — serif vs sans vs geometric, heavy vs light, any distinct
     display face; relative title/label sizes.
   - **Layout** — the grid, tile sizes and rhythm, KPI band vs charts, density
     (airy vs packed), alignment.
   - **Chart types** — bar/line/donut/table/etc., and how they're styled.
2. **Set the theme tokens up front** in `src/global.css` to match — this is the
   one place the whole app reads from (→ `app-design`: "Theming"):
   - `--color-primary` (+ `--color-chart-1`, `--color-ring`, `--color-brand`) to
     the report's accent family.
   - `--color-background` / `-card` / `-border` / `-foreground` to the report's
     canvas + surfaces.
   - `--color-chart-1..10` to the report's chart color sequence (in order).
   - `--font-display` / `--font-sans` to the closest match for the report's
     typography (load via `@fontsource-variable` in `main.tsx` or a Google Fonts
     `<link>` — → `app-design`: "Typography").
   - `--radius` to match the report's corner feel (sharp/technical vs soft).
   Set light values in `@theme static`, dark in `.dark`.
3. **Then build the hero slice** as usual — but pick the hero visual's *type and
   placement to mirror the report's most prominent visual*, and preview it against
   live data (→ `build-workflow` Phase 1, `visuals`, `headless-preview`).

## Phase 2 — breadth that mirrors the report

Recreate the report's pages/visuals: same visual types, same arrangement, same
KPI band, mapped onto the kit (`StatStrip`, `DashboardGrid` + `Tile`,
`ChartCard` / `KpiCard` / `DataTableCard`). Reuse the report's DAX measure names
so the numbers match the original (→ `dax`, `visuals`). Preview each visual.

Fidelity within reason: match the report's **intent** using the Rayfin component
set — you don't have to pixel-match Power BI chrome, but the palette, typography,
layout, and chart choices should read as the same report. If Graphein lacks a
report chart type, re-express it with the closest type (→ `visuals`: Gotchas).

## Final check

Put a `source-report/pages/*.png` next to a preview of your app: same accent
color? same typographic feel? same layout rhythm and chart types? If someone who
knew the original opened your app, would they recognize it? If not, adjust the
`global.css` tokens and layout until they would — then run the normal
`app-design` Final Audit.
