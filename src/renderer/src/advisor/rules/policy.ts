import { parseClasses } from '../../model/parseSchema'
import { isUnder } from '../../model/projectLayout'
import type { QuickHit, QuickRuleImpl } from '../quick'
import { listLabels } from '../quick'
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
            message: `${code(e.name)} stores ${code(owner.name)}, but its ${code(`@${g.decorator.name}(${actionsLabel(p)})`)} grant has no row policy, so any signed-in user can change other users' rows.`
          })
        }
      }
      return hits
    },
    summarize: (hits) =>
      `These entities store an owner but let any signed-in user change every row: ${listLabels(hits)}.`
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
            message: `${code(e.name)} grants ${code(actionsLabel(g.permission))} to anonymous callers, so anyone can change its rows without signing in.`
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
          message: `${code(e.name)} allows anonymous reads, which Fabric rejects unless your tenant admin has enabled anonymous data access.`
        })
      }
      return hits
    },
    summarize: (hits) =>
      `${hits.length} entities allow anonymous reads, which Fabric rejects unless your tenant allows anonymous data access: ${listLabels(hits)}.`
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
              message: `${code(e.name)}'s policy compares ${code(`${param}.${claim}`)}, but policies only support ${code('sub')}, ${code('email')}, and ${code('role')}.`
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
            message: `The ${code(`@blob()`)} storage class ${code(cls.name)} has no permission decorator.`
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
            message: `${code(e.name)} uses ${code(`@role('${role}', …)`)}; ${code(`@${role}(…)`)} is the documented shorthand.`
          })
        }
      }
      return hits
    }
  }
]
