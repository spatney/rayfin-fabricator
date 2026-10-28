/// <reference types="vite/client" />

/** The documentation, indexed for Search (see scripts/docs-index.mjs). */
declare module 'virtual:docs-index' {
  export type DocsIndex = import('../../../scripts/docs-index.mjs').DocsIndex
  export type DocsIndexPage = import('../../../scripts/docs-index.mjs').DocsIndexPage
  const index: DocsIndex
  export default index
}
