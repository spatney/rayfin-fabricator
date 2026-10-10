import { describe, expect, it } from 'vitest'
import {
  isUnder,
  joinPath,
  projectLayout,
  relativeTo,
  serviceFolder,
  SINGLE_PACKAGE_LAYOUT
} from './projectLayout'

describe('projectLayout', () => {
  it('uses the root and rayfin folders for single-package apps', () => {
    for (const yml of [null, '', 'not: [valid', 'services:\n  data:\n    enabled: true\n', 'services:\n  data:\n    path: .\n']) {
      expect(projectLayout(yml), String(yml)).toEqual(SINGLE_PACKAGE_LAYOUT)
    }
  })

  it('uses the packages rayfin.yml names, as in the Rayfin CLI Universal App', () => {
    const yml = [
      '\uFEFFservices:',
      '  data:',
      '    enabled: false',
      '    path: packages/data',
      '  staticHosting:',
      '    path: ./packages/frontend/',
      '  functions:',
      '    path: packages\\functions',
      ''
    ].join('\n')
    expect(projectLayout(yml)).toEqual({
      frontendRoot: 'packages/frontend',
      frontendSrc: 'packages/frontend/src',
      dataRoot: 'packages/data',
      dataDir: 'packages/data/src',
      schemaFile: 'packages/data/src/index.ts',
      functionsRoot: 'packages/functions'
    })
  })

  it('ignores paths that would leave the project', () => {
    for (const outside of ['../elsewhere', '/abs/app', 'C:/app', 'packages/../../x']) {
      expect(serviceFolder(outside), outside).toBeUndefined()
      const yml = `services:\n  data:\n    path: ${JSON.stringify(outside)}\n  staticHosting:\n    path: ${JSON.stringify(outside)}\n`
      expect(projectLayout(yml), outside).toEqual(SINGLE_PACKAGE_LAYOUT)
    }
    expect(serviceFolder(' ./a//b/ ')).toBe('a/b')
    expect(serviceFolder(3)).toBeUndefined()
  })

  it('matches paths by folder', () => {
    expect(relativeTo('packages/frontend/src/App.tsx', 'packages/frontend')).toBe('src/App.tsx')
    expect(relativeTo('packages/frontend-old/x.ts', 'packages/frontend')).toBeUndefined()
    expect(relativeTo('src/App.tsx', '')).toBe('src/App.tsx')
    expect(isUnder('rayfin/data/Todo.ts', 'rayfin/data')).toBe(true)
    expect(isUnder('rayfin/database.ts', 'rayfin/data')).toBe(false)
    expect(joinPath('', 'src')).toBe('src')
    expect(joinPath('packages/frontend', 'src')).toBe('packages/frontend/src')
  })
})
