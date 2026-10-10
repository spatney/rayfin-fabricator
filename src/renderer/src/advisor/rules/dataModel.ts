import { parseClasses, readSchemaList, readSchemaTypeNames, skipBalanced } from '../../model/parseSchema'
import type { ModelField } from '../../model/parseSchema'
import { relativeTo } from '../../model/projectLayout'
import type { QuickContext } from '../context'
import type { QuickHit, QuickRuleImpl } from '../quick'
import { listLabels } from '../quick'
import { firstLine, importsOf, lineOf, matchAll } from '../source'
import { code } from './util'

/** Decorators that give an entity property its stored type. */
const FIELD_DECORATORS = new Set([
  'uuid',
  'text',
  'email',
  'int',
  'decimal',
  'boolean',
  'date',
  'blob',
  'set',
  'one',
  'many'
])
const RELATIONS = new Set(['one', 'many'])
/** A TypeScript file directly in the data model's folder (`rayfin/data/`, or a data package's `src/`). */
const isDataFile = (ctx: QuickContext, path: string): boolean =>
  /^[^/]+\.ts$/.test(relativeTo(path, ctx.layout.dataDir) ?? '')
/** GraphQL type names the generated schema already defines (case-sensitive), per Rayfin 1.36. */
const RESERVED_NAMES = new Set([
  'Any', 'Base64String', 'Boolean', 'Byte', 'ByteArray', 'Date', 'DateTime', 'Decimal', 'Duration',
  'Float', 'ID', 'Int', 'LocalDate', 'LocalDateTime', 'LocalTime', 'Long', 'Mutation', 'Query',
  'Short', 'SignedByte', 'Single', 'String', 'Subscription', 'Time', 'TimeSpan', 'UnsignedByte',
  'UnsignedInt', 'UnsignedLong', 'UnsignedShort', 'URI', 'URL', 'UUID'
])
/** The only options `@one()` / `@many()` accept. */
const RELATION_OPTIONS = new Set(['optional', 'unique'])

/** Top-level keys of the options object in a decorator's argument text. */
function optionKeys(args: string): string[] {
  const open = args.indexOf('{')
  if (open < 0) return []
  const body = args.slice(open + 1, skipBalanced(args, open, '{', '}') - 1)
  const keys: string[] = []
  let depth = 0
  let token = ''
  for (const ch of body) {
    if ('{[('.includes(ch)) depth++
    else if ('}])'.includes(ch)) depth--
    if (depth === 0 && ch === ':') {
      const key = /([A-Za-z_$][\w$]*)\s*$/.exec(token)?.[1]
      if (key) keys.push(key)
      token = ''
    } else if (depth === 0 && ch === ',') {
      token = ''
    } else {
      token += ch
    }
  }
  return keys
}

function isRelation(f: ModelField): boolean {
  return f.decorator === 'one' || f.decorator === 'many'
}

