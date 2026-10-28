// The documentation, indexed for Search. Built from website/content/docs when the
// renderer is built (or served), so the app always ships the index of the docs in its
// own commit, and never a copy that drifted: CI skips website-only changes.
//
// Each page gives its title, description, sidebar section and its ## and ### headings,
// each with the anchor the site gives it and the first line under it. Anchors follow
// github-slugger, as the site's do; website/scripts/verify-app-links.mts checks every
// one against the built site.
//
// Node built-ins only, so the website's scripts can import it too.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** website/content/docs, next to this script. Resolved on use: only Node has file URLs here. */
function defaultContent() {
  return fileURLToPath(new URL('../website/content/docs', import.meta.url))
}
const VIRTUAL_ID = 'virtual:docs-index'
const RESOLVED_ID = '\0virtual:docs-index'
const SNIPPET_MAX = 150

/**
 * Everything github-slugger keeps: letters, marks, decimal digits, connector
 * punctuation, joiners, spaces and hyphens. The rest is removed.
 */
const SLUG_DROP =
  /[^\p{Alphabetic}\p{Mark}\p{Decimal_Number}\p{Connector_Punctuation}\p{Join_Control} -]/gu

/** A heading's anchor, as github-slugger makes it. */
export function slugify(text) {
  return text.toLowerCase().replace(SLUG_DROP, '').replace(/ /g, '-')
}

/** Unique anchors within one page: repeats get -1, -2, as github-slugger's do. */
function createSlugger() {
  const seen = new Map()
  return (text) => {
    const base = slugify(text)
    let slug = base
    while (seen.has(slug)) {
      const n = seen.get(base) + 1
      seen.set(base, n)
      slug = `${base}-${n}`
    }
    seen.set(slug, 0)
    return slug
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** Markdown and MDX inline syntax, reduced to the words a reader sees. */
export function plainText(markdown) {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[^\w*])\*([^*\s][^*]*)\*/g, '$1$2')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name) => ENTITIES[name])
    .replace(/\\([\\`*_{}[\]()#+\-.!<>])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A short line for a result: the text cut at a word, with an ellipsis. */
function clip(text, max = SNIPPET_MAX) {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, '')}…`
}

/** One frontmatter value: double-quoted (JSON-style), single-quoted, plain or folded. */
function frontmatterValue(lines, key) {
  const at = lines.findIndex((line) => line.startsWith(`${key}:`))
  if (at < 0) return ''
  const raw = lines[at].slice(key.length + 1).trim()
  if (raw === '>' || raw === '>-' || raw === '|' || raw === '|-') {
    const block = []
    for (const line of lines.slice(at + 1)) {
      if (!/^\s+\S/.test(line)) break
      block.push(line.trim())
    }
    return block.join(raw.startsWith('>') ? ' ' : '\n')
  }
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw)
    } catch {
      return raw.slice(1, -1)
    }
  }
  if (raw.startsWith("'")) return raw.slice(1, -1).replace(/''/g, "'")
  return raw
}

/** Splits a page into its frontmatter lines and its body lines. */
function splitPage(source) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  if (lines[0] !== '---') return { front: [], body: lines }
  const end = lines.indexOf('---', 1)
  if (end < 0) return { front: [], body: lines }
  return { front: lines.slice(1, end), body: lines.slice(end + 1) }
}

