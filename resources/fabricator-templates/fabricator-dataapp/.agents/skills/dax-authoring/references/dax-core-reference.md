# DAX Core Reference

Shared DAX knowledge used across queries, measures, and calculated columns.

## DAX Syntax Rules

- Measures are named objects in the semantic model. Although numeric measures are the most common, they can return values of any data type. Measures specify how to aggregate data. **Measures should be used first** to answer user requests in a DAX query before a new DAX formula is used to aggregate data in the DAX query.
- **EVALUATE Statement**: This is not a function but a statement. It must always precede a table expression. Avoid pairing EVALUATE with scalar functions like CONCATENATEX, SUMX, DISTINCTCOUNT, etc.
- Use the fully-qualified name, such as `'Table'[Column]`, for column references, and the simple name, like `[Measure]`, for measure references.
- CALCULATE takes a scalar expression as its first argument and returns a scalar value. CALCULATETABLE takes a table expression as its first argument and returns a table.
- The SUMMARIZECOLUMNS Function: This function requires a specific order of input parameters. Begin with the 'groupby' columns, then add filters, and end with aggregations or measures.
- Do not use SUMMARIZECOLUMNS when there is no aggregation or measure and the 'groupby' columns belong to more than one table; use VALUES, SUMMARIZE, or SELECTCOLUMNS instead.
- When using table expressions like SELECTCOLUMNS or CALCULATETABLE, include any columns that will be needed after, for example in an ORDER BY, FILTER.
- Filters applied to one table can propagate to another table across a relationship based on the defined filter propagation which can be either unidirectional or bidirectional.
- Avoid using SQL keywords like SELECT, WHERE, HAVING, etc. within DAX expressions.
- When using the set functions INTERSECT, UNION, or EXCEPT, make sure both input tables produce an identical number of columns.
- When using DEFINE, only use single DEFINE and any VAR or MEASURE defined are separated by new line without commas.
- For any requests involving calculations or filters based on the current date or time, use the TODAY or NOW() functions.

## CALCULATE & CALCULATETABLE

CALCULATE is the most important and powerful function in DAX. It evaluates a scalar expression in a modified filter context. CALCULATETABLE applies the same filter-context rules but returns a table expression instead of a scalar.

### Syntax

```dax
CALCULATE(<Expression> [, <Filter1> [, <Filter2> [, ...]]])
CALCULATETABLE(<TableExpression> [, <Filter1> [, <Filter2> [, ...]]])
```

### Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| Expression | Yes | The scalar expression to evaluate (CALCULATE only) |
| TableExpression | Yes | The table expression to evaluate (CALCULATETABLE only) |
| Filter | No | Boolean condition, table expression, or CALCULATE/CALCULATETABLE modifier |

### Return Value

- **CALCULATE**: Scalar value - the result of the expression evaluated in the modified filter context.
- **CALCULATETABLE**: Table value - the result of the table expression evaluated in the modified filter context.

### Filter Argument Types

#### 1. Boolean Conditions (Compact Syntax)
```dax
// Single column filter
CALCULATE([Sales Amount], 'Product'[Color] = "Red")

// IN operator for multiple values
CALCULATE([Sales Amount], 'Product'[Color] IN {"Red", "Blue"})
```

#### 2. Table Expressions
```dax
// Explicit table filter (equivalent to boolean)
CALCULATE(
    [Sales Amount],
    FILTER(ALL('Product'[Color]), 'Product'[Color] = "Red")
)
```

#### 3. CALCULATE/CALCULATETABLE Modifiers

| Modifier | Purpose |
|----------|---------|
| `ALL()` | Remove filters from table or columns |
| `ALLCROSSFILTERED()` | Clear filters on the table and filters reaching it via cross-filtering |
| `ALLEXCEPT()` | Remove all filters except specified columns |
| `ALLSELECTED()` | Remove visual filters, keep slicers |
| `KEEPFILTERS()` | Intersect with existing filters |
| `REMOVEFILTERS()` | Remove filters (alias for ALL) |
| `USERELATIONSHIP()` | Activate an inactive relationship |
| `CROSSFILTER()` | Modify filter direction |

### Context Transition

When CALCULATE or CALCULATETABLE is executed in a row context, it converts the row context to an equivalent filter context.

