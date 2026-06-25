# DAX Time Intelligence

Time intelligence functions enable period-based analysis by shifting or filtering date ranges relative to the current filter context. They require a properly configured Date table.

## Prerequisites

### Date Table Requirements

Time intelligence functions require a Date table with:

1. **Contiguous dates**: No gaps in the date sequence
2. **Unique dates**: One row per day
3. **Marked as Date Table**: In Power BI, right-click the table and select "Mark as date table"
4. **Active relationship**: Single active relationship between Date table and fact tables

## Function Categories

| Category | Purpose | Key Functions |
|----------|---------|---------------|
| Period-to-Date | Cumulative from period start | DATESYTD, DATESQTD, DATESMTD, DATESWTD |
| Period Shifting | Move dates by interval | DATEADD, SAMEPERIODLASTYEAR, PARALLELPERIOD |
| Opening/Closing Balance | Values at period boundaries | OPENINGBALANCEYEAR, CLOSINGBALANCEMONTH |
| Total-to-Date | Aggregate to period end | TOTALYTD, TOTALQTD, TOTALMTD, TOTALWTD |
| Period Navigation | First/last dates | FIRSTDATE, LASTDATE, STARTOFMONTH, ENDOFYEAR |
| Date Ranges | Custom date sets | DATESINPERIOD, DATESBETWEEN |

## Period-to-Date

### Using DATESYTD / DATESQTD / DATESMTD

```dax
Sales YTD = CALCULATE([Total Sales], DATESYTD('Date'[Date]))
Sales QTD = CALCULATE([Total Sales], DATESQTD('Date'[Date]))
Sales MTD = CALCULATE([Total Sales], DATESMTD('Date'[Date]))
```

### Using TOTALYTD / TOTALQTD / TOTALMTD (Shorthand)

```dax
// Equivalent to CALCULATE with DATESYTD
Sales YTD = TOTALYTD([Total Sales], 'Date'[Date])

// With fiscal year ending June 30
Sales FY YTD = TOTALYTD([Total Sales], 'Date'[Date], "6/30")
```

## Period Comparisons

### Year-over-Year Using SAMEPERIODLASTYEAR

```dax
Sales PY =
CALCULATE([Total Sales], SAMEPERIODLASTYEAR('Date'[Date]))

Sales YoY Change =
VAR CurrentSales = [Total Sales]
VAR PYSales = [Sales PY]
RETURN CurrentSales - PYSales

Sales YoY % =
VAR CurrentSales = [Total Sales]
VAR PYSales = [Sales PY]
RETURN DIVIDE(CurrentSales - PYSales, PYSales)
```

### Flexible Period Shift Using DATEADD

```dax
// Previous month
Sales PM = CALCULATE([Total Sales], DATEADD('Date'[Date], -1, MONTH))

// Previous quarter
Sales PQ = CALCULATE([Total Sales], DATEADD('Date'[Date], -1, QUARTER))

// Same period 2 years ago
Sales 2YA = CALCULATE([Total Sales], DATEADD('Date'[Date], -2, YEAR))
```

### PARALLELPERIOD vs DATEADD

```dax
// PARALLELPERIOD: Returns complete parallel period
// If March is selected, returns all of February
Sales Parallel Month =
CALCULATE([Total Sales], PARALLELPERIOD('Date'[Date], -1, MONTH))

// DATEADD: Shifts each date individually
// If March 1-15 is selected, returns Feb 1-15
Sales Shifted Month =
CALCULATE([Total Sales], DATEADD('Date'[Date], -1, MONTH))
```

**Key difference**: PARALLELPERIOD returns the complete period, DATEADD shifts individual dates.

## Rolling Windows

### Using DATESINPERIOD

