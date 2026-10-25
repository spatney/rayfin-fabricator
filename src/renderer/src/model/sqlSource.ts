/**
 * The tables behind a Rayfin SQL connector (a SQL database, warehouse or
 * lakehouse SQL endpoint), for the Blueprint tab's Fabric data view. Read from
 * the project's files, so no sign-in or query is needed:
 *
 *  - `rayfin/connectors/<name>/metadata.json`, which `rayfin connector add`
 *    writes when it discovers the source: every table, its columns and SQL
 *    types, primary keys and foreign keys (older CLIs wrote it to
 *    `rayfin/.temp/sources/<name>/`);
 *  - the entity files generated from it in the same folder, one `@entity`
 *    class per table the app uses, declared `extends Source({ schema, table })`.
 *
 * When metadata.json is missing, the entity files alone describe the tables the
 * app uses, and relationships come only from their `@one` decorators. Keys and
 * relationships are never guessed from column names.
 */
import type { SemanticRelationship } from '@shared/ipc'
import { sqlSourceKey, type ConnectorConfig } from './architecture'
import {
  parseEntityClasses,
  splitTopLevel,
  unquote,
  type DeclaredEntity,
  type FieldType,
  type ModelField
} from './parseSchema'
import type { DiagramColumn, SemanticModel, SemanticModelTable, SqlColumnDetail } from './semanticModel'

export interface SqlSourceModel {
  /** {@link sqlSourceKey}. */
  key: string
  connector: ConnectorConfig
  /** Where the tables come from: Rayfin's discovered schema, the app's entity files alone, or nowhere yet. */
  origin: 'metadata' | 'entities' | 'none'
  /** The metadata.json the tables come from. */
  metadataFile?: string
  /** When Rayfin discovered the tables (ISO 8601). */
  discoveredAt?: string
  /** Tables by name, each card's `sql` details set. */
  tables: SemanticModelTable[]
  /** Foreign keys: from the table holding the key (many) to the table it points to (one). */
  relationships: SemanticRelationship[]
  /** Things worth knowing, such as an entity file whose table wasn't discovered. */
  warnings: string[]
}

export interface SqlSourceFiles {
  connector: ConnectorConfig
  /** The metadata.json found for the connector: its text, or `null` when it couldn't be read. */
  metadata?: { path: string; text: string | null; problem?: string }
  /** The TypeScript files in the connector's folder. */
  files: { path: string; text: string }[]
  /** Problems met while reading the files. */
  warnings?: string[]
}

/** The folder Rayfin keeps a connector's files in. */
export const connectorDir = (connectorName: string): string => `rayfin/connectors/${connectorName}`

/** Where a connector's metadata.json may be, current location first. */
export const metadataPaths = (connectorName: string): string[] => [
  `${connectorDir(connectorName)}/metadata.json`,
  `rayfin/.temp/sources/${connectorName}/metadata.json`
]

type Obj = Record<string, unknown>

const asObj = (v: unknown): Obj | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const lower = (s: string): string => s.toLowerCase()

interface MetaTable {
  schema: string
  name: string
  columns: Obj[]
  primaryKey: string[]
  foreignKeys: Obj[]
}

/** Read metadata.json; `null` when it isn't the shape Rayfin writes. */
function parseMetadata(text: string): { discoveredAt?: string; tables: MetaTable[] } | null {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return null
  }
  const root = asObj(doc)
  if (!root || !Array.isArray(root.schemas)) return null
  const tables: MetaTable[] = []
  for (const s of root.schemas) {
    const schema = asObj(s)
    for (const t of list(schema?.tables)) {
      const table = asObj(t)
      const name = str(table?.tableName)
      if (!table || !name) continue
      tables.push({
        schema: str(schema?.schemaName) ?? '',
        name,
        columns: list(table.columns).flatMap((c) => {
          const col = asObj(c)
          return col && str(col.columnName) ? [col] : []
        }),
        primaryKey: list(table.primaryKeyColumns).flatMap((p) => {
          const n = str(p)
          return n ? [n] : []
        }),
        foreignKeys: list(table.foreignKeys).flatMap((f) => {
          const fk = asObj(f)
          return fk && str(fk.columnName) && str(fk.referencedTableName) ? [fk] : []
        })
      })
    }
  }
  return { discoveredAt: str(root.discoveredAt), tables }
}

