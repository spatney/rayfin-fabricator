import { describe, expect, it } from 'vitest'
import type { SemanticRelationship, SemanticSchemaResult } from '@shared/ipc'
import { buildSemanticModel, deriveSemanticEdges } from './semanticModel'

function result(partial: Partial<SemanticSchemaResult>): SemanticSchemaResult {
  return {
    ok: true,
    matched: true,
    tables: [],
    columns: [],
    measures: [],
    relationships: [],
    notes: [],
    ...partial
  }
}

const rel = (partial: Partial<SemanticRelationship>): SemanticRelationship => ({
  isActive: true,
  ...partial
})

describe('buildSemanticModel', () => {
  it('groups columns and measures under their table', () => {
    const model = buildSemanticModel(
      result({
        tables: [{ name: 'Sales', isHidden: false }],
        columns: [
          { table: 'Sales', name: 'Amount', dataType: 'Decimal', isHidden: false, isKey: false },
          { table: 'Sales', name: 'Id', dataType: 'Int64', isHidden: false, isKey: true }
        ],
        measures: [
          { table: 'Sales', name: 'Total', expression: 'SUM(Sales[Amount])', isHidden: false }
        ]
      })
    )
    expect(model.hasModel).toBe(true)
    expect(model.tables).toHaveLength(1)
    const sales = model.tables[0]
    // Key column sorts first.
    expect(sales.columns.map((c) => c.name)).toEqual(['Id', 'Amount'])
    expect(sales.measures.map((m) => m.name)).toEqual(['Total'])
  })

  it('surfaces a table referenced only by a relationship', () => {
    const model = buildSemanticModel(
      result({
        tables: [{ name: 'Sales', isHidden: false }],
        relationships: [rel({ fromTable: 'Sales', toTable: 'Date' })]
      })
    )
    expect(model.tables.map((t) => t.name)).toEqual(['Date', 'Sales'])
  })

  it('reports no model when there are no tables', () => {
    const model = buildSemanticModel(result({}))
    expect(model.hasModel).toBe(false)
    expect(model.tables).toEqual([])
  })

  it('carries table metadata and non-fatal notes through', () => {
    const model = buildSemanticModel(
      result({
        tables: [{ name: 'Sales', isHidden: true, storageMode: 'Import', description: 'facts' }],
        notes: ['measures query failed']
      })
    )
    expect(model.tables[0]).toMatchObject({
      isHidden: true,
      storageMode: 'Import',
      description: 'facts'
    })
    expect(model.notes).toEqual(['measures query failed'])
  })
})

describe('deriveSemanticEdges', () => {
  it('builds one directional edge per relationship with cardinality + vias', () => {
    const { derived, meta } = deriveSemanticEdges([
      rel({
        fromTable: 'Sales',
        fromColumn: 'DateKey',
        fromCardinality: 'Many',
        toTable: 'Date',
        toColumn: 'DateKey',
        toCardinality: 'One',
        crossFilter: 'OneDirection'
      })
    ])
    expect(derived.pairs).toHaveLength(1)
    expect(derived.selfs).toHaveLength(0)
    const edge = derived.pairs[0]
    expect(edge).toMatchObject({
      a: 'Sales',
      b: 'Date',
      aMarker: 'many',
      bMarker: 'one',
      aVia: 'DateKey',
      bVia: 'DateKey',
      dashed: false
    })
    expect(meta.get(edge.id)).toMatchObject({
      fromTable: 'Sales',
      toTable: 'Date',
      fromMarker: 'many',
      toMarker: 'one',
      crossFilter: 'single',
      active: true
    })
  })

  it('draws an inactive relationship dashed', () => {
    const { derived } = deriveSemanticEdges([
      rel({ fromTable: 'A', toTable: 'B', isActive: false })
    ])
    expect(derived.pairs[0].dashed).toBe(true)
  })

  it('maps BothDirections cross-filter', () => {
    const { derived, meta } = deriveSemanticEdges([
      rel({ fromTable: 'A', toTable: 'B', crossFilter: 'BothDirections' })
    ])
    expect(meta.get(derived.pairs[0].id)?.crossFilter).toBe('both')
  })

  it('turns a same-table relationship into a self-edge keyed with @self', () => {
    const { derived, meta } = deriveSemanticEdges([
      rel({
        fromTable: 'Employee',
        fromColumn: 'ManagerId',
        toTable: 'Employee',
        toColumn: 'Id',
        fromCardinality: 'Many'
      })
    ])
    expect(derived.pairs).toHaveLength(0)
    expect(derived.selfs).toHaveLength(1)
    const self = derived.selfs[0]
    expect(self).toMatchObject({ entity: 'Employee', via: 'ManagerId', many: true })
    // Geometry renders self-edges with an `@self` suffix — meta must match.
    expect(meta.get(`${self.id}@self`)).toMatchObject({
      fromTable: 'Employee',
      toTable: 'Employee'
    })
  })

  it('skips relationships missing an endpoint table', () => {
    const { derived } = deriveSemanticEdges([
      rel({ fromTable: 'A' }),
      rel({ toTable: 'B' }),
      rel({ fromTable: 'A', toTable: 'B' })
    ])
    expect(derived.pairs).toHaveLength(1)
  })
})
