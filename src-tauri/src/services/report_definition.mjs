// Reads a Power BI report definition (the parts of Fabric's getDefinition) into a
// compact model Copilot can rebuild the report from, and writes the migration's
// README.md and model.md text. Both stored formats are read: PBIR (`definition/…`
// files) and PBIR-Legacy (one report.json with JSON-in-string configs).
// Pure: no network or file access. Unexpected shapes never throw; they become
// readable warnings.

// Enums of the PBIR semantic query schema (semanticQuery 1.0.0–1.4.0).
const AGGREGATES = [
  ['Sum', 'SUM'], ['Average', 'AVERAGE'], ['DistinctCount', 'DISTINCTCOUNT'], ['Min', 'MIN'], ['Max', 'MAX'],
  ['Count', 'COUNT'], ['Median', 'MEDIAN'], ['StandardDeviation', 'STDEV.P'], ['Variance', 'VAR.P'],
]
const COMPARISONS = ['=', '>', '>=', '<', '<=']
const TIME_UNITS = ['day', 'week', 'month', 'year', 'decade', 'second', 'minute', 'hour']
const ARITHMETIC = ['+', '-', '*', '/']
const DAY = 0
// PBIR-Legacy stores PBIR's string enums as numbers, in the schema's order.
const DISPLAY_OPTIONS = ['DeprecatedDynamic', 'FitToPage', 'FitToWidth', 'ActualSize', 'ActualSizeTopLeft']
const FILTER_ORIGINS = ['Auto', 'User', 'Drill', 'Include', 'Exclude', 'Drillthrough']
const GROUP_MODES = ['ScaleMode', 'ScrollMode']
// A legacy page's config `type` (only seen on tooltip pages).
const LEGACY_TOOLTIP_PAGE = 1
const CONDITIONS = ['In', 'Not', 'And', 'Or', 'Comparison', 'Between', 'Contains', 'StartsWith', 'Exists']
const ACTION_TARGETS = {
  PageNavigation: 'navigationSection', Bookmark: 'bookmark', WebUrl: 'webUrl', Drillthrough: 'drillthroughSection',
}
const DECORATIVE = new Set(['shape', 'basicShape', 'image'])
const IMAGE = /\.(png|jpe?g|gif|svg)$/i
const AUTO_DATE_TABLE = /^(LocalDateTable|DateTableTemplate)_[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const MAX_VALUES = 50
const MAX_WARNINGS = 200
const ROW_TOLERANCE = 8

const isObj = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const list = (value) => (Array.isArray(value) ? value : [])
const num = (value) => (Number.isFinite(value) ? value : 0)
const round = (value) => (Number.isFinite(value) ? Math.round(value) : null)
const tableRef = (name) => `'${String(name ?? '?').replace(/'/g, "''")}'`
const bracket = (name) => `[${String(name ?? '?').replace(/]/g, ']]')}]`
const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()
const clip = (text, max) => (text.length > max ? text.slice(0, max - 1) + '…' : text)
const plural = (count, one, many = one + 's') => `${count} ${count === 1 ? one : many}`

function compact(value, max = 300) {
  let text
  try { text = JSON.stringify(value) } catch { text = undefined }
  return clip(text ?? String(value), max)
}

function withoutUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined))
}

function attempt(fn, fallback) {
  try { return fn() } catch { return fallback() }
}

// `'Sales'` → `Sales`: Power BI stores text literals quoted, with '' for '.
export function unquote(value) {
  if (typeof value !== 'string') return value ?? null
  const text = value.match(/^'([\s\S]*)'$/)
  return text ? text[1].replace(/''/g, "'") : value
}

// The default (selector-less) entry of a formatting object such as `title`.
function entry(objects, name) {
  const entries = list(isObj(objects) ? objects[name] : null)
  return entries.find((item) => isObj(item) && !item.selector) ?? entries.find(isObj) ?? null
}

function literal(objects, name, property) {
  const value = entry(objects, name)?.properties?.[property]?.expr?.Literal?.Value
  return typeof value === 'string' ? value : undefined
}