/** `nvarchar(30)`, `varbinary(max)`, `decimal(8,2)`; other types as written. */
function typeLabel(dataType: string, col: Obj): string {
  const t = lower(dataType)
  const max = num(col.maxLength)
  if (/^(n?(var)?char|(var)?binary)$/.test(t) && max !== undefined) return `${t}(${max < 0 ? 'max' : max})`
  const precision = num(col.precision)
  if ((t === 'decimal' || t === 'numeric') && precision !== undefined) return `${t}(${precision},${num(col.scale) ?? 0})`
  return t || '—'
}

function sqlFamily(dataType: string): SqlColumnDetail['family'] {
  const t = lower(dataType)
  if (t === 'bit') return 'bool'
  if (/int$|^(decimal|numeric|money|smallmoney|float|real)$/.test(t)) return 'num'
  if (/binary|image|rowversion|timestamp/.test(t)) return 'blob'
  if (/date|time/.test(t)) return 'date'
  if (/char|text|xml|json/.test(t)) return 'text'
  return 'unknown'
}

const FIELD_FAMILY: Partial<Record<FieldType, SqlColumnDetail['family']>> = {
  int: 'num',
  decimal: 'num',
  text: 'text',
  email: 'text',
  uuid: 'text',
  enum: 'text',
  date: 'date',
  boolean: 'bool',
  blob: 'blob'
}

/** How the database fills a column in, from Rayfin's server-generation markers. */
function generatedBy(col: Obj): string | undefined {
  if (col.identity) return 'identity'
  if (col.computed) return 'computed'
  if (typeof col.serverManaged === 'string' && col.serverManaged) return col.serverManaged
  if (col.serverManaged) return 'server-managed'
  if (col.default !== undefined && col.default !== null) return 'default'
  return undefined
}

/** `product_category` → `ProductCategory`, as Rayfin names a table's entity class. */
function pascalCase(name: string): string {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('')
}

const stringOption = (args: string, key: string): string | undefined =>
  new RegExp(`\\b${key}\\s*:\\s*(['"\`])([^'"\`]*)\\1`).exec(args)?.[2]

function listOption(args: string, key: string): string[] {
  const m = new RegExp(`\\b${key}\\s*:\\s*\\[([^\\]]*)\\]`).exec(args)
  return m ? splitTopLevel(m[1]).map(unquote).filter(Boolean) : []
}

/** The SQL column a field reads: its decorator's `column:` option, or the field's name. */
function columnOf(field: ModelField): string {
  const deco = field.decorators?.find((d) => d.name === field.decorator)
  return (deco && stringOption(deco.args, 'column')) || field.name
}

/** A connector entity and the table its `Source({ … })` names. */
interface EntityInfo {
  entity: DeclaredEntity
  schema?: string
  table?: string
  /** `primaryKey` property names. */
  primaryKey: string[]
  /** Lowercase SQL column name → field. */
  columns: Map<string, ModelField>
  grants: string[]
}

