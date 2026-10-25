import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  conditionText, exprText, fieldInfo, fieldList, filterText, infoViewSchema, literalText, modelMarkdown, normalizeDefinition,
  readingOrder, readmeMarkdown, visualCounts,
} from './report_definition.mjs'

// Synthetic fixtures only: one small report, stored once as PBIR-Legacy and once
// as PBIR, so both readers must agree on the same model.
const part = (path, value) => ({
  path,
  payload: (Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))).toString('base64'),
  payloadType: 'InlineBase64',
})
const lit = (value) => ({ Literal: { Value: value } })
const prop = (value) => ({ expr: lit(value) })
const alias = (name) => () => ({ SourceRef: { Source: name } })
const entity = (table) => ({ SourceRef: { Entity: table } })

// Field builders take a SourceRef builder: legacy queries use aliases, PBIR names tables.
const column = (table, name) => (ref) => ({ Column: { Expression: ref(table), Property: name } })
const measure = (table, name) => (ref) => ({ Measure: { Expression: ref(table), Property: name } })
const sum = (table, name) => (ref) => ({ Aggregation: { Expression: column(table, name)(ref), Function: 0 } })
const dateLevel = (table, name, level) => (ref) => ({
  HierarchyLevel: {
    Expression: { Hierarchy: { Expression: { PropertyVariationSource: { Expression: ref(table), Name: 'Variation', Property: name } }, Hierarchy: 'Date Hierarchy' } },
    Level: level,
  },
})
const level = (table, hierarchy, name) => (ref) => ({
  HierarchyLevel: { Expression: { Hierarchy: { Expression: ref(table), Hierarchy: hierarchy } }, Level: name },
})
const lastMonths = (months) => ({
  Between: {
    Expression: column('Date', 'Date')(alias('d')),
    LowerBound: { DateSpan: { Expression: { DateAdd: { Expression: { DateAdd: { Expression: { Now: {} }, Amount: 1, TimeUnit: 0 } }, Amount: -months, TimeUnit: 2 } }, TimeUnit: 0 } },
    UpperBound: { DateSpan: { Expression: { Now: {} }, TimeUnit: 0 } },
  },
})
const valuesIn = (expr, values) => ({ In: { Expressions: [expr], Values: values.map((v) => [lit(`'${v}'`)]) } })

// Filters differ between formats only in the field key and howCreated's form.
const filter = (name, type, target, from, condition, extra = {}) => (key, howCreated) => ({
  name, [key]: target(entity), type, howCreated, ...extra,
  ...(condition ? { filter: { Version: 2, From: from.map(([n, e]) => ({ Name: n, Entity: e, Type: 0 })), Where: [{ Condition: condition }] } } : {}),
})
const notTest = filter('country', 'Categorical', column('Region', 'Country'), [['r', 'Region']],
  { Not: { Expression: valuesIn(column('Region', 'Country')(alias('r')), ['Test']) } })
const recent = filter('dates', 'RelativeDate', column('Date', 'Date'), [['d', 'Date']], lastMonths(3))
const bikes = filter('category', 'Categorical', column('Product', 'Category'), [['p', 'Product']],
  valuesIn(column('Product', 'Category')(alias('p')), ['Bikes', 'Accessories']), { isLockedInViewMode: true })
const amountRange = filter('range', 'Advanced', column('Sales', 'Amount'), [['s', 'Sales']], {
  And: {
    Left: { Between: { Expression: column('Sales', 'Amount')(alias('s')), LowerBound: lit('10L'), UpperBound: lit('100L') } },
    Right: { Comparison: { ComparisonKind: 2, Left: column('Sales', 'Quantity')(alias('s')), Right: lit('2L') } },
  },
})
const topFive = (key, howCreated) => ({
  name: 'top', [key]: column('Product', 'Name')(entity), type: 'TopN', howCreated,
  filter: {
    Version: 2,
    From: [
      {
        Name: 'subquery', Type: 2,
        Expression: {
          Subquery: {
            Query: {
              Version: 2,
              From: [{ Name: 'p', Entity: 'Product', Type: 0 }, { Name: 's', Entity: 'Sales', Type: 0 }],
              Select: [{ ...column('Product', 'Name')(alias('p')), Name: 'field' }],
              OrderBy: [{ Direction: 2, Expression: measure('Sales', 'Revenue')(alias('s')) }],
              Top: 5,
            },
          },
        },
      },
      { Name: 'p', Entity: 'Product', Type: 0 },
    ],
    Where: [{ Condition: { In: { Expressions: [column('Product', 'Name')(alias('p'))], Table: { SourceRef: { Source: 'subquery' } } } } }],
  },
})
const drillTarget = filter('drill', 'Categorical', column('Product', 'Name'), [], null)

const canadaOrMexico = {
  Version: 2,
  From: [{ Name: 'r', Entity: 'Region', Type: 0 }],
  Where: [{ Condition: valuesIn(column('Region', 'Country')(alias('r')), ['Canada', 'Mexico']) }],
}

