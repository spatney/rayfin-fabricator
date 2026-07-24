# DAX Reference

Core syntax, function patterns, BLANK semantics, and time intelligence for dashboard queries.

## Query structure

```dax
[DEFINE
    VAR <variable_name> = <expression>
    MEASURE <table>[<measure_name>] = <expression>
]

EVALUATE
    <table expression>

[ORDER BY <column> [ASC|DESC], ...]
[START AT <value>, ...]
```

- Only one `DEFINE` block; no commas between declarations.
- `EVALUATE` requires a table expression. Use `ROW("Name", <scalar>)` for scalar output.
- Use `ORDER BY` for stable test output; when using `SELECTCOLUMNS`, order by the new column names.
- Columns are `'Table'[Column]`; measures are `[Measure]`.
- Quote table names with single quotes, especially common keyword names like Product, Date, Order, Currency, Time, Calendar.
- DAX strings escape `"` as doubled double quotes: `"He said ""Hello"""`.

## CALCULATE and CALCULATETABLE

```dax
CALCULATE(<scalar expression>, <filter1>, <filter2>, ...)
CALCULATETABLE(<table expression>, <filter1>, <filter2>, ...)
```

Filter arguments can be Boolean conditions, table expressions, or modifiers.

| Modifier | Purpose |
|---|---|
| `ALL()` / `REMOVEFILTERS()` | Clear filters. |
| `ALLEXCEPT()` | Clear all filters except listed columns. |
| `ALLSELECTED()` | Remove visual filters while keeping slicer context. |
| `KEEPFILTERS()` | Intersect with existing filters. |
| `USERELATIONSHIP()` | Activate inactive relationship. |
| `CROSSFILTER()` | Change relationship direction. |

Patterns:

```dax
-- Multiple filters: separate arguments
CALCULATE([Sales], 'Product'[Color] = "Red", 'Customer'[Region] = "West")

-- Percent of total
DIVIDE([Sales], CALCULATE([Sales], ALL('Product')))

-- Preserve existing filter intersection
CALCULATE([Sales], KEEPFILTERS('Product'[Color] IN {"Red", "Blue"}))
```

Boolean filter restrictions:

- A Boolean filter cannot reference multiple tables; use separate arguments.
- Do not reference measures directly in Boolean filters; evaluate the measure into a variable first.
- Do not put table functions such as `FILTER`, `TOPN`, `SUMMARIZECOLUMNS`, `DATESINPERIOD`, `UNION`, `INTERSECT`, etc. inside a Boolean expression. Pass table expressions as filter arguments or use `TREATAS`.

## SUMMARIZECOLUMNS

Preferred for grouped aggregation in queries.

```dax
SUMMARIZECOLUMNS(
    <groupBy_columnName>...,        -- fully qualified columns
    <filterTable>...,               -- table filters such as TREATAS/FILTER
    <name>, <expression>...         -- measures/aggregations
)
```

Critical rules:

- Parameter order is strict: group-by columns, filter tables, then name/expression pairs.
- Filter arguments must be table expressions; use `TREATAS` or `FILTER(ALL(...), ...)`.
- Rows where all measures are BLANK are automatically eliminated.
- Use `SUMMARIZE` or `VALUES` for distinct values without aggregations, especially across multiple tables.

```dax
DEFINE
  VAR _CategoryFilter = TREATAS({"Consumer Electronics"}, 'Product'[Category])
  VAR _YearFilter = FILTER(ALL('Calendar'[Year]), 'Calendar'[Year] >= 2022)

EVALUATE
  SUMMARIZECOLUMNS(
    'Calendar'[Year],
    'Calendar'[Month],
    _CategoryFilter,
    _YearFilter,
    "Total Quantity", SUM('Sales'[Order Quantity]),
    "Discount", [Total Discount]
  )
ORDER BY 'Calendar'[Year], 'Calendar'[Month]
```

## ALL and ALLEXCEPT

`ALL` has two distinct behaviors:

| Context | Returns | Behavior |
|---|---|---|
| Inside `CALCULATE` as a filter argument | Modifier | Removes filters. |
| As a table expression | Table | Returns all rows/values, including the blank row for invalid relationships. |

```dax
-- Grand total modifier
CALCULATE([Sales], ALL('Product'))

-- Table expression for ranking
RANKX(ALL('Product'[Name]), [Sales])
```

`ALLEXCEPT(Table, Column...)` removes all filters from a table except listed columns. It preserves existing filters; `ALL(Table) + VALUES(Column)` adds the current values as a new filter and is often better for parent-group totals.

## TREATAS

`TREATAS(<table_expression>, <column>[, <column>]...)` remaps values as filters on model columns. Column counts must match.

```dax
DEFINE
  VAR _CategoryFilter = TREATAS({"Electronics", "Computers"}, 'Product'[Category])
EVALUATE
  SUMMARIZECOLUMNS('Product'[Name], _CategoryFilter, "Sales", [Total Sales])
```

Use it for `SUMMARIZECOLUMNS` filters, virtual relationships, and selected-value filters from UI state.

## Common query patterns

### Scalar KPI

```dax
EVALUATE ROW("Revenue", [Total Revenue], "Margin %", [Margin %])
```

### Top N

```dax
DEFINE
  VAR _ProductSales = SUMMARIZECOLUMNS('Product'[Name], "Sales", [Total Sales])
EVALUATE
  TOPN(10, _ProductSales, [Sales], DESC)
ORDER BY [Sales] DESC
```

### Distinct values

```dax
EVALUATE VALUES('Product'[Category])
ORDER BY 'Product'[Category]
```

