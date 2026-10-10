import { isUnder, relativeTo } from '../../model/projectLayout'
import type { QuickContext } from '../context'
import type { QuickHit, QuickRuleImpl } from '../quick'
import {
  firstLine,
  importsOf,
  importsValues,
  jsonKeyLine,
  lineOf,
  matchAll,
  parseJsonc,
  resolveRelative,
  yamlKeyLine,
  type SourceFile
} from '../source'
import { code } from './util'

type Obj = Record<string, unknown>

const TSCONFIG = /^(rayfin\/)?tsconfig[^/]*\.json$/
const VITE_CONFIG = /^vite\.config\.(ts|mts|js|mjs|cjs)$/
/** Local env files the CLI and frameworks read (root and `rayfin/`). */
const ENV_FILE = /^(rayfin\/)?\.env(\.[^/]+)?$/

function viteConfig(ctx: QuickContext): SourceFile | undefined {
  return ctx.sources((p) => VITE_CONFIG.test(relativeTo(p, ctx.layout.frontendRoot) ?? ''))[0]
}

/** Whether an import from `fromFile` pulls in the data model (its folder, or the data package). */
function importsDataModel(ctx: QuickContext, fromFile: string, spec: string): boolean {
  const target = resolveRelative(fromFile, spec) ?? spec
  if (/(^|\/)rayfin\/data(\/|$)/.test(target)) return true
  const { dataRoot } = ctx.layout
  if (dataRoot && (target === dataRoot || isUnder(target, dataRoot))) return true
  const pkg = ctx.dataPackage
  return Boolean(pkg && (spec === pkg || spec.startsWith(`${pkg}/`)))
}

/** Frontend imports that pull entity classes (not just types) into the bundle. */
function runtimeEntityImports(ctx: QuickContext): QuickHit[] {
  const hits: QuickHit[] = []
  for (const src of ctx.frontend) {
    for (const stmt of importsOf(src.masked)) {
      if (!importsDataModel(ctx, src.path, stmt.from) || !importsValues(stmt)) continue
      const line = lineOf(src, stmt.index)
      hits.push({
        file: src.path,
        line,
        label: `${src.path}:${line}`,
        message: `${code(src.path)} imports ${code(stmt.from)} as a value, which bundles decorated entity classes into the browser build.`
      })
    }
  }
  return hits
}

function compilerOptions(json: unknown): Obj | undefined {
  const co = (json as Obj | null)?.compilerOptions
  return co && typeof co === 'object' ? (co as Obj) : undefined
}

/**
 * The effective `compilerOptions.lib` for a tsconfig, following `extends`
 * within the project. `undefined` = not set anywhere; `null` = can't tell.
 */
function effectiveLib(ctx: QuickContext, path: string): { lib: string[] | undefined; path: string } | null {
  let current: string | undefined = path
  for (let depth = 0; current && depth < 6; depth++) {
    const src = ctx.file(current)
    if (!src) return null
    const json = parseJsonc(src.text) as Obj | null
    if (!json) return null
    const lib = compilerOptions(json)?.lib
    if (Array.isArray(lib)) return { lib: lib.map(String), path: current }
    const ext = json.extends
    if (typeof ext !== 'string') return { lib: undefined, path: current }
    const resolved = resolveRelative(current, ext)
    if (!resolved) return null
    current = resolved.endsWith('.json') ? resolved : `${resolved}.json`
  }
  return null
}

