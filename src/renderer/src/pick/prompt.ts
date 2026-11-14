import type { PickLocateResult, PickTarget } from '@shared/pick'
import { translator } from '../i18n'

/** What a pick contributes to a message. */
export interface PromptPick {
  id: string
  n: number
  target: PickTarget
}

/** What the transcript shows as the user's words when they only picked. */
export function picksDisplay(note: string, count: number): string {
  const text = note.trim()
  if (text) return text
  return translator('app')('pick.display', { count })
}

function quote(text: string): string {
  return `“${text}”`
}

function elementLine(t: PickTarget): string {
  const parts = [`<${t.tag}>`]
  if (t.text) parts.push(`text ${quote(t.text)}`)
  parts.push(`${t.box.w}×${t.box.h} px`)
  if (t.nearestHeading) parts.push(`near heading ${quote(t.nearestHeading)}`)
  if (t.region) parts.push(`inside <${t.region}>`)
  return parts.join(' · ')
}

function styleLine(styles: Record<string, string>): string {
  return Object.entries(styles)
    .map(([property, value]) => `${property}: ${value}`)
    .join('; ')
}

/**
 * What Copilot gets with picked elements: the user's request, then each element
 * with what identifies it in the page and in the source. `images` maps a pick to
 * its crop's 1-based position among the message's attached images; a Retry
 * re-sends the prompt without them, since the images are gone by then.
 */
export function composePickPrompt(input: {
  note: string
  picks: PromptPick[]
  locate?: PickLocateResult | null
  images?: Record<string, number>
}): string {
  const { picks, locate, images } = input
  const one = picks.length === 1
  const note = input.note.trim()
  const lines: string[] = [
    note ||
      (one
        ? 'Touch up this element: make it look and work better, in keeping with the rest of the app.'
        : 'Touch up these elements: make them look and work better, in keeping with the rest of the app.'),
    '',
    `## Picked in the live preview (${picks.length})`,
    `I picked ${one ? 'this element' : 'these elements'} in the app's live preview. "This", "it", "these" and the numbers refer to ${one ? 'it' : 'them'}. Change the app's source so ${one ? 'it looks and works' : 'they look and work'} as asked, and leave the rest of the app as it is. Use the app's own components, utility classes and theme tokens rather than one-off inline styles.`
  ]
  const hints = new Map((locate?.targets ?? []).map((t) => [t.key, t.candidates]))
  for (const pick of picks) {
    const t = pick.target
    lines.push('', `### ${pick.n}. ${t.label}`)
    lines.push(`- Page: ${t.route || '/'}`)
    lines.push(`- Element: ${elementLine(t)}`)
    if (t.component) lines.push(`- React component: ${t.component}`)
    if (t.ariaLabel) lines.push(`- Accessible name: ${quote(t.ariaLabel)}`)
    if (t.chart) {
      const kind = [t.chart.type, t.chart.title && quote(t.chart.title)].filter(Boolean).join(' ')
      lines.push(
        `- Graphein chart${kind ? `: ${kind}` : ''} (its spec is where the chart is built)`
      )
    }
    lines.push(`- Selector: ${t.selector}`)
    if (t.classes) lines.push(`- Classes: ${t.classes}`)
    if (t.styles && Object.keys(t.styles).length) lines.push(`- Styles: ${styleLine(t.styles)}`)
    if (t.dataAttrs && Object.keys(t.dataAttrs).length) {
      lines.push(
        `- Data attributes: ${Object.entries(t.dataAttrs)
          .map(([name, value]) => `${name}="${value}"`)
          .join(' ')}`
      )
    }
    for (const c of hints.get(pick.id) ?? []) {
      lines.push(`- Likely source: ${c.file}:${c.line} (${c.reason})`)
    }
    const image = images?.[pick.id]
    if (image) lines.push(`- Picture: attached image ${image}`)
    if (t.html) lines.push('- HTML:', '```html', t.html, '```')
  }
  if (locate?.entryCss) lines.push('', `Tailwind entry stylesheet: ${locate.entryCss}`)
  lines.push('', `When you're done, say briefly what you changed for each number.`)
  return lines.join('\n')
}
