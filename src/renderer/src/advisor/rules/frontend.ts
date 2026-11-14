import { skipString } from '../../model/parseSchema'
import type { QuickHit, QuickRuleImpl } from '../quick'
import { say } from '../quick'
import { lineOf, matchAll } from '../source'
import { code } from './util'

/** Page sizes at or above this are flagged as oversized. */
const OVERSIZED_PAGE = 1000

/** The text of a JSX opening tag starting at `start`, up to its closing `>`. */
function tagText(src: string, start: number): string {
  let depth = 0
  let i = start
  while (i < src.length) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(src, i)
      continue
    }
    if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === '>' && depth === 0 && src[i - 1] !== '=') return src.slice(start, i + 1)
    i++
  }
  return src.slice(start)
}

export const frontendRules: QuickRuleImpl[] = [
  {
    id: 'performance/oversized-page',
    run: (ctx) => {
      const hits: QuickHit[] = []
      for (const src of ctx.frontend) {
        for (const m of matchAll(/\.first\s*\(\s*(\d[\d_]*)\s*\)/, src.masked)) {
          const size = Number(m[1].replace(/_/g, ''))
          if (size < OVERSIZED_PAGE) continue
          const line = lineOf(src, m.index)
          hits.push({
            file: src.path,
            line,
            label: `${src.path}:${line}`,
            ...say((w) =>
              w.t('performance/oversized-page.hit', { file: code(src.path), rows: w.number(size) })
            )
          })
        }
      }
      return hits
    }
  },
  {
    id: 'accessibility/img-alt',
    run: (ctx) => {
      const hits: QuickHit[] = []
      for (const src of ctx.frontend.filter((f) => /\.(tsx|jsx)$/.test(f.path))) {
        for (const m of matchAll(/<img\b/, src.masked)) {
          const tag = tagText(src.masked, m.index)
          if (/\balt\s*=/.test(tag) || /\{\s*\.\.\./.test(tag)) continue
          const line = lineOf(src, m.index)
          hits.push({
            file: src.path,
            line,
            label: `${src.path}:${line}`,
            ...say((w) =>
              w.t('accessibility/img-alt.hit', {
                img: code('<img>'),
                file: code(src.path),
                alt: code('alt')
              })
            )
          })
        }
      }
      return hits
    }
  }
]
