import docs from '@shared/docs-links.json'

/**
 * Pages of the Fabricator docs site (website/) that the app links to. The site's build
 * fails if one of these routes or anchors disappears (website/scripts/verify-app-links.mts).
 */
export type DocsLink = keyof typeof docs.links

export function docsUrl(link: DocsLink): string {
  return `${docs.base}${docs.links[link]}`
}

/** The address of any docs page (`/docs/ship/deploy`), optionally at one of its headings. */
export function docsPageUrl(path: string, anchor?: string): string {
  return `${docs.base}${path}${anchor ? `#${anchor}` : ''}`
}

/** Open a docs page in the system browser. */
export function openDocs(link: DocsLink): void {
  void window.api.openExternal(docsUrl(link))
}
