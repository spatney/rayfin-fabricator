#!/usr/bin/env node
// Checks the renderer bundle in dist/ for what the packaged app relies on but unit tests
// can't see (they mock Monaco and never load index.html). Run after `npm run build:renderer`.
//   - Assets load through relative ./ URLs: Tauri serves dist/ from a custom protocol.
//   - index.html carries the Content-Security-Policy, and it allows no remote origins.
//     tauri.conf.json sets `csp: null`, so this tag is the app's only CSP.
//   - Every Monaco web worker is bundled, so the editors work offline.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const WORKERS = ['editor', 'json', 'css', 'html', 'ts']

const indexHtml = path.join(DIST, 'index.html')
if (!fs.existsSync(indexHtml)) {
  console.error('dist/index.html not found. Run `npm run build:renderer` first.')
  process.exit(1)
}

const problems = []
const html = fs.readFileSync(indexHtml, 'utf8')
for (const [, , url] of html.matchAll(/<(?:script|link)\b[^>]*?\b(src|href)="([^"]*)"/g)) {
  if (!url.startsWith('./'))
    problems.push(`index.html loads ${url}; asset URLs must be relative (./)`)
}

const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/)?.[1]
if (!csp) problems.push('index.html has no Content-Security-Policy meta tag')
else if (/https?:|\*/.test(csp))
  problems.push(`the Content-Security-Policy allows remote origins: ${csp}`)

const assets = fs.readdirSync(path.join(DIST, 'assets'))
for (const worker of WORKERS) {
  if (!assets.some((name) => name.startsWith(`${worker}.worker-`) && name.endsWith('.js'))) {
    problems.push(
      `dist/assets has no ${worker}.worker-*.js, so Monaco's ${worker} worker isn't bundled`
    )
  }
}

if (problems.length) {
  console.error(`Renderer build check failed:\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
console.log(`Renderer build check passed: relative assets, CSP, ${WORKERS.length} Monaco workers.`)