export const dataModelRules: QuickRuleImpl[] = [
  {
    id: 'data-model/text-without-max',
    run: (ctx) => {
      const hits: QuickHit[] = []
      for (const e of ctx.model.entities) {
        for (const f of e.fields) {
          for (const d of f.decorators ?? []) {
            if (d.name !== 'text' && d.name !== 'email') continue
            const hasMax = /\bmax\s*:/.test(d.args) && !/\bmax\s*:\s*-1\b/.test(d.args)
            if (hasMax) continue
            hits.push({
              file: e.file,
              line: d.line || f.line,
              label: `${e.name}.${f.name}`,
              message: `${code(`${e.name}.${f.name}`)} is declared ${code(`@${d.name}(${d.args})`)} without ${code('max')}, so it becomes NVARCHAR(MAX) on MSSQL.`
            })
          }
        }
      }
      return hits
    },
    summarize: (hits) => `${hits.length} text fields have no maximum length: ${listLabels(hits)}.`
  },
  {
    id: 'data-model/fk-typed-text',
    run: (ctx) => {
      const hits: QuickHit[] = []
      for (const e of ctx.model.entities) {
        for (const rel of e.fields.filter((f) => f.decorator === 'one')) {
          const fk = e.fields.find((f) => f.name === `${rel.name}_id`)
          if (!fk || fk.decorator !== 'text') continue
          hits.push({
            file: e.file,
            line: fk.line,
            label: `${e.name}.${fk.name}`,
            message: `${code(`${e.name}.${fk.name}`)} references ${code(rel.relationTo ?? rel.name)} through ${code(`@one`)} but is declared ${code('@text()')} instead of ${code('@uuid()')}.`
          })
        }
      }
      return hits
    }
  },
  {
    id: 'data-model/relation-not-lazy',
    run: (ctx) => {
      const hits: QuickHit[] = []
      for (const e of ctx.model.entities) {
        for (const f of e.fields) {
          for (const d of f.decorators ?? []) {
            if (!RELATIONS.has(d.name)) continue
            const target = d.args.split(',')[0]?.trim() ?? ''
            if (!target || target.includes('=>')) continue
            hits.push({
              file: e.file,
              line: d.line || f.line,
              label: `${e.name}.${f.name}`,
              message: `${code(`${e.name}.${f.name}`)} passes ${code(target)} to ${code(`@${d.name}`)} directly instead of ${code(`() => ${target}`)}.`
            })
          }
        }
      }
      return hits
    }
  },
  {
    id: 'data-model/relation-import-type',
    run: (ctx) => {
      const hits: QuickHit[] = []
      for (const src of ctx.sources((p) => isDataFile(ctx, p))) {
        const targets = new Set(
          matchAll(/@(?:one|many)\s*\(\s*\(\s*\)\s*=>\s*([A-Za-z_$][\w$]*)/, src.masked).map((m) => m[1])
        )
        for (const stmt of importsOf(src.masked)) {
          const line = lineOf(src, stmt.index)
          const typeOnly = stmt.named.filter((n) => targets.has(n.local) && (stmt.typeOnly || n.type))
          if (typeOnly.length) {
            const names = typeOnly.map((n) => n.local).join(', ')
            hits.push({
              file: src.path,
              line,
              label: `${src.path} (${names})`,
              message: `${code(src.path)} imports ${code(names)} with ${code('import type')}, but uses it in a relationship decorator, which needs the runtime class.`
            })
          }
          if (stmt.from.startsWith('.') && !/\.js$/.test(stmt.from)) {
            hits.push({
              file: src.path,
              line,
              label: `${src.path} (${stmt.from})`,
              severity: 'medium',
              message: `${code(src.path)} imports ${code(stmt.from)} without the ${code('.js')} extension, which doesn't resolve as ESM.`
            })
          }
        }
      }
      return hits
    }
  },
  {
    id: 'data-model/entity-not-registered',
    run: (ctx) => {
      const schemaPath = ctx.layout.schemaFile
      const schemaName = schemaPath.slice(schemaPath.lastIndexOf('/') + 1)
      const schema = ctx.file(schemaPath)
      if (!schema) return 'na'
      const { names } = readSchemaList(schema.masked)
      const typeInfo = readSchemaTypeNames(schema.masked, names)
      const hits: QuickHit[] = []
      const reported = new Set<string>()
      for (const src of ctx.sources((p) => isDataFile(ctx, p) && p !== schemaPath)) {
        for (const cls of parseClasses(src.masked)) {
          if (!cls.decorators.some((d) => d.name === 'entity') || names.includes(cls.name)) continue
          reported.add(cls.name)
          hits.push({
            file: src.path,
            line: lineOf(src, cls.offset),
            label: cls.name,
            message: `${code(cls.name)} (${code(src.path)}) isn't listed in the ${code('schema')} array in ${schemaName}.`
          })
        }
      }
      if (typeInfo) {
        const typeLine = lineOf(schema, typeInfo.offset)
        for (const n of names) {
          if (typeInfo.names.includes(n) || reported.has(n)) continue
          hits.push({
            file: schema.path,
            line: typeLine,
            label: n,
            message: `${code(n)} is in the ${code('schema')} array but missing from the ${code(typeInfo.typeName)} type.`
          })
        }
        for (const n of typeInfo.names) {
          if (names.includes(n) || reported.has(n)) continue
          hits.push({
            file: schema.path,
            line: firstLine(schema.masked, /\bschema\s*(?::[^=]+)?=\s*\[/) ?? typeLine,
            label: n,
            message: `${code(n)} is in the ${code(typeInfo.typeName)} type but missing from the ${code('schema')} array.`
          })
        }
      }
      return hits
    }
  },
  {
    id: 'data-model/field-missing-decorator',
    run: (ctx) => {
      const hits: QuickHit[] = []
      for (const e of ctx.model.entities) {
        for (const f of e.fields) {
          if (['id', 'get', 'set', 'constructor'].includes(f.name)) continue
          const typed = (f.decorators ?? []).filter((d) => FIELD_DECORATORS.has(d.name))
          if (typed.length === 1) continue
          hits.push({
            file: e.file,
            line: f.line,
            label: `${e.name}.${f.name}`,
            message:
              typed.length === 0
                ? `${code(`${e.name}.${f.name}`)} has no field decorator, so it isn't stored.`
                : `${code(`${e.name}.${f.name}`)} has ${typed.length} field decorators (${typed.map((d) => `@${d.name}`).join(', ')}).`
          })
        }
      }
      return hits
    }
  },
  {
    id: 'data-model/decimal-precision',
    run: (ctx) => {
      const hits: QuickHit[] = []
      for (const e of ctx.model.entities) {
        for (const f of e.fields) {
          for (const d of f.decorators ?? []) {
            if (d.name !== 'decimal') continue
            const precision = /\bprecision\s*:\s*(\d+)/.exec(d.args)
            const hasPrecision = /\bprecision\s*:/.test(d.args)
            const hasScale = /\bscale\s*:/.test(d.args)
            let problem: string | undefined
            if (hasPrecision !== hasScale) problem = `sets only ${hasPrecision ? 'precision' : 'scale'}`
            else if (precision && Number(precision[1]) > 28) problem = `sets precision ${precision[1]}, above the maximum of 28`
            if (!problem) continue
            hits.push({
              file: e.file,
              line: d.line || f.line,
              label: `${e.name}.${f.name}`,
              message: `${code(`${e.name}.${f.name}`)} ${problem}.`
            })
          }
        }
      }
      return hits
    }
  },
  {
    id: 'data-model/nullable-mismatch',
    run: (ctx) => {
      const hits: QuickHit[] = []
      for (const e of ctx.model.entities) {
        for (const f of e.fields) {
          if (f.name === 'id' || isRelation(f) || f.type === 'unknown') continue
          const option = f.optionFlag === true
          const question = f.markedOptional === true
          if (option === question) continue
          hits.push({
            file: e.file,
            line: f.line,
            label: `${e.name}.${f.name}`,
            message: option
              ? `${code(`${e.name}.${f.name}`)} sets ${code('optional: true')} but the property has no ${code('?')}.`
              : `${code(`${e.name}.${f.name}`)} is marked ${code('?')} but its decorator doesn't set ${code('optional: true')}, so the column is still required.`
          })
        }
      }
      return hits
    }
  },
  {
    id: 'data-model/many-to-many',
    run: (ctx) => {
      const hits: QuickHit[] = []
      const seen = new Set<string>()
      const byName = new Map(ctx.model.entities.map((e) => [e.name, e]))
      for (const e of ctx.model.entities) {
        for (const f of e.fields) {
          if (f.decorator !== 'many' || !f.relationTo) continue
          const other = byName.get(f.relationTo)
          if (!other || other.name === e.name) continue
          const back = other.fields.some((g) => g.decorator === 'many' && g.relationTo === e.name)
          const key = [e.name, other.name].sort().join('|')
          if (!back || seen.has(key)) continue
          seen.add(key)
          hits.push({
            file: e.file,
            line: f.line,
            label: `${e.name} ↔ ${other.name}`,
            message: `${code(e.name)} and ${code(other.name)} each declare ${code('@many')} of the other, which Rayfin doesn't support without a join entity.`
          })
        }
      }
      return hits
    }
  },
  {
    id: 'data-model/reserved-entity-name',
    run: (ctx) =>
      ctx.model.entities.flatMap((e) => {
        const name = e.customName ?? e.name
        if (!RESERVED_NAMES.has(name) && !name.startsWith('__')) return []
        return [
          {
            file: e.file,
            line: e.line,
            label: name,
            message: e.customName
              ? `${code(e.name)} is registered as ${code(name)}, a name GraphQL reserves.`
              : `The entity ${code(name)} uses a name GraphQL reserves.`
          }
        ]
      })
  },
  {
    id: 'data-model/relation-options',
    run: (ctx) => {
      const hits: QuickHit[] = []
      for (const e of ctx.model.entities) {
        for (const f of e.fields) {
          for (const d of f.decorators ?? []) {
            if (!RELATIONS.has(d.name)) continue
            const comma = d.args.indexOf(',', d.args.indexOf('=>') + 1)
            const bad = comma < 0 ? [] : optionKeys(d.args.slice(comma + 1)).filter((k) => !RELATION_OPTIONS.has(k))
            if (bad.length === 0) continue
            hits.push({
              file: e.file,
              line: d.line || f.line,
              label: `${e.name}.${f.name}`,
              message: `${code(`${e.name}.${f.name}`)} passes ${bad.map(code).join(', ')} to ${code(`@${d.name}`)}, which accepts only ${code('optional')} and ${code('unique')}.`
            })
          }
        }
      }
      return hits
    }
  }
]
