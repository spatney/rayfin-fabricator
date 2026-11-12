import { describe, expect, it } from 'vitest'
import type { FileNode } from '@shared/ipc'
import { filePaths, findFileLinks, projectRelative } from './links'

const files = new Set(['src/App.tsx', 'src/api/client.ts', 'rayfin/schema.ts', 'package.json'])

function links(text: string, root = 'C:\\apps\\contoso', windows = true) {
  return findFileLinks(text, (raw) => {
    const path = projectRelative(raw, root, windows)
    return path && files.has(path) ? path : null
  })
}

describe('terminal file links', () => {
  it('finds a compiler’s file, line and column, in both of its formats', () => {
    const [colon] = links('src/App.tsx:12:5 - error TS2322: Type mismatch')
    expect(colon).toMatchObject({ start: 0, end: 16, path: 'src/App.tsx', line: 12, column: 5 })
    const [paren] = links('src/api/client.ts(40,3): error TS7006')
    expect(paren).toMatchObject({ path: 'src/api/client.ts', line: 40, column: 3 })
  })

  it('reads absolute paths inside the project, whatever their separators and case', () => {
    const [stack] = links('    at load (C:\\Apps\\Contoso\\src\\api\\client.ts:7:15)')
    expect(stack).toMatchObject({ path: 'src/api/client.ts', line: 7, column: 15 })
    const [url] = links('file:///C:/apps/contoso/rayfin/schema.ts:3')
    expect(url).toMatchObject({ path: 'rayfin/schema.ts', line: 3, start: 0 })
    const [mac] = findFileLinks('/Users/me/contoso/src/App.tsx:1', (raw) =>
      projectRelative(raw, '/Users/me/contoso', false)
    )
    expect(mac).toMatchObject({ path: 'src/App.tsx', line: 1 })
  })

  it('links only the project’s own files', () => {
    expect(links('modified:   ./package.json')).toMatchObject([{ path: 'package.json' }])
    expect(links('src/Missing.tsx:1:1 error')).toEqual([])
    expect(links('D:\\elsewhere\\src\\App.tsx:1')).toEqual([])
    expect(links('../other/src/App.tsx')).toEqual([])
    // A web address is the URL link's, not a file's.
    expect(links('see https://contoso.com/src/App.tsx for more')).toEqual([])
    // Case matters outside Windows.
    expect(links('/Apps/Contoso/src/App.tsx', '/apps/contoso', false)).toEqual([])
  })

  it('ends a path before the punctuation after it', () => {
    const [link] = links('Fix the import in src/App.tsx.')
    expect(link).toMatchObject({ path: 'src/App.tsx', start: 18, end: 29 })
  })

  it('lists a project’s files from its tree', () => {
    const tree: FileNode[] = [
      {
        name: 'src',
        path: 'src',
        type: 'dir',
        children: [{ name: 'App.tsx', path: 'src/App.tsx', type: 'file' }]
      },
      { name: 'package.json', path: 'package.json', type: 'file' }
    ]
    expect([...filePaths(tree)].sort()).toEqual(['package.json', 'src/App.tsx'])
  })
})
