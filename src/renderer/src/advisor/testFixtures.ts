import type {
  AdvisorPackage,
  AdvisorProjectSnapshot,
  RayfinPackageVersion,
  RayfinVersionInfo
} from '@shared/ipc'
import { buildQuickContext } from './context'
import { runQuickRules } from './engine'

/** A small, healthy Fabricator-style Rayfin app that passes every quick rule. */
export const GOOD_PROJECT: Record<string, string> = {
  'package.json': JSON.stringify(
    {
      dependencies: {
        '@microsoft/rayfin-auth-provider-fabric': '~1.36.0',
        '@microsoft/rayfin-client': '~1.36.0',
        '@microsoft/rayfin-core': '~1.36.0',
        react: '^19.0.0'
      },
      devDependencies: {
        '@microsoft/rayfin-cli': '~1.36.0',
        '@vitejs/plugin-react-swc': '^4.2.2',
        vite: '^7.3.2'
      }
    },
    null,
    2
  ),
  'rayfin/rayfin.yml': [
    'services:',
    '  auth:',
    '    enabled: true',
    '    fabric:',
    '      enabled: true',
    '    allowedRedirectUris:',
    '      - http://localhost:5173',
    '  data:',
    '    enabled: true',
    '    dialect: mssql',
    '  staticHosting:',
    '    enabled: true',
    '    folder: dist',
    '    assetAccess: protected',
    ''
  ].join('\n'),
  'tsconfig.json': JSON.stringify(
    {
      compilerOptions: { target: 'ES2022', lib: ['ES2022', 'DOM', 'ESNext.Decorators'] },
      include: ['src'],
      references: [{ path: './rayfin' }]
    },
    null,
    2
  ),
  'rayfin/tsconfig.json': JSON.stringify(
    { extends: '../tsconfig.json', compilerOptions: { composite: true } },
    null,
    2
  ),
  'vite.config.ts': [
    "import react from '@vitejs/plugin-react-swc'",
    "import { defineConfig } from 'vite'",
    '',
    'export default defineConfig({',
    '  plugins: [react()],',
    "  build: { target: 'es2022' }",
    '})',
    ''
  ].join('\n'),
  'rayfin/data/schema.ts': [
    "import { Todo } from './Todo.js';",
    '',
    'export type AppSchema = {',
    '  Todo: Todo;',
    '};',
    '',
    'export const schema = [Todo];',
    ''
  ].join('\n'),
  'rayfin/data/Todo.ts': [
    "import { entity, authenticated, uuid, text, boolean } from '@microsoft/rayfin-core';",
    '',
    '@entity()',
    "@authenticated('*', {",
    '  policy: (claims, item) => claims.sub.eq(item.user_id),',
    '})',
    'export class Todo {',
    '  @uuid() id!: string;',
    '  @text({ max: 200 }) title!: string;',
    '  @boolean() done!: boolean;',
    '  @text({ max: 128 }) user_id!: string;',
    '}',
    ''
  ].join('\n'),
  'src/services/rayfinClient.ts': [
    "import { RayfinClient } from '@microsoft/rayfin-client';",
    "import { ensureSignedInWithFabric } from '@microsoft/rayfin-auth-provider-fabric';",
    "import type { AppSchema } from '../../rayfin/data/schema';",
    '',
    "export const client = new RayfinClient<AppSchema>({ baseUrl: '', publishableKey: '' });",
    'export { ensureSignedInWithFabric };',
    ''
  ].join('\n'),
  'src/services/todos.ts': [
    "import { client } from './rayfinClient';",
    '',
    'export async function listTodos() {',
    "  return client.data.Todo.select(['id', 'title']).orderBy({ title: 'asc' }).first(50).executePaginated();",
    '}',
    ''
  ].join('\n'),
  'src/App.tsx': [
    'export default function App() {',
    '  return <img src="/logo.svg" alt="Todo app" />',
    '}',
    ''
  ].join('\n'),
  '.agents/skills/rayfin/SKILL.md': '# Rayfin\n'
}

const INSTALLED: AdvisorPackage[] = [
  { name: '@microsoft/rayfin-auth-provider-fabric', installed: '1.36.2', declared: '~1.36.0', dev: false },
  { name: '@microsoft/rayfin-cli', installed: '1.36.2', declared: '~1.36.0', dev: true },
  { name: '@microsoft/rayfin-client', installed: '1.36.2', declared: '~1.36.0', dev: false },
  { name: '@microsoft/rayfin-core', installed: '1.36.2', declared: '~1.36.0', dev: false },
  { name: '@microsoft/rayfin-data', installed: '1.36.2' },
  { name: '@microsoft/rayfin-lib', installed: '1.36.2' }
]

/** The Rayfin releases the bundled local backend runs, as `rayfin-local.json` says. */
export const LOCAL_SDK_RANGE = '>=1.36.0 <1.37.0'

export function versionInfo(installed = '1.36.2', latest = '1.36.2'): RayfinVersionInfo {
  const pkg = (name: string, kind: 'cli' | 'sdk'): RayfinPackageVersion => ({
    name,
    kind,
    installed,
    latest,
    upgradable: installed !== latest
  })
  return {
    version: installed,
    latest,
    upgradeAvailable: installed !== latest,
    packages: [
      pkg('@microsoft/rayfin-auth-provider-fabric', 'sdk'),
      pkg('@microsoft/rayfin-cli', 'cli'),
      pkg('@microsoft/rayfin-client', 'sdk'),
      pkg('@microsoft/rayfin-core', 'sdk')
    ]
  }
}

export interface FixtureOptions {
  /** Paths git ignores. */
  ignored?: string[]
  /** Files that exist but whose contents weren't collected. */
  listed?: string[]
  packages?: AdvisorPackage[]
  isGitRepo?: boolean
  /** The local backend's supported range (default {@link LOCAL_SDK_RANGE}); `null` for an app it doesn't run, such as a team app. */
  localSdkRange?: string | null
}

export function snapshotOf(files: Record<string, string | null>, opts: FixtureOptions = {}): AdvisorProjectSnapshot {
  const contents: Record<string, string> = {}
  for (const [path, text] of Object.entries(files)) if (text !== null) contents[path] = text
  const ignored = new Set(opts.ignored ?? [])
  const paths = new Set([...Object.keys(contents), ...(opts.listed ?? [])])
  return {
    files: [...paths].sort().map((path) => ({
      path,
      size: contents[path]?.length ?? 0,
      ignored: ignored.has(path) || undefined
    })),
    contents,
    isGitRepo: opts.isGitRepo ?? true,
    packages: opts.packages ?? INSTALLED,
    localSdkRange: opts.localSdkRange === null ? undefined : (opts.localSdkRange ?? LOCAL_SDK_RANGE)
  }
}

/** Run the quick rules over `GOOD_PROJECT` with `overrides` applied (null deletes a file). */
export async function check(
  overrides: Record<string, string | null> = {},
  opts: FixtureOptions & { versions?: RayfinVersionInfo | null } = {}
) {
  const snapshot = snapshotOf({ ...GOOD_PROJECT, ...overrides }, opts)
  const ctx = await buildQuickContext(snapshot, opts.versions === undefined ? versionInfo() : opts.versions)
  const out = runQuickRules(ctx)
  return {
    ...out,
    ctx,
    ids: out.findings.map((f) => f.ruleId).sort(),
    finding: (ruleId: string) => out.findings.find((f) => f.ruleId === ruleId),
    status: (ruleId: string) => out.results.find((r) => r.ruleId === ruleId)?.status
  }
}
