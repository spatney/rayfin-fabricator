import { describe, expect, it } from 'vitest'
import { pageText, type PdfTextItem } from './pdfPages'

const word = (str: string, x: number, y: number, width = str.length * 5, height = 10): PdfTextItem => ({
  str,
  transform: [height, 0, 0, height, x, y],
  width,
  height
})

describe('pageText', () => {
  it('reads lines top to bottom and words left to right', () => {
    const text = pageText([
      word('Profit', 300, 700),
      word('Revenue', 10, 700),
      word('Overview', 10, 760),
      word('$12.3M', 10, 680),
      word('by', 50, 760),
      word('region', 70, 760.6)
    ])
    expect(text).toBe(['Overview by region', 'Revenue | Profit', '$12.3M'].join('\n'))
  })

  it('skips blank items and keeps close words on one line', () => {
    expect(pageText([word('Total', 10, 100), word(' ', 40, 100), word('sales', 46, 100), word('', 0, 0)])).toBe('Total sales')
  })

  it('drops icon glyphs, which have no readable text', () => {
    expect(pageText([word('\ue718', 10, 200), word('\ue715', 300, 200), word('3.62M\ue118', 10, 180)])).toBe('3.62M')
  })

  it('reads nothing from an empty page', () => {
    expect(pageText([])).toBe('')
  })
})