```dax
// Inside an iterator, CALCULATE triggers context transition
Yearly Avg = AVERAGEX(
    VALUES('Date'[Calendar Year]),
    CALCULATE(SUM(Sales[Amount]))  // Row context becomes filter context
)
```

Every measure reference implicitly wraps in CALCULATE, triggering context transition:
```dax
// These are equivalent inside an iterator:
AVERAGEX(VALUES('Date'[Year]), CALCULATE([Sales Amount])) // Explicit CALCULATE is unnecessary
AVERAGEX(VALUES('Date'[Year]), [Sales Amount])  // Implicit CALCULATE
```

### Common Patterns

#### Percentage of Total
```dax
% of Total = DIVIDE(
    [Sales Amount],
    CALCULATE([Sales Amount], ALL('Product'))
)
```

#### Conditional Aggregation
```dax
High Value Sales = CALCULATE(
    [Sales Amount],
    Sales[Amount] > 1000
)
```

#### Time Intelligence
```dax
Sales YTD = CALCULATE([Sales Amount], DATESYTD('Date'[Date]))
Sales PY = CALCULATE([Sales Amount], SAMEPERIODLASTYEAR('Date'[Date]))
```

#### Multiple Filters (AND logic)
```dax
Red Electronics = CALCULATE(
    [Sales Amount],
    'Product'[Color] = "Red",
    'Product'[Category] = "Electronics"
)
```

#### KEEPFILTERS - Intersect Filters
```dax
// Without KEEPFILTERS: overrides existing Color filter (always Red+Blue)
Red Blue Sales = CALCULATE(
    [Sales Amount],
    'Product'[Color] IN {"Red", "Blue"}
)

// With KEEPFILTERS: intersects with existing Color filter
Red Blue Keepfilters = CALCULATE(
    [Sales Amount],
    KEEPFILTERS('Product'[Color] IN {"Red", "Blue"})
)
```

#### Using Relationship Modifiers
```dax
Delivered Sales = CALCULATE(
    [Sales Amount],
    USERELATIONSHIP(Sales[Delivery Date], 'Date'[Date])
)
```

### Boolean Filter Restrictions

#### Cannot Reference Multiple Tables
```dax
// Wrong - references both Product and Customer
CALCULATE([Sales], 'Product'[Color] = "Red" && 'Customer'[Region] = "West")

// Correct - each filter is a separate argument
CALCULATE(
    [Sales],
    'Product'[Color] = "Red",
    'Customer'[Region] = "West"
)
```

#### Cannot Use Measures Directly
```dax
// Wrong - measure in boolean filter
CALCULATE([Sales], 'Product'[Price] > [Avg Price])

// Correct - use variable
VAR AvgPrice = [Avg Price]
RETURN CALCULATE([Sales], 'Product'[Price] > AvgPrice)
```

#### Cannot Use Certain Table Functions in Boolean Filters

Some table functions are forbidden inside Boolean filter expressions. These functions can be passed directly as CALCULATE filter arguments, but cannot appear inside Boolean expressions (e.g., as the second operand of the `IN` operator).

Forbidden: `ADDCOLUMNS`, `FILTER`, `GROUPBY`, `SUMMARIZE`, `SUMMARIZECOLUMNS`, `TOPN`, `DATESBETWEEN`, `DATESINPERIOD`, `WINDOW`, `OFFSET`, `INDEX`, `RANK`, `INTERSECT`, `UNION`, `EXCEPT`, etc.

```dax
// Wrong - FILTER inside IN operator
CALCULATE([Sales], 'Product'[Color] IN FILTER(ALL('Product'[Color]), LEFT('Product'[Color], 1) = "B"))

// Correct - use a simple Boolean predicate
CALCULATE([Sales], LEFT('Product'[Color], 1) = "B")

// Correct - use TREATAS instead of IN
CALCULATE(
    [Reseller Sales],
    TREATAS(
        INTERSECT(
            CALCULATETABLE(VALUES('InternetSales'[ProductKey]), 'Customer'[Age] > 60),
            CALCULATETABLE(VALUES('InternetSales'[ProductKey]), 'Customer'[Age] < 16)
        ),
        'ResellerSales'[ProductKey]
    )
)

// Correct - evaluate table function in a variable first
VAR Threshold = AVERAGEX(TOPN(20, 'Product', [Sales], DESC), 'Product'[ListPrice])
RETURN CALCULATE([Sales], 'Product'[ListPrice] > Threshold)
```

