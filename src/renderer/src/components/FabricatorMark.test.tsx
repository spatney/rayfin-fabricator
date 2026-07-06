import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { FabricatorMark, MARK_GRADIENT_STOPS, MARK_TILES } from './FabricatorMark'

/**
 * The brand mark replaced a static logo.png so it could carry one blue→cyan→green
 * gradient that reads on both light and dark backgrounds. These guard that: (1) the
 * gradient stops render, (2) every tile + bracket is painted from that gradient (so
 * the fill flows continuously across the mark), (3) each instance gets a unique
 * gradient id, and (4) sizing classes + decorative/labelled a11y wiring survive.
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

  it('renders the blue→cyan→green gradient stops', () => {
    const svg = renderMark()
    const grad = svg.querySelector('linearGradient')
    expect(grad).not.toBeNull()
    const stops = grad ? Array.from(grad.querySelectorAll('stop')) : []
    expect(stops).toHaveLength(MARK_GRADIENT_STOPS.length)
    stops.forEach((stop, i) => {
      expect(stop.getAttribute('offset')).toBe(MARK_GRADIENT_STOPS[i].offset)
      expect(stop.getAttribute('stop-color')).toBe(MARK_GRADIENT_STOPS[i].color)
    })
  })

  it('paints every tile from the shared gradient', () => {
    const svg = renderMark()
    const gid = svg.querySelector('linearGradient')?.getAttribute('id')
    expect(gid).toBeTruthy()
    for (const t of MARK_TILES) {
      const rect = svg.querySelector(`rect.${t.cls}`)
      expect(rect?.getAttribute('fill')).toBe(`url(#${gid})`)
    }
  })

  it('gives each instance a unique gradient id', () => {
    const { container } = render(
      <>
        <FabricatorMark />
        <FabricatorMark />
      </>
    )
    const ids = Array.from(container.querySelectorAll('linearGradient')).map((g) => g.id)
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
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
