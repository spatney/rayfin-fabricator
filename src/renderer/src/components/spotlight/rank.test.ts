import { describe, expect, it } from 'vitest'
import { looksLikeQuestion, prepare, rank } from './rank'
import type { Searchable } from './model'

function titles(query: string, items: (string | Searchable)[]): string[] {
  const prepared = prepare(items.map((item) => (typeof item === 'string' ? { title: item } : item)))
  return rank(prepared, query).map((r) => r.item.title)
}

describe('ranking results', () => {
  it('puts a title that starts with the query before one that only contains it', () => {
    expect(titles('set', ['Reset password', 'Settings'])).toEqual(['Settings', 'Reset password'])
  })

  it('prefers the start of a word to the middle of one', () => {
    expect(titles('pro', ['Reproduce a bug', 'All projects'])).toEqual([
      'All projects',
      'Reproduce a bug'
    ])
  })

  it('finds a title by the initials of its words, and marks them', () => {
    const [hit] = rank(prepare([{ title: 'New project' }, { title: 'Open folder' }]), 'np')
    expect(hit.item.title).toBe('New project')
    expect(hit.ranges).toEqual([
      [0, 1],
      [4, 5]
    ])
  })

  it('needs every word of the query to match somewhere', () => {
    expect(
      titles('deploy share', ['Deploy', 'Share', { title: 'Deploy', keywords: ['share'] }])
    ).toHaveLength(1)
  })

  it('ignores case and accents', () => {
    const [hit] = rank(prepare([{ title: 'Café menu' }]), 'CAFE')
    expect(hit.ranges).toEqual([[0, 4]])
  })

  it('matches a path or a description only where a word starts', () => {
    const contoso = { title: 'Contoso', subtitle: '~\\RayfinProjects\\contoso' }
    expect(titles('np', [contoso])).toEqual([])
    expect(titles('proj', [contoso])).toEqual(['Contoso'])
    expect(titles('ploy', [{ title: 'Deploy guide', body: 'How to deploy an app' }])).toEqual([
      'Deploy guide'
    ])
    expect(titles('ploy', [{ title: 'Guide', body: 'How to deploy an app' }])).toEqual([])
  })

  it('lets a boost settle equal matches, such as for something picked recently', () => {
    const items = prepare([{ title: 'Sales Pipeline' }, { title: 'Sales Reports' }])
    const ranked = rank(items, 'sales', {
      boost: (item) => (item.title === 'Sales Reports' ? 0.1 : 0)
    })
    expect(ranked.map((r) => r.item.title)).toEqual(['Sales Reports', 'Sales Pipeline'])
  })
})

describe('telling a question from a search', () => {
  it.each([
    'why did my deploy fail?',
    'how do I share my app',
    'the preview won’t start',
    'my deploy keeps failing'
  ])('reads "%s" as a question', (query) => {
    expect(looksLikeQuestion(query)).toBe(true)
  })

  it.each(['deploy', 'contoso expenses', 'why', 'new project'])(
    'reads "%s" as a search',
    (query) => {
      expect(looksLikeQuestion(query)).toBe(false)
    }
  )
})