// A semantic-query literal (`'text'`, `12L`, `1.5D`, `2M`, `datetime'…'`, `true`,
// `null`) as readable DAX-like text.
export function literalText(value) {
  if (value === null || value === undefined) return 'BLANK'
  if (typeof value !== 'string') return String(value)
  const v = value.trim()
  if (v === 'null') return 'BLANK'
  if (v === 'true' || v === 'false') return v.toUpperCase()
  const text = v.match(/^'([\s\S]*)'$/)
  if (text) return '"' + text[1].replace(/''/g, "'").replace(/"/g, '""') + '"'
  const date = v.match(/^datetime'(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?)?'$/i)
  if (date) return date[2] && !/^00:00(?::00)?$/.test(date[2]) ? `${date[1]} ${date[2]}` : date[1]
  const number = v.match(/^([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)[LDM]$/)
  return number ? number[1] : v
}

// A query's `From` → alias → { entity } (a model table) or { subquery }.
export function aliasMap(from) {
  const map = {}
  for (const source of list(from)) {
    if (!isObj(source) || typeof source.Name !== 'string') continue
    if (typeof source.Entity === 'string') map[source.Name] = { entity: source.Entity }
    else if (isObj(source.Expression?.Subquery?.Query)) map[source.Name] = { subquery: source.Expression.Subquery.Query }
    else map[source.Name] = {}
  }
  return map
}

// Accepts a `From` array, an alias → table-name map, or an aliasMap result.
function aliasesOf(value) {
  if (Array.isArray(value)) return aliasMap(value)
  const map = {}
  if (isObj(value)) {
    for (const [name, target] of Object.entries(value)) {
      map[name] = typeof target === 'string' ? { entity: target } : isObj(target) ? target : {}
    }
  }
  return map
}

function tableOf(expr, aliases) {
  if (!isObj(expr)) return null
  const ref = expr.SourceRef
  if (isObj(ref)) {
    if (typeof ref.Entity === 'string') return ref.Entity
    if (ref.Source !== undefined) return aliases[ref.Source]?.entity ?? String(ref.Source)
  }
  if (isObj(expr.PropertyVariationSource)) return tableOf(expr.PropertyVariationSource.Expression, aliases)
  if (isObj(expr.TransformTableRef)) return expr.TransformTableRef.Source ?? null
  return null
}

// One field of a visual or filter: its kind, model object and readable text.
export function fieldInfo(expr, aliases) {
  const al = aliasesOf(aliases)
  return attempt(() => field(expr, al), () => ({ kind: 'unknown', text: compact(expr) }))
}

function columnField(column, al) {
  const variation = column.Expression?.PropertyVariationSource
  if (isObj(variation)) {
    // Auto date/time: a level column of the date column's hidden date table.
    const table = tableOf(variation.Expression, al)
    return {
      kind: 'column', table, column: variation.Property ?? null, level: column.Property ?? null,
      text: `${tableRef(table)}${bracket(variation.Property)} (${column.Property})`,
    }
  }
  const source = column.Expression?.SourceRef
  const date = source?.Source !== undefined ? al[source.Source]?.dateOf : null
  if (date) {
    return {
      kind: 'column', table: date.table, column: date.column, level: column.Property ?? null,
      text: `${tableRef(date.table)}${bracket(date.column)} (${column.Property})`,
    }
  }
  const table = tableOf(column.Expression, al)
  return { kind: 'column', table, column: column.Property ?? null, text: `${tableRef(table)}${bracket(column.Property)}` }
}

function hierarchyLevelField(node, al) {
  const level = node.Level ?? null
  const hierarchy = node.Expression?.Hierarchy
  if (!isObj(hierarchy)) return { kind: 'hierarchyLevel', level, text: `${expr_(node.Expression, al)}.${bracket(level)}` }
  const variation = hierarchy.Expression?.PropertyVariationSource
  if (isObj(variation)) {
    // Auto date/time: Year, Quarter, Month or Day of a date column.
    const table = tableOf(variation.Expression, al)
    return {
      kind: 'hierarchyLevel', table, column: variation.Property ?? null, hierarchy: hierarchy.Hierarchy ?? null, level,
      text: `${tableRef(table)}${bracket(variation.Property)} (${level})`,
    }
  }
  const table = tableOf(hierarchy.Expression, al)
  return {
    kind: 'hierarchyLevel', table, hierarchy: hierarchy.Hierarchy ?? null, level,
    text: `${tableRef(table)}${bracket(hierarchy.Hierarchy)}.${bracket(level)}`,
  }
}

function field(e, al) {
  if (!isObj(e)) return { kind: 'unknown', text: compact(e) }
  if (isObj(e.Column)) return columnField(e.Column, al)
  if (isObj(e.Measure)) {
    return { kind: 'measure', table: tableOf(e.Measure.Expression, al), measure: e.Measure.Property ?? null, text: bracket(e.Measure.Property) }
  }
  if (isObj(e.Aggregation)) {
    const inner = field(e.Aggregation.Expression, al)
    const [name, dax] = AGGREGATES[e.Aggregation.Function] ?? [`Aggregate${e.Aggregation.Function}`, 'AGGREGATE']
    return { ...inner, kind: 'aggregation', aggregation: name, text: `${dax}(${inner.text})` }
  }
  for (const [key, name] of [['Min', 'Min'], ['Max', 'Max']]) {
    if (isObj(e[key])) {
      const inner = field(e[key].Expression, al)
      return { ...inner, kind: 'aggregation', aggregation: name, text: `${name.toUpperCase()}(${inner.text})` }
    }
  }
  if (isObj(e.HierarchyLevel)) return hierarchyLevelField(e.HierarchyLevel, al)
  if (isObj(e.Hierarchy)) {
    const variation = e.Hierarchy.Expression?.PropertyVariationSource
    const table = tableOf(e.Hierarchy.Expression, al)
    const name = isObj(variation) ? variation.Property : e.Hierarchy.Hierarchy
    return { kind: 'hierarchy', table, hierarchy: e.Hierarchy.Hierarchy ?? null, text: `${tableRef(table)}${bracket(name)}` }
  }
  if (isObj(e.GroupRef)) {
    const table = tableOf(e.GroupRef.Expression, al)
    return { kind: 'column', table, column: e.GroupRef.Property ?? null, group: true, text: `${tableRef(table)}${bracket(e.GroupRef.Property)}` }
  }
  if (isObj(e.NativeVisualCalculation)) {
    const calc = e.NativeVisualCalculation
    return { kind: 'visualCalculation', name: calc.Name ?? null, expression: calc.Expression ?? null, text: bracket(calc.Name) }
  }
  const kind = Object.keys(e).find((key) => !['Name', 'NativeReferenceName', 'Annotations'].includes(key))
  return { kind: kind ? kind[0].toLowerCase() + kind.slice(1) : 'unknown', text: expr_(e, al) }
}

const unitName = (unit, count = 1) => {
  const name = TIME_UNITS[unit] ?? `unit ${unit}`
  return count === 1 ? name : name + 's'
}
const units = (count, unit) => `${count} ${unitName(unit, count)}`

// Expression → readable DAX-like text: 'Table'[Column], [Measure], SUM('T'[C]),
// 'Date'[Date] (Year), literals. Unknown kinds fall back to compact JSON.
export function exprText(expr, aliases) {
  const al = aliasesOf(aliases)
  return attempt(() => expr_(expr, al), () => compact(expr))
}

function expr_(e, al) {
  if (e === undefined || e === null) return '?'
  if (!isObj(e)) return compact(e)
  if (e.Column || e.Measure || e.Aggregation || e.HierarchyLevel || e.Hierarchy || e.GroupRef || e.NativeVisualCalculation) {
    return field(e, al).text
  }
  if (isObj(e.Literal)) return literalText(e.Literal.Value)
  if (isObj(e.SourceRef)) return tableRef(tableOf(e, al))
  if (isObj(e.Min) || isObj(e.Max)) return field(e, al).text
  if (isObj(e.Percentile)) {
    const p = e.Percentile
    return `PERCENTILE.${p.Exclusive ? 'EXC' : 'INC'}(${expr_(p.Expression, al)}, ${p.K})`
  }
  if (isObj(e.Arithmetic)) {
    const a = e.Arithmetic
    return `(${expr_(a.Left, al)} ${ARITHMETIC[a.Operator] ?? '?'} ${expr_(a.Right, al)})`
  }
  if (isObj(e.Now)) return 'now'
  if (isObj(e.DateAdd)) {
    const amount = Number(e.DateAdd.Amount) || 0
    return `${expr_(e.DateAdd.Expression, al)} ${amount < 0 ? '-' : '+'} ${units(Math.abs(amount), e.DateAdd.TimeUnit)}`
  }
  if (isObj(e.DateSpan)) return `the ${unitName(e.DateSpan.TimeUnit)} of (${expr_(e.DateSpan.Expression, al)})`
  if (isObj(e.PropertyVariationSource)) return `${tableRef(tableOf(e, al))}${bracket(e.PropertyVariationSource.Property)}`
  if (isObj(e.Discretize)) return `BINS(${expr_(e.Discretize.Expression, al)}, ${e.Discretize.Count})`
  if (isObj(e.Floor)) {
    const f = e.Floor
    return `FLOOR(${expr_(f.Expression, al)}, ${f.TimeUnit != null ? units(f.Size, f.TimeUnit) : f.Size})`
  }
  if (isObj(e.ScopedEval)) {
    const scope = list(e.ScopedEval.Scope).map((s) => expr_(s, al)).join(', ')
    return `${expr_(e.ScopedEval.Expression, al)} for ${scope || 'everything'}`
  }
  if (isObj(e.FilteredEval)) {
    const where = list(e.FilteredEval.Filters).map((f) => cond_(f?.Condition, al)).join(' and ')
    return `${expr_(e.FilteredEval.Expression, al)} where ${where || 'no filter'}`
  }
  if (isObj(e.SelectRef)) return bracket(e.SelectRef.ExpressionName)
  if (isObj(e.TransformOutputRoleRef)) return bracket(e.TransformOutputRoleRef.Role)
  for (const key of ['NativeMeasure', 'NativeColumn']) {
    if (isObj(e[key])) return e[key].ProposedName ? bracket(e[key].ProposedName) : String(e[key].Expression ?? '?')
  }
  if (isObj(e.SparklineData)) {
    const by = list(e.SparklineData.Groupings).map((g) => expr_(g, al)).join(', ')
    return `sparkline of ${expr_(e.SparklineData.Measure, al)} by ${by}`
  }
  if (isObj(e.ResourcePackageItem)) return String(e.ResourcePackageItem.ItemName ?? '?')
  if (isObj(e.DefaultValue)) return 'the default value'
  if (isObj(e.AnyValue)) return 'any value'
  if (isObj(e.Subquery)) return '(subquery)'
  if (CONDITIONS.some((key) => isObj(e[key]))) return cond_(e, al)
  return compact(e)
}

// Condition → readable text: In (and tuples, top N), Not, And, Or, comparisons,
// Between, Contains, StartsWith, Exists and relative dates. Unknown → JSON.
export function conditionText(condition, aliases) {
  const al = aliasesOf(aliases)
  return attempt(() => cond_(condition, al), () => compact(condition))
}

function cond_(c, al) {
  if (isObj(c) && isObj(c.Condition)) c = c.Condition
  if (!isObj(c)) return compact(c)
  if (isObj(c.In)) return in_(c.In, al, false)
  if (isObj(c.Not)) return not_(c.Not.Expression, al)
  if (isObj(c.And)) return `${side(c.And.Left, 'Or', al)} and ${side(c.And.Right, 'Or', al)}`
  if (isObj(c.Or)) return `${side(c.Or.Left, 'And', al)} or ${side(c.Or.Right, 'And', al)}`
  if (isObj(c.Comparison)) return comparison_(c.Comparison, al)
  if (isObj(c.Between)) return between_(c.Between, al)
  if (isObj(c.Contains)) return `${expr_(c.Contains.Left, al)} contains ${expr_(c.Contains.Right, al)}`
  if (isObj(c.StartsWith)) return `${expr_(c.StartsWith.Left, al)} starts with ${expr_(c.StartsWith.Right, al)}`
  if (isObj(c.Exists)) return `${expr_(c.Exists.Expression, al)} has rows`
  return expr_(c, al)
}

// Keeps a mixed and/or readable: (a or b) and c.
function side(c, other, al) {
  const text = cond_(c, al)
  return isObj(c) && isObj(c[other]) ? `(${text})` : text
}

const isBlank = (e) => e?.Literal?.Value === 'null'

function not_(c, al) {
  if (isObj(c) && isObj(c.Condition)) c = c.Condition
  if (isObj(c?.In)) return in_(c.In, al, true)
  if (isObj(c?.Contains)) return `${expr_(c.Contains.Left, al)} does not contain ${expr_(c.Contains.Right, al)}`
  if (isObj(c?.StartsWith)) return `${expr_(c.StartsWith.Left, al)} does not start with ${expr_(c.StartsWith.Right, al)}`
  if (isObj(c?.Comparison) && (c.Comparison.ComparisonKind ?? 0) === 0) {
    const { Left: left, Right: right } = c.Comparison
    return isBlank(right) ? `${expr_(left, al)} is not blank` : `${expr_(left, al)} <> ${expr_(right, al)}`
  }
  return `not (${cond_(c, al)})`
}

function in_(node, al, negate) {
  const targets = list(node.Expressions).map((e) => expr_(e, al))
  const left = targets.length === 1 ? targets[0] : `(${targets.join(', ')})`
  if (isObj(node.Table)) {
    const top = topN_(node.Table, al)
    if (top) return `${left} is ${negate ? 'not ' : ''}in the ${top}`
    return `${left} ${negate ? 'not in' : 'in'} ${expr_(node.Table, al)}`
  }
  const tuples = list(node.Values).map((tuple) => {
    const values = list(tuple).map((v) => expr_(v, al))
    return values.length === 1 ? values[0] : `(${values.join(', ')})`
  })
  const more = tuples.length > MAX_VALUES ? `, … ${tuples.length - MAX_VALUES} more` : ''
  return `${left} ${negate ? 'not in' : 'in'} (${tuples.slice(0, MAX_VALUES).join(', ')}${more})`
}

// The top N filter form: In over a subquery table (Top + OrderBy) from `From`.
function topN_(table, al) {
  const query = al[table.SourceRef?.Source]?.subquery
  if (!isObj(query)) return null
  const local = aliasMap(query.From)
  const order = list(query.OrderBy).find(isObj)
  const by = order ? ` by ${expr_(order.Expression, local)}` : ''
  return `${order?.Direction === 1 ? 'bottom' : 'top'} ${query.Top ?? '?'}${by}`
}

function comparison_(c, al) {
  const left = expr_(c.Left, al)
  const kind = c.ComparisonKind ?? 0
  if (kind === 0 && isBlank(c.Right)) return `${left} is blank`
  const date = dateTerm(c.Right)
  if (kind === 0 && date?.span != null && !date.offsets.length) return `${left} is in this ${unitName(date.span)}`
  return `${left} ${COMPARISONS[kind] ?? '?'} ${expr_(c.Right, al)}`
}

function between_(b, al) {
  const target = expr_(b.Expression, al)
  const phrase = relativeRange(dateTerm(b.LowerBound), dateTerm(b.UpperBound))
  if (phrase) return `${target} is in ${phrase}`
  return `${target} between ${expr_(b.LowerBound, al)} and ${expr_(b.UpperBound, al)}`
}

// Now, shifted by DateAdd steps (innermost first) and maybe cut to a DateSpan.
function dateTerm(e) {
  if (!isObj(e)) return null
  let current = e
  let span = null
  if (isObj(current.DateSpan)) {
    span = current.DateSpan.TimeUnit ?? null
    current = current.DateSpan.Expression
  }
  const offsets = []
  while (isObj(current?.DateAdd)) {
    offsets.unshift({ amount: Number(current.DateAdd.Amount) || 0, unit: current.DateAdd.TimeUnit })
    current = current.DateAdd.Expression
  }
  return isObj(current?.Now) ? { span, offsets } : null
}

// The relative date and time filters' ranges, as Power BI's filter pane says them.
function relativeRange(lo, hi) {
  if (!lo || !hi) return null
  const [a, b] = [lo.offsets, hi.offsets]
  const byDay = lo.span === DAY && hi.span === DAY
  // Last N units, including today: [today + 1 day - N units, today].
  if (byDay && !b.length && a.length === 2 && a[0].unit === DAY && a[0].amount === 1 && a[1].amount < 0) {
    return `the last ${units(-a[1].amount, a[1].unit)}`
  }
  // Next N units, including today: [today, today + N units - 1 day].
  if (byDay && !a.length && b.length === 2 && b[0].amount > 0 && b[1].unit === DAY && b[1].amount === -1) {
    return `the next ${units(b[0].amount, b[0].unit)}`
  }
  if (lo.span != null && lo.span === hi.span) {
    if (!a.length && !b.length) return `this ${unitName(lo.span)}`
    if (a.length === 1 && b.length === 1 && a[0].unit === lo.span && b[0].unit === lo.span) {
      if (b[0].amount === -1 && a[0].amount < 0) return `the last ${-a[0].amount} calendar ${unitName(lo.span, -a[0].amount)}`
      if (a[0].amount === 1 && b[0].amount > 0) return `the next ${b[0].amount} calendar ${unitName(lo.span, b[0].amount)}`
    }
  }
  // Relative time: [now - N units, now] and [now, now + N units].
  if (lo.span == null && hi.span == null) {
    if (!b.length && a.length === 1 && a[0].amount < 0) return `the last ${units(-a[0].amount, a[0].unit)}`
    if (!a.length && b.length === 1 && b[0].amount > 0) return `the next ${units(b[0].amount, b[0].unit)}`
  }
  return null
}

// A filter definition ({ From, Where }) as one readable condition, or null.
// `fields` (the filtered field or slicer's fields) name the date column behind
// an auto date/time table, which conditions reference as LocalDateTable_….
export function filterText(definition, fields = []) {
  if (!isObj(definition)) return null
  const al = aliasMap(definition.From)
  const dates = [...new Map(list(fields)
    .filter((f) => isObj(f) && f.table && f.column && f.level !== undefined && !AUTO_DATE_TABLE.test(f.table))
    .map((f) => [`${f.table}\n${f.column}`, { table: f.table, column: f.column }])).values()]
  if (dates.length === 1) for (const target of Object.values(al)) if (AUTO_DATE_TABLE.test(target.entity ?? '')) target.dateOf = dates[0]
  const conditions = list(definition.Where).map((where) => attempt(() => cond_(where, al), () => compact(where)))
  return conditions.length ? conditions.join(' and ') : null
}

function filterOf(item, ctx, where) {
  if (!isObj(item)) {
    ctx.warn(`${where}: skipped a filter with an unexpected shape.`)
    return null
  }
  const definition = isObj(item.filter) ? item.filter : null
  const target = isObj(item.field) ? item.field : isObj(item.expression) ? item.expression : null
  const filtered = target ? fieldInfo(target, aliasMap(definition?.From)) : null
  const origin = typeof item.howCreated === 'number' ? FILTER_ORIGINS[item.howCreated] ?? item.howCreated : item.howCreated
  return withoutUndefined({
    name: item.name ?? null,
    field: filtered?.text ?? null,
    type: item.type ?? null,
    text: filterText(definition, filtered ? [filtered] : []),
    hidden: item.isHiddenInViewMode === true,
    locked: item.isLockedInViewMode === true,
    howCreated: origin ?? undefined,
    displayName: typeof item.displayName === 'string' ? item.displayName : undefined,
    restatement: typeof item.restatement === 'string' ? item.restatement : undefined,
    raw: definition ?? undefined,
  })
}

// Item names of report resources (images) referenced anywhere in formatting.
function resourceNames(value, found = new Set(), depth = 0) {
  if (depth > 40 || value === null || typeof value !== 'object') return found
  if (Array.isArray(value)) {
    for (const item of value) resourceNames(item, found, depth + 1)
    return found
  }
  const item = value.ResourcePackageItem
  if (isObj(item) && typeof item.ItemName === 'string') found.add(item.ItemName)
  for (const child of Object.values(value)) resourceNames(child, found, depth + 1)
  return found
}

function titleOf(vcObjects) {
  const text = entry(vcObjects, 'title')?.properties?.text
  const value = text?.expr?.Literal?.Value
  if (typeof value === 'string') return unquote(value) || null
  return isObj(text?.expr) ? `= ${exprText(text.expr)}` : null
}

function slicerOf(type, objects, fields) {
  if (!/slicer/i.test(type)) return null
  const selection = entry(objects, 'general')?.properties?.filter?.filter
  return withoutUndefined({
    mode: unquote(literal(objects, 'data', 'mode')) ?? null,
    selection: isObj(selection) ? filterText(selection, fields) : null,
    singleSelect: literal(objects, 'selection', 'singleSelect') === 'true' ? true : undefined,
  })
}

function textOf(objects) {
  const paragraphs = list(entry(objects, 'general')?.properties?.paragraphs)
  const text = paragraphs
    .map((paragraph) => list(paragraph?.textRuns).map((run) => (typeof run?.value === 'string' ? run.value : '')).join(''))
    .join('\n')
    .trim()
  return text || null
}

function actionOf(vcObjects) {
  const props = entry(vcObjects, 'visualLink')?.properties
  if (!isObj(props) || literal(vcObjects, 'visualLink', 'show') === 'false') return null
  const type = unquote(literal(vcObjects, 'visualLink', 'type'))
  if (!type) return null
  const target = props[ACTION_TARGETS[type]]?.expr
  const value = target?.Literal?.Value
  return { type, target: typeof value === 'string' ? unquote(value) || null : isObj(target) ? `= ${exprText(target)}` : null }
}

// ── Visuals ─────────────────────────────────────────────────────────────────
function legacyVisual(container, ctx, where) {
  if (!isObj(container)) {
    ctx.warn(`${where}: skipped a visual with an unexpected shape.`)
    return null
  }
  const parsed = parseEmbedded(container.config, {}, ctx, `${where} settings`)
  const config = isObj(parsed) ? parsed : {}
  const layout = list(config.layouts)[0]?.position
  const position = {}
  for (const key of ['x', 'y', 'z', 'width', 'height']) position[key] = Number.isFinite(container[key]) ? container[key] : layout?.[key]
  const base = {
    name: config.name ?? null,
    position,
    parentGroupName: config.parentGroupName ?? null,
    filters: list(parseEmbedded(container.filters, [], ctx, `${where} filters`)),
    where: config.name ? `${where} (${config.name})` : where,
  }
  if (isObj(config.singleVisualGroup)) {
    const group = config.singleVisualGroup
    const mode = typeof group.groupMode === 'number' ? GROUP_MODES[group.groupMode] ?? group.groupMode : group.groupMode
    return { ...base, group: { displayName: group.displayName ?? null, mode: mode ?? null }, hidden: group.isHidden === true }
  }
  const visual = config.singleVisual
  if (!isObj(visual)) return { ...base, type: 'unknown' }
  const query = isObj(visual.prototypeQuery) ? visual.prototypeQuery : {}
  const aliases = aliasMap(query.From)
  const selects = new Map(list(query.Select).filter(isObj).map((select) => [select.Name, select]))
  const fields = []
  for (const [role, items] of Object.entries(isObj(visual.projections) ? visual.projections : {})) {
    for (const item of list(items)) {
      const ref = item?.queryRef
      const select = selects.get(ref)
      if (!select) ctx.warn(`${base.where}: the ${role} field “${ref}” isn't in the visual's query.`)
      fields.push(withoutUndefined({
        role,
        ...(select ? fieldInfo(select, aliases) : { kind: 'unknown', text: String(ref ?? '?') }),
        displayName: visual.columnProperties?.[ref]?.displayName,
        active: typeof item?.active === 'boolean' ? item.active : undefined,
      }))
    }
  }
  const sort = list(query.OrderBy).filter(isObj).map((order) => ({
    field: exprText(order.Expression, aliases),
    direction: order.Direction === 2 ? 'descending' : 'ascending',
  }))
  return {
    ...base,
    type: visual.visualType,
    objects: visual.objects,
    vcObjects: visual.vcObjects,
    fields,
    sort,
    top: query.Top,
    hidden: visual.display?.mode === 'hidden',
  }
}

function pbirVisual(container, ctx, where) {
  const base = {
    name: container.name ?? null,
    position: isObj(container.position) ? container.position : {},
    parentGroupName: container.parentGroupName ?? null,
    filters: list(container.filterConfig?.filters),
    hidden: container.isHidden === true,
    where: container.name ? `${where} (${container.name})` : where,
  }
  if (isObj(container.visualGroup)) {
    return { ...base, group: { displayName: container.visualGroup.displayName ?? null, mode: container.visualGroup.groupMode ?? null } }
  }
  const visual = container.visual
  if (!isObj(visual)) return { ...base, type: 'unknown' }
  const fields = []
  for (const [role, state] of Object.entries(isObj(visual.query?.queryState) ? visual.query.queryState : {})) {
    for (const projection of list(state?.projections)) {
      fields.push(withoutUndefined({
        role,
        ...fieldInfo(projection?.field),
        displayName: typeof projection?.displayName === 'string' ? projection.displayName : undefined,
        active: typeof projection?.active === 'boolean' ? projection.active : undefined,
      }))
    }
  }
  const sort = list(visual.query?.sortDefinition?.sort).filter(isObj).map((order) => ({
    field: exprText(order.field),
    direction: /^desc/i.test(String(order.direction)) ? 'descending' : 'ascending',
  }))
  return {
    ...base,
    type: visual.visualType,
    objects: visual.objects,
    vcObjects: visual.visualContainerObjects,
    fields,
    sort,
  }
}

function visualOf(src, ctx) {
  const p = src.position ?? {}
  const type = src.group ? 'group' : typeof src.type === 'string' && src.type ? src.type : 'unknown'
  if (type === 'unknown') ctx.warn(`${src.where}: not a visual or a group Fabricator recognizes.`)
  const visual = { name: src.name ?? null, type }
  const custom = src.group ? null : ctx.customVisual(type)
  if (custom) visual.customVisual = custom
  const title = titleOf(src.vcObjects)
  if (title) visual.title = title
  if (title && literal(src.vcObjects, 'title', 'show') === 'false') visual.titleHidden = true
  Object.assign(visual, { x: round(p.x), y: round(p.y), z: round(p.z), width: round(p.width), height: round(p.height) })
  if (src.hidden) visual.hidden = true
  if (src.parentGroupName) visual.parent = src.parentGroupName
  if (src.group) return { ...visual, group: src.group }
  visual.fields = src.fields ?? []
  visual.sort = src.sort ?? []
  if (Number.isFinite(src.top)) visual.top = src.top
  visual.filters = list(src.filters).map((item) => filterOf(item, ctx, src.where)).filter(Boolean)
  const slicer = slicerOf(type, src.objects, visual.fields)
  if (slicer) visual.slicer = slicer
  const text = type === 'textbox' ? textOf(src.objects) : null
  if (text) visual.text = text
  const action = actionOf(src.vcObjects)
  if (action) visual.action = action
  const images = [...resourceNames(src.objects), ...resourceNames(src.vcObjects)]
  if (images.length) visual.images = [...new Set(images)]
  if (DECORATIVE.has(type) && !action) visual.decorative = true
  return visual
}

// Group membership (and a hidden group hides its members), then reading order.
function finishPage(page) {
  const byName = new Map(page.visuals.filter((v) => v.name).map((v) => [v.name, v]))
  for (const visual of page.visuals) {
    const parent = byName.get(visual.parent)
    if (parent?.group) visual.groupName = parent.group.displayName ?? parent.name
    const seen = new Set([visual.name])
    for (let up = parent; up && !seen.has(up.name); up = byName.get(up.parent)) {
      seen.add(up.name)
      if (up.hidden) visual.hidden = true
    }
  }
  page.visuals = readingOrder(page.visuals)
}

// Top-to-bottom rows (visuals within ~8px of a row's top), each left to right.
export function readingOrder(visuals, tolerance = ROW_TOLERANCE) {
  const items = list(visuals).filter(isObj)
  const sorted = [...items].sort((a, b) => num(a.y) - num(b.y) || num(a.x) - num(b.x))
  const rows = []
  for (const visual of sorted) {
    const row = rows[rows.length - 1]
    if (row && num(visual.y) - row.top <= tolerance) row.items.push(visual)
    else rows.push({ top: num(visual.y), items: [visual] })
  }
  return rows.flatMap((row) => row.items.sort((a, b) => num(a.x) - num(b.x) || num(a.y) - num(b.y)))
}

// Visuals on a page that show something, and the decorative shapes and images.
export function visualCounts(page) {
  const visuals = list(page?.visuals).filter((v) => isObj(v) && v.type !== 'group')
  const decorative = visuals.filter((v) => v.decorative).length
  return { visuals: visuals.length - decorative, decorative }
}

// "Role: field, field" per role, in the visual's order; drill-down levels note
// which level the visual shows.
export function fieldList(visual) {
  const roles = new Map()
  for (const item of list(visual?.fields)) {
    if (!isObj(item)) continue
    const role = item.role ?? 'Fields'
    if (!roles.has(role)) roles.set(role, [])
    roles.get(role).push(item)
  }
  return [...roles].map(([role, items]) => {
    const texts = items.map((f) => (f.displayName ? `${f.text} as “${f.displayName}”` : f.text))
    const active = items.filter((f) => f.active === true)
    if (items.length > 1 && active.length && active.length < items.length) {
      return `${role}: ${texts.join(' › ')} (drill-down, showing ${active.map((f) => f.text).join(', ')})`
    }
    return `${role}: ${texts.join(', ')}`
  })
}

// ── Pages, bookmarks and theme ──────────────────────────────────────────────
function parseEmbedded(value, fallback, ctx, label) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch (error) {
    ctx.warn(`Couldn't read the ${label}: ${error.message}`)
    return fallback
  }
}

function pageKind({ type, binding, objects, filters }) {
  const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : value)
  const info = lower(unquote(literal(objects, 'pageInformation', 'pageInformationType')))
  const size = lower(unquote(literal(objects, 'pageSize', 'pageSizeTypes') ?? literal(objects, 'pageSize', 'type')))
  if (lower(type) === 'tooltip' || type === LEGACY_TOOLTIP_PAGE || lower(binding) === 'tooltip' || info === 'tooltip' || size === 'tooltip') {
    return 'tooltip'
  }
  if (lower(type) === 'drillthrough' || lower(binding) === 'drillthrough' || filters.some((f) => f.howCreated === 'Drillthrough')) {
    return 'drillthrough'
  }
  return 'page'
}

