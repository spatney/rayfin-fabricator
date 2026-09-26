import { describe, expect, it } from 'vitest'
import { parseUnifiedDiff } from './diff'

// Shapes copied from real Copilot `detailedContent` payloads.
const EDIT = [
  'diff --git a/C:/p/src/main.tsx b/C:/p/src/main.tsx',
  'index 0000000..0000000 100644',
  '--- a/C:/p/src/main.tsx',
  '+++ b/C:/p/src/main.tsx',
  '@@ -43,7 +43,8 @@ export function App()',
  '   lastDeploy: { url: "x" }',
  ' }',
  ' ',
  '-const seed = load()',
  '+const pendingMode = params.get("pending")',
  '+const seed = load(pendingMode)',
  ' ',
  ' function App() {',
  ' ',
  '\\ No newline at end of file'
].join('\n')

const CREATE = [
  'diff --git a/C:/p/answer.txt b/C:/p/answer.txt',
  'create file mode 100644',
  'index 0000000..0000000',
  '--- a/dev/null',
  '+++ b/C:/p/answer.txt',
  '@@ -1,0 +1,2 @@',
  '+0.05',
  '+done'
].join('\n')

describe('parseUnifiedDiff', () => {
  it('parses an edit with line numbers, section, and stats', () => {
    const [file] = parseUnifiedDiff(EDIT)
    expect(file.path).toBe('C:/p/src/main.tsx')
    expect(file.status).toBe('modified')
    expect([file.added, file.removed]).toEqual([2, 1])
    const [hunk] = file.hunks
    expect(hunk.section).toBe('export function App()')
    const del = hunk.lines.find((l) => l.kind === 'del')
    expect(del).toMatchObject({ text: 'const seed = load()', oldNo: 46 })
    const adds = hunk.lines.filter((l) => l.kind === 'add')
    expect(adds.map((l) => l.newNo)).toEqual([46, 47])
    expect(hunk.lines[hunk.lines.length - 1]).toMatchObject({
      kind: 'meta',
      text: 'No newline at end of file'
    })
  })

  it("treats the tools' a/dev/null old path as a created file", () => {
    const [file] = parseUnifiedDiff(CREATE)
    expect(file).toMatchObject({ path: 'C:/p/answer.txt', status: 'added', added: 2, removed: 0 })
  })

  it('splits multi-file patches, including headers without diff --git lines', () => {
    const multi = `${EDIT}\n${CREATE}\n--- a/C:/p/old.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-gone`
    const files = parseUnifiedDiff(multi)
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['C:/p/src/main.tsx', 'modified'],
      ['C:/p/answer.txt', 'added'],
      ['C:/p/old.ts', 'deleted']
    ])
  })

  it('reads hunk bodies by count so removed "-- comment" lines are not headers', () => {
    const sql = '--- a/q.sql\n+++ b/q.sql\n@@ -1,2 +1,1 @@\n--- drop me\n keep\n'
    const [file] = parseUnifiedDiff(sql)
    expect(file.path).toBe('q.sql')
    expect(file.hunks[0].lines.map((l) => l.kind)).toEqual(['del', 'ctx'])
    expect(file.removed).toBe(1)
  })

  it('handles hunk-only and CRLF diffs, and truncated input', () => {
    expect(parseUnifiedDiff('@@ -1 +1 @@\r\n-a\r\n+b\r\n')[0]).toMatchObject({
      path: '',
      added: 1,
      removed: 1
    })
    const cut = parseUnifiedDiff(EDIT.split('\n').slice(0, 10).join('\n'))
    expect(cut[0].added).toBe(1)
    expect(parseUnifiedDiff('')).toEqual([])
  })
})
