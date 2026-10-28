/**
 * Fails the build when a docs page or heading that the Fabricator app links to is
 * missing from the static export. The app links to the docs in two ways:
 *
 * - The pages and headings in src/shared/docs-links.json (see src/renderer/src/docsLinks.ts).
 *   Renaming a page or a linked heading must update that file in the same change.
 * - Search, which indexes every page and its ## and ### headings when the app is built
 *   (scripts/docs-index.mjs). This checks that the anchors it computes are the ones the
 *   site renders.
 *
 * Run after `npm run build`.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { siteConfig } from '../lib/site.config';
import { buildDocsIndex } from '../../scripts/docs-index.mjs';

const WEBSITE = path.resolve(import.meta.dirname, '..');
const OUT = path.join(WEBSITE, 'out');
const LINKS_FILE = path.resolve(WEBSITE, '..', 'src', 'shared', 'docs-links.json');

const { base, links } = JSON.parse(readFileSync(LINKS_FILE, 'utf8')) as {
  base: string;
  links: Record<string, string>;
};

const errors: string[] = [];
const pages = new Map<string, string>();

/** The built page for a route, read once; undefined when there is none. */
function pageHtml(route: string): string | undefined {
  if (!pages.has(route)) {
    const candidates = [path.join(OUT, `${route}.html`), path.join(OUT, route, 'index.html')];
    const file = candidates.find((candidate) => existsSync(candidate));
    pages.set(route, file ? readFileSync(file, 'utf8') : '');
  }
  return pages.get(route) || undefined;
}

if (base !== siteConfig.baseUrl) {
  errors.push(`docs-links.json base ${base} does not match the site URL ${siteConfig.baseUrl}`);
}

for (const [name, target] of Object.entries(links)) {
  const [route, anchor] = target.split('#');
  if (!route.startsWith('/docs')) {
    errors.push(`${name}: ${target} is not a docs route`);
    continue;
  }
  const html = pageHtml(route);
  if (!html) {
    errors.push(`${name}: no page for ${route}`);
    continue;
  }
  if (anchor && !html.includes(`id="${anchor}"`)) {
    errors.push(`${name}: ${route} has no heading with id "${anchor}"`);
  }
}

const index = buildDocsIndex(path.join(WEBSITE, 'content', 'docs'));
let searchLinks = 0;
for (const page of index.pages) {
  const html = pageHtml(page.path);
  searchLinks++;
  if (!html) {
    errors.push(`Search: no page for ${page.path}`);
    continue;
  }
  for (const heading of page.headings) {
    searchLinks++;
    if (!html.includes(`id="${heading.anchor}"`)) {
      errors.push(`Search: ${page.path} has no heading with id "${heading.anchor}" (${heading.text})`);
    }
  }
}

if (errors.length) {
  console.error(`In-app docs links are broken (${LINKS_FILE}, scripts/docs-index.mjs):`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log(
  `verify-app-links: ${Object.keys(links).length} in-app links and ${searchLinks} Search links resolve.`
);