```dax
// Rolling 12 months
Sales Rolling 12M =
CALCULATE(
    [Total Sales],
    DATESINPERIOD('Date'[Date], MAX('Date'[Date]), -12, MONTH)
)

// Last 30 days
Sales Last 30 Days =
CALCULATE(
    [Total Sales],
    DATESINPERIOD('Date'[Date], MAX('Date'[Date]), -30, DAY)
)

// Rolling 4 quarters
Sales Rolling 4Q =
CALCULATE(
    [Total Sales],
    DATESINPERIOD('Date'[Date], MAX('Date'[Date]), -4, QUARTER)
)
```

### Using DATESBETWEEN for Custom Ranges

```dax
// Custom date range
Sales Custom Range =
CALCULATE(
    [Total Sales],
    DATESBETWEEN('Date'[Date], DATE(2024, 1, 1), DATE(2024, 6, 30))
)
```

## Period Navigation

```dax
First Sale Date = FIRSTDATE('Date'[Date])
Last Sale Date = LASTDATE('Date'[Date])
Start of Current Month = STARTOFMONTH('Date'[Date])
End of Current Year = ENDOFYEAR('Date'[Date])
Previous Month Dates = PREVIOUSMONTH('Date'[Date])
Next Quarter Dates = NEXTQUARTER('Date'[Date])
```

## Combined Patterns

### YTD for Previous Year

```dax
Sales PY YTD =
CALCULATE([Total Sales], DATESYTD(SAMEPERIODLASTYEAR('Date'[Date])))
```

### YoY Comparison of YTD Values

```dax
Sales YTD YoY =
VAR CurrentYTD = [Sales YTD]
VAR PYYTD = [Sales PY YTD]
RETURN DIVIDE(CurrentYTD - PYYTD, PYYTD)
```

### Rolling Average

```dax
Sales 3M Moving Avg =
DIVIDE(
    CALCULATE(
        [Total Sales],
        DATESINPERIOD('Date'[Date], MAX('Date'[Date]), -3, MONTH)
    ),
    3
)
```

## Critical Rules for TI in DAX Queries

When generating DAX queries that use time intelligence functions, follow these rules:

### Establishing Date Context

Time intelligence functions require a clear "current date" reference in the filter context.

**Rule**: Always establish a valid date context by either:
1. Including groupby columns from the date table, OR
2. Applying filters on date columns

```dax
// Wrong: ROW with TI but no date context
EVALUATE
ROW(
    "Sales YTD", TOTALYTD([Total Sales], 'Date'[Date])
)

// Correct: Use CALCULATETABLE to establish date context
EVALUATE
CALCULATETABLE(
    ROW(
        "Sales YTD", TOTALYTD([Total Sales], 'Date'[Date])
    ),
    'Date'[Year] = 2024,
    TREATAS({ MAX(Sales[OrderDate]) }, 'Date'[Date])
)
```

### Using TREATAS to Set Reference Date

```dax
// Calculate TI measures with a reference date from Sales
EVALUATE
CALCULATETABLE(
    ROW(
        "Total Sales Amount YTD", TOTALYTD([Total Sales], 'Date'[Date]),
        "14-Day Moving Avg", AVERAGEX(
            DATESINPERIOD('Date'[Date], MAX('Date'[Date]), -14, DAY),
            [Total Sales]
        )
    ),
    'Product'[Category] = "Electronics",
    TREATAS({ MAX(Sales[OrderDate]) }, 'Date'[Date])
)
```

### Combining TI with SUMMARIZECOLUMNS

Include date columns as groupby columns to provide context:

```dax
// Year and Month provide the date context for YTD calculation
EVALUATE
SUMMARIZECOLUMNS(
    'Date'[Year],
    'Date'[Month],
    'Date'[MonthNumberOfYear],
    "Sales YTD", TOTALYTD([Total Sales], 'Date'[Date]),
    "Sales PY", CALCULATE([Total Sales], SAMEPERIODLASTYEAR('Date'[Date]))
)
ORDER BY 'Date'[Year] ASC, 'Date'[MonthNumberOfYear] ASC
```

