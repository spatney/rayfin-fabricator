import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import GithubSlugger from 'github-slugger';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT = path.join(ROOT, 'content', 'docs');
const PUBLIC = path.join(ROOT, 'public');
const ALLOWED_COMPONENTS = new Set(['Tabs','Tab','Cards','Card','Steps','Step']);
const ALLOWED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']);
const MAX_DESCRIPTION = 200;
type Problem = { file: string; line?: number; message: string };
const problems: Problem[] = [];
const warnings: Problem[] = [];
let screenshotComments = 0;

/**
 * Reads a page with LF line endings. A Windows checkout can have CRLF, and the line-anchored
 * patterns below (`.*$`) never match a line that ends in `\r`, which would silently skip checks.
 */
async function readSource(file: string): Promise<string> {
  return (await readFile(file, 'utf8')).replace(/\r\n?/g, '\n');
}

async function main() {
  const files = await collectMdx(CONTENT);
  if (files.length === 0) throw new Error(`No MDX files under ${CONTENT}`);
  const routes = new Set(files.map(toRoute));
  const headings = await collectHeadings(files);
  for (const file of files) {
    const raw = await readSource(file);
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    let data: Record<string, unknown>; let content: string;
    try { const parsed = matter(raw); data = parsed.data; content = parsed.content; }
    catch (error) { problems.push({ file: rel, message: `invalid YAML frontmatter — ${(error as Error).message.split('\n')[0]}` }); continue; }
    checkFrontmatter(rel, data);
    checkCodeFences(rel, content);
    checkComponents(rel, content);
    checkLinks(rel, content, routes, headings, toRoute(file));
    checkImages(rel, content);
    checkPlaceholders(rel, content);
  }
  report(files.length);
}

