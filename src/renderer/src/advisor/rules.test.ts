import { describe, expect, it } from 'vitest'
import { AI_RULES, CATEGORIES, QUICK_RULES, RULES } from '@shared/advisor/catalog'
import { localSdkOf, matchesWorkspace } from './context'
import { QUICK_IMPLS } from './rules'
import { npmRangeSpan } from './source'
import { GOOD_PROJECT, check, versionInfo } from './testFixtures'

const TODO = GOOD_PROJECT['rayfin/data/Todo.ts']
const YML = GOOD_PROJECT['rayfin/rayfin.yml']

describe('rule catalog', () => {
  it('has an implementation for every quick rule and no stray implementations', () => {
    const quick = QUICK_RULES.map((r) => r.id).sort()
    expect([...QUICK_IMPLS.keys()].sort()).toEqual(quick)
  })

  it('is well formed', () => {
    const categories = new Set(CATEGORIES.map((c) => c.id))
    const ids = new Set<string>()
    for (const rule of RULES) {
      expect(ids.has(rule.id), rule.id).toBe(false)
      ids.add(rule.id)
      expect(categories.has(rule.category), rule.id).toBe(true)
      expect(rule.id.startsWith(`${rule.category}/`), rule.id).toBe(true)
      expect(rule.docs.length, rule.id).toBeGreaterThan(0)
      for (const d of rule.docs) expect(d.url, rule.id).toMatch(/^https:\/\//)
    }
    expect(AI_RULES.every((r) => Boolean(r.check?.trim()))).toBe(true)
    expect(QUICK_RULES.every((r) => !r.check)).toBe(true)
  })
})

describe('quick checks on a healthy project', () => {
  it('report no findings', async () => {
    const out = await check()
    expect(out.findings).toEqual([])
    expect(out.results.filter((r) => r.status === 'skipped')).toEqual([])
    expect(out.status('data-model/text-without-max')).toBe('pass')
    expect(out.status('platform/functions-mssql')).toBe('na')
  })
})

describe('npm ranges', () => {
  it('reads the releases a range allows', () => {
    const span = (range: string) => npmRangeSpan(range)
    expect(span('>=1.36.0 <1.37.0')).toEqual({ lo: [1, 36, 0], hi: [1, 37, 0] })
    expect(span('~1.36.0')).toEqual({ lo: [1, 36, 0], hi: [1, 37, 0] })
    expect(span('^1.36.2')).toEqual({ lo: [1, 36, 2], hi: [2, 0, 0] })
    expect(span('^0.2.3')).toEqual({ lo: [0, 2, 3], hi: [0, 3, 0] })
    expect(span('1.36.x')).toEqual({ lo: [1, 36, 0], hi: [1, 37, 0] })
    expect(span('1.36.2')).toEqual({ lo: [1, 36, 2], hi: [1, 36, 3] })
    expect(span('>= 1.35 <=1.36')).toEqual({ lo: [1, 35, 0], hi: [1, 37, 0] })
    expect(span('1.35.0 - 1.36')).toEqual({ lo: [1, 35, 0], hi: [1, 37, 0] })
    expect(span('~1.35.0 || ^2.0.0-alpha')).toEqual({ lo: [1, 35, 0], hi: [3, 0, 0] })
    expect(span('*')).toEqual({ lo: [0, 0, 0], hi: null })
    expect(span('latest')).toBeNull()
  })

  it('names the line of releases the local backend runs and its pin', () => {
    expect(localSdkOf('>=1.36.0 <1.37.0')).toMatchObject({ label: '1.36.x', pin: '~1.36.0' })
    expect(localSdkOf('>=1.36.2 <1.38.0')).toMatchObject({
      label: '>=1.36.2 <1.38.0',
      pin: '~1.36.2'
    })
    expect(localSdkOf(undefined)).toBeNull()
  })
})

/**
 * GOOD_PROJECT laid out like the Rayfin CLI's Universal App: the frontend and
 * the data model each in the npm package rayfin.yml names.
 */
function workspaceApp(overrides: Record<string, string> = {}): Record<string, string | null> {
  const files: Record<string, string | null> = {}
  for (const [path, text] of Object.entries(GOOD_PROJECT)) {
    const to =
      path === 'rayfin/data/schema.ts'
        ? 'packages/data/src/index.ts'
        : path.startsWith('rayfin/data/')
          ? `packages/data/src/${path.slice('rayfin/data/'.length)}`
          : path.startsWith('src/') || path === 'vite.config.ts'
            ? `packages/frontend/${path}`
            : path
    if (to !== path) files[path] = null
    files[to] = text
  }
  files['rayfin/rayfin.yml'] = GOOD_PROJECT['rayfin/rayfin.yml']
    .replace('  data:\n', '  data:\n    path: packages/data\n')
    .replace('  staticHosting:\n', '  staticHosting:\n    path: packages/frontend\n')
  files['packages/data/package.json'] = JSON.stringify({ name: '@rayfin-app/data' })
  return { ...files, ...overrides }
}

describe('quick checks on a workspace app (the Rayfin CLI Universal App layout)', () => {
  it('read the packages rayfin.yml names, and a healthy one reports no findings', async () => {
    const out = await check(workspaceApp())
    expect(out.findings).toEqual([])
    expect(out.ctx.layout.frontendSrc).toBe('packages/frontend/src')
    expect(out.ctx.dataPackage).toBe('@rayfin-app/data')
    expect(out.ctx.model.entities.map((e) => e.file)).toEqual(['packages/data/src/Todo.ts'])
    expect(out.ctx.frontend.map((f) => f.path)).toContain('packages/frontend/src/App.tsx')
    expect(out.status('data-model/text-without-max')).toBe('pass')
  })

  it('check the frontend, data model and env files in those packages', async () => {
    const out = await check(
      workspaceApp({
        'packages/data/src/Todo.ts': TODO.replace('@text({ max: 200 }) title', '@text() title'),
        'packages/data/src/Note.ts': [
          "import { entity, authenticated, uuid } from '@microsoft/rayfin-core';",
          '@entity()',
          "@authenticated('*', { policy: (claims, item) => claims.sub.eq(item.user_id) })",
          'export class Note {',
          '  @uuid() id!: string;',
          '}',
          ''
        ].join('\n'),
        'packages/frontend/src/auth.ts': 'client.auth.onAuthStateChange(() => {})\n',
        'packages/frontend/src/form.ts': "import { Todo } from '@rayfin-app/data'\nexport const T = Todo\n",
        'packages/frontend/.env': 'VITE_API_SECRET=k3yValue9a8b7c6d5e4f\n'
      })
    )
    expect(out.ids).toEqual(
      expect.arrayContaining([
        'data-model/text-without-max',
        'data-model/entity-not-registered',
        'access/on-auth-state-change',
        'config/swc-with-runtime-entities',
        'secrets/secret-in-public-env',
        'secrets/env-file-not-ignored'
      ])
    )
    expect(out.finding('data-model/entity-not-registered')!.detail).toContain('in index.ts')
    // The data model is reached by relative path too.
    const relative = await check(
      workspaceApp({ 'packages/frontend/src/form.ts': "import { Todo } from '../../data/src/Todo.js'\nexport const T = Todo\n" })
    )
    expect(relative.ids).toContain('config/swc-with-runtime-entities')
    // A type-only import of the data package is fine.
    const typeOnly = await check(
      workspaceApp({ 'packages/frontend/src/form.ts': "import type { Todo } from '@rayfin-app/data'\n" })
    )
    expect(typeOnly.ids).not.toContain('config/swc-with-runtime-entities')
  })
})

describe('access and policy rules', () => {
  it('flags entities without a permission decorator, grouped with locations', async () => {
    const note = [
      "import { entity, uuid, text } from '@microsoft/rayfin-core';",
      '@entity()',
      'export class Note {',
      '  @uuid() id!: string;',
      '  @text({ max: 100 }) body!: string;',
      '}',
      ''
    ].join('\n')
    const out = await check({
      'rayfin/data/Todo.ts': TODO.replace(/@authenticated\('\*', \{\n.*\n\}\)\n/, ''),
      'rayfin/data/Note.ts': note,
      'rayfin/data/schema.ts':
        "import { Todo } from './Todo.js';\nimport { Note } from './Note.js';\n\nexport type AppSchema = {\n  Todo: Todo;\n  Note: Note;\n};\n\nexport const schema = [Todo, Note];\n"
    })
    const f = out.finding('access/entity-missing-permission')
    expect(f).toBeDefined()
    expect(f!.severity).toBe('high')
    expect(f!.detail).toContain('2 entities')
    expect(f!.locations).toHaveLength(1)
    expect(f!.id).toBe('quick:access/entity-missing-permission')
    expect(f!.excerpt).toContain('export class')
  })

  it('flags owner fields whose write grants have no policy, but not shared reads', async () => {
    const open = TODO.replace(
      "@authenticated('*', {\n  policy: (claims, item) => claims.sub.eq(item.user_id),\n})",
      "@authenticated('*')"
    )
    expect((await check({ 'rayfin/data/Todo.ts': open })).ids).toContain('policy/owner-field-without-policy')
    const sharedRead = TODO.replace(
      "@authenticated('*', {",
      "@authenticated('read')\n@authenticated(['create', 'update', 'delete'], {"
    )
    expect((await check({ 'rayfin/data/Todo.ts': sharedRead })).ids).not.toContain(
      'policy/owner-field-without-policy'
    )
  })

  it('separates public writes from public reads', async () => {
    const write = await check({ 'rayfin/data/Todo.ts': TODO.replace('@entity()', "@entity()\n@anonymous('*')") })
    expect(write.ids).toContain('policy/anonymous-write')
    expect(write.ids).not.toContain('policy/anonymous-grant')
    const read = await check({ 'rayfin/data/Todo.ts': TODO.replace('@entity()', "@entity()\n@anonymous('read')") })
    expect(read.ids).toContain('policy/anonymous-grant')
    expect(read.ids).not.toContain('policy/anonymous-write')
  })

  it('says anonymous reads work locally but that publishing to most tenants fails', async () => {
    const files = { 'rayfin/data/Todo.ts': TODO.replace('@entity()', "@entity()\n@anonymous('read')") }
    expect((await check(files)).finding('policy/anonymous-grant')!.detail).toBe(
      '`Todo` allows anonymous reads. They work in the local preview, but publishing fails unless your tenant admin has turned on anonymous data access for Fabric apps.'
    )
    // A team app has no local preview.
    expect((await check(files, { localSdkRange: null })).finding('policy/anonymous-grant')!.detail).toBe(
      '`Todo` allows anonymous reads, which Fabric refuses unless your tenant admin has turned on anonymous data access for Fabric apps.'
    )
  })

  it('flags unsupported claims and the verbose role form', async () => {
    const out = await check({
      'rayfin/data/Todo.ts': TODO.replace(
        "@authenticated('*', {\n  policy: (claims, item) => claims.sub.eq(item.user_id),",
        "@role('authenticated', '*', {\n  policy: (claims, item) => claims.tenant.eq(item.user_id),"
      )
    })
    expect(out.ids).toEqual(expect.arrayContaining(['policy/unsupported-claim', 'policy/prefer-shorthand']))
    expect(out.finding('policy/prefer-shorthand')!.severity).toBe('note')
    expect(out.finding('policy/unsupported-claim')!.detail).toContain('claims.tenant')
  })

  it('flags onAuthStateChange but ignores it in comments', async () => {
    const flagged = await check({ 'src/auth.ts': 'client.auth.onAuthStateChange(() => {})\n' })
    expect(flagged.ids).toContain('access/on-auth-state-change')
    const commented = await check({ 'src/auth.ts': '// use onAuthStateChange? no — onSessionChange\n' })
    expect(commented.ids).not.toContain('access/on-auth-state-change')
  })

  it('flags Fabric SSO without its provider, and lazy-only provider imports', async () => {
    const pkg = JSON.parse(GOOD_PROJECT['package.json'])
    delete pkg.dependencies['@microsoft/rayfin-auth-provider-fabric']
    const missing = await check({
      'package.json': JSON.stringify(pkg, null, 2),
      'src/services/rayfinClient.ts': "import { RayfinClient } from '@microsoft/rayfin-client';\n"
    })
    expect(missing.ids).toContain('access/fabric-provider-missing')

    const lazy = await check({
      'src/services/rayfinClient.ts':
        "export async function signIn() {\n  const { ensureSignedInWithFabric } = await import('@microsoft/rayfin-auth-provider-fabric')\n}\n"
    })
    expect(lazy.ids).toContain('access/fabric-provider-dynamic-import')
  })

  it('reads dependencies declared in npm workspaces, like the Rayfin CLI Universal App', async () => {
    const pkg = JSON.parse(GOOD_PROJECT['package.json'])
    const provider = '@microsoft/rayfin-auth-provider-fabric'
    const frontend = { name: '@app/frontend', dependencies: { [provider]: pkg.dependencies[provider] } }
    delete pkg.dependencies[provider]
    const monorepo = (workspaces: unknown, at = 'packages/frontend/package.json') =>
      check({
        'package.json': JSON.stringify({ ...pkg, workspaces }, null, 2),
        [at]: JSON.stringify(frontend, null, 2)
      })
    expect((await monorepo(['packages/*'])).ids).not.toContain('access/fabric-provider-missing')
    expect((await monorepo({ packages: ['packages/frontend'] })).ids).not.toContain('access/fabric-provider-missing')
    // A manifest outside the declared workspaces doesn't count.
    expect((await monorepo(['apps/*'])).ids).toContain('access/fabric-provider-missing')
    expect((await monorepo(['packages/*'], 'packages/frontend/vendor/package.json')).ids).toContain(
      'access/fabric-provider-missing'
    )
  })

  it('matches npm workspace globs by folder', () => {
    expect(matchesWorkspace('packages/frontend', 'packages/*')).toBe(true)
    expect(matchesWorkspace('packages/frontend', './packages/frontend/')).toBe(true)
    expect(matchesWorkspace('packages/a/b', 'packages/**')).toBe(true)
    expect(matchesWorkspace('packages/a/b', 'packages/*')).toBe(false)
    expect(matchesWorkspace('packages', 'packages/*')).toBe(false)
    expect(matchesWorkspace('apps/web', 'app*/web')).toBe(true)
    expect(matchesWorkspace('packages.x/web', 'packages/*')).toBe(false)
    expect(matchesWorkspace('elsewhere', '../elsewhere')).toBe(false)
  })

  it('flags a wired-up mock auth service with fixture credentials', async () => {
    const mock = "export class MockAuthService {\n  private static MOCK_PASSWORD = 'LocalDev!Pass123'\n}\n"
    const out = await check({
      'src/services/MockAuthService.ts': mock,
      'src/services/bootstrap.ts': "import { MockAuthService } from './MockAuthService'\nexport const auth = new MockAuthService()\n"
    })
    const f = out.finding('access/mock-auth-credentials')
    expect(f).toBeDefined()
    expect(f!.excerpt).not.toContain('LocalDev!Pass123')
    const unused = await check({ 'src/services/MockAuthService.ts': mock })
    expect(unused.ids).not.toContain('access/mock-auth-credentials')
  })
})

describe('secrets rules', () => {
  it('flags secret-looking public variables without showing their values', async () => {
    const out = await check(
      { '.env.local': 'VITE_RAYFIN_PUBLISHABLE_KEY=pk-123\nVITE_OPENAI_API_KEY=sk-live-abcdefghijklmnop\nVITE_DB_PASSWORD=hunter22\n' },
      { ignored: ['.env.local'] }
    )
    const f = out.finding('secrets/secret-in-public-env')!
    expect(f.severity).toBe('high')
    expect(f.locations).toHaveLength(1)
    expect(f.excerpt).not.toContain('hunter22')
    expect(f.excerpt).not.toContain('sk-live-abcdefghijklmnop')
    expect(out.ids).not.toContain('secrets/env-file-not-ignored')
  })

  it('flags env files git does not ignore, skipping templates', async () => {
    const out = await check({ 'rayfin/.env': 'RAYFIN_PUBLIC_API_URL=https://x\n', '.env.example': 'X=\n' })
    const f = out.finding('secrets/env-file-not-ignored')!
    expect(f.file).toBe('rayfin/.env')
    expect(f.locations).toHaveLength(0)
    expect((await check({ 'rayfin/.env': 'A=1\n' }, { isGitRepo: false })).status('secrets/env-file-not-ignored')).toBe('na')
  })

  it('flags hard-coded credentials but not obvious placeholders', async () => {
    const out = await check({
      'src/services/ai.ts': "const key = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'\n",
      'scripts/deploy.ps1': 'rayfin login --client-secret s3cr3tValue!\n'
    })
    const f = out.finding('secrets/hardcoded-credential')!
    expect(f.locations).toHaveLength(1)
    expect(f.excerpt).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789')
    const fake = await check({ 'src/services/ai.ts': "const key = 'sk-proj-EXAMPLEabcdefghijklmnopqrstuvwxyz0123'\n" })
    expect(fake.ids).not.toContain('secrets/hardcoded-credential')
  })

  it('flags wildcard and insecure redirect URIs, keeping localhost http', async () => {
    const out = await check({
      'rayfin/rayfin.yml': YML.replace(
        '      - http://localhost:5173',
        '      - http://localhost:5173\n      - https://*.example.com\n      - http://myapp.example.com'
      )
    })
    const f = out.finding('secrets/redirect-uri-scope')!
    expect(f.detail).toContain('2 places')
  })

  it('flags a non-publishable key in the publishable slot and tracked deployment metadata', async () => {
    const out = await check(
      {
        '.env.local': 'VITE_RAYFIN_PUBLISHABLE_KEY=sk-oops-1234567890\n',
        'rayfin/.deployments.json': '{}'
      },
      { ignored: ['.env.local'] }
    )
    expect(out.ids).toEqual(
      expect.arrayContaining(['secrets/publishable-key-mismatch', 'secrets/deployments-file-tracked'])
    )
  })

  it('keeps the local backend folder out of git', async () => {
    const STATE = [
      '.rayfin-local/db.sqlite',
      '.rayfin-local/keys/signing.json',
      '.rayfin-local/secrets.json',
      '.rayfin-local/state.json'
    ]
    const rule = 'secrets/local-backend-not-ignored'
    const intact = { '.rayfin-local/.gitignore': '*\n' }
    // rayfin-local's own `.gitignore` ignores the whole folder, as does a project-wide entry.
    expect(
      (
        await check(intact, { listed: STATE, ignored: [...STATE, '.rayfin-local/.gitignore'] })
      ).status(rule)
    ).toBe('pass')
    expect((await check({}, { listed: STATE, ignored: STATE })).status(rule)).toBe('pass')

    const missing = (await check({}, { listed: STATE })).finding(rule)!
    expect(missing.severity).toBe('high')
    expect(missing.file).toBeUndefined()
    expect(missing.detail).toBe(
      "`.rayfin-local/.gitignore` is missing, so git can commit your secrets' local values, the local backend's signing keys, the app's local database and the local app's IDs (`.rayfin-local/secrets.json`, `.rayfin-local/keys/`, `.rayfin-local/db.sqlite`, `.rayfin-local/state.json`)."
    )

    // A changed `.gitignore` is the place to fix.
    const changed = (
      await check(
        { '.rayfin-local/.gitignore': 'db.sqlite\nkeys/\nsecrets.json\n' },
        { listed: STATE, ignored: STATE.slice(0, 3) }
      )
    ).finding(rule)!
    expect(changed.severity).toBe('low')
    expect(changed.file).toBe('.rayfin-local/.gitignore')
    expect(changed.excerpt).toContain('secrets.json')
    expect(changed.detail).toBe(
      "`.rayfin-local/.gitignore` no longer ignores everything in the folder, so git can commit the local app's IDs (`.rayfin-local/state.json`)."
    )

    // Files git already tracks stay in commits, whatever `.gitignore` says.
    const tracked = (
      await check(intact, {
        listed: STATE,
        ignored: ['.rayfin-local/.gitignore', ...STATE.slice(1)]
      })
    ).finding(rule)!
    expect(tracked.detail).toBe(
      "Git tracks files in `.rayfin-local/` even though `.rayfin-local/.gitignore` ignores the folder, so commits include the app's local database (`.rayfin-local/db.sqlite`)."
    )

    expect((await check({}, { listed: STATE, isGitRepo: false })).status(rule)).toBe('na')
    expect((await check()).status(rule)).toBe('na')
  })
})

describe('data model rules', () => {
  it('flags text fields without max, including @email and max: -1', async () => {
    const out = await check({
      'rayfin/data/Todo.ts': TODO.replace('@text({ max: 200 }) title', '@text() title').replace(
        '@boolean() done!: boolean;',
        '@boolean() done!: boolean;\n  @email({ max: -1 }) contact!: string;'
      )
    })
    const f = out.finding('data-model/text-without-max')!
    expect(f.detail).toContain('Todo.title')
    expect(f.detail).toContain('Todo.contact')
    expect(f.line).toBe(9)
  })

  it('accepts max given as a constant', async () => {
    const out = await check({ 'rayfin/data/Todo.ts': TODO.replace('max: 200', 'max: TITLE_MAX') })
    expect(out.ids).not.toContain('data-model/text-without-max')
  })

  it('checks relationship declarations and imports', async () => {
    const list = [
      "import { entity, authenticated, uuid, text, many } from '@microsoft/rayfin-core';",
      "import type { Todo } from './Todo';",
      '@entity()',
      "@authenticated('read')",
      'export class List {',
      '  @uuid() id!: string;',
      '  @text({ max: 80 }) name!: string;',
      '  @many(() => Todo) todos?: Todo[];',
      '}',
      ''
    ].join('\n')
    const todo = TODO.replace(
      "import { entity, authenticated, uuid, text, boolean } from '@microsoft/rayfin-core';",
      "import { entity, authenticated, uuid, text, boolean, one } from '@microsoft/rayfin-core';\nimport { List } from './List.js';"
    ).replace('@boolean() done!: boolean;', '@boolean() done!: boolean;\n  @text({ max: 36 }) list_id!: string;\n  @one(List) list?: List;')
    const out = await check({
      'rayfin/data/List.ts': list,
      'rayfin/data/Todo.ts': todo,
      'rayfin/data/schema.ts':
        "import { Todo } from './Todo.js';\nimport { List } from './List.js';\n\nexport type AppSchema = {\n  Todo: Todo;\n  List: List;\n};\n\nexport const schema = [Todo, List];\n"
    })
    expect(out.ids).toEqual(
      expect.arrayContaining(['data-model/fk-typed-text', 'data-model/relation-not-lazy', 'data-model/relation-import-type'])
    )
    const imports = out.finding('data-model/relation-import-type')!
    expect(imports.severity).toBe('high')
    expect(imports.detail).toContain('2 places')
  })

  it('flags half-registered and unregistered entities', async () => {
    const extra = TODO.replace(/class Todo/, 'class Tag').replace("'*'", "'read'")
    const out = await check({
      'rayfin/data/Tag.ts': extra,
      'rayfin/data/schema.ts': "import { Todo } from './Todo.js';\n\nexport type AppSchema = {\n  Todo: Todo;\n  Label: Todo;\n};\n\nexport const schema = [Todo];\n"
    })
    const f = out.finding('data-model/entity-not-registered')!
    expect(f.detail).toContain('Tag')
    expect(f.detail).toContain('Label')
  })

  it('flags undecorated and double-decorated fields, decimal options, nullability, and many-to-many', async () => {
    const tag = [
      "import { entity, authenticated, uuid, text, many } from '@microsoft/rayfin-core';",
      "import { Todo } from './Todo.js';",
      '@entity()',
      "@authenticated('read')",
      'export class Tag {',
      '  @uuid() id!: string;',
      '  @text({ max: 40 }) label!: string;',
      '  @many(() => Todo) todos?: Todo[];',
      '}',
      ''
    ].join('\n')
    const todo = TODO.replace(
      "import { entity, authenticated, uuid, text, boolean } from '@microsoft/rayfin-core';",
      "import { entity, authenticated, uuid, text, boolean, decimal, many } from '@microsoft/rayfin-core';\nimport { Tag } from './Tag.js';"
    ).replace(
      '@boolean() done!: boolean;',
      [
        '@boolean() done!: boolean;',
        '  notes!: string;',
        '  @decimal({ precision: 30, scale: 2 }) cost!: number;',
        '  @text({ max: 50, optional: true }) color!: string;',
        '  @many(() => Tag) tags?: Tag[];'
      ].join('\n')
    )
    const out = await check({
      'rayfin/data/Tag.ts': tag,
      'rayfin/data/Todo.ts': todo,
      'rayfin/data/schema.ts':
        "import { Todo } from './Todo.js';\nimport { Tag } from './Tag.js';\n\nexport type AppSchema = {\n  Todo: Todo;\n  Tag: Tag;\n};\n\nexport const schema = [Todo, Tag];\n"
    })
    expect(out.ids).toEqual(
      expect.arrayContaining([
        'data-model/field-missing-decorator',
        'data-model/decimal-precision',
        'data-model/nullable-mismatch',
        'data-model/many-to-many'
      ])
    )
  })
})

describe('query rules', () => {
  it('flags query API misuse in frontend code', async () => {
    const service = [
      "import { client } from './rayfinClient';",
      'export async function stats() {',
      '  const n = await client.data.Todo.count();',
      "  const one = await client.data.Todo.findByPk('1');",
      "  const page = await client.data.Todo.select(['id']).first(20).executePaginated();",
      '  console.log(page.totalCount);',
      "  await client.data.Todo.select(['id']).where({ 'list.id': { eq: '1' } }).execute();",
      "  await client.data.Todo.select(['list.owner.email']).execute();",
      "  await client.data.Todo.groupBy(['done']).aggregate({ n: { count: 'score' } }).orderBy({ done: 'asc' }).execute();",
      "  await client.data.Todo.select(['id']).orderBy({ title: 'DESC' }).first(5000).executePaginated();",
      "  await fetch(`${import.meta.env.VITE_RAYFIN_API_URL}graphql`, { method: 'POST' });",
      '  return [n, one]',
      '}',
      ''
    ].join('\n')
    const out = await check({ 'src/services/stats.ts': service })
    expect(out.ids).toEqual(
      expect.arrayContaining([
        'queries/count-method',
        'queries/find-by-pk',
        'queries/total-count',
        'queries/where-dot-path',
        'queries/select-nested-path',
        'queries/aggregate-with-row-methods',
        'queries/sort-direction-case',
        'queries/raw-data-fetch',
        'performance/oversized-page'
      ])
    )
    expect(out.finding('queries/count-method')!.line).toBe(3)
  })

  it('does not flag array counts, one-level selects, or FK filters', async () => {
    const service = [
      "import { client } from './rayfinClient';",
      'export async function ok(items: string[]) {',
      '  const count = items.filter(Boolean).length;',
      "  await client.data.Todo.select(['id', 'list.name']).where({ list_id: { eq: '1' } }).first(10).executePaginated();",
      '  return count',
      '}',
      ''
    ].join('\n')
    const out = await check({ 'src/services/ok.ts': service })
    expect(out.findings).toEqual([])
  })
})

describe('config rules', () => {
  it('flags rayfin.yml problems', async () => {
    const out = await check({
      'rayfin/rayfin.yml': 'frontend:\n  framework: vite\nservices:\n  data:\n    enabled: true\n  staticHosting:\n    enabled: true\n    folder: build\n'
    })
    expect(out.ids).toEqual(
      expect.arrayContaining([
        'config/missing-service-blocks',
        'config/data-dialect',
        'config/static-hosting-folder',
        'config/deprecated-yml-keys'
      ])
    )
    expect(out.finding('config/data-dialect')!.line).toBe(4)
  })

  it('flags legacy decorators and a missing ESNext.Decorators lib', async () => {
    const out = await check({
      'tsconfig.json': JSON.stringify({ compilerOptions: { lib: ['ES2022'], experimentalDecorators: true } }, null, 2)
    })
    expect(out.ids).toEqual(expect.arrayContaining(['config/experimental-decorators', 'config/decorators-lib']))
    expect(out.finding('config/decorators-lib')!.file).toBe('tsconfig.json')
  })

  it('only flags SWC and the Vite target when entity classes reach the browser', async () => {
    expect((await check()).ids).not.toContain('config/swc-with-runtime-entities')
    const runtime = await check({
      'src/form.ts': "import { Todo } from '../rayfin/data/Todo';\nexport const T = Todo\n",
      'vite.config.ts': "import react from '@vitejs/plugin-react-swc'\nexport default { plugins: [react()] }\n"
    })
    expect(runtime.ids).toEqual(expect.arrayContaining(['config/swc-with-runtime-entities', 'config/vite-target']))
    const typeOnly = await check({ 'src/form.ts': "import type { Todo } from '../rayfin/data/Todo';\n" })
    expect(typeOnly.ids).not.toContain('config/swc-with-runtime-entities')
  })
})

describe('platform rules', () => {
  it('grades outdated versions by how far behind they are', async () => {
    // A team app, which the local backend doesn't run: every newer release counts.
    const team = { localSdkRange: null }
    const minor = await check({}, { ...team, versions: versionInfo('1.33.2', '1.35.1') })
    expect(minor.finding('platform/cli-outdated')!.severity).toBe('medium')
    expect(minor.finding('platform/sdk-outdated')!.severity).toBe('medium')
    const major = await check({}, { ...team, versions: versionInfo('1.35.1', '2.0.0') })
    expect(major.finding('platform/cli-outdated')!.severity).toBe('high')
    const patch = await check({}, { ...team, versions: versionInfo('1.35.0', '1.35.1') })
    expect(patch.finding('platform/cli-outdated')!.severity).toBe('low')
    const offline = await check({}, { versions: null })
    expect(offline.status('platform/cli-outdated')).toBe('skipped')
  })

  it('only counts releases the local backend runs as updates for apps it runs', async () => {
    const beyond = await check({}, { versions: versionInfo('1.36.2', '1.37.0') })
    expect(beyond.status('platform/cli-outdated')).toBe('pass')
    expect(beyond.status('platform/sdk-outdated')).toBe('pass')
    const patch = await check({}, { versions: versionInfo('1.36.0', '1.36.2') })
    expect(patch.finding('platform/cli-outdated')!.severity).toBe('low')
    expect(patch.finding('platform/sdk-outdated')!.severity).toBe('low')
  })

  it('keeps Rayfin packages on the releases the local backend runs', async () => {
    const pkg = JSON.parse(GOOD_PROJECT['package.json'])
    const declare = (deps: Record<string, string>): string =>
      JSON.stringify({ ...pkg, dependencies: { ...pkg.dependencies, ...deps } }, null, 2)
    // New projects' `~1.36.0` pins pass (GOOD_PROJECT uses them).
    expect((await check()).status('platform/sdk-local-range')).toBe('pass')

    const manifest = declare({ '@microsoft/rayfin-core': '^1.36.0' })
    const caret = await check({ 'package.json': manifest })
    const loose = caret.finding('platform/sdk-local-range')!
    expect(loose.severity).toBe('low')
    expect(loose.detail).toBe(
      '`@microsoft/rayfin-core` is declared as `^1.36.0`, so the next install can move it past Rayfin 1.36.x, the releases Fabricator runs on this computer. Pin it to `~1.36.0`.'
    )
    expect(loose.line).toBe(
      manifest.split('\n').findIndex((l) => l.includes('"@microsoft/rayfin-core"')) + 1
    )

    const outside = await check({
      'package.json': declare({
        '@microsoft/rayfin-client': '~1.35.0',
        '@microsoft/rayfin-core': 'latest'
      })
    })
    const both = outside.finding('platform/sdk-local-range')!
    expect(both.severity).toBe('medium')
    expect(both.detail).toBe(
      "These Rayfin packages aren't on Rayfin 1.36.x, the releases Fabricator runs on this computer: rayfin-client ~1.35.0, rayfin-core latest. Pin them to `~1.36.0`, and reinstall."
    )

    // Installed outside the line, though declared right: reinstall.
    const stale = await check(
      {},
      { packages: [{ name: '@microsoft/rayfin-core', installed: '1.37.0', declared: '~1.36.0' }] }
    )
    const reinstall = stale.finding('platform/sdk-local-range')!
    expect(reinstall.severity).toBe('medium')
    expect(reinstall.detail).toContain('is installed at 1.37.0')
    expect(reinstall.detail).toContain('Run `npm install`')

    // The functions package's manifest counts too.
    const functions = await check({
      'rayfin/functions/package.json': JSON.stringify({
        dependencies: { '@microsoft/rayfin-functions': '^1.36.2' }
      })
    })
    expect(functions.finding('platform/sdk-local-range')!.file).toBe(
      'rayfin/functions/package.json'
    )

    // Team apps don't run on the local backend.
    expect(
      (await check({ 'package.json': manifest }, { localSdkRange: null })).status(
        'platform/sdk-local-range'
      )
    ).toBe('na')
  })

  it('accepts `~` pins for connector packages but not caret ranges', async () => {
    const connector = (declared: string) =>
      check(
        {},
        {
          packages: [
            { name: '@microsoft/rayfin-cli', installed: '1.36.2', declared: '~1.36.0' },
            { name: '@microsoft/rayfin-connector-kusto', installed: '1.36.2', declared }
          ]
        }
      )
    expect((await connector('~1.36.0')).status('platform/connector-version')).toBe('pass')
    expect((await connector('1.36.2')).status('platform/connector-version')).toBe('pass')
    expect((await connector('^1.36.0')).finding('platform/connector-version')!.detail).toBe(
      "`@microsoft/rayfin-connector-kusto` is declared as `^1.36.0`, which can install a different release than the CLI's."
    )
    expect((await connector('~1.36')).status('platform/connector-version')).toBe('pass')
    expect((await connector('~1')).status('platform/connector-version')).toBe('fail')
  })

  it('notes connectors that run only on Fabric, for apps the local backend runs', async () => {
    const yml = `${YML}connectors:\n  - name: sales\n    type: fabric-semanticmodel\n  - name: orders\n    type: fabric-sqldatabase\n  - name: logs\n    type: kusto\n`
    const out = await check({ 'rayfin/rayfin.yml': yml })
    const f = out.finding('platform/connector-fabric-only')!
    expect(f.severity).toBe('note')
    expect(f.detail).toBe(
      "`logs` is a `kusto` connector, which runs only on Fabric, so the local preview can't call it. Until the app is published, those calls fail; after that, the preview uses the published app's backend."
    )
    expect(f.line).toBe(yml.split('\n').indexOf('  - name: logs') + 1)
    // A team app previews on Fabric, where the connector runs.
    const team = await check({ 'rayfin/rayfin.yml': yml }, { localSdkRange: null })
    expect(team.status('platform/connector-fabric-only')).toBe('na')
  })

  it('flags SDK packages installed at different versions', async () => {
    const out = await check(
      {},
      {
        packages: [
          { name: '@microsoft/rayfin-cli', installed: '1.35.1', declared: '1.35.1' },
          { name: '@microsoft/rayfin-core', installed: '1.35.1', declared: '1.35.1' },
          { name: '@microsoft/rayfin-client', installed: '1.35.1', declared: '1.35.1' },
          { name: '@microsoft/rayfin-lib', installed: '1.34.0' }
        ]
      }
    )
    expect(out.finding('platform/sdk-lockstep')!.detail).toContain('rayfin-lib 1.34.0')
  })

  it('checks connector wiring rules', async () => {
    const out = await check(
      {
        'rayfin/rayfin.yml': `${YML}connectors:\n  - name: sales\n    type: fabric-semanticmodel\n    auth:\n      type: application\n`,
        'rayfin/connectors/sales/schema.ts': "import { Sales } from './Sales.js';\nexport type AppConnectorsSchema = { sales: Sales };\n",
        'rayfin/connectors/sales/Sales.ts': 'export class Sales {}\n',
        'rayfin/connectors/old/schema.ts': 'export {}\n',
        'src/connectors.ts': "import { ConnectorsRayfinClient } from '@microsoft/rayfin-client/experimental';\n"
      },
      {
        packages: [
          { name: '@microsoft/rayfin-cli', installed: '1.35.1', declared: '1.35.1' },
          { name: '@microsoft/rayfin-core', installed: '1.35.1', declared: '1.35.1' },
          { name: '@microsoft/rayfin-connector-fabric-semanticmodel', installed: '1.34.0', declared: '^1.34.0' }
        ]
      }
    )
    expect(out.ids).toEqual(
      expect.arrayContaining([
        'platform/connector-app-auth',
        'platform/connector-schema-value-import',
        'platform/connector-client-experimental-import',
        'platform/connector-orphaned-dir',
        'platform/connector-version'
      ])
    )
    expect(out.finding('platform/connector-orphaned-dir')!.detail).toContain('old')
  })

  it('reads the older map-shaped connectors block and flags its shape', async () => {
    const out = await check({
      'rayfin/rayfin.yml': `${YML}connectors:\n  sales:\n    connector: kusto\n    auth:\n      type: application\n`,
      'rayfin/connectors/sales/schema.ts': 'export {}\n'
    })
    expect(out.ids).toEqual(expect.arrayContaining(['config/connectors-list-shape', 'platform/connector-app-auth']))
    expect(out.ids).not.toContain('platform/connector-orphaned-dir')
    expect((await check()).status('config/connectors-list-shape')).toBe('na')
  })

  it('checks functions, their availability, and experimental storage', async () => {
    const out = await check({
      'rayfin/rayfin.yml': YML.replace('  staticHosting:', '  functions:\n    enabled: true\n  staticHosting:'),
      'rayfin/functions/package.json': JSON.stringify({ dependencies: { mssql: '^11.0.1' } }, null, 2),
      'rayfin/functions/src/function_app.ts':
        "import { RayfinContext } from '@microsoft/rayfin-functions';\nconst cfg = { options: { encrypt: 'strict' } }\n"
    })
    expect(out.ids).toEqual(
      expect.arrayContaining([
        'platform/functions-context-import',
        'platform/functions-mssql',
        'platform/functions-availability',
        'config/functions-auth'
      ])
    )
    expect(out.ids).not.toContain('platform/experimental-services')
    expect(out.finding('platform/functions-availability')!.severity).toBe('note')
    expect(out.finding('config/functions-auth')!.severity).toBe('high')

    const withAuth = await check({
      'rayfin/rayfin.yml': YML.replace(
        '  staticHosting:',
        '  functions:\n    enabled: true\n    auth:\n      type: application\n  storage:\n    enabled: true\n  staticHosting:'
      )
    })
    expect(withAuth.ids).not.toContain('config/functions-auth')
    expect(withAuth.finding('platform/experimental-services')!.detail).toContain('storage')
  })

  it('flags deprecated Fabric callbacks and missing agent files', async () => {
    const out = await check({
      'src/pages/AuthCallback.tsx':
        "import { bridgeFabricCallback } from '@microsoft/rayfin-auth-provider-fabric';\nbridgeFabricCallback();\n",
      '.agents/skills/rayfin/SKILL.md': null
    })
    expect(out.ids).toEqual(expect.arrayContaining(['platform/deprecated-fabric-callback', 'platform/ai-files-missing']))
  })
})

describe('Rayfin 1.36 rules', () => {
  it('flags reserved entity names and unsupported relationship options', async () => {
    const event = [
      "import { entity, authenticated, uuid, text, one } from '@microsoft/rayfin-core';",
      "import { Todo } from './Todo.js';",
      '',
      '@entity()',
      "@authenticated('read')",
      'export class Date {',
      '  @uuid() id!: string;',
      '  @text({ max: 50 }) label!: string;',
      "  @one(() => Todo, { optional: true, foreignKey: 'todo' }) todo?: Todo;",
      '}',
      ''
    ].join('\n')
    const out = await check({
      'rayfin/data/Date.ts': event,
      'rayfin/data/schema.ts':
        "import { Todo } from './Todo.js';\nimport { Date } from './Date.js';\n\nexport type AppSchema = {\n  Todo: Todo;\n  Date: Date;\n};\n\nexport const schema = [Todo, Date];\n"
    })
    expect(out.finding('data-model/reserved-entity-name')!.detail).toContain('`Date`')
    const relation = out.finding('data-model/relation-options')!
    expect(relation.detail).toContain('passes `foreignKey` to `@one`')

    const renamed = await check({
      'rayfin/data/Date.ts': event.replace('@entity()', "@entity('EventDate')").replace(", foreignKey: 'todo'", '')
    })
    expect(renamed.ids).not.toContain('data-model/reserved-entity-name')
    expect(renamed.ids).not.toContain('data-model/relation-options')
  })

  it('flags removed experimental imports, removed audiences, and the old context API', async () => {
    const out = await check({
      'rayfin/data/Note.ts':
        "import { entity, text, blob } from '@microsoft/rayfin-core/experimental';\nexport const x = [entity, text, blob]\n",
      'rayfin/rayfin.yml': YML.replace(
        '  staticHosting:',
        '  functions:\n    enabled: true\n    auth:\n      type: application\n  staticHosting:'
      ),
      'rayfin/functions/src/function_app.ts': [
        'export const f = async (ctx) => {',
        '  const a = AudienceType.KeyVault',
        "  const t = await ctx.getToken(AudienceType.Sql)",
        "  const s = await ctx.getSecret('API_KEY')",
        '  return [a, t, s]',
        '}',
        ''
      ].join('\n')
    })
    const moved = out.finding('platform/removed-experimental-import')!
    expect(moved.detail).toContain('`entity`, `text`')
    expect(moved.detail).not.toContain('`blob`')
    expect(out.finding('platform/functions-removed-audience')!.detail).toContain('AudienceType.KeyVault')
    expect(out.finding('platform/functions-legacy-context-api')!.locations).toHaveLength(1)

    // Code that's correct for an older Rayfin isn't flagged by 1.36-only rules.
    const older = await check(
      { 'rayfin/data/Note.ts': "import { entity } from '@microsoft/rayfin-core/experimental';\n" },
      { packages: [{ name: '@microsoft/rayfin-core', installed: '1.35.1', declared: '1.35.1' }] }
    )
    expect(older.status('platform/removed-experimental-import')).toBe('na')
  })

  it('checks rayfin.yml settings that changed in 1.35.1 and 1.36', async () => {
    const yml = YML.replace('    assetAccess: protected\n', '')
      .replace('  staticHosting:', '  connectors:\n    enabled: true\n  staticHosting:')
      .replace('    enabled: true\n    folder: dist', '    enabled: true\n    anonymousAccess: true\n    folder: dist')
    const out = await check({
      'rayfin/rayfin.yml': yml,
      'rayfin/.env.local': 'RAYFIN_FEATURE_FLAGS=storage,functions\nSECRET_TOKEN=abc123\n'
    })
    expect(out.finding('config/static-hosting-posture')!.severity).toBe('low')
    const deprecated = out.finding('config/deprecated-yml-keys')!
    expect(deprecated.detail).toMatch(/services\.connectors\.enabled/)
    expect(deprecated.detail).toMatch(/anonymousAccess/)
    const flags = out.finding('config/stale-feature-flags')!
    expect(flags.detail).toContain('`functions`')
    expect(flags.excerpt).not.toContain('SECRET_TOKEN')

    const embedded = await check({
      'rayfin/rayfin.yml': YML.replace('    assetAccess: protected', '    assetAccess: public\n    embedded:\n      only: true')
    })
    expect(embedded.finding('config/embedded-public-conflict')!.severity).toBe('high')
  })

  it('flags Entra token sign-in without the exchange enabled', async () => {
    const direct = "import { signInWithEntraToken } from '@microsoft/rayfin-auth-provider-fabric';\nawait signInWithEntraToken(client.auth, { entraToken })\n"
    const local =
      "if (import.meta.env.DEV) {\n  const localDev = await import('@microsoft/rayfin-local-dev');\n  const token = await localDev.fetchRayfinLocalSessionToken();\n}\n"
    const enabled = YML.replace(
      '    fabric:\n      enabled: true',
      '    fabric:\n      enabled: true\n      externalEntraExchange: true'
    )
    for (const [call, source] of [
      ['signInWithEntraToken()', direct],
      ['fetchRayfinLocalSessionToken()', local]
    ]) {
      const off = await check({ 'src/services/auth.ts': source })
      expect(off.finding('access/entra-exchange-not-enabled')?.detail).toContain(call)
      const on = await check({ 'src/services/auth.ts': source, 'rayfin/rayfin.yml': enabled })
      expect(on.ids).not.toContain('access/entra-exchange-not-enabled')
    }
  })
})

describe('accessibility rules', () => {
  it('flags images without alt text but not ones with alt or spread props', async () => {
    const out = await check({
      'src/Gallery.tsx':
        'export const G = (p: object) => (\n  <div>\n    <img src="/a.png" />\n    <img src="/b.png" alt="" />\n    <img {...p} />\n    <img src={url} onLoad={() => x > 1} alt={label} />\n  </div>\n)\n'
    })
    const f = out.finding('accessibility/img-alt')!
    expect(f.line).toBe(3)
    expect(f.locations).toHaveLength(0)
  })
})
