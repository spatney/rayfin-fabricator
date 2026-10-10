/**
 * Where a Rayfin app keeps its frontend, data model and functions.
 *
 * Single-package apps keep the frontend in `src/`, the data model in
 * `rayfin/data/` (registered in `schema.ts`) and functions in
 * `rayfin/functions/`. Workspace apps, such as the Rayfin CLI's Universal App,
 * keep each in its own npm package, which `rayfin/rayfin.yml` names with
 * `services.<service>.path`: `packages/frontend`, `packages/data` (its entities
 * registered in `src/index.ts`, which the package exports) and
 * `packages/functions`. The Rayfin CLI builds and deploys each service from
 * that folder.
 */
import { parse as parseYaml } from 'yaml'

export interface ProjectLayout {
  /** The frontend package's folder: `''` for the project root. */
  frontendRoot: string
  /** The frontend's source folder: `src`, or `<frontendRoot>/src`. */
  frontendSrc: string
  /** The data package's folder, or `null` when the data model lives in `rayfin/data/`. */
  dataRoot: string | null
  /** The data model's source folder: `rayfin/data`, or `<dataRoot>/src`. */
  dataDir: string
  /** The file that registers the entities: `rayfin/data/schema.ts`, or `<dataRoot>/src/index.ts`. */
  schemaFile: string
  /** The functions package's folder: `rayfin/functions` unless rayfin.yml names another. */
  functionsRoot: string
}

/** The layout of a single-package app, and of one whose rayfin.yml can't be read. */
export const SINGLE_PACKAGE_LAYOUT: Readonly<ProjectLayout> = Object.freeze({
  frontendRoot: '',
  frontendSrc: 'src',
  dataRoot: null,
  dataDir: 'rayfin/data',
  schemaFile: 'rayfin/data/schema.ts',
  functionsRoot: 'rayfin/functions'
})

type Obj = Record<string, unknown>

const asObj = (value: unknown): Obj | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : undefined

/**
 * A `services.<service>.path` as a normalized project-relative folder: `''` for
 * the project root, `undefined` when it isn't set or would leave the project.
 */
export function serviceFolder(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const raw = value.trim().replace(/\\/g, '/')
  if (raw.startsWith('/') || /^[a-z]:/i.test(raw)) return undefined
  const parts: string[] = []
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') return undefined
    parts.push(seg)
  }
  return parts.join('/')
}

/** `dir/rel`, or `rel` when `dir` is the project root (`''`). */
export function joinPath(dir: string, rel: string): string {
  return dir ? `${dir}/${rel}` : rel
}

/** `path` relative to the folder `dir`, or `undefined` when it isn't inside it. */
export function relativeTo(path: string, dir: string): string | undefined {
  if (!dir) return path
  return path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : undefined
}

/** Whether `path` is inside the folder `dir` (the project root `''` contains everything). */
export function isUnder(path: string, dir: string): boolean {
  return relativeTo(path, dir) !== undefined
}

/** The layout a parsed `rayfin/rayfin.yml` describes. */
export function layoutOf(rayfinConfig: unknown): ProjectLayout {
  const services = asObj(asObj(rayfinConfig)?.services) ?? {}
  const folder = (service: string): string | undefined => serviceFolder(asObj(services[service])?.path)
  const frontendRoot = folder('staticHosting') ?? ''
  // The CLI reads entities from a data package's exports; the project root
  // (the default) keeps them in `rayfin/data/`.
  const dataRoot = folder('data') || null
  return {
    frontendRoot,
    frontendSrc: joinPath(frontendRoot, 'src'),
    dataRoot,
    dataDir: dataRoot ? `${dataRoot}/src` : SINGLE_PACKAGE_LAYOUT.dataDir,
    schemaFile: dataRoot ? `${dataRoot}/src/index.ts` : SINGLE_PACKAGE_LAYOUT.schemaFile,
    functionsRoot: folder('functions') || SINGLE_PACKAGE_LAYOUT.functionsRoot
  }
}

/** The layout `rayfin/rayfin.yml`'s text describes (single-package when missing or unreadable). */
export function projectLayout(rayfinYml: string | null | undefined): ProjectLayout {
  if (!rayfinYml) return { ...SINGLE_PACKAGE_LAYOUT }
  try {
    return layoutOf(parseYaml(rayfinYml.replace(/^\uFEFF/, '')))
  } catch {
    return { ...SINGLE_PACKAGE_LAYOUT }
  }
}
