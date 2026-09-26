import { describe, expect, it } from 'vitest'
import { displayPath, projectRelative, resolveProjectFile } from './paths'

const ROOT = 'C:\\Users\\sachi\\RayfinProjects\\df55-app'

describe('projectRelative', () => {
  it('makes Windows paths under the root relative with forward slashes, case-insensitively', () => {
    expect(projectRelative('C:\\Users\\sachi\\RayfinProjects\\df55-app\\src\\App.tsx', ROOT)).toBe(
      'src/App.tsx'
    )
    expect(projectRelative('c:/users/sachi/rayfinprojects/DF55-APP/src/App.tsx', ROOT)).toBe(
      'src/App.tsx'
    )
    expect(projectRelative(ROOT, ROOT)).toBe('')
  })

  it('returns null outside the project and passes relative paths through', () => {
    expect(
      projectRelative('C:\\Users\\sachi\\.copilot\\session-state\\x\\plan.md', ROOT)
    ).toBeNull()
    expect(
      projectRelative('C:\\Users\\sachi\\RayfinProjects\\df55-app-other\\a.ts', ROOT)
    ).toBeNull()
    expect(projectRelative('./src/main.css', ROOT)).toBe('src/main.css')
  })
})

describe('displayPath', () => {
  it('splits a project file into a dim directory and a file name', () => {
    expect(displayPath(`${ROOT}\\src\\pages\\HomePage.tsx`, ROOT)).toMatchObject({
      dir: 'src/pages/',
      base: 'HomePage.tsx',
      rel: 'src/pages/HomePage.tsx'
    })
    expect(displayPath(`${ROOT}\\package.json`, ROOT)).toMatchObject({
      dir: '',
      base: 'package.json'
    })
  })

  it('shows only the file name for paths outside the project', () => {
    const p = displayPath('C:\\Users\\sachi\\.copilot\\session-state\\abc\\plan.md', ROOT)
    expect(p).toMatchObject({ dir: '', base: 'plan.md', rel: null })
    expect(p.full).toContain('session-state')
  })
})

describe('resolveProjectFile', () => {
  const files = [
    'src/App.tsx',
    'src/pages/HomePage.tsx',
    'src/main.css',
    'rayfin/data/Todo.ts',
    'package.json',
    'src/index.ts',
    'rayfin/index.ts'
  ]

  it('matches exact, absolute, ./ and line-suffixed paths', () => {
    expect(resolveProjectFile('src/App.tsx', files, ROOT)).toBe('src/App.tsx')
    expect(resolveProjectFile(`${ROOT}\\src\\App.tsx`, files, ROOT)).toBe('src/App.tsx')
    expect(resolveProjectFile('./src/main.css', files, ROOT)).toBe('src/main.css')
    expect(resolveProjectFile('src/App.tsx:42:7', files, ROOT)).toBe('src/App.tsx')
    expect(resolveProjectFile('src/App.tsx#L10-L20', files, ROOT)).toBe('src/App.tsx')
  })

  it('matches a unique basename or path suffix, never an ambiguous one', () => {
    expect(resolveProjectFile('HomePage.tsx', files, ROOT)).toBe('src/pages/HomePage.tsx')
    expect(resolveProjectFile('pages/HomePage.tsx', files, ROOT)).toBe('src/pages/HomePage.tsx')
    expect(resolveProjectFile('package.json', files, ROOT)).toBe('package.json')
    expect(resolveProjectFile('index.ts', files, ROOT)).toBeNull()
  })

  it('ignores code, URLs and paths outside the project', () => {
    expect(resolveProjectFile('salesModel', files, ROOT)).toBeNull()
    expect(resolveProjectFile('npm run build', files, ROOT)).toBeNull()
    expect(resolveProjectFile('https://rayfin.ai/docs', files, ROOT)).toBeNull()
    expect(resolveProjectFile('C:\\Windows\\System32\\App.tsx', files, ROOT)).toBeNull()
  })
})