### Quick Reference

| Pattern | Formula |
|---------|---------|
| Simple filter | `CALCULATE([M], Table[Col] = "Value")` |
| Multiple values | `CALCULATE([M], Table[Col] IN {"A", "B"})` |
| Remove filter | `CALCULATE([M], ALL(Table[Col]))` |
| Remove table filter | `CALCULATE([M], ALL(Table))` |
| Percentage of total | `DIVIDE([M], CALCULATE([M], ALL(Table)))` |
| Keep + new filter | `CALCULATE([M], KEEPFILTERS(Table[Col] = "X"))` |
| Time intelligence | `CALCULATE([M], DATESYTD('Date'[Date]))` |
| Different relationship | `CALCULATE([M], USERELATIONSHIP(...))` |
| Filtered table | `CALCULATETABLE(Table, Table[Col] = "Value")` |

## SUMMARIZECOLUMNS

SUMMARIZECOLUMNS is the modern, high-performance function for grouping data and calculating aggregations in DAX queries. It's the preferred choice over SUMMARIZE when working with measures.

### Syntax

```dax
SUMMARIZECOLUMNS(
    <groupBy_columnName> [, <groupBy_columnName>]...,
    [<filterTable>]...,
    [<name>, <expression>]...
)
```

### Parameters

- **groupBy_columnName** (optional): Column references to group by. Must be fully qualified (`Table[Column]`)
- **filterTable** (optional): Table expressions used to filter the result
- **name** (optional): Name for a calculated column
- **expression** (optional): DAX expression for a calculated column

**Critical:**
- **All parameter types are optional** - you can omit groupBy columns, filters, or aggregations as needed
- When present, parameters must follow this order: GroupBy Columns -> Filter Tables -> Aggregations/Measures
- Valid combinations include: filters + measures only (no groupBy), groupBy + measures only (no filters), etc.

### Key Characteristics

#### 1. Automatic Blank Measure Row Elimination

SUMMARIZECOLUMNS returns only rows where **at least one measure is not BLANK**.

```dax
// Only returns categories that have sales
EVALUATE
    SUMMARIZECOLUMNS(
        'Product'[Category],
        "Total Sales", [Total Sales]
    )
```

> **Important Distinction**: This elimination is about **measure values being blank**, NOT about excluding the **blank row from referential integrity violations**. If orphaned fact rows exist, they are grouped under the blank row member and **will appear** if aggregated measures are non-blank.

#### 2. Filter Arguments Must Be Table Expressions

```dax
// Wrong:
SUMMARIZECOLUMNS('Product'[Category], 'Product'[Category] = "Bikes", "Total Sales", [Total Sales])

// Correct - Use TREATAS:
DEFINE
    VAR _CategoryFilter = TREATAS({"Bikes"}, 'Product'[Category])
EVALUATE
    SUMMARIZECOLUMNS('Product'[Category], _CategoryFilter, "Total Sales", [Total Sales])
```

#### 3. Parameter Order is Strict

```dax
SUMMARIZECOLUMNS(
    // 1. GroupBy columns (any number)
    'Product'[Category],
    'Calendar'[Year],
    // 2. Filters (any number of table expressions)
    TREATAS({"Red", "Black"}, 'Product'[Color]),
    FILTER(ALL('Calendar'[Year]), 'Calendar'[Year] >= 2020),
    // 3. Aggregations/Measures (name-expression pairs)
    "Total Sales", [Total Sales],
    "Quantity", SUM('Sales'[Quantity])
)
```

### Common Usage Patterns

#### Basic Grouping with Measures
```dax
EVALUATE
    SUMMARIZECOLUMNS(
        'Product'[Category],
        'Calendar'[Year],
        "Total Sales", [Total Sales],
        "Total Quantity", SUM('Sales'[Quantity])
    )
ORDER BY 'Calendar'[Year] DESC, [Total Sales] DESC
```

#### With TREATAS Filter
```dax
DEFINE
    VAR _CategoryFilter = TREATAS({"Consumer Electronics"}, 'Product'[Category])
EVALUATE
    SUMMARIZECOLUMNS(
        'Calendar'[Year],
        'Calendar'[Month],
        _CategoryFilter,
        "Total Quantity", SUM('Sales'[Order Quantity])
    )
ORDER BY 'Calendar'[Year] DESC, 'Calendar'[Month] DESC
```

