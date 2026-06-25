# DAX Query Patterns

Complete guide for writing DAX queries — structure, syntax rules, worked examples, and anti-patterns.

## Query Structure

```dax
[DEFINE
    VAR <variable_name> = <expression>
    MEASURE <table>[<measure_name>] = <expression>
]

EVALUATE
    <table expression>

[ORDER BY
    <column> [ASC|DESC], ...]

[START AT
    <value>, ...]
```

## Key Components

**DEFINE (Optional)**
- Declare variables (VAR) and measures (MEASURE)
- Variables can store table expressions, filters, or scalar values
- Only ONE DEFINE block per query
- Separate VARs/MEASUREs with newlines (no commas)

**EVALUATE (Required)**
- Must precede a table expression
- Returns a table of results
- Cannot use scalar functions directly (SUMX, DISTINCTCOUNT, etc.)

**ORDER BY (Strongly Recommended)**
- Always include for queries returning multiple rows
- Ensures consistent, predictable results
- When using SELECTCOLUMNS, reference the NEW column names

**START AT (Optional)**
- For paging results

## Essential Syntax Rules

### Naming Conventions
- **Columns**: `'Table'[Column]` (fully-qualified)
- **Measures**: `[Measure]` (simple name, never qualify)

### DEFINE Rules
```dax
// Correct — Single DEFINE, no commas
DEFINE
    VAR _X = 1
    VAR _Y = 2
    MEASURE 'Sales'[Temp] = COUNTROWS()

// Wrong — Multiple DEFINEs
DEFINE VAR _X = 1
DEFINE VAR _Y = 2

// Wrong — Commas between VARs
DEFINE
    VAR _X = 1,
    VAR _Y = 2
```

## Critical DAX Query Rules

### 1. EVALUATE Must Use Table Expressions

Correct:
```dax
EVALUATE 'Product'
ORDER BY 'Product'[Name]

EVALUATE ROW("Total", [Total Sales])

EVALUATE SUMMARIZECOLUMNS('Product'[Category], "Sales", [Total Sales])
ORDER BY [Sales] DESC
```

Wrong:
```dax
EVALUATE [Total Sales]  // Scalar value, not a table
EVALUATE SUMX('Sales', Sales[Amount])  // Scalar function, not a table
```

### Column Selection Functions

| Function | Use For | Duplicates? | Example |
|----------|---------|-------------|---------|
| **VALUES** | Single column distinct | No | `VALUES('Product'[Category])` |
| **SUMMARIZE** | Multiple columns distinct | No | `SUMMARIZE('Sales', 'Product'[Cat], 'Product'[Color])` |
| **SELECTCOLUMNS** | Projection with rename | Yes | `SELECTCOLUMNS('Sales', "Prod", RELATED('Product'[Name]))` |

## Common Patterns

### Sample Schema (for reference)

These examples use the following hypothetical data model:

```yaml
Tables:
  - Name: Sales
    Measures:
      - Name: Total Discount (Type: Decimal)
      - Name: Total Amount (Type: Decimal)
      - Name: Total Quantity (Type: Integer)
    Columns: CustomerKey (Text), Order Quantity (Integer), ProductKey (Text), OrderDate (Date), Sales Amount (Decimal)
  - Name: Product
    Measures:
      - Name: Median List Price (Type: Decimal)
    Columns: Category (Text), Color (Text), List Price (Decimal), Name (Text), ProductKey (Text)
  - Name: Customer
    Columns: CustomerKey (Text), Name (Text)
  - Name: Calendar
    Columns: Date (Date), Month (Integer), Year (Integer)
Active Relationships:
  - PK: 'Product'[ProductKey] -> FK: 'Sales'[ProductKey] (Unidirectional: Product filters Sales)
  - PK: 'Customer'[CustomerKey] -> FK: 'Sales'[CustomerKey] (Unidirectional: Customer filters Sales)
  - PK: 'Calendar'[Date] -> FK: 'Sales'[OrderDate] (Unidirectional: Calendar filters Sales)
```

### Pattern 1: Simple Filtered Aggregation

```dax
// Total sales for red products
EVALUATE
  CALCULATETABLE(
    ROW("Total Sales Amount", [Total Amount]),
    'Product'[Color] == "Red"
  )
```

### Pattern 2: Multi-Dimensional Summary

```dax
DEFINE
  VAR _CategoryFilter = TREATAS({"Consumer Electronics"}, 'Product'[Category])
  VAR _YearFilter = FILTER(ALL('Calendar'[Year]), 'Calendar'[Year] >= 2022)

EVALUATE
  SUMMARIZECOLUMNS(
    'Calendar'[Year],
    _CategoryFilter,
    _YearFilter,
    "Total Quantity", SUM('Sales'[Order Quantity])
  )
ORDER BY 'Calendar'[Year] DESC
```

### Pattern 3: Monthly Summary with Multiple Filters

```dax
DEFINE
  // Filters for products in electronics category
  VAR _Filter1 = TREATAS(
    {
      "Consumer Electronics"
    },
    'Product'[Category]
  )
  // Filters to years 2022 and 2023
  VAR _Filter2 = FILTER(
    ALL('Calendar'[Year]),
    'Calendar'[Year] >= 2022 && 'Calendar'[Year] <= 2023
  )

// Quantity and discount filtered to electronics products for years 2022 and 2023, grouped by month
EVALUATE
  SUMMARIZECOLUMNS(
    'Calendar'[Year],
    'Calendar'[Month],
    _Filter1,
    _Filter2,
    "Total Quantity", SUM('Sales'[Order Quantity]),
    "Discount", [Total Discount]
  )
```