const OVERVIEW = [
  { name: 'shape', type: 'shape', at: [0, 0, 1280, 90] },
  { name: 'logo', type: 'image', at: [1180, 2, 80, 60], objects: { general: [{ properties: { imageUrl: { expr: { ResourcePackageItem: { PackageName: 'RegisteredResources', PackageType: 1, ItemName: 'logo.png' } } } } }] } },
  { name: 'header', group: 'Header', at: [30, 4, 620, 80] },
  {
    name: 'title', type: 'textbox', at: [40, 6, 600, 60], parent: 'header',
    objects: { general: [{ properties: { paragraphs: [{ textRuns: [{ value: 'Financial ' }, { value: 'overview' }] }, { textRuns: [{ value: 'FY2024' }] }] } }] },
  },
  {
    name: 'slicer', type: 'slicer', at: [1000, 8, 160, 60], roles: { Values: [['Region.Country', column('Region', 'Country')]] },
    objects: { data: [{ properties: { mode: prop("'Dropdown'") } }], general: [{ properties: { filter: { filter: canadaOrMexico } } }] },
  },
  {
    name: 'kpi', type: 'kpi', at: [40, 100, 300, 160], title: 'Revenue vs goal',
    roles: {
      Indicator: [['Sales.Revenue', measure('Sales', 'Revenue')]],
      Goal: [['Sales.Revenue Goal', measure('Sales', 'Revenue Goal')]],
      TrendLine: [['Date.Date Hierarchy.Year', dateLevel('Date', 'Date', 'Year')]],
    },
  },
  {
    name: 'combo', type: 'lineClusteredColumnComboChart', at: [360, 104, 600, 300], title: 'Revenue and margin',
    roles: {
      Category: [['Date.Calendar.Year', level('Date', 'Calendar', 'Year'), true], ['Date.Calendar.Month', level('Date', 'Calendar', 'Month')]],
      Y: [['Sales.Revenue', measure('Sales', 'Revenue')]],
      Y2: [['Sales.Margin %', measure('Sales', 'Margin %')]],
    },
    sort: [[measure('Sales', 'Revenue'), 'desc']],
    filters: [topFive],
  },
  { name: 'card', type: 'card', at: [40, 300, 300, 120], roles: { Values: [['Sum(Sales.Amount)', sum('Sales', 'Amount')]] }, filters: [amountRange] },
  {
    name: 'bullet', type: 'BulletChart1443347686880', at: [360, 420, 600, 200],
    roles: { Value: [['Sales.Revenue', measure('Sales', 'Revenue')]], TargetValue: [['Sales.Revenue Goal', measure('Sales', 'Revenue Goal')]] },
  },
  { name: 'secret', type: 'card', at: [1000, 420, 240, 120], hidden: true, roles: { Values: [['Sales.Margin %', measure('Sales', 'Margin %')]] } },
  {
    name: 'button', type: 'actionButton', at: [1100, 660, 160, 40], title: 'Details',
    vcObjects: { visualLink: [{ properties: { show: prop('true'), type: prop("'PageNavigation'"), navigationSection: prop("'details'") } }] },
  },
]
const PAGES = [
  { name: 'tip', displayName: 'Revenue tooltip', size: [320, 240], tooltip: true, ordinal: 2, visuals: [{ name: 'tipcard', type: 'card', at: [0, 0, 320, 240], roles: { Values: [['Sales.Revenue', measure('Sales', 'Revenue')]] } }] },
  { name: 'overview', displayName: 'Overview', size: [1280, 720], filters: [notTest], visuals: OVERVIEW },
  {
    name: 'details', displayName: 'Details', size: [1280, 720], drillthrough: true, ordinal: 1, filters: [drillTarget],
    visuals: [{ name: 'table', type: 'tableEx', at: [0, 0, 1280, 720], roles: { Values: [['Product.Name', column('Product', 'Name')], ['Sum(Sales.Amount)', sum('Sales', 'Amount')]] } }],
  },
]
const BOOKMARK = {
  name: 'bm1', displayName: 'Show margin', options: {},
  explorationState: { version: '1.3', activeSection: 'overview', sections: { overview: { visualContainers: { kpi: { singleVisual: { display: { mode: 'hidden' } } } } } } },
}
const SHARED_PARTS = [
  part('StaticResources/SharedResources/BaseThemes/CY24SU10.json', { name: 'CY24SU10', dataColors: ['#118DFF', '#12239E'], background: '#FFFFFF', foreground: '#252423', tableAccent: '#118DFF' }),
  part('StaticResources/RegisteredResources/Contoso8123.json', { name: 'Contoso', dataColors: ['#0F6CBD', '#C239B3'], background: '#FAFAFA', foreground: '#1B1B1B', tableAccent: '#0F6CBD' }),
  part('StaticResources/RegisteredResources/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  part('CustomVisuals/BulletChart1443347686880/resources/BulletChart1443347686880.pbiviz.json', { visual: { name: 'BulletChart', displayName: 'Bullet Chart by OKViz', guid: 'BulletChart1443347686880' } }),
]
const titleObjects = (v) => ({ ...(v.title ? { title: [{ properties: { text: prop(`'${v.title}'`) } }] } : {}), ...v.vcObjects })

function legacyContainer(v) {
  const config = { name: v.name, layouts: [{ id: 0, position: { x: v.at[0], y: v.at[1], z: 0, width: v.at[2], height: v.at[3] } }] }
  if (v.parent) config.parentGroupName = v.parent
  if (v.group) {
    config.singleVisualGroup = { displayName: v.group, groupMode: 0 }
  } else {
    // Real legacy queries name tables by alias, e.g. `s` for Sales.
    const aliases = new Map()
    const ref = (table) => {
      if (!aliases.has(table)) {
        let name = table[0].toLowerCase()
        for (let n = 1; [...aliases.values()].includes(name); n++) name = table[0].toLowerCase() + n
        aliases.set(table, name)
      }
      return { SourceRef: { Source: aliases.get(table) } }
    }
    const select = []
    const projections = {}
    for (const [role, items] of Object.entries(v.roles ?? {})) {
      projections[role] = items.map(([queryRef, build, active]) => {
        if (!select.some((s) => s.Name === queryRef)) select.push({ ...build(ref), Name: queryRef })
        return active ? { queryRef, active } : { queryRef }
      })
    }
    const orderBy = (v.sort ?? []).map(([build, direction]) => ({ Direction: direction === 'desc' ? 2 : 1, Expression: build(ref) }))
    config.singleVisual = {
      visualType: v.type,
      projections,
      prototypeQuery: { Version: 2, From: [...aliases].map(([Entity, Name]) => ({ Name, Entity, Type: 0 })), Select: select, ...(orderBy.length ? { OrderBy: orderBy } : {}) },
      ...(v.objects ? { objects: v.objects } : {}),
      vcObjects: titleObjects(v),
      ...(v.hidden ? { display: { mode: 'hidden' } } : {}),
    }
  }
  const [x, y, width, height] = v.at
  return { x, y, z: 0, width, height, config: JSON.stringify(config), filters: JSON.stringify((v.filters ?? []).map((f) => f('expression', 1))) }
}

function legacyReport() {
  const sections = PAGES.map((page) => ({
    name: page.name,
    displayName: page.displayName,
    ...(page.ordinal ? { ordinal: page.ordinal } : {}),
    width: page.size[0],
    height: page.size[1],
    displayOption: 1,
    config: JSON.stringify(page.tooltip ? { visibility: 1, type: 1 } : {}),
    filters: JSON.stringify((page.filters ?? []).map((f) => f('expression', page.drillthrough ? 5 : 1))),
    visualContainers: page.visuals.map(legacyContainer),
  }))
  const config = {
    version: '5.61',
    themeCollection: { baseTheme: { name: 'CY24SU10', version: '5.61', type: 2 }, customTheme: { name: 'Contoso8123.json', version: '5.61', type: 1 } },
    bookmarks: [BOOKMARK],
  }
  return [
    part('definition.pbir', { version: '1.0', datasetReference: { byConnection: {} } }),
    part('report.json', {
      config: JSON.stringify(config),
      filters: JSON.stringify([recent, bikes].map((f) => f('expression', 1))),
      layoutOptimization: 0,
      resourcePackages: [{ resourcePackage: { name: 'BulletChart1443347686880', type: 0, items: [{ name: 'package.json', path: 'package.json', type: 5 }] } }],
      sections,
    }),
    ...SHARED_PARTS,
  ]
}

function pbirVisual(v) {
  const [x, y, width, height] = v.at
  const base = { name: v.name, position: { x, y, z: 0, width, height }, ...(v.parent ? { parentGroupName: v.parent } : {}) }
  if (v.group) return { ...base, visualGroup: { displayName: v.group, groupMode: 'ScaleMode' } }
  const queryState = {}
  for (const [role, items] of Object.entries(v.roles ?? {})) {
    queryState[role] = { projections: items.map(([queryRef, build, active]) => ({ field: build(entity), queryRef, ...(active ? { active } : {}) })) }
  }
  const sort = (v.sort ?? []).map(([build, direction]) => ({ field: build(entity), direction: direction === 'desc' ? 'Descending' : 'Ascending' }))
  return {
    ...base,
    visual: {
      visualType: v.type,
      query: { queryState, ...(sort.length ? { sortDefinition: { sort } } : {}) },
      ...(v.objects ? { objects: v.objects } : {}),
      visualContainerObjects: titleObjects(v),
    },
    ...(v.filters ? { filterConfig: { filters: v.filters.map((f) => f('field', 'User')) } } : {}),
    ...(v.hidden ? { isHidden: true } : {}),
  }
}

function pbirReport() {
  const pages = PAGES.flatMap((page) => [
    part(`definition/pages/${page.name}/page.json`, {
      name: page.name,
      displayName: page.displayName,
      displayOption: 'FitToPage',
      width: page.size[0],
      height: page.size[1],
      ...(page.tooltip ? { type: 'Tooltip', visibility: 'HiddenInViewMode', pageBinding: { name: 'tipBinding', type: 'Tooltip' } } : {}),
      ...(page.drillthrough ? { pageBinding: { name: 'drillBinding', type: 'Drillthrough' } } : {}),
      ...(page.filters ? { filterConfig: { filters: page.filters.map((f) => f('field', page.drillthrough ? 'Drillthrough' : 'User')) } } : {}),
    }),
    ...page.visuals.map((v) => part(`definition/pages/${page.name}/visuals/${v.name}/visual.json`, pbirVisual(v))),
  ])
  return [
    part('definition.pbir', { version: '4.0', datasetReference: { byConnection: {} } }),
    part('definition/version.json', { version: '2.0.0' }),
    part('definition/report.json', {
      themeCollection: {
        baseTheme: { name: 'CY24SU10', reportVersionAtImport: '5.61', type: 'SharedResources' },
        customTheme: { name: 'Contoso8123.json', reportVersionAtImport: '5.61', type: 'RegisteredResources' },
      },
      filterConfig: { filters: [recent, bikes].map((f) => f('field', 'User')) },
      publicCustomVisuals: ['BulletChart1443347686880'],
    }),
    part('definition/pages/pages.json', { pageOrder: ['overview', 'details', 'tip'], activePageName: 'overview' }),
    ...pages,
    part('definition/bookmarks/bookmarks.json', { items: [{ name: 'bm1' }] }),
    part('definition/bookmarks/bm1.bookmark.json', BOOKMARK),
    ...SHARED_PARTS,
  ]
}

function checkReport(model, format) {
  assert.deepEqual(model.warnings, [])
  assert.equal(model.format, format)
  assert.deepEqual(
    model.pages.map((p) => [p.name, p.displayName, p.order, p.kind, p.hidden, p.width, p.height]),
    [
      ['overview', 'Overview', 0, 'page', false, 1280, 720],
      ['details', 'Details', 1, 'drillthrough', false, 1280, 720],
      ['tip', 'Revenue tooltip', 2, 'tooltip', true, 320, 240],
    ],
  )
  const [overview] = model.pages
  assert.deepEqual(overview.filters.map((f) => [f.field, f.text]), [["'Region'[Country]", `'Region'[Country] not in ("Test")`]])
  assert.deepEqual(
    overview.visuals.map((v) => v.name),
    ['shape', 'header', 'title', 'slicer', 'logo', 'kpi', 'combo', 'card', 'bullet', 'secret', 'button'],
  )
  const visual = Object.fromEntries(overview.visuals.map((v) => [v.name, v]))

  assert.equal(visual.kpi.title, 'Revenue vs goal')
  assert.deepEqual([visual.kpi.x, visual.kpi.y, visual.kpi.width, visual.kpi.height], [40, 100, 300, 160])
  assert.deepEqual(visual.kpi.fields.map((f) => [f.role, f.kind, f.table, f.text]), [
    ['Indicator', 'measure', 'Sales', '[Revenue]'],
    ['Goal', 'measure', 'Sales', '[Revenue Goal]'],
    ['TrendLine', 'hierarchyLevel', 'Date', "'Date'[Date] (Year)"],
  ])
  assert.equal(visual.kpi.fields[2].level, 'Year')

  assert.equal(visual.combo.title, 'Revenue and margin')
  assert.deepEqual(visual.combo.fields.map((f) => [f.role, f.text]), [
    ['Category', "'Date'[Calendar].[Year]"], ['Category', "'Date'[Calendar].[Month]"], ['Y', '[Revenue]'], ['Y2', '[Margin %]'],
  ])
  assert.deepEqual(visual.combo.sort, [{ field: '[Revenue]', direction: 'descending' }])
  assert.deepEqual(visual.combo.filters.map((f) => [f.type, f.text]), [['TopN', "'Product'[Name] is in the top 5 by [Revenue]"]])
  assert.equal(fieldList(visual.combo)[0], "Category: 'Date'[Calendar].[Year] › 'Date'[Calendar].[Month] (drill-down, showing 'Date'[Calendar].[Year])")

  assert.deepEqual(visual.card.fields.map((f) => [f.kind, f.aggregation, f.table, f.column, f.text]), [['aggregation', 'Sum', 'Sales', 'Amount', "SUM('Sales'[Amount])"]])
  assert.equal(visual.card.filters[0].text, "'Sales'[Amount] between 10 and 100 and 'Sales'[Quantity] >= 2")
  assert.ok(visual.card.filters[0].raw.Where, 'the raw filter query is kept')

  assert.deepEqual(visual.slicer.slicer, { mode: 'Dropdown', selection: `'Region'[Country] in ("Canada", "Mexico")` })
  assert.equal(visual.title.text, 'Financial overview\nFY2024')
  assert.equal(visual.title.groupName, 'Header')
  assert.equal(visual.header.type, 'group')
  assert.deepEqual(visual.button.action, { type: 'PageNavigation', target: 'details', targetName: 'Details' })
  assert.equal(visual.shape.decorative, true)
  assert.equal(visual.logo.decorative, true)
  assert.deepEqual(visual.logo.images, ['logo.png'])
  assert.equal(visual.bullet.customVisual, 'Bullet Chart by OKViz')
  assert.equal(visual.secret.hidden, true)
  assert.equal(visual.kpi.hidden, undefined)
  assert.deepEqual(visualCounts(overview), { visuals: 8, decorative: 2 })

  assert.deepEqual(model.filters.map((f) => [f.type, f.text, f.locked]), [
    ['RelativeDate', "'Date'[Date] is in the last 3 months", false],
    ['Categorical', `'Product'[Category] in ("Bikes", "Accessories")`, true],
  ])
  assert.deepEqual(model.bookmarks, [{ name: 'bm1', displayName: 'Show margin', page: 'overview', hiddenVisuals: ['kpi'], pageName: 'Overview' }])
  assert.deepEqual(model.theme, {
    base: 'CY24SU10',
    custom: { name: 'Contoso', dataColors: ['#0F6CBD', '#C239B3'], background: '#FAFAFA', foreground: '#1B1B1B', tableAccent: '#0F6CBD' },
    baseColors: { dataColors: ['#118DFF', '#12239E'], background: '#FFFFFF', foreground: '#252423', tableAccent: '#118DFF' },
  })
  assert.deepEqual(model.customVisuals, [{ id: 'BulletChart1443347686880', name: 'Bullet Chart by OKViz', visuals: 1 }])
  assert.deepEqual(model.resources, [{ name: 'logo.png', path: 'StaticResources/RegisteredResources/logo.png' }])
}

test('a PBIR-Legacy report normalizes with aliases resolved, kinds, filters and order', () => {
  checkReport(normalizeDefinition(legacyReport()), 'PBIRLegacy')
})

test('the same report stored as PBIR normalizes to the same model', () => {
  const pbir = normalizeDefinition(pbirReport())
  checkReport(pbir, 'PBIR')
  const legacy = normalizeDefinition(legacyReport())
  const strip = (model) => model.pages.map((p) => p.visuals.map(({ name, type, title, fields, sort, filters }) => (
    { name, type, title, fields, sort, filters: filters?.map(({ text }) => text) })))
  assert.deepEqual(strip(pbir), strip(legacy))
})

test('literals read as DAX-like values', () => {
  assert.equal(literalText("'O''Brien'"), '"O\'Brien"')
  assert.equal(literalText("'say \"hi\"'"), '"say ""hi"""')
  assert.equal(literalText('123L'), '123')
  assert.equal(literalText('1.5D'), '1.5')
  assert.equal(literalText('2.50M'), '2.50')
  assert.equal(literalText("datetime'2024-01-01T00:00:00'"), '2024-01-01')
  assert.equal(literalText("datetime'2024-03-05T13:45:00.000'"), '2024-03-05 13:45:00')
  assert.equal(literalText('true'), 'TRUE')
  assert.equal(literalText('null'), 'BLANK')
})

test('expressions read as DAX-like text and unknown kinds fall back to JSON', () => {
  const s = alias('s')
  assert.equal(exprText(column('Sales', 'Amount')(s), { s: 'Sales' }), "'Sales'[Amount]")
  assert.equal(exprText({ Aggregation: { Expression: column('Sales', 'Amount')(s), Function: 2 } }, { s: 'Sales' }), "DISTINCTCOUNT('Sales'[Amount])")
  assert.equal(exprText({ Aggregation: { Expression: column('Sales', 'Amount')(s), Function: 1 } }, [{ Name: 's', Entity: 'Sales' }]), "AVERAGE('Sales'[Amount])")
  assert.equal(exprText(level('Date', 'Calendar', 'Quarter')(entity)), "'Date'[Calendar].[Quarter]")
  assert.equal(exprText(dateLevel('Orders', 'Order Date', 'Month')(entity)), "'Orders'[Order Date] (Month)")
  assert.equal(exprText({ Mystery: { a: 1 } }), '{"Mystery":{"a":1}}')
  assert.equal(exprText(undefined), '?')
})

test('conditions read as filter-pane text', () => {
  const p = { p: 'Product' }
  const color = column('Product', 'Color')(alias('p'))
  const size = column('Product', 'Size')(alias('p'))
  assert.equal(
    conditionText({ In: { Expressions: [color, size], Values: [[lit("'Red'"), lit("'L'")], [lit("'Blue'"), lit("'M'")]] } }, p),
    `('Product'[Color], 'Product'[Size]) in (("Red", "L"), ("Blue", "M"))`,
  )
  assert.equal(conditionText({ Comparison: { ComparisonKind: 3, Left: size, Right: lit('5D') } }, p), "'Product'[Size] < 5")
  assert.equal(conditionText({ Comparison: { ComparisonKind: 0, Left: color, Right: lit('null') } }, p), "'Product'[Color] is blank")
  assert.equal(conditionText({ Not: { Expression: { Comparison: { ComparisonKind: 0, Left: color, Right: lit('null') } } } }, p), "'Product'[Color] is not blank")
  assert.equal(conditionText({ Not: { Expression: { Contains: { Left: color, Right: lit("'ed'") } } } }, p), `'Product'[Color] does not contain "ed"`)
  assert.equal(conditionText({ StartsWith: { Left: color, Right: lit("'B'") } }, p), `'Product'[Color] starts with "B"`)
  const red = { Comparison: { ComparisonKind: 0, Left: color, Right: lit("'Red'") } }
  const blue = { Comparison: { ComparisonKind: 0, Left: color, Right: lit("'Blue'") } }
  const large = { Comparison: { ComparisonKind: 1, Left: size, Right: lit('10L') } }
  assert.equal(conditionText({ And: { Left: { Or: { Left: red, Right: blue } }, Right: large } }, p),
    `('Product'[Color] = "Red" or 'Product'[Color] = "Blue") and 'Product'[Size] > 10`)
  assert.equal(conditionText({ Condition: lastMonths(3) }, { d: 'Date' }), "'Date'[Date] is in the last 3 months")
  const now = { Now: {} }
  const span = (expr, unit) => ({ DateSpan: { Expression: expr, TimeUnit: unit } })
  const add = (expr, amount, unit) => ({ DateAdd: { Expression: expr, Amount: amount, TimeUnit: unit } })
  const date = column('Date', 'Date')(alias('d'))
  assert.equal(conditionText({ Between: { Expression: date, LowerBound: span(add(now, -3, 2), 2), UpperBound: span(add(now, -1, 2), 2) } }, { d: 'Date' }),
    "'Date'[Date] is in the last 3 calendar months")
  assert.equal(conditionText({ Comparison: { ComparisonKind: 0, Left: date, Right: span(now, 3) } }, { d: 'Date' }), "'Date'[Date] is in this year")
  assert.equal(conditionText({ Between: { Expression: date, LowerBound: span(now, 0), UpperBound: span(add(add(now, 2, 1), -1, 0), 0) } }, { d: 'Date' }),
    "'Date'[Date] is in the next 2 weeks")
  assert.equal(conditionText({ Between: { Expression: date, LowerBound: add(now, -15, 6), UpperBound: now } }, { d: 'Date' }), "'Date'[Date] is in the last 15 minutes")
  assert.equal(conditionText({ Between: { Expression: date, LowerBound: lit("datetime'2024-01-01T00:00:00'"), UpperBound: lit("datetime'2024-06-30T00:00:00'") } }, { d: 'Date' }),
    "'Date'[Date] between 2024-01-01 and 2024-06-30")
  assert.equal(conditionText({ Mystery: 1 }), '{"Mystery":1}')
  assert.equal(conditionText(null), 'null')
})

test('reading order goes row by row, with an 8px row tolerance', () => {
  const order = readingOrder([
    { name: 'c', x: 10, y: 300 }, { name: 'b', x: 600, y: 4 }, { name: 'a', x: 20, y: 10 }, { name: 'd', x: 300, y: 296 }, { name: 'e', x: 0, y: 320 },
  ])
  assert.deepEqual(order.map((v) => v.name), ['a', 'b', 'c', 'd', 'e'])
})

test('garbage definitions produce warnings, never exceptions', () => {
  const broken = [
    null,
    'not parts',
    [{}],
    [part('report.json', 'not json')],
    [part('report.json', {
      config: '{bad',
      filters: 'nope',
      sections: [{
        name: 's', config: '{bad', filters: '[7]',
        visualContainers: [
          { config: 'nope' },
          5,
          { config: JSON.stringify({ name: 'v', singleVisual: { visualType: 'card', projections: { Values: [{ queryRef: 'missing' }], Bad: 3 }, prototypeQuery: { From: 'x', Select: 7 } } }) },
        ],
      }, 'oops'],
    })],
    [part('definition/report.json', { filterConfig: { filters: [7] }, themeCollection: { customTheme: { name: 'Gone.json' } } }), part('definition/pages/p/page.json', 'oops')],
    [part('somethingElse.json', {})],
  ]
  for (const parts of broken) {
    const model = normalizeDefinition(parts)
    assert.ok(Array.isArray(model.pages), JSON.stringify(parts)?.slice(0, 80))
    assert.ok(model.warnings.length > 0, `no warning for ${JSON.stringify(parts)?.slice(0, 80)}`)
    assert.equal(typeof readmeMarkdown({ report: model, pages: [] }), 'string')
  }
  const legacy = normalizeDefinition(broken[4])
  assert.equal(legacy.pages.length, 1)
  assert.deepEqual(legacy.pages[0].visuals.map((v) => v.type).sort(), ['card', 'unknown'])
  assert.equal(typeof readmeMarkdown(null), 'string')
  assert.equal(typeof readmeMarkdown({ report: { pages: [{ visuals: [null, 5, { fields: 'x' }] }] }, pages: 'x' }), 'string')
  assert.equal(typeof modelMarkdown(null, null), 'string')
})

const SOURCE = {
  reportName: 'Contoso Sales',
  reportUrl: 'https://app.powerbi.com/groups/ws/reports/r',
  workspaceName: 'Sales',
  personal: false,
  modelName: 'Contoso',
  modelWorkspaceName: 'Data',
  alias: 'contoso',
  connectorCommand: 'npx rayfin connector add fabric-semanticmodel contoso --workspace ws --item ds',
}
const README_PAGES = [
  { name: 'overview', displayName: 'Overview', order: 0, stem: '01-overview', kind: 'page', hidden: false },
  { name: 'details', displayName: 'Details', order: 1, stem: '02-details', kind: 'drillthrough', hidden: false },
  { name: 'tip', displayName: 'Revenue tooltip', order: 2, stem: '03-revenue-tooltip', kind: 'tooltip', hidden: true },
]

test('the README lists the source, files, pages and visuals in reading order', () => {
  const readme = readmeMarkdown({ source: SOURCE, pages: README_PAGES, images: true, report: normalizeDefinition(legacyReport()) })
  assert.match(readme, /^# Migrating “Contoso Sales” from Power BI$/m)
  assert.ok(readme.includes('`npx rayfin connector add fabric-semanticmodel contoso --workspace ws --item ds`'))
  assert.ok(readme.includes('- Semantic model: Contoso (workspace: Data)'))
  assert.ok(readme.includes('- Format: PBIR-Legacy'))
  for (const stem of ['01-overview', '02-details', '03-revenue-tooltip']) {
    assert.ok(readme.includes(`\`pages/${stem}.png\``) && readme.includes(`\`pages/${stem}.txt\``), stem)
  }
  assert.ok(readme.includes('### 1. Overview') && readme.includes('### 3. Revenue tooltip'))
  assert.ok(readme.includes('- Tooltip page · hidden · 320×240 · 1 visual · name `tip`'))
  assert.ok(readme.includes('- Page filters: \'Region\'[Country] not in ("Test")'))
  const kpi = "- kpi “Revenue vs goal” at 40,100 300×160 — Indicator: [Revenue]; Goal: [Revenue Goal]; TrendLine: 'Date'[Date] (Year)"
  assert.ok(readme.includes(kpi))
  assert.ok(readme.indexOf(kpi) < readme.indexOf('- lineClusteredColumnComboChart “Revenue and margin”'))
  assert.ok(readme.includes("filters: 'Product'[Name] is in the top 5 by [Revenue]; sort: [Revenue] descending"))
  assert.ok(readme.includes('- textbox at 40,6 600×60 — text: “Financial overview FY2024”; in group “Header”'))
  assert.ok(readme.includes('- Bullet Chart by OKViz (custom visual) at 360,420'))
  assert.ok(readme.includes('action: PageNavigation → Details'))
  assert.ok(readme.includes(`selected: 'Region'[Country] in ("Canada", "Mexico")`))
  assert.ok(readme.includes('- Not listed: 2 decorative shapes and images'))
  assert.ok(!readme.includes('- shape at') && !readme.includes('- group'))
  assert.ok(readme.includes("## Report filters") && readme.includes("- 'Date'[Date] is in the last 3 months"))
  assert.ok(readme.includes('## Bookmarks') && readme.includes('- “Show margin” → page “Overview”, hides 1 visual'))
})

test('the README still guides Copilot without a definition or page images', () => {
  const readme = readmeMarkdown({ source: { ...SOURCE, personal: true }, pages: README_PAGES, images: false, report: null })
  assert.ok(readme.includes('- Workspace: My workspace'))
  assert.ok(readme.includes('`report.json`: not available'))
  assert.ok(readme.includes('- Image and text: not available'))
  assert.ok(readme.includes('### 2. Details') && readme.includes('- Drillthrough page'))
  assert.ok(readme.includes(SOURCE.connectorCommand))
})

test('model.md lists tables, columns, measures with DAX and relationships', () => {
  const md = modelMarkdown({
    tables: [{ name: 'Sales' }, { name: 'LocalDateTable_0f1c2d3e-0000-4000-8000-000000000001', isHidden: true }, { name: 'Date' }],
    columns: [
      { table: 'Sales', name: 'Amount', dataType: 'decimal', formatString: '#,0.00' },
      { table: 'Sales', name: 'Margin', dataType: 'double', expression: 'VAR x = 1\nRETURN x' },
      { table: 'Date', name: 'DateKey', dataType: 'int64', isKey: true, isHidden: true },
    ],
    measures: [{ table: 'Sales', name: 'Revenue', expression: 'SUM ( Sales[Amount] )', formatString: '$#,0', displayFolder: 'KPIs' }],
    relationships: [
      { fromTable: 'Sales', fromColumn: 'DateKey', toTable: 'Date', toColumn: 'DateKey', fromCardinality: 'many', toCardinality: 'one', isActive: true, crossFilter: 'oneDirection' },
      { fromTable: 'Sales', fromColumn: 'ShipKey', toTable: 'Date', toColumn: 'DateKey', isActive: false, crossFilter: 'bothDirections' },
    ],
  }, { name: 'Contoso', source: 'definition' })
  assert.ok(md.startsWith('# Semantic model “Contoso”\n'))
  assert.ok(md.includes('2 tables · 3 columns · 1 measure · 2 relationships (1 auto date/time table left out)'))
  assert.ok(md.includes('- `Amount` — decimal · format `#,0.00`'))
  assert.ok(md.includes('- `Margin` — double · calculated:\n  ```dax\n  VAR x = 1\n  RETURN x\n  ```'))
  assert.ok(md.includes('- `[Revenue]` — format `$#,0` · folder KPIs\n  ```dax\n  SUM ( Sales[Amount] )\n  ```'))
  assert.ok(md.includes("- 'Sales'[DateKey] → 'Date'[DateKey] (many to one, filters one way)"))
  assert.ok(md.includes("- 'Sales'[ShipKey] → 'Date'[DateKey] (many to one, filters both ways, inactive)"))
  assert.ok(!md.includes('LocalDateTable'))
})

test('INFO.VIEW rows become the TMSL shape, and model.md says measure DAX is masked', () => {
  const schema = infoViewSchema({
    tables: [{ '[Name]': 'Sales', '[IsHidden]': false }],
    columns: [
      { '[Table]': 'Sales', '[Name]': 'Amount', '[DataType]': 'Decimal', '[IsHidden]': 'False' },
      { '[Table]': 'Sales', '[Name]': 'RowNumber-2662979B', '[Type]': 'RowNumber' },
    ],
    measures: [{ '[Table]': 'Sales', '[Name]': 'Revenue', '[Expression]': null, '[FormatString]': '$#,0' }],
    relationships: [{
      '[FromTable]': 'Sales', '[FromColumn]': 'DateKey', '[ToTable]': 'Date', '[ToColumn]': 'DateKey',
      '[FromCardinality]': 'Many', '[ToCardinality]': 'One', '[IsActive]': true, '[CrossFilteringBehavior]': 'BothDirections',
    }],
  })
  assert.deepEqual(schema.columns.map((c) => [c.table, c.name, c.dataType, c.isHidden]), [['Sales', 'Amount', 'Decimal', false]])
  assert.deepEqual(schema.measures.map((m) => [m.name, m.expression, m.formatString]), [['Revenue', null, '$#,0']])
  assert.deepEqual(schema.relationships[0], {
    name: null, fromTable: 'Sales', fromColumn: 'DateKey', toTable: 'Date', toColumn: 'DateKey',
    fromCardinality: 'many', toCardinality: 'one', isActive: true, crossFilter: 'bothDirections',
  })
  const md = modelMarkdown(schema, { source: 'queries' })
  assert.ok(md.includes('measure DAX is not available here'))
  assert.ok(md.includes('- `[Revenue]` — format `$#,0`') && !md.includes('(no expression)'))
})

test('auto date/time conditions name the date column, not its hidden date table', () => {
  const local = 'LocalDateTable_0f1c2d3e-0000-4000-8000-000000000001'
  const year = { Column: { Expression: { SourceRef: { Source: 'l' } }, Property: 'Year' } }
  const definition = { Version: 2, From: [{ Name: 'l', Entity: local, Type: 0 }], Where: [{ Condition: { In: { Expressions: [year], Values: [[lit('2018L')]] } } }] }
  assert.equal(filterText(definition, [fieldInfo(dateLevel('Date', 'Date', 'Year')(entity))]), "'Date'[Date] (Year) in (2018)")
  assert.equal(filterText(definition), `'${local}'[Year] in (2018)`)
})

test('packaged custom visuals that no page uses are listed but not counted', () => {
  const unused = part('CustomVisuals/PBI_CV_UNUSED/resources/PBI_CV_UNUSED.pbiviz.json', { visual: { guid: 'PBI_CV_UNUSED', displayName: 'Unused Gauge' } })
  const model = normalizeDefinition([...pbirReport(), unused])
  assert.deepEqual(model.customVisuals.map((c) => [c.name, c.visuals]), [['Bullet Chart by OKViz', 1], ['Unused Gauge', 0]])
  assert.ok(!readmeMarkdown({ source: SOURCE, pages: README_PAGES, images: true, report: model }).includes('Unused Gauge'))
})