async function collectHeadings(files: string[]): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>();
  for (const file of files) {
    const raw = await readSource(file);
    let content = ''; try { content = matter(raw).content; } catch { continue; }
    const slugger = new GithubSlugger(); const anchors = new Set<string>();
    for (const match of content.matchAll(/^#{2,6}\s+(.+)$/gm)) {
      const heading = match[1].trim(); const explicit = heading.match(/\[#([^\]]+)\]\s*$/);
      anchors.add(explicit ? explicit[1] : slugger.slug(heading.replace(/\s*\[#([^\]]+)\]\s*$/, '')));
    }
    map.set(toRoute(file), anchors);
  }
  return map;
}

function checkFrontmatter(file: string, data: Record<string, unknown>) {
  const title = data.title; const description = data.description;
  if (typeof title !== 'string' || title.trim() === '') problems.push({ file, message: 'missing frontmatter `title`' });
  if (typeof description !== 'string' || description.trim() === '') problems.push({ file, message: 'missing frontmatter `description`' });
  else if (description.length > MAX_DESCRIPTION) problems.push({ file, message: `description is ${description.length} chars; max ${MAX_DESCRIPTION}` });
}

function checkCodeFences(file: string, content: string) {
  const lines = content.split('\n'); let inFence = false; let fenceMarker = ''; let fenceLang = '';
  lines.forEach((line, index) => {
    const match = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
    const closes = Boolean(inFence && match && match[2].startsWith(fenceMarker[0]) && match[3].trim() === '');
    if (inFence && fenceLang === 'mermaid' && !closes) checkMermaidLine(file, index + 1, line);
    if (!match) return;
    const [, , marker, rest] = match;
    if (inFence) { if (closes) { inFence = false; fenceMarker = ''; fenceLang = ''; } return; }
    inFence = true; fenceMarker = marker;
    const info = rest.trim(); const lang = info.split(/\s+/)[0]; fenceLang = lang;
    if (!lang) problems.push({ file, line: index + 1, message: 'code fence has no language' });
    if (lang === 'prompt' && !/\btitle=("[^"]+"|'[^']+')/.test(info)) problems.push({ file, line: index + 1, message: 'prompt fence needs title="…"' });
  });
  if (inFence) problems.push({ file, message: 'unterminated code fence' });
}

/** components/mermaid.tsx injects theme-aware styles for these classes; fences only tag nodes. */
const MERMAID_CLASSES = new Set(['actor', 'service', 'store', 'external', 'experimental']);

function checkMermaidLine(file: string, line: number, text: string) {
  if (/^\s*(classDef|style|linkStyle)\b/.test(text)) {
    problems.push({ file, line, message: 'mermaid fences must not style nodes; tag them with `class <ids> <class>` and let the site theme them' });
  }
  const tagged = text.match(/^\s*class\s+\S+\s+([\w-]+)\s*;?\s*$/);
  if (tagged && !MERMAID_CLASSES.has(tagged[1])) {
    problems.push({ file, line, message: `unknown mermaid class "${tagged[1]}" (use ${[...MERMAID_CLASSES].join(', ')})` });
  }
}

function checkComponents(file: string, content: string) {
  const stripped = stripCode(content); const seen = new Set<string>();
  for (const match of stripped.matchAll(/<([A-Z][A-Za-z0-9]*)[\s/>]/g)) {
    const name = match[1]; if (ALLOWED_COMPONENTS.has(name) || seen.has(name)) continue;
    seen.add(name); problems.push({ file, message: `<${name}> is not in the MDX component allowlist` });
  }
  if (/<Callout/.test(stripped)) problems.push({ file, message: 'use a GFM alert (`> [!NOTE]`) instead of <Callout>' });
}

function checkLinks(file: string, content: string, routes: Set<string>, headings: Map<string, Set<string>>, selfRoute: string) {
  const stripped = stripCode(content);
  for (const match of stripped.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const href = match[1]; if (/^(https?:|mailto:)/.test(href) || href.startsWith('/screenshots/')) continue;
    if (href.startsWith('./') || href.startsWith('../')) { problems.push({ file, message: `relative link ${href}; use an absolute site path` }); continue; }
    const [pathname, anchor] = href.split('#'); const targetRoute = pathname === '' ? selfRoute : pathname.replace(/\/$/, '');
    if (pathname !== '' && !pathname.startsWith('/')) continue;
    if (pathname.endsWith('.md')) { problems.push({ file, message: `link to markdown mirror ${href}; link to the page route instead` }); continue; }
    if (pathname !== '' && !pathname.startsWith('/docs') && pathname !== '/') problems.push({ file, message: `internal link ${href} should start with /docs (or /)` });
    if (targetRoute.startsWith('/docs')) {
      if (!routes.has(targetRoute)) { problems.push({ file, message: `broken internal link ${href}` }); continue; }
      if (anchor && !headings.get(targetRoute)?.has(anchor)) warnings.push({ file, message: `dead anchor ${href}` });
    }
  }
}

function checkImages(file: string, content: string) {
  const stripped = stripCode(content);
  for (const match of stripped.matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const alt = match[1].trim(); const src = match[2];
    if (!alt) problems.push({ file, message: `image ${src} has empty alt text` });
    if (/^https?:/.test(src)) continue;
    if (!src.startsWith('/')) { problems.push({ file, message: `image ${src} must use a root-relative /public path` }); continue; }
    const ext = path.extname(src.split(/[?#]/)[0]).toLowerCase();
    if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) { problems.push({ file, message: `image ${src} must use a supported image extension (${[...ALLOWED_IMAGE_EXTENSIONS].join(', ')})` }); continue; }
    const full = path.join(PUBLIC, src.replace(/^\//, ''));
    if (!existsSync(full)) problems.push({ file, message: `image ${src} does not exist under public/` });
    checkScreenshotTwin(file, src);
  }
  screenshotComments += [...content.matchAll(/\{\/\*\s*screenshot:[\s\S]*?\*\/\}/g)].length;
}

/**
 * Pages link a screenshot's dark capture, `/screenshots/<id>.webp`; the site swaps in its light
 * twin, `<id>.light.webp`, for the light theme (components/mdx.tsx), so both must exist.
 */
function checkScreenshotTwin(file: string, src: string) {
  if (!src.startsWith('/screenshots/')) return;
  if (/\.light\.webp$/i.test(src)) { problems.push({ file, message: `image ${src}: link the dark capture (${src.replace(/\.light\.webp$/i, '.webp')}); the site shows the light one in the light theme` }); return; }
  if (!/^\/screenshots\/[\w-]+\.webp$/.test(src)) { problems.push({ file, message: `image ${src}: screenshots are /screenshots/<id>.webp, with a light twin <id>.light.webp` }); return; }
  const twin = path.join(PUBLIC, src.replace(/^\//, '').replace(/\.webp$/, '.light.webp'));
  if (!existsSync(twin)) problems.push({ file, message: `image ${src} has no light twin ${src.replace(/\.webp$/, '.light.webp')} under public/` });
}

function checkPlaceholders(file: string, content: string) { if (content.trim() === 'This page is being written.') warnings.push({ file, message: 'page body is still exactly "This page is being written."' }); }
function stripCode(content: string): string { return content.replace(/^(\s*)(`{3,}|~{3,})[\s\S]*?\n\1\2\s*$/gm, (block) => '\n'.repeat(block.split('\n').length - 1)).replace(/`[^`\n]*`/g, ''); }
async function collectMdx(dir: string): Promise<string[]> { const out: string[] = []; for (const entry of await readdir(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) out.push(...await collectMdx(full)); else if (entry.name.endsWith('.mdx')) out.push(full); } return out; }
function toRoute(file: string): string { const rel = path.relative(CONTENT, file).replace(/\\/g, '/').replace(/\.mdx$/, ''); const withoutIndex = rel.replace(/(^|\/)index$/, ''); return withoutIndex ? `/docs/${withoutIndex}` : '/docs'; }
function report(fileCount: number) { for (const w of warnings) console.warn(`warn  ${w.file}${w.line ? `:${w.line}` : ''}  ${w.message}`); for (const p of problems) console.error(`error ${p.file}${p.line ? `:${p.line}` : ''}  ${p.message}`); if (screenshotComments) console.log(`info  ${screenshotComments} screenshot placeholder comment(s)`); console.log(`\n[check-docs] ${fileCount} pages, ${problems.length} errors, ${warnings.length} warnings`); if (problems.length > 0) process.exitCode = 1; }
await main();
