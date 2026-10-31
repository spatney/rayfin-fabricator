import { describe, expect, it } from 'vitest'
import type { DesignItem } from '@shared/design'
import { composeDesignPrompt, itemSummary, summarizeDesign } from './prompt'
import { cropBox } from './capture'
import { deviceHostHeight, deviceHostWidth } from './devices'

const button: DesignItem = {
  id: 'i1',
  kind: 'element',
  createdAt: 1,
  instruction: 'Make it a secondary outline button',
  target: {
    label: 'Button · Add deal', role: 'button', tag: 'button', selector: 'main > button', route: '/deals',
    text: 'Add deal', classes: 'bg-indigo-600 text-white px-4', nearestHeading: 'Deals', region: 'main', box: { w: 90, h: 36 }
  },
  tweaks: [{
    kind: 'background', summary: 'Background: bg-indigo-600 → bg-white',
    tailwind: { from: 'bg-indigo-600', to: 'bg-white' }, css: [{ property: 'background-color', from: 'rgb(79, 70, 229)', to: '#ffffff' }]
  }]
}
const theme: DesignItem = {
  id: 't1', kind: 'theme', createdAt: 2, tweaks: [],
  theme: { accent: { from: 'indigo', to: 'emerald' }, tokens: { '--color-indigo-600': 'oklch(0.54 0.16 163)' }, summary: ['Accent: indigo → emerald'] }
}
const chart: DesignItem = {
  id: 'c1', kind: 'element', createdAt: 3, similar: 2,
  target: { label: 'Chart · Revenue', role: 'chart', tag: 'div', selector: 'div.chart', route: '/', box: { w: 400, h: 300 }, chart: { type: 'bar', title: 'Revenue' } },
  tweaks: [],
  chart: { before: { type: 'bar' }, after: { type: 'line' }, summary: ['type: bar → line'] }
}

describe('design prompt', () => {
  it('summarizes each item in one readable line for chips and the transcript', () => {
    expect(itemSummary(button)).toBe('“Make it a secondary outline button” · Background: bg-indigo-600 → bg-white')
    expect(summarizeDesign([button, theme, chart])).toEqual({
      items: [
        { n: 1, kind: 'element', label: 'Button · Add deal', summary: itemSummary(button) },
        { n: 2, kind: 'theme', label: 'Theme', summary: 'Accent: indigo → emerald' },
        { n: 3, kind: 'element', label: 'Chart · Revenue', summary: 'Chart type: bar → line · +2 like it' }
      ]
    })
  })

  it('composes a structured prompt with requests, Tailwind swaps, element details and source hints', () => {
    const prompt = composeDesignPrompt({
      note: 'Also keep it accessible',
      items: [button, theme, chart],
      route: '/deals',
      viewport: { w: 1280, h: 800, dpr: 1 },
      fullView: true,
      crops: ['i1', 'c1'],
      locate: {
        entryCss: 'src/main.css',
        targets: [{ key: 'i1', candidates: [{ file: 'src/pages/DealsPage.tsx', line: 212, reason: '3 matching classes + text', score: 0.9, snippet: '' }] }]
      }
    })
    expect(prompt.startsWith('Also keep it accessible\n')).toBe(true)
    expect(prompt).toContain('## Design changes from the live preview (3)')
    expect(prompt).toContain('(route /deals, viewport 1280×800)')
    expect(prompt).toContain('Attached images: #1 is the full view with the changes previewed; #2–#3 are crops of changes 1, 3.')
    expect(prompt).toContain('### 1. Button · Add deal')
    expect(prompt).toContain('- Request: “Make it a secondary outline button”')
    expect(prompt).toContain('Tailwind: bg-indigo-600 → bg-white')
    expect(prompt).toContain('- Element: <button class="bg-indigo-600 text-white px-4"> · text “Add deal” · near heading “Deals” · inside <main> · selector main > button')
    expect(prompt).toContain('- Likely source: src/pages/DealsPage.tsx:212 (3 matching classes + text)')
    expect(prompt).toContain('### 2. Theme — scope: the whole app')
    expect(prompt).toContain('- Tailwind entry stylesheet: src/main.css')
    expect(prompt).toContain('"--color-indigo-600":"oklch(0.54 0.16 163)"')
    expect(prompt).toContain('### 3. Chart · Revenue — scope: this element and 2 more like it')
    expect(prompt).toContain('- Chart spec change (data omitted): type: bar → line')
    expect(prompt).toContain('- Chart changes: update the Graphein spec where it is built')
    expect(prompt).toContain('Finish with a short summary per change number.')
  })

  it('falls back to a default request without a note and flags items not on the page', () => {
    const prompt = composeDesignPrompt({ note: '  ', items: [{ ...button, missing: true }] })
    expect(prompt.startsWith('Please apply these design changes to my app.')).toBe(true)
    expect(prompt).toContain('isn\'t on the page currently shown (it was on /deals)')
    expect(prompt).not.toContain('Attached images')
  })

  it('asks for a semantic accent to change the token in @theme and .dark', () => {
    const tokenTheme: DesignItem = {
      ...theme,
      theme: {
        accent: { from: 'primary', to: 'emerald', token: true },
        tokens: { '--color-primary': 'var(--color-emerald-600)' },
        darkTokens: { '--color-primary': 'var(--color-emerald-400)' },
        summary: ['Accent: primary → emerald']
      }
    }
    const prompt = composeDesignPrompt({ note: '', items: [tokenTheme] })
    expect(prompt).toContain('- Dark mode (`.dark`) overrides previewed: {"--color-primary":"var(--color-emerald-400)"}')
    expect(prompt).toContain('change the token itself in the `@theme` block and in the `.dark` block')
    expect(composeDesignPrompt({ note: '', items: [theme] })).not.toContain('Semantic color tokens')
  })
})

describe('design capture geometry', () => {
  const layout = { viewport: { w: 1000, h: 800, dpr: 2 }, frame: { x: 0, y: 0 }, rects: {} }
  it('maps an element rect into the captured image with context, clamped to the image', () => {
    expect(cropBox({ x: 100, y: 50, w: 200, h: 40 }, layout, 2000, 1600)).toEqual({ sx: 184, sy: 84, sw: 432, sh: 112 })
    expect(cropBox({ x: 0, y: 0, w: 50, h: 20 }, layout, 2000, 1600)).toEqual({ sx: 0, sy: 0, sw: 116, sh: 56 })
  })
  it('offsets by the app frame in the Fabric view and skips when the frame is unknown', () => {
    expect(cropBox({ x: 10, y: 10, w: 100, h: 50 }, { ...layout, frame: { x: 240, y: 56 } }, 1000, 800)).toEqual({ sx: 242, sy: 58, sw: 116, sh: 66 })
    expect(cropBox({ x: 10, y: 10, w: 100, h: 50 }, { ...layout, frame: null }, 1000, 800)).toBeNull()
  })
})

describe('design devices', () => {
  it('sizes the preview host so the app sees the device size at any UI zoom', () => {
    expect(deviceHostWidth('desktop', 1.25)).toBeNull()
    expect(deviceHostWidth('phone', 1)).toBe(390)
    expect(deviceHostWidth('phone', 1.25)).toBe(312)
    expect(deviceHostWidth('tablet', 0)).toBe(820)
    expect(deviceHostHeight('phone', 1)).toBe(844)
    expect(deviceHostHeight('phone', 1.25)).toBe(675)
    expect(deviceHostHeight('tablet', 1)).toBeNull()
    expect(deviceHostHeight('desktop', 1)).toBeNull()
  })
})
