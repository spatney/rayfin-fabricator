---
name: app-design
description: >
  Use when building or modifying the app layout, dashboard kit visuals,
  UI components, or making any visual design decisions. Ensures consistency,
  accessibility, and a polished, unique app.
---

# App Design

Your job is to build cohesive, distinctive apps — not just correct ones. Add character through intentional design decisions — typography pairing, color emphasis, spatial rhythm, and a clear visual point of view.

## Fast path

Optimize **time to wow**: ship a working vertical slice fast, then iterate. In **Phase 1 — Hero slice (time to wow)**, use a clean default look quickly and move on: get ONE compelling, real visual wired to live data and previewed against it (`npm run preview`).

For that first slice, pick one characterful `--font-display` plus a complementary `--font-sans`, loaded via Google Fonts in `index.html`; set `--color-primary` and `--radius` in `src/global.css`; then get back to the hero visual. Do NOT perfect theming in Phase 1.

After the hero slice is wired, continue with **Phase 2 — Breadth** by adding remaining visuals/KPIs, previewing each new visual against live data. Use **Phase 3 — Polish** for theme/typography refinement, loading/empty/error states, edge-case correctness, and final audits.

Preview each visual against live data with `npm run preview` (Fabricator auto-deploys after the turn), read deep references only when a specific problem demands it, and never block the first hero visual on exhaustive discovery or perfect theming.

The deep theming workflow, reference files, and Final Audit below are for Phase 2/3 polish — don't do them before the hero visual ships.

## Aesthetic Direction

Before building, quickly decide the app's tone in one word and its signature detail — the one thing someone notices first — but do not let this block the first deploy. A clean default is fine for Phase 1; deepen the aesthetic direction in the polish pass. These two choices guide every decision that follows. Pick a tone that is specific and bold, not safe or generic. Examples like editorial, geometric, organic, industrial, playful, or minimal are starting points — don't limit yourself to these. Invent a direction that fits the app's purpose.

Then match your execution to your direction — a maximalist direction needs layered effects and rich detail in the code; a minimalist direction needs precise spacing, restraint, and careful typography. Elegance comes from committing to the direction fully, not from adding more.

### Typography

Pick fonts that set the app's character — this is one of the strongest signals of intentional design. At minimum choose a characterful `--font-display` paired with a complementary `--font-sans`, ideally from the same foundry or design family. Update `--font-mono` and `--font-numeric` if necessary. The starter default is **Inter** (matching Graphein's native theme) — a clean, neutral base; pick a more distinctive display face when the app calls for personality, and otherwise avoid generic defaults like Arial or Roboto.

Load fonts via Google Fonts (or another CDN) as `<link>` tags in `index.html`, then update the font family tokens in the `@theme` block of `global.css`.

### Theming Workflow

Start by customizing `src/global.css` — this is the single source of truth for the app's visual identity. Every component uses these tokens, so setting them first means the entire UI shifts together.

1. **Colors**: Update the semantic color tokens (`--color-primary`, `--color-background`, `--color-card`, `--color-border`, etc.) in both the `@theme` block and the `.dark` override to match the aesthetic direction. The defaults mirror **Graphein's native theme** (teal accent, slate neutrals, a 10-hue chart palette) so charts and chrome ship unified out of the box — make them yours.
2. **Radius**: Adjust `--radius` (the base radius) and the radius scale to match the tone — sharp/geometric (lower values), soft/rounded (higher values), or pill-shaped (`--radius-full`).
3. **Fonts**: Update the font family tokens as described in the Typography section above.
4. **Then build components.** Focus component-level styling on layout, spacing, and element-specific details — not re-specifying colors and radii that the tokens already handle.
5. **Selective overrides last.** After the base theme is in place, inspect and adjust individual components that need to deviate — an accent-colored card border, a button with a unique hover effect, etc.

---