#### With FILTER + ALL for Ranges
```dax
DEFINE
    VAR _YearFilter = FILTER(ALL('Calendar'[Year]), 'Calendar'[Year] >= 2022 && 'Calendar'[Year] <= 2023)
EVALUATE
    SUMMARIZECOLUMNS('Calendar'[Year], _YearFilter, "Total Sales", [Total Sales])
ORDER BY 'Calendar'[Year] DESC
```

#### Top N with SUMMARIZECOLUMNS
```dax
DEFINE
    VAR _ProductSales = SUMMARIZECOLUMNS('Product'[Name], "Sales", [Total Sales])
EVALUATE
    TOPN(10, _ProductSales, [Sales], DESC)
ORDER BY [Sales] DESC
```

#### Filter Only (No GroupBy Columns)

Returns a single-row result with aggregated values.

```dax
DEFINE
    VAR __filtered_products = FILTER(ALL('Product'[ProductID]), 'Product'[Category] = "Electronics")
EVALUATE
    SUMMARIZECOLUMNS(__filtered_products, "Filtered Count", COUNTROWS('Product'))
```

### SUMMARIZECOLUMNS vs SUMMARIZE

| Aspect | SUMMARIZECOLUMNS | SUMMARIZE |
|--------|------------------|-----------|
| **Use for** | Aggregations with measures | Distinct column combinations only |
| **Blank measure elimination** | Auto-eliminates rows where ALL measures are BLANK | Keeps all combinations |
| **Performance** | Optimized for queries | Less optimized |
| **Filter params** | Accepts table filters | No filter parameters |

Use SUMMARIZECOLUMNS when you need aggregations. Use SUMMARIZE when you only need distinct combinations of column values.

## ALL & ALLEXCEPT

### ALL Function

Removes filters from a table or column(s), or returns all values as a table regardless of filter context.

> **Note**: This function has two distinct usages with different behaviors.

#### ALL as CALCULATE Modifier (Filter Removal)

```dax
CALCULATE(<Expression>, ALL(<TableName>))
CALCULATE(<Expression>, ALL(<ColumnName>[, <ColumnName>, ...]))
CALCULATE(<Expression>, ALL())
```

When used as a filter argument in CALCULATE:
- **Does NOT return a table** — only removes filters from filter context
- Clears filters on specified table or column(s)
- `ALL()` with no arguments removes all filters from all tables
- `REMOVEFILTERS` is functionally equivalent in this context

**Percentage of Total:**
```dax
Sales % of Total = DIVIDE(
    SUM(Sales[Amount]),
    CALCULATE(SUM(Sales[Amount]), ALL(Product))
)
```

**Remove Filter on Specific Column(s):**
```dax
Sales All Colors = CALCULATE([Sales Amount], ALL(Product[Color]))
```

**Grand Total Across All Dimensions:**
```dax
Database Grand Total = CALCULATE([Sales Amount], ALL())
```

| Pattern | Formula |
|---------|---------|
| Grand total | `CALCULATE([Measure], ALL(Table))` |
| % of total | `DIVIDE([Measure], CALCULATE([Measure], ALL(Table)))` |
| Ignore specific filter | `CALCULATE([Measure], ALL(Table[Column]))` |

#### ALL as Table Function (Returns Rows)

When used as a table expression:
- **Returns a table** containing all rows/values, ignoring filter context
- Includes blank row for invalid relationships
- Can be used with iterators (SUMX, FILTER, etc.)

**Ranking Pattern:**
```dax
Product Rank = RANKX(ALL(Product[Product Name]), [Sales Amount])
```

**Iteration Over All Values:**
```dax
Max Sales Any Product = MAXX(ALL(Product), [Sales Amount])
```

**Count All Values:**
```dax
Total Product Count = COUNTROWS(ALL(Product))
```

#### Key Distinction

| Usage Context | Returns | Behavior |
|---------------|---------|----------|
| Inside CALCULATE as filter argument | Nothing (modifier only) | Removes filters from context |
| Anywhere else (iterator, variable, table expression) | Table of rows | Returns all rows ignoring filters |

Notes:
- Always includes blank row for invalid relationships (use `ALLNOBLANKROW` to exclude)
- `ALL()` with no arguments ONLY works inside CALCULATE as modifier