### Pattern 4: Filter and Select with Threshold

```dax
DEFINE
  // Red or Black product filter
  VAR _Filter = TREATAS(
    {
      "Red",
      "Black"
    },
    'Product'[Color]
  )
  // Sales of Red or Black products
  VAR _Core = SUMMARIZECOLUMNS(
    'Product'[Name],
    _Filter,
    "Total Sales", [Total Amount]
  )

// Products with total sales above $1,000,000
EVALUATE
  SELECTCOLUMNS(
    FILTER(
      _Core,
      [Total Sales] > 1000000
    ),
    'Product'[Name]
  )
```

### Pattern 5: Distinct Values Without Duplicates

```dax
// Product color, category and key for products sold in 2022
EVALUATE
  CALCULATETABLE(
    // SUMMARIZE is used to remove duplicate rows
    SUMMARIZE(
      'Sales',
      'Product'[Color],
      'Product'[Category],
      'Sales'[ProductKey]
    ),
    'Calendar'[Year] == 2022
  )
```

### Pattern 6: Cross-Table Selection With Duplicates

```dax
// Product color, category and key for products sold in 2022
EVALUATE
  CALCULATETABLE(
    SELECTCOLUMNS(
      'Sales',
      "Color",
      RELATED('Product'[Color]),
      "Category",
      RELATED('Product'[Category]),
      'Sales'[ProductKey]
    ),
    'Calendar'[Year] == 2022
  )
```

### Pattern 7: Finding Items With No Matches

```dax
DEFINE
  // Sale row count
  MEASURE 'Sales'[Row Count] = COUNTROWS()

// Products with no sales
EVALUATE
  FILTER(
    'Product',
    ISBLANK([Row Count])
  )
```

### Pattern 8: Comparison Against Aggregate

```dax
DEFINE
  // Pre-calculate Median List Price before the query so it applies to all rows
  VAR _MedianListPrice = [Median List Price]

// Products with list price over the median.
EVALUATE
  CALCULATETABLE(
    VALUES('Product'[Name]),
    'Product'[List Price] > _MedianListPrice
  )
```

### Pattern 9: Complex Multi-Step (TopN + Related Data)

```dax
DEFINE
  // To make query more readable, a filter can be defined separately.
  VAR _Filter = FILTER(
    ALL('Calendar'[Year]),
    'Calendar'[Year] > 2020
  )
  // Get the product with the maximum Total Quantity
  VAR _TopProduct = TOPN(
    1,
    SUMMARIZECOLUMNS(
      'Product'[Name],
      _Filter,
      "Total Quantity", [Total Quantity]
    ),
    [Total Quantity],
    DESC
  )

// Name and order date for sales of the top product
EVALUATE
  SELECTCOLUMNS(
    CALCULATETABLE(
      'Sales',
      _TopProduct
    ),
    // Column name is needed because it is not part of the original table
    "Product Name",
    RELATED('Product'[Name]),
    'Sales'[OrderDate]
  )
```

### Pattern 10: Simple Lookup

```dax
// Products sold in 2022
EVALUATE
  CALCULATETABLE(
    SUMMARIZE(
      'Sales',
      'Product'[Name]
    ),
    'Calendar'[Year] == 2022
  )
```

### Pattern 11: Cross-Table with Sorting

```dax
// Sorted product and customer names for all sales
EVALUATE
  SELECTCOLUMNS(
    'Sales',
    // Since product and customer are not in the sales table, SELECTCOLUMNS requires a name for those columns
    "Product Name",
    RELATED('Product'[Name]),
    "Customer Name",
    RELATED('Customer'[Name])
  )
  // ORDER BY needs to use the renamed column names
  ORDER BY
    [Product Name] ASC,
    [Customer Name] ASC
```

## Code Quality Standards

- Comments explain purpose
- DEFINE with well-named variables (prefix with `_` to avoid keywords)
- Filters defined separately
- Intermediate calculations in variables
- Simple, readable EVALUATE statement
- Appropriate ORDER BY

## Syntax Mistakes

### SQL Keywords
```dax
// Wrong
SELECT * FROM Product WHERE Category = 'Electronics'

// Correct
EVALUATE
    FILTER('Product', 'Product'[Category] = "Electronics")
ORDER BY 'Product'[Name]
```

### Method Chaining
```dax
// Wrong (like Python/JavaScript)
Product.FILTER(...).SELECTCOLUMNS(...)

// Correct — Use variables
DEFINE
    VAR _Filtered = FILTER('Product', ...)
    VAR _Projected = SELECTCOLUMNS(_Filtered, ...)
EVALUATE
    _Projected
ORDER BY [Name]
```

### Scalar After EVALUATE
```dax
// Wrong
EVALUATE [Total Sales]
EVALUATE SUMX('Sales', Sales[Amount])

// Correct — Wrap in ROW or table function
EVALUATE ROW("Total", [Total Sales])
```
