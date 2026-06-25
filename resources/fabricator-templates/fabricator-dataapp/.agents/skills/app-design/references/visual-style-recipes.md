---
name: visual-style-recipes
description: Use when generating chart and data grid visuals. Provides guidance for consistent, polished data visualizations.

---
# Visual Style Recipes

Styling guidance for chart and data grid visuals — theming, dark mode, layout, and chart-specific patterns.

---

## Theming

### How theming works

All visual styling flows from CSS custom properties defined in `src/global.css`. Visual components read these variables at runtime — edit `global.css` to theme everything.

- **Light mode** values go in the `@theme` block
- **Dark mode** overrides go in the `.dark` block
- Changes cascade automatically to all charts and grids

See the `formatting.md` reference for the full list of CSS variables and how to change them.

### Custom theme colors

The `theme` prop on `VegaVisual` and `DataGrid` controls axis colors, text fills, grid lines, and background. Use the `useCssTheme()` hook to derive it from the `--color-*` variables in `global.css` — the hook updates automatically when the theme changes (e.g. dark-mode toggle adds/removes the `.dark` class):

```tsx
import { VegaVisual, useCssTheme } from "@microsoft/fabric-visuals";

const theme = useCssTheme();

<VegaVisual spec={spec} data={dataTable} theme={theme} />
```

Edit `--color-*` values in `global.css` (and the `.dark` block) to change chart colors — the hook bridges them into the JS theme object the visuals consume. Other CSS variables (spacing, fonts, radii, app-level colors) are picked up directly via the cascade.

Validate that chart data colors (series palettes and categorical hues) fit the app's current visual theme and design direction. If default data colors feel out of place, adjust the palette so it better supports the intended mood, contrast, and hierarchy.

### Data color alignment

Validate that chart data colors (series palettes and categorical hues) fit the app's current visual theme and design direction. If default data colors feel out of place, adjust the palette so it better supports the intended mood, contrast, and hierarchy.

### Chart typography alignment

Validate that chart text styling fits the app's current theme and typography direction. If chart labels, titles, legends, or axis text feel disconnected from the rest of the UI, update chart font family, weight, and size settings so they align with the app's token-driven type system.

- Keep chart font family aligned with the primary app font choice.
- Adjust axis labels, legend labels, and chart titles to match the visual density of the layout.
- Re-check label legibility after changing theme colors, since typography and color contrast must work together.

### Axis and label color consistency

Axis labels and titles follow `foregroundSecondary` and `foreground` from the theme object. Data-label text can also derive from `foregroundSecondary`. Keep those token mappings consistent across all charts to avoid mismatched label colors.

---

## Layout

### Chart container sizing

Every Vega-Lite spec should set `width: "container"` and `height: "container"` — including pie/donut charts.

### Chart container height chain

Charts must fill their card's visible height — no dead space, no cropping. This requires a **complete height chain** from the grid/flex cell down to the chart:

1. **Grid/flex cell** → provides the height
2. **Card wrapper** → `h-full` so the cell's height becomes definite
3. **Card content area** → `flex-1 min-h-0`
4. **Chart wrapper** → `flex flex-col flex-1 min-h-0`
5. **VegaVisual** → fills its parent

If a chart appears squished, trace the height chain upward — typically a missing `h-full` on an intermediate wrapper.

Do not wrap `<VegaVisual>` in a fixed-height container.

The direct parent of `<DataGrid>` should use `overflow-auto flex-1 min-h-0` for row scrolling.

### `minHeight` vs `height` for chart containers

Validate that containers in the height chain provide a definite height when charts rely on `h-full`.

- `height` creates a definite height and allows `h-full` chart wrappers to resolve correctly.
- `minHeight` alone does not create a definite height for flex/grid children and can lead to squished charts in standalone sections.

Use layout-aware checks:

- Grid layouts: `minHeight` on the grid container is generally acceptable because grid tracks provide definite row heights.
- Standalone full-width chart sections: prefer explicit `height` on the section/container when using `h-full` card/chart wrappers.

### Chart titles in cards

Do NOT put titles in the Vega-Lite spec `title` property for dashboard cards. Render as a heading element in the card header instead. Scale the heading size to match the app's type hierarchy.

- The title should summarize what the chart shows in plain language (e.g., "Monthly Revenue by Region", "Top 10 Products by Units Sold").
- Derive the title from the data fields and the intent of the visualization — do not use generic titles like "Chart" or "Bar Chart".
- If the user provides a title, use it as-is. Otherwise, infer a good title from the query and encodings.

For standalone charts (no card wrapper), use the spec `title` with anchor `start`, semibold weight, and primary text color.

> **Layout creativity**: Consider mixed card spans, a full-width hero row, asymmetric column ratios, or generous negative space between sections. The layout should reinforce the aesthetic direction.

---

## Named Styles

The base theme includes named styles that marks can opt into via the `style` property in the spec. See `formatting.md` for the label styles (`labelCallout`, `labelSubtitle`, `labelVertical`, `labelHorizontal`).

Additional mark-type styles:

| Style | Use case | Effect |
|---|---|---|
| `scatter` | Scatter plot points | `opacity: 0.7` — reveals overlapping points |
| `bubble` | Bubble chart points | `opacity: 0.6` — softer fill for sized circles |
| `densityArea` | Density/distribution areas | `fillOpacity: 0.35` — more transparent than standard area |

Usage in a spec:
```json
{ "mark": { "type": "point", "style": "scatter" } }
```

---

## Soft Guidance

These produce good results. Deviate when the design calls for it.

### Card content spacing

Content areas inside a card should use consistent horizontal padding that matches the card header. Don't let content sit flush against card edges while the header has padding.

### Bar corner radius

The default `cornerRadiusEnd` is `4` (from `--radius-md`). Use `0` for sharp aesthetics or higher for rounder feels. Whatever value you pick, use it consistently across **all** bar charts.

### Grouped bar charts

- Set `paddingInner: 0` on the `xOffset` scale so sub-bars sit flush. The stroke already provides visual separation between bars in a group.

### Heatmaps

- Set `paddingInner: 0.02` on the x and y band scales so cells have a thin gap between them for accessibility.

### Bubble charts

- **Always hide the size legend** — set `legend: null` on the `size` encoding.

### Pie / Donut

- For donuts, set `innerRadius` to ~65% of `outerRadius` for a balanced hole.
- Single series: hide the legend.

### Waterfall charts

- Color-encode by type with a fixed domain/range: increase (green), decrease (red), subtotal (primary).

---

## Workarounds

Known VegaVisual limitations that require spec-level fixes.

### Mixed positive/negative bar corner radius

A single `cornerRadiusEnd` rounds corners on the wrong side for negative values. Use a two-layer approach:

1. Reset `cornerRadiusEnd` to `0` in spec-level config.
2. **Layer 1**: filter to `datum.value >= 0`, apply top corner radii (vertical) or right (horizontal).
3. **Layer 2**: filter to `datum.value < 0`, apply bottom corner radii (vertical) or left (horizontal).

---

## DataGrid

Pass theme colors to the DataGrid via the `theme` prop. Use `useCssTheme()` to bridge `--color-*` variables in `global.css` to the JS theme object:

```tsx
import { useCssTheme } from "@microsoft/fabric-visuals";

const theme = useCssTheme();

<DataGrid
  data={dataTable}
  theme={theme}
/>
```

Font, spacing, and border styles are controlled by CSS variables in `global.css` and cascade automatically.