function legacyPage(section, index, ctx) {
  const where = `Page “${section.displayName ?? section.name ?? index + 1}”`
  const parsed = parseEmbedded(section.config, {}, ctx, `${where} settings`)
  const config = isObj(parsed) ? parsed : {}
  const filters = list(parseEmbedded(section.filters, [], ctx, `${where} filters`))
    .map((item) => filterOf(item, ctx, where))
    .filter(Boolean)
  const visuals = list(section.visualContainers)
    .map((container, i) => legacyVisual(container, ctx, `${where}, visual ${i + 1}`))
    .filter(Boolean)
    .map((src) => visualOf(src, ctx))
  const option = section.displayOption
  return {
    name: String(section.name ?? `page-${index + 1}`),
    displayName: String(section.displayName ?? section.name ?? `Page ${index + 1}`),
    order: null,
    rank: [num(section.ordinal), index],
    width: round(section.width),
    height: round(section.height),
    displayOption: typeof option === 'number' ? DISPLAY_OPTIONS[option] ?? option : option ?? null,
    hidden: config.visibility === 1 || config.visibility === 'HiddenInViewMode',
    kind: pageKind({ type: config.type, binding: config.pageBinding?.type, objects: config.objects, filters }),
    filters,
    images: [...resourceNames(config.objects)],
    visuals,
  }
}

