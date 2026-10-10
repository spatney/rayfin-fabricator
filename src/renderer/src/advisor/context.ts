/**
 * The read model the quick-check rules run against, built once per run from an
 * `advisor.collect` snapshot plus the project's Rayfin version report.
 */
import { parse as parseYaml } from 'yaml'
import type {
  AdvisorCondition,
  AdvisorPackage,
  AdvisorProjectFile,
  AdvisorProjectSnapshot,
  RayfinVersionInfo
} from '@shared/ipc'
import { parseDataModel, type DataModel } from '../model/parseSchema'
import {
  isUnder,
  layoutOf,
  relativeTo,
  SINGLE_PACKAGE_LAYOUT,
  type ProjectLayout
} from '../model/projectLayout'
import { sourceFile, type SourceFile } from './source'

const CODE_FILE = /\.(tsx?|jsx?|mts|cts|mjs|cjs)$/i
const TEST_FILE = /(\.test\.|\.spec\.|(^|\/)__tests__\/|(^|\/)tests?\/)/i

type Obj = Record<string, unknown>

export interface PackageJsonInfo {
  /** Declared in the root package.json or in one of its npm workspaces. */
  dependencies: Record<string, string>
  /** Declared in the root package.json or in one of its npm workspaces. */
  devDependencies: Record<string, string>
  /** The root package.json's scripts. */
  scripts: Record<string, string>
}

export interface QuickContext {
  snapshot: AdvisorProjectSnapshot
  /** A collected text file, comment-masked, by project-relative path. */
  file(path: string): SourceFile | undefined
  /** Collected text files whose path matches. */
  sources(match: (path: string) => boolean): SourceFile[]
  /** Runtime frontend code under the frontend's `src/` (tests excluded); see {@link layout}. */
  frontend: SourceFile[]
  /**
   * Where the app keeps its frontend, data model and functions: the project
   * root's `src/` and `rayfin/`, or the npm packages rayfin.yml names, as in the
   * Rayfin CLI's Universal App.
   */
  layout: ProjectLayout
  /** The data package's npm name (such as `@rayfin-app/data`), when the data model is a package. */
  dataPackage?: string
  /** Listing metadata for any project file (collected or not). */
  fileInfo(path: string): AdvisorProjectFile | undefined
  exists(path: string): boolean
  /** Parsed `rayfin/rayfin.yml`, or null when missing or unreadable. */
  yml: { path: string; text: string; data: Obj } | null
  /** `services.<name>` from rayfin.yml, when it's an object. */
  service(name: string): Obj | undefined
  /** True when `services.<name>.enabled` is exactly `true`. */
  enabled(name: string): boolean
  packageJson: PackageJsonInfo | null
  /**
   * Every dependency declared in package.json (prod and dev), including the
   * manifests of its npm workspaces, such as the Rayfin CLI Universal App's
   * `packages/frontend`.
   */
  hasDependency(name: string): boolean
  model: DataModel
  conditions: Set<AdvisorCondition>
  versions: RayfinVersionInfo | null
  packages: AdvisorPackage[]
}

function asObj(value: unknown): Obj | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : undefined
}

function asStringMap(value: unknown): Record<string, string> {
  const obj = asObj(value)
  if (!obj) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj)) if (typeof v === 'string') out[k] = v
  return out
}

/** The `workspaces` globs of a root package.json (a list, or `{ packages }`). */
function workspacePatterns(pkg: Obj): string[] {
  const field = pkg.workspaces
  const list = Array.isArray(field) ? field : asObj(field)?.packages
  return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : []
}

