# Formatting & color

Format numbers/dates and color visuals. **Formatting lives in the visual layer,
never in DAX** — emit raw typed numbers from queries and format them here so charts
scale axes and tables sort.

## Where formatting lives

| Surface | How to format |
|---|---|
| Envy chart spec | a `format` hint on the `FieldDef` (axis/label/tooltip) — the [mini-language](#format-mini-language) |
| `KpiCard` | the `valueFormat` prop |
| `DataTableCard` / `DataGrid` | per-column `format` in `columnMetadata` (a VBA/ECMA-376 string) |
| Anywhere in JSX | call a formatter from `@/components/dashboard` directly |

## Format mini-language (chart specs)

Inside a spec, format a channel by adding a `format` string to its `FieldDef`. A
small subset of d3-format (numbers) plus strftime-style dates:

```jsonc
"encoding": {
  "x": { "field": "month", "type": "temporal", "format": "%b %Y" },  // Jan 2024
  "y": { "field": "revenue", "type": "quantitative", "format": "$,.0f" } // $84,200
}
```

**Numbers** — `[$][,][.precision][type]`:

| Hint | Input | Output | Use for |
|---|---|---|---|
| `,d` | `1234567` | `1,234,567` | integers / counts |
| `.1f` | `3.14159` | `3.1` | fixed decimals |
| `.0%` | `0.42` | `42%` | ratios (0–1) as percent |
| `$,.0f` | `5230` | `$5,230` | currency |
| `.1s` / `.2s` | `1200` / `1234567` | `1.2k` / `1.2M` | compact axis ticks |

**Dates** — a hint containing `%` is a date pattern: `%Y %y %m %d %e %B %b %a %H
%M %p %%`. Example `%b %e, %Y` → `Jan 2, 2024`. (See the
[Envy spec reference](envy-spec-reference.md#format-mini-language).)

Envy auto-formats axes, sizes the plot responsively, and legends multi-series
charts by default — you only add a `format` when you want a specific unit (currency
/ percent / compact) or date pattern.

## `valueFormat` (KpiCard)

`KpiCard` takes a one-word preset or a function `(n: number) => string`:

| value | renders | use for |
|---|---|---|
| `"number"` | grouped, compact ≥ 10k | counts, generic scalars (default) |
| `"compact"` | K / M / B / T | large magnitudes |
| `"currency"` | `$1,234.00` | money |
| `"percent"` | `42.0%` (expects a **0–100** value) | rates already in percent |
| `"ratio"` | `42%` (expects a **0–1** value) | ratios / shares |
| `(n) => …` | your own | anything custom |

```tsx
<KpiCard label="Revenue" value={341500} valueFormat="currency" />
<KpiCard label="Conversion" value={0.051} valueFormat="ratio" />   {/* → 5.1% */}
```

`delta` is a **percent-scale number** (`9.2` → `+9.2%`), not a fraction. The
standalone formatters are all exported and null/NaN-safe (non-finite → em dash):
`formatNumber`, `formatCompact`, `formatCurrency`, `formatPercent`, `formatRatio`,
`formatDelta`, `formatDate`.

## Table column formats

`DataTableCard` / `DataGrid` format each cell from that column's `format`
(VBA/ECMA-376) string in `columnMetadata`:

```tsx
const data = toDataTable(result, [
  { name: "month", displayName: "Month" },
  { name: "revenue", displayName: "Revenue", format: "$#,0.00" },
  { name: "margin", displayName: "Margin", format: "0.0%" },
]);
```

- `"#,0"` integers · `"$#,0.00"` currency · `"0.0%"` percent · `"mm/dd/yyyy"` dates.
- A `cellRenderer` **overrides** `format` — see [data-grid-visual.md](data-grid-visual.md).
- **Exception:** numbers that read as identifiers (a year, an ID) shouldn't be
  number-formatted.

## Number rules

- Prefer `.1s`/`.2s` (compact) on chart axes and `"compact"` on KPI heroes; show
  full grouped values in tooltips and tables.
- Currency → 2 decimals; counts → 0.
- Never `FORMAT()` a measure to text in DAX — emit raw numerics. (See
  `dax`.)

## Color & theme

You **never put color in a spec.** `ChartCard` injects the app's theme — a
resolved palette derived from `src/global.css` tokens — into every Envy chart, so
charts stay on-brand and dark-mode aware automatically. Restyle the whole app by
editing the tokens; put light values in the base scope and dark overrides under
`.dark`.

| What to change | CSS variable(s) |
|---|---|
| Accent (recolors charts/links/focus) | `--color-primary`, `--color-chart-1`, `--color-brand`, `--color-ring` |
| Series palette (every chart follows) | `--color-chart-1` … `--color-chart-6` |
| Chart axes / grid | `--color-chart-axis`, `--color-chart-grid` |
| Text | `--color-foreground`, `--color-foreground-secondary`, `--color-foreground-muted` |
| Surfaces / borders | `--color-background`, `--color-card`, `--color-popover`, `--color-border` |
| Fonts | `--font-display`, `--font-sans`, `--font-mono` |
| Radius | `--radius-md`, `--radius-lg`, `--radius-xl`, `--radius-2xl` |

The bridge (`src/lib/envy-theme.ts`) maps these tokens → an Envy `ThemeInput`
(base light/dark + palette + accent + axis/grid) and re-resolves on theme toggle.
All tokens are hex/rgba (never `oklch`) so Envy's color parser can derive ramps,
area fills, and hover tints.

For the **`KpiCard` accent dot** and the small set of places that still take a
color name (`accent` / `seriesColor`), reference a token, never raw hex:
`"chart-1"`…`"chart-6"`, a role (`"success" | "danger" | "warning" | "info" |
"brand" | "neutral"`), `var(--…)`, or a hex string (avoid — won't re-theme).

### Accessibility

The six palette tokens are pre-tuned for contrast. If you author a custom palette,
keep each series ≥ **3:1** against the card background and alternate contrast
between neighbors so adjacent series never blend.