export const configRules: QuickRuleImpl[] = [
  {
    id: 'config/missing-service-blocks',
    run: (ctx) => {
      if (!ctx.yml) return 'na'
      const services = ctx.yml.data.services
      const obj = services && typeof services === 'object' ? (services as Obj) : {}
      return ['auth', 'data']
        .filter((k) => !(k in obj))
        .map((k) => ({
          file: ctx.yml!.path,
          line: yamlKeyLine(ctx.yml!.text, ['services']) ?? 1,
          label: `services.${k}`,
          message: `rayfin.yml doesn't declare ${code(`services.${k}`)}.`
        }))
    }
  },
  {
    id: 'config/data-dialect',
    run: (ctx) => {
      if (!ctx.yml || !ctx.enabled('data')) return []
      const dialect = ctx.service('data')?.dialect
      if (dialect === 'mssql') return []
      return [
        {
          file: ctx.yml.path,
          line:
            yamlKeyLine(ctx.yml.text, ['services', 'data', 'dialect']) ??
            yamlKeyLine(ctx.yml.text, ['services', 'data']),
          label: 'services.data',
          message:
            dialect === undefined
              ? `${code('services.data')} is enabled but doesn't set ${code('dialect')}.`
              : `${code('services.data.dialect')} is ${code(String(dialect))}; Fabric apps support only ${code('mssql')}.`
        }
      ]
    }
  },
  {
    id: 'config/experimental-decorators',
    run: (ctx) => {
      const hits: QuickHit[] = []
      for (const src of ctx.sources((p) => TSCONFIG.test(p))) {
        const co = compilerOptions(parseJsonc(src.text))
        for (const key of ['experimentalDecorators', 'emitDecoratorMetadata']) {
          if (co?.[key] !== true) continue
          hits.push({
            file: src.path,
            line: jsonKeyLine(src.text, key),
            label: `${src.path} ${key}`,
            message: `${code(src.path)} sets ${code(`${key}: true`)}.`
          })
        }
      }
      return hits
    }
  },
  {
    id: 'config/decorators-lib',
    run: (ctx) => {
      const start = ctx.file('rayfin/tsconfig.json') ? 'rayfin/tsconfig.json' : 'tsconfig.json'
      if (!ctx.file(start)) return 'na'
      const found = effectiveLib(ctx, start)
      if (!found) return 'na'
      const ok = found.lib?.some((l) => /^esnext(\.decorators)?$/i.test(l.trim()))
      if (ok) return []
      const src = ctx.file(found.path)!
      return [
        {
          file: found.path,
          line: jsonKeyLine(src.text, found.lib ? 'lib' : 'compilerOptions'),
          label: found.path,
          message: found.lib
            ? `${code(found.path)}'s ${code('lib')} doesn't include ${code('ESNext.Decorators')}.`
            : `${code(found.path)} doesn't set ${code('lib')}, so ${code('ESNext.Decorators')} isn't included.`
        }
      ]
    }
  },
  {
    id: 'config/swc-with-runtime-entities',
    run: (ctx) => {
      const vite = viteConfig(ctx)
      if (!vite || !/plugin-react-swc/.test(vite.masked)) return []
      return runtimeEntityImports(ctx).map((h) => ({
        ...h,
        message: `${h.message} This project builds with ${code('@vitejs/plugin-react-swc')}, which can't parse those decorators.`
      }))
    }
  },
  {
    id: 'config/vite-target',
    run: (ctx) => {
      const vite = viteConfig(ctx)
      const imports = runtimeEntityImports(ctx)
      if (!vite || imports.length === 0) return []
      if (/target\s*:\s*['"`](es202[2-9]|es20[3-9]\d|esnext)['"`]/i.test(vite.masked)) return []
      return [
        {
          file: vite.path,
          line: firstLine(vite.masked, /\bbuild\s*:/) ?? 1,
          label: vite.path,
          message: `${code(vite.path)} doesn't target ES2022 or later, but the bundle includes entity classes (for example ${imports[0].label}).`
        }
      ]
    }
  },
  {
    id: 'config/static-hosting-folder',
    run: (ctx) => {
      const hosting = ctx.service('staticHosting')
      const folder = hosting?.folder
      const vite = viteConfig(ctx)
      if (!ctx.yml || hosting?.enabled !== true || typeof folder !== 'string' || !vite) return []
      const root = hosting.root
      if (typeof root === 'string' && !['', '.', './'].includes(root.trim())) return []
      if (/\broot\s*:/.test(vite.masked)) return []
      const outDir = /\boutDir\s*:\s*['"`]([^'"`]+)['"`]/.exec(vite.masked)?.[1] ?? 'dist'
      const norm = (s: string): string => s.trim().replace(/^\.\//, '').replace(/\/+$/, '')
      if (norm(folder) === norm(outDir)) return []
      return [
        {
          file: ctx.yml.path,
          line: yamlKeyLine(ctx.yml.text, ['services', 'staticHosting', 'folder']),
          label: 'services.staticHosting.folder',
          message: `${code('staticHosting.folder')} is ${code(folder)}, but Vite writes the build to ${code(outDir)}.`
        }
      ]
    }
  },
  {
    id: 'config/deprecated-yml-keys',
    run: (ctx) => {
      if (!ctx.yml) return 'na'
      const yml = ctx.yml
      const hits: QuickHit[] = ['frontend', 'publishable_key']
        .filter((k) => k in yml.data)
        .map((k) => ({
          file: yml.path,
          line: yamlKeyLine(yml.text, [k]),
          label: k,
          message: `rayfin.yml still has the deprecated top-level ${code(`${k}:`)} key.`
        }))
      if (ctx.service('connectors') && 'enabled' in (ctx.service('connectors') as Obj)) {
        hits.push({
          file: yml.path,
          line: yamlKeyLine(yml.text, ['services', 'connectors', 'enabled']),
          label: 'services.connectors.enabled',
          message: `${code('services.connectors.enabled')} does nothing since Rayfin 1.36; connectors are always on.`
        })
      }
      if (ctx.service('staticHosting') && 'anonymousAccess' in (ctx.service('staticHosting') as Obj)) {
        hits.push({
          file: yml.path,
          line: yamlKeyLine(yml.text, ['services', 'staticHosting', 'anonymousAccess']),
          label: 'services.staticHosting.anonymousAccess',
          message: `${code('services.staticHosting.anonymousAccess')} was replaced by ${code('assetAccess')} in Rayfin 1.35.1.`
        })
      }
      return hits
    }
  },
  {
    id: 'config/functions-auth',
    run: (ctx) => {
      if (!ctx.yml || !ctx.enabled('functions')) return []
      const auth = ctx.service('functions')?.auth
      const type = auth && typeof auth === 'object' ? (auth as Obj).type : undefined
      if (type === 'application') return []
      return [
        {
          file: ctx.yml.path,
          line:
            yamlKeyLine(ctx.yml.text, ['services', 'functions', 'auth']) ??
            yamlKeyLine(ctx.yml.text, ['services', 'functions']),
          label: 'services.functions.auth',
          message:
            type === undefined
              ? `${code('services.functions')} is enabled but doesn't set ${code('auth.type: application')}.`
              : `${code('services.functions.auth.type')} is ${code(String(type))}; enabled Functions need ${code('application')}.`
        }
      ]
    }
  },
  {
    id: 'config/static-hosting-posture',
    run: (ctx) => {
      const hosting = ctx.service('staticHosting')
      if (!ctx.yml || hosting?.enabled !== true) return []
      const access = hosting.assetAccess
      if (access === 'protected' || access === 'public') return []
      return [
        {
          file: ctx.yml.path,
          line:
            yamlKeyLine(ctx.yml.text, ['services', 'staticHosting', 'assetAccess']) ??
            yamlKeyLine(ctx.yml.text, ['services', 'staticHosting']),
          label: 'services.staticHosting.assetAccess',
          message:
            access === undefined
              ? `${code('services.staticHosting')} doesn't set ${code('assetAccess')}.`
              : `${code('services.staticHosting.assetAccess')} is ${code(String(access))}; use ${code('protected')} or ${code('public')}.`
        }
      ]
    }
  },
  {
    id: 'config/embedded-public-conflict',
    run: (ctx) => {
      const hosting = ctx.service('staticHosting')
      const embedded = hosting?.embedded
      const only = Boolean(embedded) && typeof embedded === 'object' && (embedded as Obj).only === true
      if (!ctx.yml || hosting?.assetAccess !== 'public' || !only) return []
      return [
        {
          file: ctx.yml.path,
          line: yamlKeyLine(ctx.yml.text, ['services', 'staticHosting', 'assetAccess']),
          label: 'services.staticHosting',
          message: `${code('services.staticHosting')} sets ${code('assetAccess: public')} together with ${code('embedded.only: true')}.`
        }
      ]
    }
  },
  {
    id: 'config/stale-feature-flags',
    run: (ctx) => {
      const hits: QuickHit[] = []
      const files = ctx.sources(
        (p) =>
          ENV_FILE.test(p) || p === 'package.json' || p.startsWith('.github/workflows/') || p.startsWith('scripts/')
      )
      for (const src of files) {
        for (const m of matchAll(/RAYFIN_FEATURE_FLAGS\s*[=:]\s*["']?([A-Za-z0-9_,\- ]+)/, src.masked)) {
          const stale = m[1]
            .split(/[,\s]+/)
            .map((f) => f.trim().toLowerCase())
            .filter((f) => f === 'functions' || f === 'connectors')
          if (stale.length === 0) continue
          const line = lineOf(src, m.index)
          hits.push({
            file: src.path,
            line,
            label: src.path,
            // Only the flag's own line: env files can hold secrets on neighboring lines.
            excerpt: { text: src.text.split(/\r?\n/)[line - 1] ?? '', start: line },
            message: `${code(src.path)} lists ${[...new Set(stale)].map(code).join(' and ')} in ${code('RAYFIN_FEATURE_FLAGS')}, which no longer need a flag.`
          })
        }
      }
      return hits
    }
  },
  {
    id: 'config/connectors-list-shape',
    run: (ctx) => {
      const block = ctx.yml?.data.connectors
      if (!ctx.yml || block === undefined || block === null || Array.isArray(block)) return []
      if (typeof block !== 'object') return []
      const names = Object.keys(block as Obj)
      return [
        {
          file: ctx.yml.path,
          line: yamlKeyLine(ctx.yml.text, ['connectors']),
          label: names.join(', ') || 'connectors',
          message: `${code('connectors:')} in rayfin.yml is a map keyed by connector name (${names.map(code).join(', ')}) instead of a list of ${code('- name:')} entries.`
        }
      ]
    }
  }
]