function pbirPage(folder, files, ctx, pageOrder) {
  const page = files.json(`definition/pages/${folder}/page.json`)
  if (!isObj(page)) {
    ctx.warn(`Skipped the page folder “${folder}”: its page.json couldn't be read.`)
    return null
  }
  const name = String(page.name ?? folder)
  const where = `Page “${page.displayName ?? name}”`
  const filters = list(page.filterConfig?.filters).map((item) => filterOf(item, ctx, where)).filter(Boolean)
  const prefix = `definition/pages/${folder}/visuals/`
  const visuals = files.paths
    .filter((path) => path.startsWith(prefix) && /^[^/]+\/visual\.json$/.test(path.slice(prefix.length)))
    .map((path) => {
      const container = files.json(path)
      if (!isObj(container)) return null
      return visualOf(pbirVisual(container, ctx, `${where}, visual ${path.slice(prefix.length).split('/')[0]}`), ctx)
    })
    .filter(Boolean)
  const position = pageOrder.indexOf(name)
  return {
    name,
    displayName: String(page.displayName ?? name),
    order: null,
    rank: [position < 0 ? pageOrder.length : position, 0],
    width: round(page.width),
    height: round(page.height),
    displayOption: page.displayOption ?? null,
    hidden: page.visibility === 'HiddenInViewMode',
    kind: pageKind({ type: page.type, binding: page.pageBinding?.type, objects: page.objects, filters }),
    filters,
    images: [...resourceNames(page.objects)],
    visuals,
  }
}

