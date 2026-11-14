import { isUnder } from '../../model/projectLayout'
import type { QuickHit, QuickRuleImpl } from '../quick'
import { listLabels, say } from '../quick'
import { dynamicImports, importsOf, lineOf, yamlKeyLine } from '../source'
import { CODE_FILE, code, regexHits } from './util'

const FABRIC_PROVIDER = '@microsoft/rayfin-auth-provider-fabric'

export const accessRules: QuickRuleImpl[] = [
  {
    id: 'access/entity-missing-permission',
    run: (ctx) =>
      ctx.model.entities
        .filter((e) => e.permissions.length === 0)
        .map((e) => ({
          file: e.file,
          line: e.line,
          label: e.name,
          ...say((w) => w.t('access/entity-missing-permission.hit', { entity: code(e.name) }))
        })),
    summarize: (hits) =>
      say((w) =>
        w.t('access/entity-missing-permission.summary', {
          count: hits.length,
          entities: listLabels(hits, w)
        })
      )
  },
  {
    id: 'access/on-auth-state-change',
    run: (ctx) =>
      regexHits(ctx.frontend, /\bonAuthStateChange\b/, (src) =>
        say((w) =>
          w.t('access/on-auth-state-change.hit', {
            file: code(src.path),
            method: code('onAuthStateChange')
          })
        )
      )
  },
  {
    id: 'access/fabric-provider-missing',
    run: (ctx) => {
      const fabric = ctx.service('auth')?.fabric as { enabled?: unknown } | undefined
      if (fabric?.enabled !== true || !ctx.yml) return []
      if (ctx.hasDependency(FABRIC_PROVIDER)) return []
      return [
        {
          file: ctx.yml.path,
          line: yamlKeyLine(ctx.yml.text, ['services', 'auth', 'fabric']),
          label: 'package.json',
          ...say((w) =>
            w.t('access/fabric-provider-missing.hit', {
              setting: code('services.auth.fabric.enabled'),
              package: code(FABRIC_PROVIDER)
            })
          )
        }
      ]
    }
  },
  {
    id: 'access/fabric-provider-dynamic-import',
    run: (ctx) => {
      if (!ctx.hasDependency(FABRIC_PROVIDER)) return []
      let imported = false
      const lazy: QuickHit[] = []
      for (const src of ctx.frontend) {
        if (importsOf(src.masked).some((s) => s.from === FABRIC_PROVIDER)) imported = true
        for (const d of dynamicImports(src.masked)) {
          if (d.from !== FABRIC_PROVIDER) continue
          const line = lineOf(src, d.index)
          lazy.push({
            file: src.path,
            line,
            label: `${src.path}:${line}`,
            ...say((w) =>
              w.t('access/fabric-provider-dynamic-import.hit', {
                file: code(src.path),
                dynamicImport: code('import()')
              })
            )
          })
        }
      }
      return imported ? [] : lazy
    }
  },
  {
    id: 'access/mock-auth-credentials',
    run: (ctx) => {
      const hits: QuickHit[] = []
      for (const src of ctx.sources((p) => isUnder(p, ctx.layout.frontendSrc) && CODE_FILE.test(p))) {
        if (!/\bclass\s+MockAuthService\b/.test(src.masked)) continue
        const cred = /\b(\w*PASSWORD\w*|password)\s*[:=]\s*(['"`])([^'"`\n]{4,})\2/i.exec(src.masked)
        if (!cred) continue
        const wired = ctx.frontend.some((o) => o.path !== src.path && /\bMockAuthService\b/.test(o.masked))
        if (!wired) continue
        const line = lineOf(src, cred.index)
        hits.push({
          file: src.path,
          line,
          label: src.path,
          ...say((w) => w.t('access/mock-auth-credentials.hit', { file: code(src.path) }))
        })
      }
      return hits
    }
  },
  {
    id: 'access/entra-exchange-not-enabled',
    run: (ctx) => {
      const fabric = ctx.service('auth')?.fabric as { externalEntraExchange?: unknown } | undefined
      if (fabric?.externalEntraExchange === true) return []
      return regexHits(
        ctx.sources(
          (p) => (isUnder(p, ctx.layout.frontendSrc) || p.startsWith('scripts/')) && CODE_FILE.test(p)
        ),
        /\b(signInWithEntraToken|fetchRayfinLocalSessionToken)\s*\(/,
        (src, m) =>
          say((w) =>
            w.t('access/entra-exchange-not-enabled.hit', {
              file: code(src.path),
              call: code(`${m[1]}()`),
              setting: code('services.auth.fabric.externalEntraExchange: true')
            })
          )
      )
    }
  }
]