### Determining "Last Year" Dynamically

Avoid hardcoding years. Use MAX on the fact table's date column:

```dax
DEFINE
    // Last year based on actual sales, not calendar table
    VAR _LastYear = YEAR(MAX(Sales[OrderDate]))

EVALUATE
SUMMARIZECOLUMNS(
    'Customer'[Name],
    'Date'[Year],
    TREATAS({ _LastYear, _LastYear - 1, _LastYear - 2 }, 'Date'[Year]),
    "Total Sales", [Total Sales],
    "Sales PY", CALCULATE([Total Sales], SAMEPERIODLASTYEAR('Date'[Date]))
)
ORDER BY 'Customer'[Name] ASC, 'Date'[Year] ASC
```

## Common Mistakes

### Missing Date Table Relationship

```dax
// Wrong: No relationship to Date table
Sales YTD = TOTALYTD(SUM(Sales[Amount]), Sales[OrderDate])

// Correct: Use Date table column
Sales YTD = TOTALYTD(SUM(Sales[Amount]), 'Date'[Date])
```

### Gaps in Date Table

Time intelligence functions may return unexpected results with non-contiguous dates. Ensure your Date table has every day, even if no transactions occurred.

### Using CALCULATE with FILTER on Dates

```dax
// Inefficient: FILTER iterates all dates
Sales YTD =
CALCULATE(
    [Total Sales],
    FILTER(ALL('Date'), 'Date'[Date] <= MAX('Date'[Date]) && YEAR('Date'[Date]) = YEAR(MAX('Date'[Date])))
)

// Efficient: Use built-in function
Sales YTD = CALCULATE([Total Sales], DATESYTD('Date'[Date]))
```

## Performance Considerations

1. **Use TOTALYTD/TOTALQTD/TOTALMTD** for simple aggregations (slightly more efficient)
2. **Use DATESYTD/DATESQTD/DATESMTD** when you need to nest or combine with other functions
3. **Store base measures** in variables when combining multiple time intelligence calculations
4. **Avoid nested time intelligence** when possible; use intermediate measures

## Complete Function Reference

### Period-to-Date Functions
| Function | Description |
|----------|-------------|
| DATESYTD | Year-to-date dates |
| DATESQTD | Quarter-to-date dates |
| DATESMTD | Month-to-date dates |
| DATESWTD | Week-to-date dates (calendar-based) |

### Total-to-Date Functions
| Function | Description |
|----------|-------------|
| TOTALYTD | Year-to-date total |
| TOTALQTD | Quarter-to-date total |
| TOTALMTD | Month-to-date total |
| TOTALWTD | Week-to-date total (calendar-based) |

### Period Shifting Functions
| Function | Description |
|----------|-------------|
| DATEADD | Flexible shift by days, months, quarters, years |
| SAMEPERIODLASTYEAR | Same dates in previous year |
| PARALLELPERIOD | Complete parallel period |

### Opening/Closing Balance Functions
| Function | Description |
|----------|-------------|
| OPENINGBALANCEMONTH / QUARTER / YEAR | Value at period start |
| CLOSINGBALANCEMONTH / QUARTER / YEAR | Value at period end |

### Period Navigation Functions
| Function | Description |
|----------|-------------|
| FIRSTDATE / LASTDATE | First/last date in context |
| STARTOFMONTH / STARTOFQUARTER / STARTOFYEAR | Period start date |
| ENDOFMONTH / ENDOFQUARTER / ENDOFYEAR | Period end date |
| PREVIOUSDAY / MONTH / QUARTER / YEAR | Prior period dates |
| NEXTDAY / MONTH / QUARTER / YEAR | Next period dates |

### Custom Range Functions
| Function | Description |
|----------|-------------|
| DATESINPERIOD | Dates within interval from start date |
| DATESBETWEEN | Dates between two specific dates |