function bookmarkOf(bookmark, group) {
  const state = isObj(bookmark.explorationState) ? bookmark.explorationState : {}
  const hidden = []
  for (const section of Object.values(isObj(state.sections) ? state.sections : {})) {
    for (const [name, visual] of Object.entries(isObj(section?.visualContainers) ? section.visualContainers : {})) {
      if (visual?.singleVisual?.display?.mode === 'hidden') hidden.push(name)
    }
    for (const [name, groupState] of Object.entries(isObj(section?.visualContainerGroups) ? section.visualContainerGroups : {})) {
      if (groupState?.isHidden === true) hidden.push(name)
    }
  }
  const targets = list(bookmark.options?.targetVisualNames)
  return withoutUndefined({
    name: bookmark.name ?? null,
    displayName: bookmark.displayName ?? bookmark.name ?? null,
    page: state.activeSection ?? null,
    group: group ?? undefined,
    hiddenVisuals: hidden.length ? hidden : undefined,
    targetVisuals: targets.length ? targets : undefined,
  })
}

function legacyBookmarks(items, group = null, out = []) {
  for (const item of list(items)) {
    if (!isObj(item)) continue
    if (Array.isArray(item.children)) legacyBookmarks(item.children, item.displayName ?? item.name ?? null, out)
    else out.push(bookmarkOf(item, group))
  }
  return out
}

function pbirBookmarks(files) {
  const byName = new Map()
  for (const path of files.paths) {
    const match = path.match(/^definition\/bookmarks\/([^/]+)\.bookmark\.json$/i)
    const bookmark = match ? files.json(path) : null
    if (isObj(bookmark)) byName.set(String(bookmark.name ?? match[1]), bookmark)
  }
  const out = []
  const used = new Set()
  const take = (name, group) => {
    const bookmark = byName.get(name)
    if (!bookmark || used.has(name)) return
    used.add(name)
    out.push(bookmarkOf(bookmark, group))
  }
  for (const item of list(files.json('definition/bookmarks/bookmarks.json')?.items)) {
    if (!isObj(item)) continue
    if (Array.isArray(item.children)) for (const child of item.children) take(child, item.displayName ?? item.name ?? null)
    else take(item.name, null)
  }
  for (const name of byName.keys()) take(name, null)
  return out
}

function themeFile(files, name, base) {
  const wanted = [name, `${name}.json`].map((n) => '/' + n.toLowerCase())
  const path = files.paths.find((p) => {
    const lower = p.toLowerCase()
    return lower.startsWith('staticresources/') && (!base || lower.includes('/basethemes/')) && wanted.some((n) => lower.endsWith(n))
  })
  return path ? files.json(path) : null
}

function themeColors(theme) {
  return withoutUndefined({
    dataColors: list(theme?.dataColors),
    background: theme?.background ?? null,
    foreground: theme?.foreground ?? null,
    tableAccent: theme?.tableAccent ?? null,
    textClasses: isObj(theme?.textClasses) ? theme.textClasses : undefined,
  })
}

function themeOf(collection, files, ctx) {
  const name = (value) => (typeof value?.name === 'string' && value.name ? value.name : null)
  const baseName = name(collection?.baseTheme)
  const customName = name(collection?.customTheme)
  const base = baseName ? themeFile(files, baseName, true) : null
  const custom = customName ? themeFile(files, customName, false) : null
  if (customName && !custom) ctx.warn(`The custom theme “${customName}” isn't in the definition.`)
  const baseColors = base ? themeColors(base) : null
  const hasColors = baseColors && (baseColors.dataColors.length || baseColors.background || baseColors.foreground || baseColors.tableAccent)
  return withoutUndefined({
    base: baseName,
    custom: customName ? { name: String(custom?.name ?? customName.replace(/\.json$/i, '')), ...themeColors(custom) } : null,
    baseColors: hasColors ? baseColors : undefined,
  })
}