function entityInfo(entity: DeclaredEntity): EntityInfo {
  const source = /\bSource\s*\(/.test(entity.heritage) ? entity.heritage : ''
  const columns = new Map<string, ModelField>()
  for (const f of entity.fields) if (f.type !== 'relation') columns.set(lower(columnOf(f)), f)
  return {
    entity,
    schema: source ? stringOption(source, 'schema') : undefined,
    table: source ? stringOption(source, 'table') : undefined,
    primaryKey: source ? listOption(source, 'primaryKey') : [],
    columns,
    grants: entity.permissions.map(
      (p) => `${p.role}: ${p.actions.join(', ')}${p.hasPolicy ? ' (row policy)' : ''}`
    )
  }
}

function tableDetail(schema: string, info: EntityInfo | undefined): SemanticModelTable['sql'] {
  return {
    schema,
    entity: info && {
      name: info.entity.customName || info.entity.name,
      file: info.entity.file,
      grants: info.grants
    }
  }
}

/** A card id per table: its name, or `schema.name` when the source has several schemas. */
function tableIds(tables: { schema: string; name: string }[]): (schema: string, name: string) => string {
  const several = new Set(tables.map((t) => lower(t.schema))).size > 1
  return (schema, name) => (several && schema ? `${schema}.${name}` : name)
}

const byName = (a: SemanticModelTable, b: SemanticModelTable): number => a.name.localeCompare(b.name)

/** Key columns first; otherwise the order the database lists them. */
const keysFirst = (columns: DiagramColumn[]): DiagramColumn[] => [
  ...columns.filter((c) => c.isKey),
  ...columns.filter((c) => !c.isKey)
]

function fromMetadata(
  meta: { discoveredAt?: string; tables: MetaTable[] },
  entities: EntityInfo[],
  warnings: string[]
): Pick<SqlSourceModel, 'tables' | 'relationships'> {
  const idOf = tableIds(meta.tables)
  const key = (schema: string, name: string): string => `${lower(schema)}.${lower(name)}`
  const ids = new Map(meta.tables.map((t) => [key(t.schema, t.name), idOf(t.schema, t.name)]))

  // Each entity to its table: by `Source({ schema, table })`, then by class name.
  const entityOf = new Map<string, EntityInfo>()
  for (const info of entities) {
    let match: MetaTable | undefined
    if (info.table) {
      const named = meta.tables.filter((t) => lower(t.name) === lower(info.table!))
      match = info.schema ? named.find((t) => lower(t.schema) === lower(info.schema!)) : (named.find((t) => lower(t.schema) === 'dbo') ?? named[0])
    } else {
      const names = [info.entity.name, info.entity.customName].filter(Boolean)
      match = meta.tables.find((t) => names.includes(pascalCase(t.name)))
    }
    if (!match) {
      const where = info.table ? `the table ${info.schema ? `${info.schema}.` : ''}${info.table}` : 'a table'
      warnings.push(`${info.entity.file.split('/').pop()} reads ${where}, which isn’t in the discovered tables.`)
      continue
    }
    const k = key(match.schema, match.name)
    if (!entityOf.has(k)) entityOf.set(k, info)
  }

  const tables: SemanticModelTable[] = []
  const relationships: SemanticRelationship[] = []
  for (const t of meta.tables) {
    const id = idOf(t.schema, t.name)
    const info = entityOf.get(key(t.schema, t.name))
    const primary = new Set(t.primaryKey.map(lower))
    const refs = new Map<string, string>()
    for (const fk of t.foreignKeys) {
      const to = ids.get(key(str(fk.referencedTableSchema) ?? t.schema, str(fk.referencedTableName)!))
      const column = str(fk.referencedColumnName)
      if (to && !refs.has(lower(str(fk.columnName)!))) refs.set(lower(str(fk.columnName)!), column ? `${to}.${column}` : to)
    }
    const columns = t.columns.map((col): DiagramColumn => {
      const name = str(col.columnName)!
      const dataType = str(col.dataType) ?? ''
      return {
        table: id,
        name,
        dataType,
        isHidden: false,
        isKey: primary.has(lower(name)),
        sql: {
          typeLabel: typeLabel(dataType, col),
          family: sqlFamily(dataType),
          nullable: col.isNullable === true,
          references: refs.get(lower(name)),
          generated: generatedBy(col),
          mapped: !info || info.columns.has(lower(name))
        }
      }
    })
    tables.push({ name: id, isHidden: false, columns: keysFirst(columns), measures: [], sql: tableDetail(t.schema, info) })

    // One relationship per constraint; a composite key's first column anchors the line.
    const constraints = new Map<string, Obj[]>()
    for (const fk of t.foreignKeys) {
      const name = str(fk.constraintName) ?? `${str(fk.columnName)}→${str(fk.referencedTableName)}`
      constraints.set(name, [...(constraints.get(name) ?? []), fk])
    }
    for (const [name, rows] of constraints) {
      const first = rows[0]
      const to = ids.get(key(str(first.referencedTableSchema) ?? t.schema, str(first.referencedTableName)!))
      if (!to) continue
      // A key that is also the whole primary key makes a one-to-one.
      const fromColumns = rows.map((r) => lower(str(r.columnName)!))
      const oneToOne = primary.size > 0 && fromColumns.length === primary.size && fromColumns.every((c) => primary.has(c))
      relationships.push({
        name,
        fromTable: id,
        fromColumn: str(first.columnName),
        fromCardinality: oneToOne ? 'One' : 'Many',
        toTable: to,
        toColumn: str(first.referencedColumnName),
        toCardinality: 'One',
        isActive: true
      })
    }
  }
  return { tables: tables.sort(byName), relationships }
}

function fromEntities(entities: EntityInfo[]): Pick<SqlSourceModel, 'tables' | 'relationships'> {
  const located = entities.map((info) => ({ info, schema: info.schema ?? '', name: info.table ?? info.entity.name }))
  const idOf = tableIds(located)
  const byClass = new Map(located.map((l) => [l.info.entity.name, l]))
  const tables: SemanticModelTable[] = []
  const relationships: SemanticRelationship[] = []
  const seen = new Set<string>()
  for (const { info, schema, name } of located) {
    const id = idOf(schema, name)
    if (seen.has(id)) continue
    seen.add(id)
    const primary = new Set(info.primaryKey)
    const refs = new Map<string, string>()
    for (const f of info.entity.fields) {
      if (f.decorator !== 'one' || !f.relationTo) continue
      const target = byClass.get(f.relationTo)
      if (!target) continue
      const args = f.decorators?.find((d) => d.name === 'one')?.args ?? ''
      const sourceFields = listOption(args, 'sourceFields')
      const targetFields = listOption(args, 'targetFields')
      if (!sourceFields.length) continue
      const columnFor = (owner: EntityInfo, prop: string | undefined): string | undefined => {
        const field = prop ? owner.entity.fields.find((x) => x.name === prop) : undefined
        return field ? columnOf(field) : prop
      }
      const toId = idOf(target.schema, target.name)
      const fromColumn = columnFor(info, sourceFields[0])
      const toColumn = columnFor(target.info, targetFields[0])
      if (fromColumn) refs.set(lower(fromColumn), toColumn ? `${toId}.${toColumn}` : toId)
      relationships.push({
        name: `${info.entity.name}.${f.name}`,
        fromTable: id,
        fromColumn,
        fromCardinality: 'Many',
        toTable: toId,
        toColumn,
        toCardinality: 'One',
        isActive: true
      })
    }
    const columns = info.entity.fields
      .filter((f) => f.type !== 'relation')
      .map((f): DiagramColumn => {
        const column = columnOf(f)
        const type = f.decorator ?? f.tsType ?? ''
        return {
          table: id,
          name: column,
          dataType: type,
          isHidden: false,
          isKey: primary.has(f.name),
          sql: {
            typeLabel: f.max && f.type === 'text' ? `${type}(${f.max})` : type || '—',
            family: FIELD_FAMILY[f.type] ?? 'unknown',
            nullable: f.optional,
            references: refs.get(lower(column)),
            generated: f.tsType?.includes('AutoGenerated<') ? 'auto' : undefined,
            mapped: true
          }
        }
      })
    tables.push({ name: id, isHidden: false, columns: keysFirst(columns), measures: [], sql: tableDetail(schema, info) })
  }
  return { tables: tables.sort(byName), relationships }
}

/** A SQL connector's tables, from its metadata.json and entity files. */
export function buildSqlSource(input: SqlSourceFiles): SqlSourceModel {
  const warnings = [...(input.warnings ?? [])]
  const entities: EntityInfo[] = []
  for (const file of input.files) {
    for (const entity of parseEntityClasses(file.text, file.path)) entities.push(entityInfo(entity))
  }

  const base = { key: sqlSourceKey(input.connector.name), connector: input.connector, warnings }
  const metadata = input.metadata
  const meta = metadata?.text != null ? parseMetadata(metadata.text) : null
  if (metadata && !meta) {
    const name = metadata.path.split('/').pop()
    warnings.push(
      metadata.problem ??
        (metadata.text == null ? `Couldn’t read ${name}.` : `${name} isn’t in the shape Rayfin writes, so it was skipped.`)
    )
  }
  if (meta && metadata) {
    return {
      ...base,
      origin: 'metadata',
      metadataFile: metadata.path,
      discoveredAt: meta.discoveredAt,
      ...fromMetadata(meta, entities, warnings)
    }
  }
  if (entities.length) return { ...base, origin: 'entities', ...fromEntities(entities) }
  return { ...base, origin: 'none', tables: [], relationships: [] }
}

/** How many of the source's tables the app has an entity for. */
export const usedTableCount = (source: SqlSourceModel): number => source.tables.filter((t) => t.sql?.entity).length

/** The diagram for a source: every table, or only the ones the app uses. */
export function sqlDiagram(source: SqlSourceModel, usedOnly: boolean): SemanticModel {
  const tables = usedOnly ? source.tables.filter((t) => t.sql?.entity) : source.tables
  const shown = new Set(tables.map((t) => t.name))
  return {
    tables,
    relationships: source.relationships.filter((r) => shown.has(r.fromTable ?? '') && shown.has(r.toTable ?? '')),
    hasModel: tables.length > 0,
    notes: []
  }
}