### ALLEXCEPT Function

Removes all filters from a table except for specified columns.

#### ALLEXCEPT as CALCULATE Modifier

```dax
CALCULATE(<Expression>, ALLEXCEPT(<Table>, <Column1>[, <Column2>, ...]))
```

When used as a filter argument in CALCULATE:
- **Does NOT return a table** — only modifies filter context
- Clears all filters on the specified table
- Retains filters ONLY on the listed columns

**Percentage of Parent Group:**
```dax
% of Continent =
VAR CurrentSales = [Sales Amount]
VAR ContinentSales = CALCULATE(
    [Sales Amount],
    ALLEXCEPT(Customer, Customer[Continent])
)
RETURN DIVIDE(CurrentSales, ContinentSales)
```

**Subtotal Pattern:**
```dax
Category Subtotal = CALCULATE(
    [Sales Amount],
    ALLEXCEPT(Product, Product[Category])
)
```

#### ALLEXCEPT vs ALL + VALUES

```dax
// Using ALLEXCEPT — preserves existing Continent filters
CALCULATE([Sales], ALLEXCEPT(Customer, Customer[Continent]))

// Using ALL + VALUES — adds current Continent(s) as a new filter
CALCULATE([Sales], ALL(Customer), VALUES(Customer[Continent]))
```

**Critical Difference**: ALLEXCEPT preserves existing filters; ALL + VALUES adds the current values as a new filter. Use ALL + VALUES when you need the parent group total. Use ALLEXCEPT only when an explicit filter already exists on the column you want to preserve.

#### ALLEXCEPT as Table Function

```dax
// Count products in current category regardless of other filters
Products in Category =
VAR CategoryProducts = ALLEXCEPT(Product, Product[Category])
RETURN COUNTROWS(CategoryProducts)
```

## TREATAS

TREATAS takes a table expression and remaps its columns as if they were columns that already exist in the data model. It applies a virtual relationship between the input table and the target columns without requiring an actual relationship.

### Syntax

```dax
TREATAS(<table_expression>, <column>[, <column>]...)
```

- **table_expression**: A table expression that returns values to be mapped
- **column**: Fully qualified column references. Count must match the table expression's column count.

Due to auto-exist semantics, only rows where the value combinations actually exist in the target columns are retained.

### Examples

#### Simple Column Mapping
```dax
CALCULATE([Sales Amount], TREATAS({"Red", "Blue"}, Product[Color]))
```

#### Multi-Column Mapping
```dax
CALCULATETABLE(
    Sales,
    TREATAS({(2023, 1), (2023, 2)}, Calendar[Year], Calendar[Quarter])
)
```

#### In SUMMARIZECOLUMNS (Most Common Usage)

TREATAS is the preferred way to create filter arguments for SUMMARIZECOLUMNS.

```dax
DEFINE
    VAR _CategoryFilter = TREATAS({"Electronics", "Computers"}, 'Product'[Category])
EVALUATE
    SUMMARIZECOLUMNS(
        'Product'[Name],
        _CategoryFilter,
        "Sales", [Total Sales]
    )
```

#### Filtering with Dynamic Values
```dax
DEFINE
    VAR _TopCategories = TOPN(3, VALUES('Product'[Category]), [Total Sales])
    VAR _CategoryFilter = TREATAS(_TopCategories, 'Product'[Category])
EVALUATE
    SUMMARIZECOLUMNS('Product'[Name], _CategoryFilter, "Sales", [Total Sales])
```

#### Virtual Relationships
```dax
CALCULATE(
    [Total Sales],
    TREATAS(VALUES(BudgetTable[ProductID]), Product[ProductID])
)
```

### Key Points
- Creates a virtual relationship for filtering purposes
- Values that don't exist in the target column are automatically filtered out (auto-exist)
- Most commonly used with SUMMARIZECOLUMNS as a filter argument
- Column count in table expression must match number of target columns
- Replaces older patterns like INTERSECT for applying dynamic filters

## Common Mistakes

### 1. Using Reserved Keywords Incorrectly

#### As Variable Names

Reserved keywords cannot be used as variable names in VAR statements.

```dax
// Wrong: SUM is a reserved keyword
Total Sales =
VAR SUM = [Sales Amount]
RETURN SUM

// Correct: Use prefixed name
Total Sales =
VAR _TotalSales = [Sales Amount]
RETURN _TotalSales
```