Keep these principles in mind:
- Use semantic color tokens so surfaces, text, and borders adapt correctly to light and dark mode.
- Maintain sufficient contrast between text and backgrounds.
- The recommended minimum text size is `text-200`. 
- Keep spacing consistent — use the spacing tokens from the theme rather than arbitrary values.
- Ensure all interactive elements are keyboard-accessible with visible focus indicators and appropriate disabled states.

Read these reference files on demand during Phase 2–3 iteration, when refining a specific element — they include "Make it yours" prompts that tie back to the aesthetic direction above:
- [Dashboard Archetypes](references/dashboard-archetypes.md) — pick a layout shape (executive / operational / analytical) before composing tiles; per-archetype recipes, rhythm, and pitfalls.
- [UI Style Recipes](references/ui-style-recipes.md) — per-element styling guidance for buttons, cards, inputs, dialogs, tabs, tooltips, tables, and more.
- [Visual Style Recipes](references/visual-style-recipes.md) — dashboard kit theming, chart/table recipes, dark mode support, and token-driven styling.

---

## App Layout

These are good defaults for app structure. Adapt them to the specific app's needs.

### Golden path — default dashboard layout

**First, pick an archetype.** A strong dashboard takes a recognizable shape for one
audience: **executive summary** (KPI band + hero trend + breakdowns), **operational
monitoring** (dense uniform status grid), or **analytical deep-dive** (filter rail +
cross-filtered exploration). Choose one before placing tiles — it sets the frame, KPI
treatment, grid rhythm, and what to omit. Default to executive summary when unsure.
→ [Dashboard archetypes](references/dashboard-archetypes.md) for shapes, recipes, and pitfalls.

Copy this first, then swap in your queries/specs. It gives the model one clear path:
one metric band, one varied 12-col canvas, flat hierarchy via surfaces/borders/accent edges/typography — **no gradients or shadows**.

```tsx
import {
  PageShell, ThemeToggle,
  StatStrip, Stat,
  DashboardGrid, Tile,
  ChartCard, KpiCard, DataTableCard,
  FilterStateProvider, FilterBar, DropdownSlicer, DateRangeSlicer,
} from "@/components/dashboard";

// Wrap the app once so every tile shares one filter model.
<FilterStateProvider>
  <PageShell
    eyebrow="Sales" title="Revenue overview" subtitle="FY24"
    actions={<ThemeToggle />}
    toolbar={
      // Slicers ship in the toolbar by default. Feed options from
      // useSlicerOptions({ connection, field }); selections drive every tile.
      <FilterBar>
        <DropdownSlicer label="Region" field="Geography[Region]" options={regionOptions} />
        <DropdownSlicer label="Category" field="Product[Category]" options={categoryOptions} />
        <DateRangeSlicer label="Date" field="Date[Date]" />
      </FilterBar>
    }
  >
    {/* 1. Metric band — one strip, not four look-alike boxes */}
    <StatStrip>
      <Stat label="Revenue" data={rows} valueKey="revenue" valueFormat="currency" accent="chart-1" delta={12.4} />
      <Stat label="Orders"  data={rows} valueKey="orders"  delta={3.1} />
      <Stat label="Avg order" value={84.2} valueFormat="currency" delta={-1.2} />
    </StatStrip>

    {/* 2. Varied grid — mix Tile sizes for editorial rhythm (NOT a uniform grid) */}
    <DashboardGrid>
      <Tile size="hero"><ChartCard title="Revenue trend" className="h-full" spec={lineSpec} /></Tile>
      <Tile size="md"><ChartCard title="By region" spec={barSpec} /></Tile>
      <Tile size="md"><ChartCard title="Channel mix" spec={pieSpec} /></Tile>
      <Tile size="full"><DataTableCard title="Detail" spec={tableSpec} /></Tile>
    </DashboardGrid>
  </PageShell>
</FilterStateProvider>
```

### Page Structure

