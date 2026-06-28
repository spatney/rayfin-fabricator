---
name: headless-preview
description: >
  Use to check how a Graphein chart spec looks against REAL data without
  deploying. `npm run preview` renders one spec headlessly to a PNG plus a
  machine-readable report — pull a live DAX result with fabric-app-data, render
  it themed exactly like the deployed app, then view the PNG and read the report
  (clipping / overlap / contrast / mark counts) and iterate. This is the fast
  inner loop per visual; deploy stays the integration checkpoint. Covers the
  query→render→critique loop, the CLI flags, reading the report, the
  validate→repair workflow, and which types are DOM-only (preview by deploying).
---

# Headless preview — render a spec against live data, no deploy

You can render a single Graphein `ChartSpec` **to a PNG and a JSON report on this
machine**, with no browser and no deploy, using `@graphein/node`. Pair it with a
live `fabric-app-data query` result and you can check a visual's *real*
presentation — does the data shape suit this chart, do labels clip, do colors
read, is the trend what you expected — in seconds, before you ever deploy.

> **This is the inner loop; deploy is still the checkpoint.** Headless preview
> validates one visual's presentation and data fit fast. Deploy + screenshot
> remains how you verify the whole app: auth, the Fabric shell, the full
> dashboard, slicers, KPIs, and DOM-only visuals. Use both — preview to iterate a
> chart, deploy to sign off.

## When to use it

| Use headless preview when… | Deploy instead when… |
|---|---|
| Checking a chart against live data before wiring it in | Verifying the whole running app / Fabric shell |
| Choosing a chart type / encoding for a real result | Checking slicers, cross-filtering, auth, navigation |
| Catching clipping, overlap, low contrast, wrong grain | Previewing a `kpi` / `table` / `matrix` / slicer (DOM-only) |
| Tuning formatting, labels, `series`, sort, transforms | Final review / hand-off |

## The loop

```
1. fabric-app-data query <alias> --file q.dax     → live rows (JSON)
2. author a ChartSpec (type + encoding)           → spec.json
3. npm run preview -- --spec spec.json --data rows → PNG + report JSON
4. VIEW the PNG (you have vision) + READ the report
5. not right? adjust the spec / DAX → back to 3
6. happy? drop the spec into a <ChartCard> and deploy
```

## Run it

```bash
# Spec with data already inlined (fully offline, the simplest check):
npm run preview -- --spec hero.json

# Author a spec WITHOUT data, fetch live rows in one shot:
npm run preview -- --spec hero.json --query sales --dax-file src/queries/hero.dax

# Or feed a pre-fetched query result you already have:
npx fabric-app-data query sales --file src/queries/hero.dax > rows.json
npm run preview -- --spec hero.json --data rows.json --theme dark
```

`npm run preview --` forwards flags to `node scripts/preview-visual.mjs`. The spec
is the same JSON you pass to `<ChartCard spec={…} />` (a `type` + `encoding`,
optionally with `data`). `--spec -` and `--data -` read stdin.

### Flags

| Flag | Purpose |
|---|---|
| `--spec <path\|->` | **Required.** The `ChartSpec` JSON (file or stdin). |
| `--query <alias>` | Run DAX against this `fabric.yaml` alias and inject the rows as `spec.data`. |
| `--dax <DAX>` / `--dax-file <path>` | The DAX for `--query` (inline or a `.dax` file). |
| `--data <path\|->` | A pre-fetched `fabric-app-data query` JSON result to map into `spec.data`. |
| `--columns <json>` | Optional `toChartData`-style alias map, e.g. `'{"month":"Date[Month]","revenue":"Total Revenue"}'`. |
| `--out <path>` | PNG path (default: a temp file, echoed as `out`). |
| `--width` / `--height` / `--dpr` | Pixel size (default `800` × `500`, dpr `2`). |
| `--theme light\|dark` | Match `src/global.css` tokens (default `light`). `--no-theme` to skip. |
| `--limit <n>` | Row cap for `--query` (default `1000`). |