#### As Table Names

Many common table names like "Product", "Date", "Order" are also DAX reserved keywords. When a table name conflicts with a reserved keyword, enclose it in single quotes.

```dax
// Wrong: PRODUCT is a reserved keyword
Total Products = COUNTROWS(Product)

// Correct: Single quotes escape the table name
Total Products = COUNTROWS('Product')

// Wrong: DATE is a reserved keyword
Sales This Year = CALCULATE([Sales Amount], Date[Year] = 2024)

// Correct:
Sales This Year = CALCULATE([Sales Amount], 'Date'[Year] = 2024)
```

**Common table names that are keywords**: Product, Date, Order, Currency, Time, Calendar

**Best Practice**: Always quote table names with single quotes for all table references, even if not currently a keyword.

### 2. Incorrect Column Reference from Table Variables

You cannot directly project a single column from a table variable using `_varTable[Column]` syntax.

```dax
// Wrong:
VAR _modelInfo = INFO.MODEL()
VAR _discouraged = _modelInfo[DiscourageImplicitMeasures]
RETURN _discouraged

// Correct: Use SUMMARIZE
VAR _modelInfo = INFO.MODEL()
VAR _discouraged = SUMMARIZE(_modelInfo, [DiscourageImplicitMeasures])
RETURN _discouraged
```

```dax
// Wrong:
VAR _products = FILTER('Product', 'Product'[Category] = "Bikes")
RETURN _products[ProductName]

// Correct: Reference columns in iterator functions
VAR _products = FILTER('Product', 'Product'[Category] = "Bikes")
RETURN CONCATENATEX(_products, 'Product'[ProductName], ", ")
```

### 3. Incorrect String Literal Escaping

DAX uses doubled double quotes for escaping, not backslash.

```dax
// Wrong: Backslash escape doesn't work in DAX
"He said \"Hello\""

// Correct: Two double quotes = one quote in the string
"He said ""Hello"""
```

## BLANK Semantics

### Overview

BLANK is a special value in DAX that represents "no value". It is conceptually similar to SQL NULL but behaves very differently in expressions and comparisons.

### Why BLANK Matters: SUMMARIZECOLUMNS Non-Empty Semantics

SUMMARIZECOLUMNS has **non-empty semantics**: a row is returned only if at least one measure returns a non-BLANK value.

**The Result Space Explosion Problem:**

```dax
EVALUATE
    SUMMARIZECOLUMNS(
        'Product'[Name],
        'Customer'[Name],
        "Sales", [Sales]
    )
```

If `[Sales]` is `SUM('Sales'[Amount])`: Only combinations with actual sales records are returned.
If `[Sales]` is `SUM('Sales'[Amount]) + 0`: The `+ 0` converts BLANK to 0, making every row non-empty. ALL combinations are returned — potentially trillions of rows!

**Functions that return BLANK by design** (to prevent result explosion): COUNTROWS (empty table), SUM/AVERAGE (no rows), DIVIDE (division by zero).

### Key Difference from SQL NULL

| Behavior | SQL NULL | DAX BLANK |
|----------|----------|-----------|
| Addition | NULL + 4 = NULL | BLANK() + 4 = 4 |
| Subtraction | NULL - 4 = NULL | BLANK() - 4 = -4 |
| Multiplication | NULL * 4 = NULL | BLANK() * 4 = BLANK |
| Division | 4 / NULL = NULL | 4 / BLANK() = Infinity |
| Equality | NULL = NULL is UNKNOWN | BLANK() = BLANK() is TRUE |
| String concat | NULL \|\| 'A' = NULL | BLANK() & "A" = "A" |

### BLANK Propagation Rules

**Operations where BLANK propagates (returns BLANK):**
```dax
BLANK() * 4            // BLANK (multiplication)
BLANK() / 4            // BLANK (division)
BLANK() / BLANK()      // BLANK
-BLANK()               // BLANK (negation)
BLANK() + BLANK()      // BLANK (both operands blank)
BLANK() - BLANK()      // BLANK (both operands blank)
```

**Operations where BLANK converts to 0 or empty string:**
```dax
BLANK() + 4            // 4 (BLANK converted to 0)
BLANK() - 4            // -4 (BLANK converted to 0)
4 / BLANK()            // Infinity (BLANK converted to 0)
BLANK() & "A"          // "A" (BLANK converted to empty string)
```

