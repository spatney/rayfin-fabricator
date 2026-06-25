// Shared syntax-highlighting helpers built on highlight.js.
//
// We import the hljs CORE (not the full bundle) and register a curated language
// set once, to keep the renderer chunk small. Used by both the Markdown code
// blocks and the tool-output (file read) previews.
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import json from 'highlight.js/lib/languages/json'
import bash from 'highlight.js/lib/languages/bash'
import cssLang from 'highlight.js/lib/languages/css'
import xml from 'highlight.js/lib/languages/xml'
import rust from 'highlight.js/lib/languages/rust'
import python from 'highlight.js/lib/languages/python'
import sql from 'highlight.js/lib/languages/sql'
import yaml from 'highlight.js/lib/languages/yaml'
import markdown from 'highlight.js/lib/languages/markdown'

let registered = false
function ensureLanguages(): void {
  if (registered) return
  registered = true
  hljs.registerLanguage('javascript', javascript)
  hljs.registerLanguage('typescript', typescript)
  hljs.registerLanguage('json', json)
  hljs.registerLanguage('bash', bash)
  hljs.registerLanguage('css', cssLang)
  hljs.registerLanguage('xml', xml)
  hljs.registerLanguage('rust', rust)
  hljs.registerLanguage('python', python)
  hljs.registerLanguage('sql', sql)
  hljs.registerLanguage('yaml', yaml)
  hljs.registerLanguage('markdown', markdown)
}

/** Common fence aliases → a registered language. */
const LANG_ALIAS: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  html: 'xml',
  svg: 'xml',
  py: 'python',
  rs: 'rust',
  yml: 'yaml',
  md: 'markdown'
}

/** File extension → a registered language (for file-read previews). */
const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'css',
  less: 'css',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  vue: 'xml',
  rs: 'rust',
  py: 'python',
  sql: 'sql',
  yml: 'yaml',
  yaml: 'yaml',
  md: 'markdown',
  markdown: 'markdown',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash'
}

type Highlight = { html: string; label: string } | null

// Memoize highlight results so repeated renders of the same code block (every
// streamed chat token currently re-renders sibling messages) don't re-run the
// hljs tokenizer. Bounded with simple FIFO eviction to cap memory.
const HL_CACHE = new Map<string, Highlight>()
const HL_CACHE_MAX = 500

/** Syntax-highlight `text` for `lang`, returning HTML + resolved label, or null. */
export function highlightCode(text: string, lang?: string): Highlight {
  const key = (lang ?? '').toLowerCase()
  const resolved = LANG_ALIAS[key] ?? key
  const cacheKey = `${resolved}\u0000${text}`
  const cached = HL_CACHE.get(cacheKey)
  if (cached !== undefined) return cached

  ensureLanguages()
  let result: Highlight = null
  if (resolved && hljs.getLanguage(resolved)) {
    try {
      const out = hljs.highlight(text, { language: resolved, ignoreIllegals: true })
      result = { html: out.value, label: resolved }
    } catch {
      result = null
    }
  }
  if (HL_CACHE.size >= HL_CACHE_MAX) {
    const oldest = HL_CACHE.keys().next().value
    if (oldest !== undefined) HL_CACHE.delete(oldest)
  }
  HL_CACHE.set(cacheKey, result)
  return result
}

/** Infer a registered language from a file path's extension, or undefined. */
export function langFromPath(path: string): string | undefined {
  const ext = /\.([a-z0-9]+)\s*$/i.exec(path.trim())?.[1]?.toLowerCase()
  return ext ? EXT_LANG[ext] : undefined
}