Data precedence: `--query` (live) **or** `--data` (pre-fetched) overrides any
inlined `spec.data`; with neither, the spec's own `data` is used. Rows are mapped
exactly like `toChartData` — column **short names** (`Sales[Month]` → `Month`),
numeric DAX types coerced to numbers — so the keys you reference in `encoding`
match. Pass `--columns` to alias them (and to disambiguate two columns that share
a short name), just like `toChartData({ columns })`.

## Read the report

The script prints one JSON object. Treat it as a critique checklist:

```jsonc
{
  "ok": true,                 // false ⇒ the report found a presentation problem
  "rendered": true,
  "type": "line",
  "out": "…/line.png",        // VIEW this image
  "theme": "light",
  "fontParity": true,         // Inter registered → matches the deployed look
  "dataRows": 12,             // how many rows actually rendered (0 ⇒ empty tile!)
  "marks": 12, "series": 1, "colors": 1,
  "summary": "Revenue rose 92% from 120 to 230 between Jan and May.",
  "diagnostics": [            // clipping / overlap / contrast / axis issues
    { "code": "label-overlap", "severity": "warning", "message": "…", "axis": "x" }
  ],
  "lint": [ … ],              // validateSpec warnings (soft issues)
  "repaired": [ … ]           // JSON-Patch ops auto-applied to fix the spec
}
```

- **View the PNG** at `out` — that is the real deployed-look render (app theme +
  Inter font). Judge it like a reviewer: legibility, clipping, color, grain.
- **`ok: false` or any `diagnostics`** → fix before deploying. Common codes:
  label/axis overlap, clipped marks, low contrast, too many colors, empty plot.
- **`dataRows: 0` (or `marks: 0`)** → your `encoding` fields don't match the
  mapped row keys, or the query returned nothing. Fix the field names / `--columns`
  / the DAX — never ship an empty tile.
- **`summary`** is Graphein's own read of the data — a quick sanity check that the
  chart says what you think (e.g. confirms the trend direction).

## Validate → repair (built in)

Before rendering, the script runs `validateSpec(spec)`; if it's invalid it tries
`repairSpec(spec)` and re-validates. You get:

- A clean render plus any `repaired` patch ops (apply the same fixes to your
  source spec) when repair succeeds.
- Exit `1` with `errors` (path-pointed) when the spec can't be auto-repaired —
  read the `path`/`message`, fix the spec, re-run.

You can also call these directly while authoring (all re-exported from the kit):
`validateSpec(spec) → { valid, errors, warnings }`, `repairSpec(spec) → { spec,
applied, remaining }`, `summarize(spec) → string`.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Rendered — PNG written, report printed. |
| `1` | Error — invalid/unrepairable spec, bad data, or render failure (see `error`). |
| `2` | **DOM-only visual** — no headless canvas form; preview it by deploying. |

## What renders headlessly

**Supported** (single canvas charts): `line`, `area`, `bar`, `scatter`, `box`,
`pie`, `heatmap`, `sankey`, `choropleth`, `combo`, `histogram`, `funnel`,
`treemap`, `gauge`, `bullet`, `calendarHeatmap`, `waterfall`, `slope`, `dumbbell`
— plus their `transform`, `annotations`, `insights`, `trendline`, and `facet`.

**DOM-only** (exit `2` — preview by deploying): `kpi`, `table`, `matrix`, and the
slicers (`dropdown`, `list`, `search`, `range`, `dateRange`), and `dashboard`.
These are React/HTML surfaces, not canvas charts.

## Notes

- The PNG defaults to a temp path so nothing lands in the repo; pass `--out` only
  if you want it somewhere specific (don't commit it).
- Theme/font parity is automatic: the script parses `src/global.css` tokens (the
  same `--color-*` bridge as `lib/graphein-theme.ts`) and registers the bundled
  Inter, so a preview looks like the deployed chart. Edit `global.css` to recolor —
  never hardcode hex in a spec.
- This is local presentation feedback. It does **not** replace deploying for
  end-to-end verification.