- The app layout should fill the viewport.
- On wide screens, constrain the content width so it doesn't stretch uncomfortably. Use responsive breakpoints or multi-column layouts to make good use of available space.
- **Default frame:** `PageShell({ eyebrow?, title?, subtitle?, actions?, toolbar?, children, maxWidth? })` — single-column masthead + centered content. Put filters in `toolbar`, not crammed beside the title.
- **Filter-heavy frame:** `SidebarShell({ rail, ...PageShellProps })` — persistent in-content filter/context rail. The app is already embedded in the Fabric portal shell; do **not** turn the rail into full-height route navigation.
- **Custom frame:** `AppShell` only when the presets do not fit (custom masthead, toolbar, or rail composition).

Don't default to the same layout every time. The structure should serve the aesthetic direction — a filter rail + main content split, a full-width single column, a multi-panel master-detail, an asymmetric split, or something else entirely. These are starting points, not an exhaustive list. Invent a layout that fits the app's purpose and tone.

The header/toolbar is part of the design language — not every app needs a traditional fixed header. Consider alternatives: a compact inline toolbar in `toolbar`, a branded banner, a collapsible drawer, a minimal top-right action cluster, or no header at all if the content speaks for itself.

### Container Sizing

Dashboard kit chart and table cards fill their container — the **container controls their dimensions**. Without constraints, charts, tables, and content stretch to the full viewport width, which produces squished, unreadable visuals on wide screens.

- **Constrain the dashboard wrapper, not individual charts.** `PageShell` / `SidebarShell` do this with `maxWidth` by default. If the app lacks an outer wrapper, create one.
- **Do not constrain individual chart containers.** Let the wrapper width plus `DashboardGrid` / `Tile` columns determine each chart's size naturally.
- If the user explicitly requests full-width charts, confirm the design choice before proceeding.

### Dashboard Grid

Use `DashboardGrid` + `Tile` for the main canvas. Picking semantic sizes is easier than span math and should be the default.

| `Tile size` | Large-screen span |
|---|---:|
| `"sm"` | 3 columns |
| `"md"` | 4 columns |
| `"lg"` | 6 columns |
| `"wide"` | 8 columns |
| `"hero"` | 8 columns × 2 rows |
| `"full"` | 12 columns |

- **Vary sizes = the editorial default.** Mix `hero`, `md`, `wide`, and `full` to create hierarchy. Do **not** build a uniform spreadsheet grid unless the data truly demands it.
- A `hero` tile is 2 rows tall: put `className="h-full"` on the card inside it — otherwise the card keeps its natural height and the lower row renders blank.
- A `hero` (8×2) leaves a 4-col × 2-row space to its right; two `md` (or `sm`) tiles placed right after it stack to fill that space exactly (as in the recipe above).
- Use `StatStrip` + `Stat` for the KPI header: one bordered, hairline-divided band of 2–5 metrics. Do not compose four identical `KpiCard`s as the first choice.
- `KpiGrid`, `ChartGrid`, `BentoGrid`, and `BentoItem` are legacy/back-compat. Existing examples may use them, but new dashboards should use `StatStrip` and `DashboardGrid` + `Tile`.

### Secondary rhythm and hierarchy

- `SectionBand({ title?, subtitle?, action?, children })` — group a long column into alternate-surface (`surface-2`) zones. Nest a `DashboardGrid` inside it to give a themed sub-section its own tile layout:

  ```tsx
  <SectionBand title="Deep dive" subtitle="Channel & regional detail">
    <DashboardGrid>
      <Tile size="lg"><ChartCard title="Channel mix" variant="feature" accent="chart-1" spec={areaSpec} /></Tile>
      <Tile size="lg"><ChartCard title="Price vs. units" variant="feature" accent="chart-1" spec={scatterSpec} /></Tile>
      <Tile size="full"><DataTableCard title="Regional performance" spec={tableSpec} /></Tile>
    </DashboardGrid>
  </SectionBand>
  ```
