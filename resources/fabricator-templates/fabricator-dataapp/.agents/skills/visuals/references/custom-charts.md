# When the kit lacks your chart — pick the closest Graphein type

There is **no custom-chart escape hatch** to maintain anymore: charts are Graphein
specs, and you compose them by choosing a `type` and an `encoding`. When a
visualization isn't an obvious built-in, don't hand-roll SVG — map it onto the
nearest Graphein type. Graphein 0.6 has a broad catalog, so most intents now have
a native type.

## Map the intent to a type

| You want… | Author this |
|---|---|
| Ranked / "top N" | `bar` (vertical), rows sorted by value (`topN`) |
| Horizontal two-point compare (before/after) | `dumbbell` (`category` + `value` + `group`) |
| Progress to goal / actual vs target | `bullet` (`value` + `target`), or a `KpiCard` with `delta` |
| Gauge / single value vs max | `gauge` (`value` + `min`/`max`) |
| Two measures, different scales | `combo` (dual-axis: `layers[]` with `axis: "left" \| "right"`) |
| Funnel / stage conversion | native `funnel` (`stage` + `value`) |
| Running total / bridge | native `waterfall` (`stage` + signed `value`, `totals?`) |
| Nested part-to-whole | native `treemap` (`category` + `value` + `group?`) |
| Distribution of one measure | native `histogram` (`x` binned) |
| Value over a calendar | native `calendarHeatmap` (`date` + `color`) |
| Rank change between two periods | native `slope` (`x` two values, `y`, `series`) |
| Distribution / spread | `box` (raw observations per category) |
| Flow between nodes | `sankey` (`source` + `target` + `value`) |
| Values on a map | `choropleth` (`geo` FeatureCollection + `key` + `color`) |
| Cross-tab / pivot table | `matrix` spec (or `DataTableCard` with a `matrix` spec) |

All of the above are valid Graphein types — author them as a spec and drop them
into `ChartCard` like any other (see the
[spec reference](graphein-spec-reference.md)). Most render headlessly, so check
them with `npm run preview` before deploying (see the **headless-preview** skill).

## If a type genuinely doesn't exist

Graphein 0.6 still has **no radar/spider chart** (and no sunburst). It also does
not honor horizontal **bars** (the `orientation` field is ignored). Options, in
order:

1. **Re-express the question** with a supported type — a radar is usually a
   small-multiple (`facet`) of bars or a `line`; a horizontal ranked bar is a
   sorted **vertical** `bar`; a sunburst is often a `treemap`. This is almost
   always the right call.
2. **A simple bespoke React component** inside a `ChartCard` (children mode) for a
   truly one-off, non-charty visual (e.g. a custom progress list). Theme it from
   `src/global.css` tokens and `seriesColor` / `roleColor` so dark mode keeps
   working — never hardcode hex.

Before reaching for a custom component, reconsider the declarative features —
`transform` (aggregate/bin/fold), `annotations` (reference lines/bands),
`insights`, `trendline`, and `facet` cover many things that used to need bespoke
drawing.

Don't rebuild a charting core. If you find yourself writing axis/scale math, step
back and pick a supported Graphein type instead.