### Multi-dimensional summary

```dax
EVALUATE
  SUMMARIZECOLUMNS(
    'Calendar'[Year],
    'Product'[Category],
    "Revenue", [Total Revenue]
  )
ORDER BY 'Calendar'[Year], [Revenue] DESC
```

### Cross-table selection with duplicates

```dax
EVALUATE
  CALCULATETABLE(
    SELECTCOLUMNS(
      'Sales',
      "Product Name", RELATED('Product'[Name]),
      "Customer Name", RELATED('Customer'[Name]),
      'Sales'[OrderDate]
    ),
    'Calendar'[Year] = 2024
  )
ORDER BY [Product Name], [Customer Name]
```

### Items with no matches

```dax
DEFINE
  MEASURE 'Sales'[Row Count] = COUNTROWS('Sales')
EVALUATE
  FILTER('Product', ISBLANK([Row Count]))
```

## BLANK semantics

BLANK is not SQL NULL. It may convert to 0 or empty string in some operations, and `SUMMARIZECOLUMNS` uses non-empty semantics.

| Behavior | DAX BLANK |
|---|---|
| `BLANK() + 4` | `4` |
| `BLANK() * 4` | BLANK |
| `4 / BLANK()` | Infinity |
| `DIVIDE(4, BLANK())` | BLANK |
| `BLANK() = 0` | TRUE |
| `BLANK() == 0` | FALSE |
| `BLANK() = ""` | TRUE |
| `BLANK() == BLANK()` | TRUE |

Rules:

- Use `ISBLANK(x)` or `x == BLANK()`; standard equality treats BLANK as 0/empty/FALSE.
- Let measures return BLANK. Avoid `+ 0` and `DIVIDE(x, y, 0)` in grouped queries.
- Use `COALESCE` sparingly and only when display semantics truly require a default.
- BLANK sorts lowest; it sorts before numeric zero.
- `VALUES(column)` may include the relationship blank row; `DISTINCT(column)` does not; `ALLNOBLANKROW(table)` removes that special blank row.

## Time intelligence

Time intelligence requires a Date table with contiguous unique dates, marked as a date table, and an active relationship to facts.

| Category | Purpose | Key functions |
|---|---|---|
| Period-to-date | Cumulative from period start | `DATESYTD`, `DATESQTD`, `DATESMTD`, `DATESWTD` |
| Total-to-date | Aggregate to period end | `TOTALYTD`, `TOTALQTD`, `TOTALMTD`, `TOTALWTD` |
| Period shifting | Move dates | `DATEADD`, `SAMEPERIODLASTYEAR`, `PARALLELPERIOD` |
| Custom ranges | Rolling/custom windows | `DATESINPERIOD`, `DATESBETWEEN` |
| Navigation | First/last/start/end dates | `FIRSTDATE`, `LASTDATE`, `STARTOFMONTH`, `ENDOFYEAR` |
| Balances | Period boundaries | `OPENINGBALANCEYEAR`, `CLOSINGBALANCEMONTH` |

Patterns:

```dax
Sales YTD = CALCULATE([Total Sales], DATESYTD('Date'[Date]))
Sales FY YTD = TOTALYTD([Total Sales], 'Date'[Date], "6/30")
Sales PY = CALCULATE([Total Sales], SAMEPERIODLASTYEAR('Date'[Date]))
Sales YoY % = DIVIDE([Total Sales] - [Sales PY], [Sales PY])
Sales Rolling 12M = CALCULATE([Total Sales], DATESINPERIOD('Date'[Date], MAX('Date'[Date]), -12, MONTH))
```

`PARALLELPERIOD` returns a complete parallel period; `DATEADD` shifts each date individually.

### Time intelligence inside queries

Establish date context by grouping on date columns or applying date filters.

```dax
EVALUATE
SUMMARIZECOLUMNS(
  'Date'[Year],
  'Date'[Month],
  'Date'[MonthNumberOfYear],
  "Sales YTD", TOTALYTD([Total Sales], 'Date'[Date]),
  "Sales PY", CALCULATE([Total Sales], SAMEPERIODLASTYEAR('Date'[Date]))
)
ORDER BY 'Date'[Year], 'Date'[MonthNumberOfYear]
```

For KPI-style rows, use `CALCULATETABLE` plus a date filter/reference:

```dax
EVALUATE
CALCULATETABLE(
  ROW(
    "Sales YTD", TOTALYTD([Total Sales], 'Date'[Date]),
    "14-Day Moving Avg", AVERAGEX(DATESINPERIOD('Date'[Date], MAX('Date'[Date]), -14, DAY), [Total Sales])
  ),
  TREATAS({ MAX('Sales'[OrderDate]) }, 'Date'[Date])
)
```

Avoid hardcoded "last year" when data recency matters; derive it from the fact table's max date.

```dax
DEFINE
  VAR _LastYear = YEAR(MAX('Sales'[OrderDate]))
EVALUATE
SUMMARIZECOLUMNS(
  'Customer'[Name],
  'Date'[Year],
  TREATAS({ _LastYear, _LastYear - 1 }, 'Date'[Year]),
  "Total Sales", [Total Sales],
  "Sales PY", CALCULATE([Total Sales], SAMEPERIODLASTYEAR('Date'[Date]))
)
```

Common mistakes:

- Using fact date columns directly in time-intelligence functions instead of the Date table.
- Missing/gapped Date table.
- Hand-writing date filters when built-in functions (`DATESYTD`, `DATESINPERIOD`) are clearer.
- Nested time intelligence where intermediate measures/variables would be clearer.