/** Whether a project-relative folder matches an npm workspace glob such as `packages/*`. */
export function matchesWorkspace(dir: string, pattern: string): boolean {
  const clean = pattern.trim().replace(/^\.\//, '').replace(/\/+$/, '')
  if (!clean || clean.split('/').includes('..')) return false
  const source = clean
    .split('/')
    .map((seg) =>
      seg === '**'
        ? '.+'
        : seg
            .split('*')
            .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
            .join('[^/]*')
    )
    .join('/')
  return new RegExp(`^${source}$`).test(dir)
}

/** Runtime frontend code: a code file under the frontend's `srcDir`, tests excluded. */
export function isRuntimeFrontendFile(path: string, srcDir = SINGLE_PACKAGE_LAYOUT.frontendSrc): boolean {
  const rel = relativeTo(path, srcDir)
  return rel !== undefined && CODE_FILE.test(path) && !TEST_FILE.test(rel)
}

export async function buildQuickContext(
  snapshot: AdvisorProjectSnapshot,
  versions: RayfinVersionInfo | null
): Promise<QuickContext> {
  const cache = new Map<string, SourceFile>()
  const file = (path: string): SourceFile | undefined => {
    const hit = cache.get(path)
    if (hit) return hit
    const text = snapshot.contents[path]
    if (text === undefined) return undefined
    const src = sourceFile(path, text)
    cache.set(path, src)
    return src
  }
  const sources = (match: (path: string) => boolean): SourceFile[] =>
    Object.keys(snapshot.contents)
      .filter(match)
      .sort()
      .map((p) => file(p) as SourceFile)
  const listing = new Map(snapshot.files.map((f) => [f.path, f]))

  let yml: QuickContext['yml'] = null
  for (const path of ['rayfin/rayfin.yml', 'rayfin/rayfin.yaml']) {
    const text = snapshot.contents[path]
    if (text === undefined) continue
    try {
      const data = asObj(parseYaml(text)) ?? {}
      yml = { path, text, data }
    } catch {
      yml = { path, text, data: {} }
    }
    break
  }
  const services = asObj(yml?.data.services) ?? {}
  const service = (name: string): Obj | undefined => asObj(services[name])
  const enabled = (name: string): boolean => service(name)?.enabled === true
  const layout = layoutOf(yml?.data)
  let dataPackage: string | undefined
  if (layout.dataRoot) {
    try {
      const name = asObj(JSON.parse(snapshot.contents[`${layout.dataRoot}/package.json`] ?? 'null'))?.name
      if (typeof name === 'string' && name.trim()) dataPackage = name.trim()
    } catch {
      // An unreadable data package manifest names no package.
    }
  }

  let packageJson: PackageJsonInfo | null = null
  const rawPackage = snapshot.contents['package.json']
  if (rawPackage !== undefined) {
    try {
      const pkg = asObj(JSON.parse(rawPackage)) ?? {}
      let dependencies = asStringMap(pkg.dependencies)
      let devDependencies = asStringMap(pkg.devDependencies)
      // npm workspaces declare the app's own dependencies too; the root's win.
      const patterns = workspacePatterns(pkg)
      for (const [path, text] of Object.entries(snapshot.contents)) {
        const dir = path.endsWith('/package.json') ? path.slice(0, -'/package.json'.length) : null
        if (!dir || !patterns.some((p) => matchesWorkspace(dir, p))) continue
        try {
          const ws = asObj(JSON.parse(text)) ?? {}
          dependencies = { ...asStringMap(ws.dependencies), ...dependencies }
          devDependencies = { ...asStringMap(ws.devDependencies), ...devDependencies }
        } catch {
          // An unreadable workspace manifest declares nothing.
        }
      }
      packageJson = { dependencies, devDependencies, scripts: asStringMap(pkg.scripts) }
    } catch {
      packageJson = null
    }
  }
  const hasDependency = (name: string): boolean =>
    Boolean(packageJson && (name in packageJson.dependencies || name in packageJson.devDependencies))

  const model = await parseDataModel(async (path) => snapshot.contents[path] ?? null)

  const dataPaths = Object.keys(snapshot.contents).filter(
    (p) => p.startsWith('rayfin/') || isUnder(p, layout.dataDir)
  )
  const anyFileUnder = (prefix: string): boolean =>
    snapshot.files.some((f) => f.path.startsWith(prefix))
  const connectorsBlock = yml?.data.connectors
  const hasConnectorEntries = Array.isArray(connectorsBlock)
    ? connectorsBlock.length > 0
    : Boolean(asObj(connectorsBlock) && Object.keys(asObj(connectorsBlock)!).length > 0)
  const conditions = new Set<AdvisorCondition>()
  if (enabled('data') || model.entities.length > 0) conditions.add('data')
  if (enabled('auth')) conditions.add('auth')
  if (asObj(service('auth')?.fabric)?.enabled === true || hasDependency('@microsoft/rayfin-auth-provider-fabric')) {
    conditions.add('fabricSso')
  }
  if (
    enabled('storage') ||
    dataPaths.some((p) => /@blob\s*\(/.test(snapshot.contents[p] ?? ''))
  ) {
    conditions.add('storage')
  }
  if (enabled('functions') || anyFileUnder(`${layout.functionsRoot}/`)) conditions.add('functions')
  if (
    enabled('connectors') ||
    hasConnectorEntries ||
    anyFileUnder('rayfin/connectors/') ||
    snapshot.packages.some((p) => /^@microsoft\/rayfin-connector/.test(p.name) && p.declared)
  ) {
    conditions.add('connectors')
  }
  if (enabled('staticHosting')) conditions.add('hosting')

  return {
    snapshot,
    file,
    sources,
    frontend: sources((p) => isRuntimeFrontendFile(p, layout.frontendSrc)),
    layout,
    dataPackage,
    fileInfo: (path) => listing.get(path),
    exists: (path) => listing.has(path) || snapshot.contents[path] !== undefined,
    yml,
    service,
    enabled,
    packageJson,
    hasDependency,
    model,
    conditions,
    versions,
    packages: snapshot.packages
  }
}