- `Card({ eyebrow?, title?, subtitle?, action?, variant?, accent?, footer?, children })` — generic flat content tile.
- `ChartCard` supports `eyebrow`, `variant`, and `accent`; use `variant="feature"` and `accent="chart-1"` to mark the hero tile.
- `KpiCard` supports `variant`, but prefer `StatStrip` for the top KPI band.
- Hierarchy comes from layout, surface layering, border weight, accent edges, and typography — **never gradients or drop shadows**.

### Loading, Empty & Error States

Every component that depends on async data should handle all three states:

| State | What to show |
|---|---|
| **Loading** | A skeleton placeholder matching the shape of the expected content |
| **Empty** | A centered muted message explaining no data is available |
| **Error** | A destructive-styled banner with the error message |

### Dark Mode

Include a light/dark mode toggle in the app header or toolbar. Prefer the kit's `ThemeToggle` from `@/components/dashboard`; use `useAppTheme` from `@/hooks/use-theme` only for a custom control.

---

## Coding Conventions

- **Styling**: Tailwind CSS v4 utility classes for all styling. Theme colors are defined as CSS custom properties in `src/global.css` using `@theme`. Use Tailwind classes directly in JSX.
- **Theming**: Light/dark color tokens defined in `src/global.css` via CSS custom properties. Dark mode uses the `.dark` class on the root `html` element, auto-detected via `prefers-color-scheme`, `data-appearance` attribute, or `.dark` class. The `useAppTheme` hook in `src/hooks/use-theme.ts` manages the toggle.
- **CSS class merging**: Use `cn()` from `@/lib/utils` (powered by `clsx` + `tailwind-merge`) to conditionally combine Tailwind class names.
- **Icons**: Lucide React for UI icons.
- **UI Components**: Use Radix primitives with Tailwind CSS styling for all interactive elements — buttons, inputs, dialogs, menus, tabs, etc.

### UI Token Rules

All styling must use the design tokens defined in `src/global.css` via Tailwind utility classes. Never hardcode raw color values, pixel sizes, or font stacks — raw values are only permitted in `global.css` where the tokens are defined. Refer to `global.css` for available tokens, their values, and expected usage.

Examples:
- `bg-primary text-primary-foreground` — not `bg-blue-600 text-white`
- `text-300` — not `text-sm` or `text-[14px]`
- `p-l gap-m` — not `p-4`, `gap-3`, `p-spacing-l`, or `gap-spacing-m`
- `font-semibold` — not `font-[600]`
- `rounded-xl` — not `rounded-[8px]`
- `icon-size-200` — not `w-4 h-4`

**`cn()` and tailwind-merge conflicts:** `tailwind-merge` treats `text-*` utilities as one conflict group. In `cn()`, combining text size and text color with ambiguous `text-*` classes can drop one class. Prefer explicit length syntax for font size (e.g., `text-[length:var(--text-300)]`) when combining with text color classes inside `cn()`. If classes are static and not merged, `text-300 text-foreground` is acceptable.

**Form element font inheritance:** Native form controls may not inherit the page font family by default. Ensure base styles in `global.css` set `font-family: inherit` for `select`, `input`, `textarea`, and `button`.

---

## Final Audit

Treat this as a Phase 3 polish-pass activity after the dashboard is built, deployed, and reviewed — not before the first deploy.

After assembling a layout, audit each element in its actual context — not in isolation. A component may look correct on its own but break the visual rhythm of the page. Check: Is every text legible? Are labels proportional to their controls? Are toolbar rows aligned on a shared edge? Do charts fill their containers? Do repeated elements (badges in tables, icons in lists) maintain appropriate visual weight for their density? Fix anything that fails.

For individual visuals, let Graphein critique itself: `npm run preview` renders a spec headlessly and returns a **report** that flags clipping, label/axis overlap, low contrast, and excess colors (`ok: false` + `diagnostics`). Use it to catch per-visual presentation issues fast; the whole-page audit covers layout rhythm and the Fabric shell after the automatic after-turn deploy. (→ `headless-preview`)