### Comparison Semantics

#### Standard Equality (=) — Equivalent Values
BLANK is equivalent to 0, empty string "", FALSE, DateTime origin:
```dax
BLANK() = 0            // TRUE
BLANK() = ""           // TRUE
BLANK() = FALSE        // TRUE
BLANK() = BLANK()      // TRUE
```

#### Strict Equality (==), IN, SWITCH — Exact Match
Only identical values match:
```dax
BLANK() == 0           // FALSE
BLANK() == ""          // FALSE
BLANK() == BLANK()     // TRUE
BLANK() IN {0}         // FALSE
BLANK() IN {BLANK()}   // TRUE
```

#### Comparison Operators
BLANK is treated as 0:
```dax
BLANK() < 1            // TRUE (0 < 1)
BLANK() > -1           // TRUE (0 > -1)
```

### Testing for BLANK

Use ISBLANK (not equality to BLANK):
```dax
// Wrong: matches BLANK, 0, and ""
IF([Value] = BLANK(), "is blank", "has value")

// Correct:
IF(ISBLANK([Value]), "is blank", "has value")
IF([Value] == BLANK(), "is blank", "has value")
```

### SWITCH Behavior

SWITCH uses exact match semantics (like == and IN):
```dax
SWITCH(BLANK(),
    0, "zero",           // Not matched
    FALSE, "false",      // Not matched
    BLANK(), "blank",    // Matched!
    "other")
// Returns: "blank"
```

### Safe Division with DIVIDE

```dax
DIVIDE(BLANK(), 4)        // BLANK
DIVIDE(4, BLANK())        // BLANK (not Infinity!)
DIVIDE(BLANK(), BLANK())  // BLANK
```

**Anti-Pattern Warning:**
```dax
// BAD: Can cause result space explosion in SUMMARIZECOLUMNS queries
DIVIDE([Sales], [Quantity], 0)

// GOOD: Let DIVIDE return BLANK (the default)
DIVIDE([Sales], [Quantity])
```

### COALESCE for Default Values
```dax
COALESCE([Measure], 0)  // Returns 0 if measure is BLANK
COALESCE([Value1], [Value2], [Value3], "default")  // First non-BLANK
```

### Blank Row Concept

The **blank row** is separate from the BLANK value. It's a special row created when fact table rows reference non-existent dimension keys.

```dax
// VALUES includes blank row from invalid relationships
VALUES(Product[ProductKey])  // May include blank row

// DISTINCT never includes blank row
DISTINCT(Product[ProductKey])  // Never includes blank row

// ALLNOBLANKROW removes only the special blank row
ALLNOBLANKROW(Product)  // Excludes blank row from invalid relationships
```

### Sort Order

BLANK always sorts as the **lowest** value (first in ASC, last in DESC). BLANK sorts BEFORE zero in numeric sorting.

| Value | ASC Position | DESC Position |
|-------|-------------|---------------|
| -1 | 1st | Last |
| BLANK | 2nd | 3rd |
| 0 | 3rd | 2nd |
| 1 | 4th | 1st |

**Key Insight**: `BLANK() = 0` is TRUE (equality), but BLANK sorts before 0 (sort order).

### Best Practices

1. **Let measures return BLANK** — Never add `+ 0` or use `DIVIDE(x, y, 0)` just to display 0
2. **Use ISBLANK or == for testing BLANK** — Standard equality (=) treats BLANK as equivalent to 0, empty string, and FALSE
3. **Use COALESCE sparingly** — Only in display-layer measures, not in measures used for filtering or grouping

### Related Functions

| Function | Purpose |
|----------|---------|
| BLANK() | Returns a blank value |
| ISBLANK(value) | Tests if value is BLANK |
| COALESCE(value1, value2, ...) | Returns first non-BLANK value |
| DIVIDE(num, denom [, alt]) | Safe division, returns BLANK for division by zero |
| VALUES(column) | Returns distinct values including blank row |
| DISTINCT(column) | Returns distinct values excluding blank row |
| ALLNOBLANKROW(table) | Removes blank row from filter context |
| FIRSTNONBLANK(column, expr) | First value where expression is not blank |
| LASTNONBLANK(column, expr) | Last value where expression is not blank |
