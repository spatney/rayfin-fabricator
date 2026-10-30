import { describe, expect, it } from 'vitest'
import index from 'virtual:docs-index'
import docs from '@shared/docs-links.json'
import { slugify } from '../../../../../scripts/docs-index.mjs'

describe('the docs index Search reads', () => {
  // The links in docs-links.json are verified against the built site, so finding
  // each of them here shows the index's anchors are the site's.
  it.each(Object.entries(docs.links))('has the page and heading %s links to', (_, target) => {
    const [path, anchor] = target.split('#')
    const page = index.pages.find((p) => p.path === path)
    expect(page, `no page ${path}`).toBeDefined()
    if (anchor) expect(page!.headings.map((h) => h.anchor)).toContain(anchor)
  })

  it('gives each page its title and the section it sits in', () => {
    const deploy = index.pages.find((p) => p.path === '/docs/ship/deploy')
    expect(deploy).toMatchObject({ title: 'Publish to Microsoft Fabric', section: 'Ship' })
    expect(deploy!.description).not.toBe('')
  })

  it('makes anchors as the site does', () => {
    expect(slugify('GitHub Copilot sign-in doesn’t work')).toBe(
      'github-copilot-sign-in-doesnt-work'
    )
    expect(slugify('Fabric & Power BI: what’s shared?')).toBe('fabric--power-bi-whats-shared')
  })
})
