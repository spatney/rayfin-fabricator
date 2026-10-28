/** A ## or ### heading of a docs page. */
export interface DocsIndexHeading {
  level: number
  text: string
  /** The heading's id on the site, so `${page.path}#${anchor}` links to it. */
  anchor: string
  /** The first line of prose under the heading, clipped; '' when there is none. */
  snippet: string
}

/** One page of the documentation site. */
export interface DocsIndexPage {
  /** The page's route on the site, such as `/docs/ship/deploy`. */
  path: string
  title: string
  description: string
  /** The sidebar section the page sits in, such as `Ship`. */
  section: string
  headings: DocsIndexHeading[]
}

export interface DocsIndex {
  pages: DocsIndexPage[]
}

/** A heading's anchor, as github-slugger (and so the site) makes it. */
export function slugify(text: string): string

/** Markdown and MDX inline syntax, reduced to the words a reader sees. */
export function plainText(markdown: string): string

/** Index the docs under `contentDir`, and list the files it read. */
export function buildDocsIndex(contentDir?: string): DocsIndex & { files: string[] }

/** A Vite plugin serving the index as `virtual:docs-index`. */
export function docsIndexPlugin(options?: { contentDir?: string }): {
  name: string
  resolveId(id: string): string | undefined
  load(
    this: { warn(message: string): void; addWatchFile(file: string): void },
    id: string
  ): string | undefined
}