// ── Parts and formats ───────────────────────────────────────────────────────
function partReader(parts, ctx) {
  const payloads = new Map()
  if (!Array.isArray(parts)) ctx.warn('The report definition has no parts.')
  for (const part of list(parts)) {
    if (!isObj(part) || typeof part.path !== 'string' || !part.path || typeof part.payload !== 'string') {
      ctx.warn('Skipped a definition part without a path or payload.')
      continue
    }
    payloads.set(part.path.replace(/\\/g, '/').replace(/^\/+/, ''), part.payload)
  }
  const cache = new Map()
  const json = (path) => {
    if (!payloads.has(path)) return null
    if (!cache.has(path)) {
      let value = null
      try {
        value = JSON.parse(Buffer.from(payloads.get(path), 'base64').toString('utf8').replace(/^\uFEFF/, ''))
      } catch (error) {
        ctx.warn(`Couldn't read ${path}: ${error.message}`)
      }
      cache.set(path, value)
    }
    return cache.get(path)
  }
  return { paths: [...payloads.keys()], has: (path) => payloads.has(path), json }
}

// Custom visual type → display name, from each package's pbiviz.json.
function customVisualNames(files) {
  const names = new Map()
  for (const path of files.paths) {
    const match = path.match(/^CustomVisuals\/([^/]+)\/(?:.*\/)?[^/]*\.pbiviz\.json$/i)
    if (!match) continue
    const visual = files.json(path)?.visual
    const name = typeof visual?.displayName === 'string' ? visual.displayName.trim() : ''
    if (!name) continue
    for (const id of [match[1], visual.guid]) if (typeof id === 'string' && id && !names.has(id)) names.set(id, name)
  }
  return names
}

function customVisualLookup(files, declared) {
  const names = customVisualNames(files)
  const ids = new Set([...declared].filter((id) => typeof id === 'string'))
  return (type) => (names.has(type) ? names.get(type) : ids.has(type) || /^PBI_CV_/i.test(type) ? type : null)
}

function readLegacy(files, ctx) {
  const report = files.json('report.json')
  if (!isObj(report)) return null
  const parsed = parseEmbedded(report.config, {}, ctx, 'report settings')
  const config = isObj(parsed) ? parsed : {}
  const declared = [
    ...list(report.publicCustomVisuals), ...list(config.publicCustomVisuals),
    ...list(report.resourcePackages).map((p) => p?.resourcePackage ?? p).filter((p) => p?.type === 0 || p?.type === 'CustomVisual').map((p) => p?.name),
  ]
  ctx.customVisual = customVisualLookup(files, declared)
  if (!Array.isArray(report.sections)) ctx.warn('report.json has no pages (sections).')
  const pages = list(report.sections)
    .map((section, index) => {
      if (isObj(section)) return legacyPage(section, index, ctx)
      ctx.warn(`Skipped page ${index + 1}: unexpected shape.`)
      return null
    })
    .filter(Boolean)
  const filters = list(parseEmbedded(report.filters, [], ctx, 'report filters'))
    .map((item) => filterOf(item, ctx, 'Report'))
    .filter(Boolean)
  return {
    format: 'PBIRLegacy',
    pages,
    filters,
    bookmarks: legacyBookmarks(config.bookmarks),
    theme: themeOf(config.themeCollection, files, ctx),
  }
}

function readPbir(files, ctx) {
  const report = files.json('definition/report.json')
  if (!isObj(report)) return null
  const declared = [
    ...list(report.publicCustomVisuals),
    ...list(report.organizationCustomVisuals).map((v) => v?.name),
    ...list(report.resourcePackages).filter((p) => p?.type === 'CustomVisual').map((p) => p?.name),
  ]
  ctx.customVisual = customVisualLookup(files, declared)
  const pageOrder = list(files.json('definition/pages/pages.json')?.pageOrder).map(String)
  const folders = [...new Set(files.paths.map((path) => path.match(/^definition\/pages\/([^/]+)\/page\.json$/)?.[1]).filter(Boolean))]
  const pages = folders.map((folder) => pbirPage(folder, files, ctx, pageOrder)).filter(Boolean)
  return {
    format: 'PBIR',
    pages,
    filters: list(report.filterConfig?.filters).map((item) => filterOf(item, ctx, 'Report')).filter(Boolean),
    bookmarks: pbirBookmarks(files),
    theme: themeOf(report.themeCollection, files, ctx),
  }
}

function resourcesOf(files) {
  const used = new Set()
  return files.paths
    .filter((path) => /^StaticResources\/RegisteredResources\//i.test(path) && IMAGE.test(path))
    .map((path) => {
      const file = path.split('/').pop()
      let name = file
      for (let n = 2; used.has(name.toLowerCase()); n++) name = file.replace(/(\.[^.]+)$/, `-${n}$1`)
      used.add(name.toLowerCase())
      return { name, path }
    })
}

// Fabric getDefinition `definition.parts` → the report model written to
// report.json: format, pages (in order) with their visuals in reading order,
// report filters, bookmarks, theme, custom visuals, images and warnings.
export function normalizeDefinition(parts) {
  const warnings = []
  const ctx = {
    warn: (message) => { if (warnings.length < MAX_WARNINGS) warnings.push(message) },
    customVisual: () => null,
  }
  const model = { format: null, pages: [], filters: [], bookmarks: [], theme: { base: null, custom: null }, customVisuals: [], resources: [], warnings }
  try {
    const files = partReader(parts, ctx)
    const read = files.has('definition/report.json') ? readPbir(files, ctx) : files.has('report.json') ? readLegacy(files, ctx) : null
    model.resources = resourcesOf(files)
    if (!read) {
      if (files.paths.length) ctx.warn('The definition has neither definition/report.json (PBIR) nor report.json (PBIR-Legacy).')
      return model
    }
    read.pages.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.displayName.localeCompare(b.displayName))
    model.format = read.format
    model.pages = read.pages
    for (const [order, page] of model.pages.entries()) {
      page.order = order
      delete page.rank
    }
    model.filters = read.filters
    model.bookmarks = read.bookmarks
    model.theme = read.theme
    const pageNames = new Map(model.pages.map((page) => [page.name, page.displayName]))
    const bookmarkNames = new Map(model.bookmarks.map((bookmark) => [bookmark.name, bookmark.displayName]))
    for (const bookmark of model.bookmarks) if (pageNames.has(bookmark.page)) bookmark.pageName = pageNames.get(bookmark.page)
    const custom = new Map()
    for (const page of model.pages) {
      finishPage(page)
      for (const visual of page.visuals) {
        if (visual.customVisual) {
          const known = custom.get(visual.type) ?? { id: visual.type, name: visual.customVisual, visuals: 0 }
          known.visuals++
          custom.set(visual.type, known)
        }
        const action = visual.action
        if (!action?.target) continue
        const name = action.type === 'Bookmark' ? bookmarkNames.get(action.target) : pageNames.get(action.target)
        if (name) action.targetName = name
      }
    }
    model.customVisuals = [...custom.values()]
    // Packaged but not placed on any page: listed so raw/CustomVisuals makes sense.
    for (const [id, name] of customVisualNames(files)) {
      if (!model.customVisuals.some((c) => c.id === id || c.name === name)) model.customVisuals.push({ id, name, visuals: 0 })
    }
  } catch (error) {
    ctx.warn(`Couldn't fully read the report definition: ${error?.message ?? error}`)
  }
  return model
}

// ── README.md ───────────────────────────────────────────────────────────────
function code(text) {
  const value = String(text ?? '')
  const longest = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length))
  const ticks = '`'.repeat(longest + 1)
  const pad = value.startsWith('`') || value.endsWith('`') ? ' ' : ''
  return `${ticks}${pad}${value}${pad}${ticks}`
}

