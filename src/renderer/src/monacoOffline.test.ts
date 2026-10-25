/// <reference types="node" />
import { readdirSync, readFileSync } from 'fs'
import { join, relative, resolve } from 'path'
import { describe, expect, it } from 'vitest'

// Fabricator runs offline from Tauri's custom protocol, so every module that uses
// @monaco-editor/react must also load ./monaco, which hands the bundled Monaco to the
// loader (`loader.config({ monaco })`). Without it the editor tries to fetch Monaco from
// a CDN and never appears. Component tests mock the editor, so only this check sees it.
const ROOT = resolve(process.cwd(), 'src/renderer/src')
const USES_EDITOR = /(?:from\s*|import\(\s*)['"]@monaco-editor\/react['"]/
const LOADS_BUNDLED_MONACO = /(?:from\s*|import\s*\(?\s*)['"](?:\.\.?\/)+monaco['"]/
const TYPE_ONLY_IMPORT = /^import\s+type\s[\s\S]*?from\s*['"][^'"]+['"]/gm

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

describe('Monaco offline loading', () => {
  it('loads the bundled Monaco wherever @monaco-editor/react is used', () => {
    const editors = sources(ROOT)
      .filter((file) => relative(ROOT, file) !== 'monaco.ts')
      .map((file) => ({ file, code: readFileSync(file, 'utf8').replace(TYPE_ONLY_IMPORT, '') }))
      .filter(({ code }) => USES_EDITOR.test(code))
    expect(editors.length).toBeGreaterThan(0)
    const missing = editors
      .filter(({ code }) => !LOADS_BUNDLED_MONACO.test(code))
      .map(({ file }) => relative(ROOT, file))
    expect(missing).toEqual([])
  })
})
