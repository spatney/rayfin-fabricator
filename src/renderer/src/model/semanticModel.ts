/**
 * View-model + edge derivation for the **semantic model** diagram (the Fabric /
 * Power BI model behind a data-app), the live-queried counterpart to the offline
 * Rayfin data model in `parseSchema.ts`.
 *
 * `buildSemanticModel` folds the flat `SemanticSchemaResult` rows (tables,
 * columns, measures, relationships — as returned by the `INFO.VIEW.*` DAX query)
 * into per-table cards, and `deriveSemanticEdges` turns the relationship rows
 * into the generic `DerivedEdges` consumed by `computeEdgeGeometry`, plus a
 * per-edge metadata map (cardinality markers, cross-filter direction, active
 * state) the view needs to render Power-BI-style relationship glyphs.
 */

import type {
  SemanticColumn,
  SemanticMeasure,
  SemanticRelationship,
  SemanticSchemaResult
} from '@shared/ipc'
import type { DerivedEdges, EndMarker, RelEdge, SelfEdge } from './relationships'

/** A semantic-model table card: its columns and measures grouped together. */
export interface SemanticModelTable {
  name: string
  description?: string
  isHidden: boolean
  storageMode?: string
  columns: SemanticColumn[]
  measures: SemanticMeasure[]
}

export interface SemanticModel {
  tables: SemanticModelTable[]
  relationships: SemanticRelationship[]
  /** True when the model has at least one table. */
  hasModel: boolean
  /** Non-fatal notes surfaced from the query (e.g. a sub-query that failed). */
  notes: string[]
}

/** Cross-filter propagation direction for a relationship edge. */
export type CrossFilter = 'single' | 'both' | 'none'

/** Per-edge metadata the geometry engine drops; used to render relationship glyphs. */
export interface SemanticEdgeMeta {
  fromTable: string
  toTable: string
  fromColumn?: string
  toColumn?: string
  fromMarker: EndMarker
  toMarker: EndMarker
  crossFilter: CrossFilter
  active: boolean
}

export interface SemanticEdges {
  derived: DerivedEdges
  /** Keyed by the rendered `EdgeRender.id` (`@self` suffix included for self-edges). */
  meta: Map<string, SemanticEdgeMeta>
}

function cardMarker(cardinality?: string): EndMarker {
  const c = (cardinality ?? '').trim().toLowerCase()
  if (c === 'many') return 'many'
  if (c === 'one') return 'one'
  return 'none'
}

function crossFilterOf(direction?: string): CrossFilter {
  const d = (direction ?? '').trim().toLowerCase()
  if (!d) return 'none'
  if (d.includes('both')) return 'both'
  // 'OneDirection' and 'Automatic' both propagate a single way for a diagram.
  if (d.includes('one') || d.includes('auto') || d.includes('single')) return 'single'
  return 'none'
}

function relLabel(rel: SemanticRelationship): string {
  if (rel.fromColumn && rel.toColumn) return `${rel.fromColumn} → ${rel.toColumn}`
  return rel.name ?? rel.fromColumn ?? rel.toColumn ?? ''
}

/** Columns: keys first, then visible before hidden, then alphabetical by name. */
function sortColumns(a: SemanticColumn, b: SemanticColumn): number {
  if (a.isKey !== b.isKey) return a.isKey ? -1 : 1
  if (a.isHidden !== b.isHidden) return a.isHidden ? 1 : -1
  return (a.name ?? '').localeCompare(b.name ?? '')
}

function sortMeasures(a: SemanticMeasure, b: SemanticMeasure): number {
  return (a.name ?? '').localeCompare(b.name ?? '')
}

/**
 * Fold the flat schema rows into per-table cards. Tables referenced only by a
 * column, measure or relationship are still surfaced (defensive against a
 * partial sub-query result), and every table's columns/measures are sorted for
 * a stable diagram.
 */
export function buildSemanticModel(result: SemanticSchemaResult): SemanticModel {
  const byName = new Map<string, SemanticModelTable>()

  const ensure = (name?: string): SemanticModelTable | null => {
    const key = (name ?? '').trim()
    if (!key) return null
    let t = byName.get(key)
    if (!t) {
      t = { name: key, isHidden: false, columns: [], measures: [] }
      byName.set(key, t)
    }
    return t
  }

  for (const t of result.tables ?? []) {
    const table = ensure(t.name)
    if (!table) continue
    table.isHidden = !!t.isHidden
    table.description = t.description
    table.storageMode = t.storageMode
  }

  for (const c of result.columns ?? []) ensure(c.table)?.columns.push(c)
  for (const m of result.measures ?? []) ensure(m.table)?.measures.push(m)
  for (const r of result.relationships ?? []) {
    ensure(r.fromTable)
    ensure(r.toTable)
  }

  const tables = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  for (const t of tables) {
    t.columns.sort(sortColumns)
    t.measures.sort(sortMeasures)
  }

  return {
    tables,
    relationships: result.relationships ?? [],
    hasModel: tables.length > 0,
    notes: result.notes ?? []
  }
}

/**
 * Turn relationship rows into `DerivedEdges` for {@link computeEdgeGeometry}.
 *
 * Unlike the data model there is no fk/inverse de-duplication to do — semantic
 * relationships are already first-class, directional and carry their own
 * cardinality — so each row becomes exactly one edge. A relationship whose two
 * ends are the same table becomes a self-edge. The parallel `meta` map carries
 * the cardinality markers, cross-filter direction and active flag the geometry
 * `EdgeRender` doesn't retain, keyed by the id the engine will emit.
 */
export function deriveSemanticEdges(relationships: readonly SemanticRelationship[]): SemanticEdges {
  const pairs: RelEdge[] = []
  const selfs: SelfEdge[] = []
  const meta = new Map<string, SemanticEdgeMeta>()

  relationships.forEach((rel, i) => {
    const from = (rel.fromTable ?? '').trim()
    const to = (rel.toTable ?? '').trim()
    if (!from || !to) return

    const fromMarker = cardMarker(rel.fromCardinality)
    const toMarker = cardMarker(rel.toCardinality)
    const entry: SemanticEdgeMeta = {
      fromTable: from,
      toTable: to,
      fromColumn: rel.fromColumn,
      toColumn: rel.toColumn,
      fromMarker,
      toMarker,
      crossFilter: crossFilterOf(rel.crossFilter),
      active: rel.isActive !== false
    }

    if (from === to) {
      const id = `sem-self-${i}`
      selfs.push({
        id,
        entity: from,
        via: rel.fromColumn ?? rel.toColumn ?? '',
        many: fromMarker === 'many' || toMarker === 'many'
      })
      // computeEdgeGeometry renders self-edges with an `@self` suffix.
      meta.set(`${id}@self`, entry)
      return
    }

    const id = `sem-${i}`
    pairs.push({
      id,
      a: from,
      b: to,
      aMarker: fromMarker,
      bMarker: toMarker,
      aVia: rel.fromColumn,
      bVia: rel.toColumn,
      dashed: !entry.active,
      label: relLabel(rel)
    })
    meta.set(id, entry)
  })

  return { derived: { pairs, selfs }, meta }
}
