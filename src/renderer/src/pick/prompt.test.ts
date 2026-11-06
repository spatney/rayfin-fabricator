import { describe, expect, it } from 'vitest'
import type { PickTarget } from '@shared/pick'
import { composePickPrompt, picksDisplay } from './prompt'

const SAVE: PickTarget = {
  label: 'Button · Save',
  role: 'button',
  tag: 'button',
  selector: '#save',
  route: '/deals',
  box: { w: 80, h: 32 },
  text: 'Save',
  classes: 'btn btn-primary',
  component: 'DealForm',
  nearestHeading: 'New deal',
  region: 'main',
  styles: { 'background-color': 'rgb(79, 70, 229)', 'border-radius': '6px' },
  html: '<button id="save" class="btn btn-primary">Save</button>'
}
const CHART: PickTarget = {
  label: 'Chart · Deals by stage',
  role: 'chart',
  tag: 'div',
  selector: 'main > div:nth-of-type(2)',
  route: '/deals',
  box: { w: 600, h: 320 },
  chart: { type: 'bar', title: 'Deals by stage' }
}

describe('Touch Up prompt', () => {
  it('gives Copilot the request and each picked element, with its likely source and picture', () => {
    const prompt = composePickPrompt({
      note: '  make it the primary action ',
      picks: [{ id: 'a', n: 1, target: SAVE }],
      locate: {
        entryCss: 'src/index.css',
        targets: [
          {
            key: 'a',
            candidates: [
              { file: 'src/DealForm.tsx', line: 42, reason: 'text “Save”', score: 0.9, snippet: '' }
            ]
          }
        ]
      },
      images: { a: 1 }
    })
    expect(prompt).toBe(
      [
        'make it the primary action',
        '',
        '## Picked in the live preview (1)',
        `I picked this element in the app's live preview. "This", "it", "these" and the numbers refer to it. Change the app's source so it looks and works as asked, and leave the rest of the app as it is. Use the app's own components, utility classes and theme tokens rather than one-off inline styles.`,
        '',
        '### 1. Button · Save',
        '- Page: /deals',
        '- Element: <button> · text “Save” · 80×32 px · near heading “New deal” · inside <main>',
        '- React component: DealForm',
        '- Selector: #save',
        '- Classes: btn btn-primary',
        '- Styles: background-color: rgb(79, 70, 229); border-radius: 6px',
        '- Likely source: src/DealForm.tsx:42 (text “Save”)',
        '- Picture: attached image 1',
        '- HTML:',
        '```html',
        '<button id="save" class="btn btn-primary">Save</button>',
        '```',
        '',
        'Tailwind entry stylesheet: src/index.css',
        '',
        `When you're done, say briefly what you changed for each number.`
      ].join('\n')
    )
  })

  it('asks Copilot to touch up picks sent without words, and leaves pictures out of a retry', () => {
    const prompt = composePickPrompt({
      note: '',
      picks: [
        { id: 'a', n: 1, target: SAVE },
        { id: 'b', n: 2, target: CHART }
      ]
    })
    expect(prompt.split('\n')[0]).toBe(
      'Touch up these elements: make them look and work better, in keeping with the rest of the app.'
    )
    expect(prompt).toContain('"This", "it", "these" and the numbers refer to them.')
    expect(prompt).toContain('### 2. Chart · Deals by stage')
    expect(prompt).toContain(
      '- Graphein chart: bar “Deals by stage” (its spec is where the chart is built)'
    )
    expect(prompt).not.toContain('Picture:')
    expect(picksDisplay('', 1)).toBe('Touch this up')
    expect(picksDisplay(' ', 2)).toBe('Touch these 2 up')
    expect(picksDisplay(' bigger ', 2)).toBe('bigger')
  })
})
