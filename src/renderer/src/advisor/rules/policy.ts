import { parseClasses } from '../../model/parseSchema'
import { isUnder } from '../../model/projectLayout'
import type { QuickHit, QuickRuleImpl } from '../quick'
import { listLabels, say } from '../quick'
import { lineOf, matchAll } from '../source'
import { actionsLabel, code, grantsOf, grantsWrite } from './util'

/** Field names that record which signed-in user owns a row. */
const OWNER_FIELD = /^(user_?id|owner_?id|created_?by|author_?id|creator_?id)$/i
const SUPPORTED_CLAIMS = new Set(['sub', 'email', 'role'])
const PERMISSION_DECORATORS = new Set(['role', 'authenticated', 'anonymous'])

export const policyRules: QuickRuleImpl[] = [
  {
    id: 'policy/owner-field-without-policy',
    run: (ctx) => {
      const hits: QuickHit[] = []
      for (const e of ctx.model.entities) {
        if (e.permissions.length === 0) continue
        const owner = e.fields.find(
          (f) => OWNER_FIELD.test(f.name) && (f.type === 'text' || f.type === 'email' || f.type === 'unknown')
        )
        if (!owner) continue
        for (const g of grantsOf(e)) {
          const { permission: p } = g
          if (p.role !== 'authenticated' || p.hasPolicy || !grantsWrite(p)) continue
          hits.push({
            file: e.file,
            line: g.decorator.line,
            label: e.name,
            ...say((w) =>
              w.t('policy/owner-field-without-policy.hit', {
                entity: code(e.name),
                owner: code(owner.name),
                grant: code(`@${g.decorator.name}(${actionsLabel(p)})`)
              })
            )
          })
        }
      }
      return hits
    },
    summarize: (hits) =>
      say((w) =>
        w.t('policy/owner-field-without-policy.summary', { entities: listLabels(hits, w) })
      )
  },
  {
    id: 'policy/anonymous-write',
    run: (ctx) => {
      const hits: QuickHit[] = []
      for (const e of ctx.model.entities) {
        for (const g of grantsOf(e)) {
          if (g.permission.role !== 'anonymous' || !grantsWrite(g.permission)) continue
          hits.push({
            file: e.file,
            line: g.decorator.line,
            label: e.name,
            ...say((w) =>
              w.t('policy/anonymous-write.hit', {
                entity: code(e.name),
                actions: code(actionsLabel(g.permission))
              })
            )
          })
        }
      }
      return hits
    }
  },
  {
    id: 'policy/anonymous-grant',
    run: (ctx) => {
      const hits: QuickHit[] = []
      for (const e of ctx.model.entities) {
        const grants = grantsOf(e).filter((g) => g.permission.role === 'anonymous')
        // Public writes are reported (more severely) by policy/anonymous-write.
        if (grants.length === 0 || grants.some((g) => grantsWrite(g.permission))) continue
        hits.push({
          file: e.file,
          line: grants[0].decorator.line,
          label: e.name,
          ...say((w) =>
            ctx.runsLocally
              ? w.t('policy/anonymous-grant.hitLocal', { entity: code(e.name) })
              : w.t('policy/anonymous-grant.hitFabric', { entity: code(e.name) })
          )
        })
      }
      return hits
    },
    summarize: (hits, ctx) =>
      say((w) => {
        const values = { count: hits.length, entities: listLabels(hits, w) }
        return ctx.runsLocally
          ? w.t('policy/anonymous-grant.summaryLocal', values)
          : w.t('policy/anonymous-grant.summaryFabric', values)
      })
  },
  {
    id: 'policy/unsupported-claim',
    run: (ctx) => {
      const hits: QuickHit[] = []
      for (const e of ctx.model.entities) {
        for (const g of grantsOf(e)) {
          if (!g.permission.hasPolicy) continue
          const param = /policy\s*:\s*\(\s*([A-Za-z_$][\w$]*)/.exec(g.decorator.args)?.[1] ?? 'claims'
          const seen = new Set<string>()
          for (const m of matchAll(new RegExp(`\\b${param.replace(/\$/g, '\\$')}\\.([A-Za-z_$][\\w$]*)`), g.decorator.args)) {
            const claim = m[1]
            if (SUPPORTED_CLAIMS.has(claim) || seen.has(claim)) continue
            seen.add(claim)
            hits.push({
              file: e.file,
              line: g.decorator.line,
              label: `${e.name} (${param}.${claim})`,
              ...say((w) =>
                w.t('policy/unsupported-claim.hit', {
                  entity: code(e.name),
                  claim: code(`${param}.${claim}`),
                  sub: code('sub'),
                  email: code('email'),
                  role: code('role')
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
    id: 'policy/blob-without-permission',
    run: (ctx) => {
      const hits: QuickHit[] = []
      const { dataDir, functionsRoot } = ctx.layout
      const files = ctx.sources(
        (p) =>
          /\.(ts|js)$/.test(p) &&
          ((p.startsWith('rayfin/') && !p.startsWith('rayfin/functions/') && !isUnder(p, functionsRoot)) ||
            isUnder(p, dataDir))
      )
      for (const src of files) {
        for (const cls of parseClasses(src.masked)) {
          if (!cls.decorators.some((d) => d.name === 'blob')) continue
          if (cls.decorators.some((d) => PERMISSION_DECORATORS.has(d.name))) continue
          hits.push({
            file: src.path,
            line: lineOf(src, cls.offset),
            label: cls.name,
            ...say((w) =>
              w.t('policy/blob-without-permission.hit', {
                blob: code(`@blob()`),
                storageClass: code(cls.name)
              })
            )
          })
        }
      }
      return hits
    }
  },
  {
    id: 'policy/prefer-shorthand',
    run: (ctx) => {
      const hits: QuickHit[] = []
      for (const e of ctx.model.entities) {
        for (const g of grantsOf(e)) {
          const role = g.permission.role
          if (g.decorator.name !== 'role' || (role !== 'authenticated' && role !== 'anonymous')) continue
          hits.push({
            file: e.file,
            line: g.decorator.line,
            label: e.name,
            ...say((w) =>
              w.t('policy/prefer-shorthand.hit', {
                entity: code(e.name),
                longhand: code(`@role('${role}', …)`),
                shorthand: code(`@${role}(…)`)
              })
            )
          })
        }
      }
      return hits
    }
  }
]
