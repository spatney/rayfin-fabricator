import { describe, expect, it } from 'vitest'
import {
  activeMention,
  isImagePath,
  isPathQuery,
  mentionText,
  pathReference,
  rankEntries,
  splitPathQuery
} from './mentions'

describe('the @-token being typed', () => {
  it('is found after a space, quoted when its path has spaces', () => {
    expect(activeMention('look at @src/Ap')).toEqual({ start: 8, query: 'src/Ap', quoted: false })
    expect(activeMention('@"C:\\My files\\no')).toEqual({
      start: 0,
      query: 'C:\\My files\\no',
      quoted: true
    })
    expect(activeMention('@')).toEqual({ start: 0, query: '', quoted: false })
  })

  it('isn’t an email, a finished quote or a finished word', () => {
    expect(activeMention('mail a@b.com')).toBeNull()
    expect(activeMention('@"C:\\My files\\notes.md"')).toBeNull()
    expect(activeMention('@src/App.tsx ')).toBeNull()
  })
})

describe('@ paths outside the project', () => {
  it('starts with ./, ../, ~/, a root or a drive', () => {
    for (const q of [
      '../',
      '..\\x',
      './src',
      '~/notes',
      '/Users',
      '\\\\server\\share',
      'C:\\',
      'd:/data'
    ]) {
      expect(isPathQuery(q), q).toBe(true)
    }
    for (const q of ['', 'src/App', '..', '~', 'C:', 'microsoft/rayfin-cli'])
      expect(isPathQuery(q), q).toBe(false)
  })

  it('splits at the last separator into the folder and the name being typed', () => {
    expect(splitPathQuery('../shared/no')).toEqual({ dir: '../shared/', partial: 'no' })
    expect(splitPathQuery('C:\\Users\\')).toEqual({ dir: 'C:\\Users\\', partial: '' })
  })

  it('lists what starts with the name first, then what contains it, folders before files, hidden only once asked for', () => {
    const entries = [
      { name: 'readme.md', dir: false },
      { name: 'docs', dir: true },
      { name: 'my-docs.txt', dir: false },
      { name: 'Docs-old', dir: true },
      { name: '.docs', dir: true }
    ]
    expect(rankEntries(entries, 'do').map((e) => e.name)).toEqual([
      'docs',
      'Docs-old',
      'my-docs.txt'
    ])
    expect(rankEntries(entries, '').map((e) => e.name)).toEqual([
      'docs',
      'Docs-old',
      'my-docs.txt',
      'readme.md'
    ])
    expect(rankEntries(entries, '.d').map((e) => e.name)).toEqual(['.docs'])
  })

  it('quotes a reference with spaces, and can leave the quote open to keep browsing', () => {
    expect(mentionText('../shared/notes.md')).toBe('@../shared/notes.md')
    expect(mentionText('C:\\My files\\notes.md')).toBe('@"C:\\My files\\notes.md"')
    expect(mentionText('C:\\My files\\', false, true)).toBe('@"C:\\My files\\')
    expect(mentionText('C:\\My files\\a.md', true)).toBe('@"C:\\My files\\a.md"')
  })
})

describe('references to files and folders dropped or picked on this computer', () => {
  const root = 'C:\\projects\\notes'

  it('point inside the project by their path there, a folder spelled out with ./', () => {
    expect(pathReference('C:\\projects\\notes\\src\\App.tsx', root, false)).toBe('@src/App.tsx')
    expect(pathReference('c:\\Projects\\Notes\\src\\components', root, true)).toBe(
      '@./src/components/'
    )
    expect(pathReference(root, root, true)).toBe('@./')
  })

  it('point outside it by their full path, a folder ending with a separator', () => {
    expect(pathReference('C:\\Users\\me\\Design docs', root, true)).toBe(
      '@"C:\\Users\\me\\Design docs\\"'
    )
    expect(pathReference('C:\\Users\\me\\brief.md', root, false)).toBe('@C:\\Users\\me\\brief.md')
    expect(pathReference('/Users/me/specs/', '/Users/me/notes', true)).toBe('@/Users/me/specs/')
  })

  it('attach only the images a model can see', () => {
    for (const image of ['shot.png', 'C:\\a\\Photo.JPG', 'b.jpeg', 'c.gif', 'd.webp', 'e.bmp'])
      expect(isImagePath(image), image).toBe(true)
    for (const other of ['logo.svg', 'notes.md', 'png', 'C:\\pics'])
      expect(isImagePath(other), other).toBe(false)
  })
})