function fence(text, language, indent = '') {
  const value = String(text ?? '')
  const longest = Math.max(2, ...(value.match(/`+/g) ?? []).map((run) => run.length))
  const marks = '`'.repeat(longest + 1)
  return [`${indent}${marks}${language}`, ...value.split(/\r?\n/).map((line) => indent + line), `${indent}${marks}`]
}

const kindLabel = (kind) => (kind === 'tooltip' ? 'Tooltip page' : kind === 'drillthrough' ? 'Drillthrough page' : 'Page')
const formatLabel = (format) => (format === 'PBIRLegacy' ? 'PBIR-Legacy' : format)

function visualLine(visual) {
  const name = visual.customVisual ? `${visual.customVisual} (custom visual)` : visual.type
  const title = visual.title ? ` “${clip(oneLine(visual.title), 120)}”` : ''
  const details = [...fieldList(visual)]
  if (visual.text) details.push(`text: “${clip(oneLine(visual.text), 120)}”`)
  if (visual.slicer?.mode) details.push(`mode: ${visual.slicer.mode}`)
  if (visual.slicer?.singleSelect) details.push('single select')
  if (visual.slicer?.selection) details.push(`selected: ${visual.slicer.selection}`)
  const filters = list(visual.filters).filter((f) => f?.text).map((f) => f.text)
  if (filters.length) details.push(`filters: ${filters.join('; ')}`)
  if (list(visual.sort).length) details.push(`sort: ${visual.sort.map((s) => `${s.field} ${s.direction}`).join(', ')}`)
  if (Number.isFinite(visual.top)) details.push(`top ${visual.top}`)
  if (visual.action) {
    const target = visual.action.targetName ?? visual.action.target
    details.push(`action: ${visual.action.type}${target ? ` → ${target}` : ''}`)
  }
  if (list(visual.images).length) details.push(`image: ${visual.images.map((image) => `resources/${image}`).join(', ')}`)
  if (visual.titleHidden) details.push('title hidden')
  if (visual.groupName) details.push(`in group “${visual.groupName}”`)
  if (visual.hidden) details.push('hidden until a bookmark or button shows it')
  const at = ` at ${visual.x ?? '?'},${visual.y ?? '?'} ${visual.width ?? '?'}×${visual.height ?? '?'}`
  return `- ${name}${title}${at}${details.length ? ' — ' + details.join('; ') : ''}`
}

// The pages the caller passes (with stems for the image and text files), in
// order, enriched with the definition's pages; definition-only pages go last.
function mergePages(given, defined) {
  const byName = new Map(defined.filter(isObj).map((page) => [page.name, page]))
  const seen = new Set()
  const out = []
  for (const page of [...given].filter(isObj).sort((a, b) => num(a.order) - num(b.order))) {
    seen.add(page.name)
    const known = byName.get(page.name)
    out.push({ ...known, ...withoutUndefined(Object.fromEntries(Object.entries(page).filter(([, v]) => v !== null))), visuals: known?.visuals ?? null, filters: known?.filters ?? [] })
  }
  for (const page of defined) if (isObj(page) && !seen.has(page.name)) out.push(page)
  return out
}

// The bundle's README.md: what the material is, where it came from, and each
// page with its visuals in reading order. Holds only what the definition holds.
export function readmeMarkdown(input) {
  const { source: given, pages: pageList, images, report } = isObj(input) ? input : {}
  const source = isObj(given) ? given : {}
  const model = isObj(report) ? report : null
  const pages = mergePages(list(pageList), list(model?.pages))
  const name = source.reportName || 'the report'
  const lines = []
  const add = (...items) => lines.push(...items)

  add(`# Migrating “${name}” from Power BI`, '')
  add('Source material for rebuilding this Power BI report as a Rayfin app. It stays on this computer, out of git. Read this file first; then, for each page you migrate, its entry below, its image and its text.', '')

  add('## Source', '')
  add(`- Report: ${source.reportUrl ? `[${name}](${source.reportUrl})` : name}`)
  add(`- Workspace: ${source.personal ? 'My workspace' : source.workspaceName || 'unknown'}`)
  if (source.modelName) {
    const where = source.modelWorkspaceName ? ` (workspace: ${source.modelWorkspaceName})` : ''
    add(`- Semantic model: ${source.modelName}${where}`)
  }
  if (source.alias) add(`- Connector alias: ${code(source.alias)}${source.connectorCommand ? `, added with ${code(source.connectorCommand)}` : ''}`)
  else if (source.connectorCommand) add(`- Connector command: ${code(source.connectorCommand)}`)
  add(`- Format: ${model?.format ? formatLabel(model.format) : 'not available (the definition couldn’t be read)'}`)
  const totals = pages.reduce((sum, page) => {
    if (!page.visuals) return sum
    const counts = visualCounts(page)
    return { visuals: sum.visuals + counts.visuals, decorative: sum.decorative + counts.decorative }
  }, { visuals: 0, decorative: 0 })
  const visualTotal = model ? ` · ${plural(totals.visuals, 'visual')}${totals.decorative ? ` (+ ${totals.decorative} decorative)` : ''}` : ''
  add(`- Pages: ${pages.length}${visualTotal}`)
  const theme = model?.theme
  if (theme?.base || theme?.custom) {
    const parts = [theme.base && `base ${theme.base}`, theme.custom && `custom “${theme.custom.name}”`].filter(Boolean)
    add(`- Theme: ${parts.join(', ')} (colors in ${code('theme.json')})`)
  }
  const custom = list(model?.customVisuals).filter((c) => c?.visuals > 0)
  if (custom.length) add(`- Custom visuals: ${custom.map((c) => c.name).join(', ')}`)
  add('')

  add('## Files', '')
  add(model
    ? `- ${code('report.json')}: the report definition, simplified. Each page lists its visuals in reading order with type, title, position and size, fields by role (table, column or measure, aggregation, hierarchy level), sort, top N, filters (readable text plus the raw query), slicer selections, text box text and button actions. Also report filters, bookmarks and the theme.`
    : `- ${code('report.json')}: not available. The definition couldn’t be read, so work from the page images and text.`)
  add(`- ${code('model.md')}: the semantic model’s tables, columns, measures and relationships.`)
  if (model) {
    add(`- ${code('theme.json')}: the theme’s colors (base and custom theme).`)
    add(`- ${code('resources/')}: images the report uses, such as logos and backgrounds.`)
    add(`- ${code('raw/')}: the definition files exactly as Power BI returned them, for anything ${code('report.json')} leaves out.`)
  }
  if (images) {
    add(`- ${code('pages/<stem>.png')}: an image of each page, exported from Power BI.`)
    add(`- ${code('pages/<stem>.txt')}: the text on each page from the same export, grouped into lines. Check the app’s numbers against it.`)
  } else {
    add('- Page images and text: not available (Power BI couldn’t export this report’s pages).')
  }
  add('')

  add('## Pages', '')
  pages.forEach((page, index) => {
    add(`### ${index + 1}. ${oneLine(page.displayName ?? page.name)}`, '')
    const counts = page.visuals ? visualCounts(page) : null
    const facts = [kindLabel(page.kind)]
    if (page.hidden) facts.push('hidden')
    if (page.width && page.height) facts.push(`${page.width}×${page.height}`)
    if (counts) facts.push(`${plural(counts.visuals, 'visual')}${counts.decorative ? ` (+ ${counts.decorative} decorative)` : ''}`)
    if (page.name) facts.push(`name ${code(page.name)}`)
    add(`- ${facts.join(' · ')}`)
    add(images && page.stem
      ? `- Image: ${code(`pages/${page.stem}.png`)} · text: ${code(`pages/${page.stem}.txt`)}`
      : '- Image and text: not available')
    const filters = list(page.filters).filter((f) => f?.text).map((f) => f.text)
    if (filters.length) add(`- Page filters: ${filters.join('; ')}`)
    if (!page.visuals) {
      add(`- Visuals: not available (${images && page.stem ? 'see the page image' : 'the definition couldn’t be read'})`)
    } else {
      const shown = readingOrder(page.visuals.filter((v) => isObj(v) && v.type !== 'group' && !v.decorative))
      if (shown.length) {
        add('- Visuals, in reading order:')
        for (const visual of shown) add('  ' + visualLine(visual))
      }
      if (counts.decorative) add(`- Not listed: ${plural(counts.decorative, 'decorative shape or image', 'decorative shapes and images')} (see ${code('report.json')})`)
    }
    add('')
  })

  const reportFilters = list(model?.filters).filter((f) => f?.text)
  if (reportFilters.length) {
    add('## Report filters', '', 'These apply to every page.', '')
    for (const f of reportFilters) add(`- ${f.text}${f.hidden ? ' (hidden)' : ''}${f.locked ? ' (locked)' : ''}`)
    add('')
  }
  const bookmarks = list(model?.bookmarks).filter(isObj)
  if (bookmarks.length) {
    add('## Bookmarks', '')
    for (const b of bookmarks) {
      const page = b.pageName ?? b.page
      const hides = list(b.hiddenVisuals).length ? `, hides ${plural(b.hiddenVisuals.length, 'visual')}` : ''
      add(`- “${b.displayName ?? b.name}”${page ? ` → page “${page}”` : ''}${b.group ? ` (group “${b.group}”)` : ''}${hides}`)
    }
    add('')
  }
  const warnings = list(model?.warnings)
  if (warnings.length) {
    add('## Reading notes', '', 'Parts of the definition Fabricator couldn’t fully read (see raw/ for the originals):', '')
    for (const warning of warnings.slice(0, 20)) add(`- ${oneLine(warning)}`)
    if (warnings.length > 20) add(`- … ${warnings.length - 20} more in ${code('report.json')}`)
    add('')
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

// ── model.md ────────────────────────────────────────────────────────────────
const bool = (value) => value === true || String(value).toLowerCase() === 'true'
const textOrNull = (value) => (value === undefined || value === null || value === '' ? null : String(value))
const camel = (value) => (typeof value === 'string' && value ? value[0].toLowerCase() + value.slice(1) : null)
const unbracket = (row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/^.*\[([^\]]*)\]$/, '$1'), value]))

// INFO.VIEW.TABLES/COLUMNS/MEASURES/RELATIONSHIPS() rows → normalizeTmsl's shape.
// Power BI masks measure expressions there, so `expression` is usually null.
export function infoViewSchema({ tables, columns, measures, relationships } = {}) {
  const rows = (value) => list(value).filter(isObj).map(unbracket)
  return {
    tables: rows(tables).filter((t) => t.Name).map((t) => ({
      name: String(t.Name), description: textOrNull(t.Description), isHidden: bool(t.IsHidden), storageMode: textOrNull(t.StorageMode),
    })),
    columns: rows(columns)
      .filter((c) => c.Name && !/rownumber/i.test(String(c.Type ?? '')) && !/^RowNumber-/i.test(String(c.Name)))
      .map((c) => ({
        table: textOrNull(c.Table), name: String(c.Name), dataType: textOrNull(c.DataType), isHidden: bool(c.IsHidden),
        isKey: bool(c.IsKey), dataCategory: textOrNull(c.DataCategory), formatString: textOrNull(c.FormatString),
        displayFolder: textOrNull(c.DisplayFolder), expression: textOrNull(c.Expression),
      })),
    measures: rows(measures).filter((m) => m.Name).map((m) => ({
      table: textOrNull(m.Table), name: String(m.Name), expression: textOrNull(m.Expression), dataType: textOrNull(m.DataType),
      formatString: textOrNull(m.FormatString), displayFolder: textOrNull(m.DisplayFolder), description: textOrNull(m.Description),
      isHidden: bool(m.IsHidden),
    })),
    relationships: rows(relationships).filter((r) => r.FromTable && r.ToTable).map((r) => ({
      name: textOrNull(r.Name), fromTable: String(r.FromTable), fromColumn: textOrNull(r.FromColumn),
      toTable: String(r.ToTable), toColumn: textOrNull(r.ToColumn),
      fromCardinality: textOrNull(r.FromCardinality)?.toLowerCase() ?? 'many',
      toCardinality: textOrNull(r.ToCardinality)?.toLowerCase() ?? 'one',
      isActive: r.IsActive === undefined || r.IsActive === null ? true : bool(r.IsActive),
      crossFilter: camel(textOrNull(r.CrossFilteringBehavior)) ?? 'oneDirection',
    })),
  }
}

function columnLines(column) {
  const facts = [
    column.dataType, column.formatString && `format ${code(column.formatString)}`,
    column.dataCategory && `category ${column.dataCategory}`, column.displayFolder && `folder ${column.displayFolder}`,
    column.isKey && 'key', column.isHidden && 'hidden',
  ].filter(Boolean)
  const head = `- ${code(column.name)}${facts.length ? ' — ' + facts.join(' · ') : ''}`
  if (!column.expression) return [head]
  if (!column.expression.includes('\n')) return [`${head} · calculated: ${code(column.expression)}`]
  return [`${head} · calculated:`, ...fence(column.expression, 'dax', '  ')]
}

function measureLines(measure, masked) {
  const facts = [
    measure.formatString && `format ${code(measure.formatString)}`, measure.displayFolder && `folder ${measure.displayFolder}`,
    measure.isHidden && 'hidden',
  ].filter(Boolean)
  const lines = [`- ${code(bracket(measure.name))}${facts.length ? ' — ' + facts.join(' · ') : ''}`]
  if (measure.description) lines.push(`  ${oneLine(measure.description)}`)
  if (measure.expression) lines.push(...fence(measure.expression, 'dax', '  '))
  else if (!masked) lines.push('  (no expression)')
  return lines
}

function relationshipLine(r) {
  const direction = /^both/i.test(String(r.crossFilter ?? '')) ? 'filters both ways' : /^auto/i.test(String(r.crossFilter ?? '')) ? 'automatic filter direction' : 'filters one way'
  const facts = [`${r.fromCardinality ?? 'many'} to ${r.toCardinality ?? 'one'}`, direction]
  if (r.isActive === false) facts.push('inactive')
  return `- ${tableRef(r.fromTable)}${bracket(r.fromColumn)} → ${tableRef(r.toTable)}${bracket(r.toColumn)} (${facts.join(', ')})`
}

// model.md from normalizeTmsl's shape (or infoViewSchema's). `info.source` is
// 'definition' (TMSL, with DAX) or 'queries' (INFO.VIEW, measure DAX masked).
export function modelMarkdown(schema, info = {}) {
  const s = isObj(schema) ? schema : {}
  const meta = isObj(info) ? info : {}
  const auto = (name) => AUTO_DATE_TABLE.test(String(name ?? ''))
  const tables = list(s.tables).filter((t) => isObj(t) && t.name && !auto(t.name))
  const columns = list(s.columns).filter((c) => isObj(c) && c.name && !auto(c.table))
  const measures = list(s.measures).filter((m) => isObj(m) && m.name)
  const relationships = list(s.relationships).filter((r) => isObj(r) && !auto(r.fromTable) && !auto(r.toTable))
  const skipped = list(s.tables).filter((t) => auto(t?.name)).length
  const masked = meta.source === 'queries'
  const lines = [`# Semantic model${meta.name ? ` “${meta.name}”` : ''}`, '']
  lines.push(masked
    ? 'Read with Power BI’s `INFO.VIEW` queries because the model’s definition couldn’t be read. Those queries mask measure expressions, so **measure DAX is not available here**: rely on each measure’s name, folder and format, and check results against the report’s page text.'
    : 'Read from the model’s definition: tables, columns, measures with their DAX, and relationships.', '')
  const autoNote = skipped ? ` (${plural(skipped, 'auto date/time table')} left out)` : ''
  lines.push(`${plural(tables.length, 'table')} · ${plural(columns.length, 'column')} · ${plural(measures.length, 'measure')} · ${plural(relationships.length, 'relationship')}${autoNote}`, '')
  lines.push('## Tables', '')
  const known = new Set(tables.map((t) => t.name))
  const orphans = [...new Set([...columns, ...measures].map((x) => x.table).filter((t) => t && !known.has(t)))]
  for (const table of [...tables, ...orphans.map((name) => ({ name }))]) {
    lines.push(`### ${table.name}${table.isHidden ? ' (hidden)' : ''}`, '')
    if (table.description) lines.push(oneLine(table.description), '')
    const tableColumns = columns.filter((c) => c.table === table.name)
    if (tableColumns.length) lines.push('Columns:', '', ...tableColumns.flatMap(columnLines), '')
    const tableMeasures = measures.filter((m) => m.table === table.name)
    if (tableMeasures.length) lines.push('Measures:', '', ...tableMeasures.flatMap((m) => measureLines(m, masked)), '')
  }
  const loose = measures.filter((m) => !m.table)
  if (loose.length) lines.push('### Measures without a table', '', ...loose.flatMap((m) => measureLines(m, masked)), '')
  lines.push('## Relationships', '')
  lines.push(...(relationships.length ? relationships.map(relationshipLine) : ['None.']), '')
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}
