import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import {
  FabricatorMark,
  MARK_GRAY,
  MARK_TEAL,
  MARK_TILES
} from './FabricatorMark'

/**
 * The brand mark replaced a static logo.png so its gray tiles could follow the
 * theme. These guard that: (1) the gray tiles paint from the --logo-gray var (the
 * fix for the washed-out light theme), (2) teal tiles keep the fixed brand teal,
 * and (3) sizing classes + decorative/labelled a11y wiring survive.
 */
describe('FabricatorMark', () => {
  afterEach(cleanup)

  function renderMark(props: Parameters<typeof FabricatorMark>[0] = {}): SVGSVGElement {
    const { container } = render(<FabricatorMark {...props} />)
    const svg = container.querySelector('svg')
    if (!svg) throw new Error('expected an <svg>')
    return svg as SVGSVGElement
  }

  it('keeps the base fab-mark class and appends the sizing class', () => {
    const svg = renderMark({ className: 'brand-mark' })
    expect(svg.classList.contains('fab-mark')).toBe(true)
    expect(svg.classList.contains('brand-mark')).toBe(true)
  })

  it('paints gray tiles from the theme-aware --logo-gray var', () => {
    const svg = renderMark()
    const grayTiles = MARK_TILES.filter((t) => t.fill === 'gray')
    expect(grayTiles.length).toBeGreaterThan(0)
    for (const t of grayTiles) {
      const rect = svg.querySelector(`rect.${t.cls}`)
      expect(rect?.getAttribute('fill')).toBe(MARK_GRAY)
      expect(MARK_GRAY).toContain('--logo-gray')
    }
  })

  it('paints teal tiles with the fixed brand teal', () => {
    const svg = renderMark()
    const tealTiles = MARK_TILES.filter((t) => t.fill === 'teal')
    for (const t of tealTiles) {
      const rect = svg.querySelector(`rect.${t.cls}`)
      expect(rect?.getAttribute('fill')).toBe(MARK_TEAL)
    }
  })

  it('is decorative (aria-hidden) by default and labelled when a title is given', () => {
    expect(renderMark().getAttribute('aria-hidden')).toBe('true')

    const labelled = renderMark({ title: 'Fabricator' })
    expect(labelled.getAttribute('aria-hidden')).toBeNull()
    expect(labelled.getAttribute('role')).toBe('img')
    expect(labelled.getAttribute('aria-label')).toBe('Fabricator')
    expect(labelled.querySelector('title')?.textContent).toBe('Fabricator')
  })
})
