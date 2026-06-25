# Highlight Queries — Aligned Subsets for Cross-Highlight Overlays

A cross-highlight overlay layers a bright "selected subset" on a dimmed baseline. The subset comes from a fresh DAX query scoped by the selection — not from filtering the baseline result client-side.

For how the spec binds the two tables to two layers, see the visuals skill's [multi-data input](../../visuals/references/multi-data-input.md) reference. This page covers producing the subset table.

## When you need this

A chart layers two datasets at the same axis grain (dimmed baseline + bright subset), and the bright layer reflects a selection made elsewhere on the page.

If the selection column is one of the chart's own encoding fields and you only need to dim non-matching rows, use Vega-Lite native selection in the spec — no query needed.

## Re-aggregate, don't filter

The baseline and the subset are two separate queries. The subset query has:

- The **same grouping columns** as the baseline.
- The **same measure expressions** as the baseline.
- An **added filter** from the selection's predicates, via `CALCULATETABLE` + `TREATAS` / `KEEPFILTERS`.

Wrap the baseline aggregation in `CALCULATETABLE`:

```dax
// Baseline
EVALUATE
  SUMMARIZECOLUMNS('Product'[Category], "Sales", [Total Sales])
ORDER BY 'Product'[Category]
```

```dax
// Subset — selection: Rating ∈ {PG, PG-13}
EVALUATE
  CALCULATETABLE(
    SUMMARIZECOLUMNS('Product'[Category], "Sales", [Total Sales]),
    TREATAS({"PG", "PG-13"}, 'Movie'[Rating])
  )
ORDER BY 'Product'[Category]
```

The model re-evaluates `[Total Sales]` under the added filter. `Movie[Rating]` doesn't appear in the result; the chart doesn't project it.

## Match the baseline's row set

The two layers register by axis key. Every baseline row needs a counterpart in the subset, even when the selection matches no fact rows for that group.

`SUMMARIZECOLUMNS` drops groups where every measure is BLANK, which leaves gaps under baseline bars. Keep all rows one of two ways:

**Option A — coalesce the measure to zero:**

```dax
EVALUATE
  CALCULATETABLE(
    SUMMARIZECOLUMNS('Product'[Category], "Sales", COALESCE([Total Sales], 0)),
    TREATAS({"PG", "PG-13"}, 'Movie'[Rating])
  )
ORDER BY 'Product'[Category]
```

**Option B — left-join the baseline's group list** (use when zero is wrong, e.g. a ratio that must stay BLANK):

```dax
EVALUATE
  VAR Categories = SUMMARIZECOLUMNS('Product'[Category])
  VAR Filtered =
    CALCULATETABLE(
      SUMMARIZECOLUMNS('Product'[Category], "Sales", [Total Sales]),
      TREATAS({"PG", "PG-13"}, 'Movie'[Rating])
    )
  RETURN NATURALLEFTOUTERJOIN(Categories, Filtered)
ORDER BY 'Product'[Category]
```

## Build the filter from a selection

`DataPointSelection[]` is a disjunction (OR) of conjunctions (AND) of predicates:

- `SetPredicate` (`{ type: 'set', name, values }`) → `TREATAS(<values>, '<Table>'[<Column>])`.
- `RangePredicate` (`{ type: 'range', name, min, max }`) → `FILTER('<Table>', '<Table>'[<Column>] >= min && '<Table>'[<Column>] <= max)`.
- Multiple predicates in one selection → multiple filter arguments to the same `CALCULATETABLE` (AND).
- Multiple selections → `UNION` the per-selection filter tables inside one `KEEPFILTERS` argument (OR).

Assemble the query string in TypeScript and pass it to `useSemanticModelQuery`. Identical selections reuse the SDK's cache.

## Wiring it in the component

The host component holds the selection (from another visual's `onInteraction`), fetches the aligned subset, and swaps the second named dataset on each change. Pass `{ all }` alone when there's no selection, `{ all, highlighted }` once a subset is fetched.

```tsx
function SalesByCategoryChart({ selections }: { selections: DataPointSelection[] | null }) {
  const theme = useCssTheme();
  const all = useBaselineTable();
  const highlighted = useHighlightedTable(selections); // scoped CALCULATETABLE query; null when no selection

  return (
    <VegaVisual
      spec={vegaLiteSpec}
      data={highlighted ? { all, highlighted } : { all }}
      theme={theme}
    />
  );
}
```

`useHighlightedTable` builds the scoped query from the selection's predicates (above) and runs it through `useSemanticModelQuery` — it does **not** filter `all` client-side. See the visuals [multi-data input](../../visuals/references/multi-data-input.md) reference for how the spec layers `all` and `highlighted`.

## Keep baseline and subset in sync

When the baseline query changes, keep the subset query in sync with it:

- Same grouping columns, same order.
- Same measure name and expression — the spec's field reference (`y: { field: "Sales" }`) is shared by both layers.
- Same outer time / scope filters; the selection adds to them, it doesn't replace them.

Derive both from the same factory: the baseline query is the source; the subset query is `CALCULATETABLE(<baseline aggregation>, <selection predicates>)`.

## Anti-patterns

- ❌ **Filtering the baseline DataTable client-side.** Cannot re-aggregate measures, apply RLS, or resolve selections on unprojected columns. Wrong subtotals for any non-SUM measure (DISTINCTCOUNT, ratios, AVERAGEX, complex measures).
- ❌ **`FILTER('FactTable', …)` instead of `TREATAS` on the dimension column.** Targets the wrong table, ignores relationships, slower.
- ❌ **Letting `SUMMARIZECOLUMNS` drop empty groups.** Causes axis-key gaps. Use `COALESCE` or a left-join.
- ❌ **Changing grain or column shape in the subset query.** The layers no longer share an axis.
- ❌ **`FORMAT()` in the subset query.** Stringified measures break the shared field encoding. Return raw types.
