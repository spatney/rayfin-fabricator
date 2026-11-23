import type { QuickHit, QuickRuleImpl } from '../quick'
import { say } from '../quick'
import { lineOf, matchAll, methodCalls, statementAround, stringLiterals } from '../source'
import { code, regexHits } from './util'

const DOT_PATH = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/

export const queryRules: QuickRuleImpl[] = [
  {
    id: 'queries/count-method',
    run: (ctx) => {
      const hits: QuickHit[] = []
      for (const src of ctx.frontend) {
        for (const m of matchAll(/\.count\s*\(/, src.masked)) {
          if (!/\.data\.[A-Za-z_$][\w$]*/.test(statementAround(src.masked, m.index))) continue
          const line = lineOf(src, m.index)
          hits.push({
            file: src.path,
            line,
            label: `${src.path}:${line}`,
            ...say((w) =>
              w.t('queries/count-method.hit', { file: code(src.path), method: code('.count()') })
            )
          })
        }
      }
      return hits
    }
  },
  {
    id: 'queries/find-by-pk',
    run: (ctx) =>
      regexHits(ctx.frontend, /\.findByPk\s*\(/, (src) =>
        say((w) =>
          w.t('queries/find-by-pk.hit', { file: code(src.path), method: code('findByPk') })
        )
      )
  },
  {
    id: 'queries/total-count',
    run: (ctx) =>
      regexHits(
        ctx.frontend.filter((src) => /\.data\.|executePaginated/.test(src.masked)),
        /\.totalCount\b/,
        (src) =>
          say((w) =>
            w.t('queries/total-count.hit', { file: code(src.path), property: code('totalCount') })
          )
      )
  },
  {
    id: 'queries/where-dot-path',
    run: (ctx) => {
      const hits: QuickHit[] = []
      for (const src of ctx.frontend) {
        for (const call of methodCalls(src.masked, 'where')) {
          for (const lit of stringLiterals(call.args)) {
            if (!DOT_PATH.test(lit.value)) continue
            const after = call.args.slice(lit.index + lit.value.length + 2)
            if (!/^\s*:/.test(after)) continue
            const line = lineOf(src, call.argsStart + lit.index)
            hits.push({
              file: src.path,
              line,
              label: `${src.path}:${line}`,
              ...say((w) =>
                w.t('queries/where-dot-path.hit', {
                  file: code(src.path),
                  path: code(`'${lit.value}'`),
                  select: code('.select()')
                })
              )
            })
          }
        }
      }
      return hits
    }
  },
  {
    id: 'queries/select-nested-path',
    run: (ctx) => {
      const hits: QuickHit[] = []
      for (const src of ctx.frontend) {
        for (const call of methodCalls(src.masked, 'select')) {
          for (const lit of stringLiterals(call.args)) {
            if (!DOT_PATH.test(lit.value) || lit.value.split('.').length < 3) continue
            const line = lineOf(src, call.argsStart + lit.index)
            hits.push({
              file: src.path,
              line,
              label: `${src.path}:${line}`,
              ...say((w) =>
                w.t('queries/select-nested-path.hit', {
                  file: code(src.path),
                  path: code(`'${lit.value}'`)
                })
              )
            })
          }
        }
      }
      return hits
    }
  },
  {
    id: 'queries/aggregate-with-row-methods',
    run: (ctx) => {
      const hits: QuickHit[] = []
      for (const src of ctx.frontend) {
        const seen = new Set<number>()
        for (const m of matchAll(/\.(aggregate|groupBy)\s*\(/, src.masked)) {
          const stmt = statementAround(src.masked, m.index)
          const row = /\.(select|orderBy|first|after)\s*\(/.exec(stmt)
          if (!row) continue
          const line = lineOf(src, m.index)
          if (seen.has(line)) continue
          seen.add(line)
          hits.push({
            file: src.path,
            line,
            label: `${src.path}:${line}`,
            ...say((w) =>
              w.t('queries/aggregate-with-row-methods.hit', {
                file: code(src.path),
                aggregate: code(`.${m[1]}()`),
                rowMethod: code(`.${row[1]}()`)
              })
            )
          })
        }
      }
      return hits
    }
  },
  {
    id: 'queries/sort-direction-case',
    run: (ctx) => {
      const hits: QuickHit[] = []
      for (const src of ctx.frontend) {
        for (const call of methodCalls(src.masked, 'orderBy')) {
          const bad = /(['"`])(ASC|DESC|Asc|Desc)\1/.exec(call.args)
          if (!bad) continue
          const line = lineOf(src, call.argsStart + bad.index)
          hits.push({
            file: src.path,
            line,
            label: `${src.path}:${line}`,
            ...say((w) =>
              w.t('queries/sort-direction-case.hit', {
                file: code(src.path),
                direction: code(`'${bad[2]}'`),
                lowercase: code(`'${bad[2].toLowerCase()}'`)
              })
            )
          })
        }
      }
      return hits
    }
  },
  {
    id: 'queries/raw-data-fetch',
    run: (ctx) => {
      const hits: QuickHit[] = []
      for (const src of ctx.frontend) {
        if (!/rayfin/i.test(src.masked)) continue
        for (const call of matchAll(/\bfetch\s*\(/, src.masked)) {
          const args = src.masked.slice(call.index, call.index + 400)
          if (!/graphql/i.test(args)) continue
          const line = lineOf(src, call.index)
          hits.push({
            file: src.path,
            line,
            label: `${src.path}:${line}`,
            ...say((w) =>
              w.t('queries/raw-data-fetch.fetch', { file: code(src.path), fetch: code('fetch()') })
            )
          })
        }
        for (const tag of matchAll(/\bgql\s*`/, src.masked)) {
          const line = lineOf(src, tag.index)
          hits.push({
            file: src.path,
            line,
            label: `${src.path}:${line}`,
            ...say((w) =>
              w.t('queries/raw-data-fetch.gql', { file: code(src.path), gql: code('gql') })
            )
          })
        }
      }
      return hits
    }
  }
]