/** Lines that open a block a snippet should skip: images, tables, components, comments, callouts. */
const NOT_PROSE = /^(!\[|\||<|\{\/\*|>|---|\s*$)/

/** The first line of prose under a heading, or '' when a block of something else comes first. */
function snippetAfter(body, from) {
  let fence = null
  for (let i = from; i < body.length; i++) {
    const line = body[i]
    const marker = line.match(/^\s*(`{3,}|~{3,})/)
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null
      continue
    }
    if (marker) {
      fence = marker[1]
      continue
    }
    if (/^#{1,6}\s/.test(line)) return ''
    if (NOT_PROSE.test(line)) continue
    const text = plainText(line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, ''))
    if (text) return clip(text)
  }
  return ''
}

/** The ## and ### headings of a page, outside code fences, with anchors and snippets. */
function headingsOf(body) {
  const slug = createSlugger()
  const headings = []
  let fence = null
  for (let i = 0; i < body.length; i++) {
    const line = body[i]
    const marker = line.match(/^\s*(`{3,}|~{3,})/)
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null
      continue
    }
    if (marker) {
      fence = marker[1]
      continue
    }
    const heading = line.match(/^(#{2,6})\s+(.+?)(?:\s+#+)?\s*$/)
    if (!heading) continue
    // Headings deeper than ### still take a slug, so later anchors stay in step.
    const explicit = heading[2].match(/\s*\[#([^\]]+)\]\s*$/)
    const text = plainText(explicit ? heading[2].slice(0, explicit.index) : heading[2])
    const anchor = explicit ? explicit[1] : slug(text)
    if (heading[1].length > 3 || !text) continue
    headings.push({ level: heading[1].length, text, anchor, snippet: snippetAfter(body, i + 1) })
  }
  return headings
}

/** The sidebar's sections, by page: `---Build---` in meta.json starts the Build section. */
function sectionsOf(contentDir) {
  const sections = new Map()
  const meta = path.join(contentDir, 'meta.json')
  if (!existsSync(meta)) return sections
  let current = ''
  for (const entry of JSON.parse(readFileSync(meta, 'utf8')).pages ?? []) {
    const separator = typeof entry === 'string' && entry.match(/^---(.+)---$/)
    if (separator) current = separator[1].trim()
    else if (typeof entry === 'string') sections.set(entry, current)
  }
  return sections
}

function collect(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collect(full, out)
    else if (entry.isFile() && /\.mdx?$/.test(entry.name)) out.push(full)
  }
  return out
}

/** `start/tour.mdx` → `/docs/start/tour`; an `index` page takes its folder's route. */
function routeOf(contentDir, file) {
  const rel = path
    .relative(contentDir, file)
    .replace(/\\/g, '/')
    .replace(/\.mdx?$/, '')
  const route = rel === 'index' ? '' : rel.replace(/\/index$/, '')
  return route ? `/docs/${route}` : '/docs'
}

/**
 * Index the docs under `contentDir`. Returns the index and the files it read, so a
 * dev server can watch them. A missing folder gives an empty index.
 */
export function buildDocsIndex(contentDir = defaultContent()) {
  if (!existsSync(contentDir)) return { pages: [], files: [] }
  const sections = sectionsOf(contentDir)
  const files = collect(contentDir).sort()
  const pages = files.map((file) => {
    const { front, body } = splitPage(readFileSync(file, 'utf8'))
    const route = routeOf(contentDir, file)
    const key = path
      .relative(contentDir, file)
      .replace(/\\/g, '/')
      .replace(/\.mdx?$/, '')
    return {
      path: route,
      title: plainText(frontmatterValue(front, 'title')) || route,
      description: plainText(frontmatterValue(front, 'description')),
      section: sections.get(key) ?? '',
      headings: headingsOf(body)
    }
  })
  return { pages, files: [...files, path.join(contentDir, 'meta.json')] }
}

/** Serves the index as `virtual:docs-index` (default export: `{ pages }`). */
export function docsIndexPlugin(options = {}) {
  const contentDir = options.contentDir ?? defaultContent()
  return {
    name: 'fabricator-docs-index',
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : undefined
    },
    load(id) {
      if (id !== RESOLVED_ID) return undefined
      const { pages, files } = buildDocsIndex(contentDir)
      if (pages.length === 0) {
        this.warn(`No documentation found under ${contentDir}; Search will have no docs.`)
      }
      for (const file of files) if (existsSync(file)) this.addWatchFile(file)
      return `export default ${JSON.stringify({ pages })}`
    }
  }
}
