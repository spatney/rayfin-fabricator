#!/usr/bin/env node
// Re-vendors the `wry` crate into src-tauri/vendor/wry and applies Fabricator's local
// patches from src-tauri/vendor/wry-patches (see docs/VENDORED-WRY-PATCH.md).
//
//   node scripts/wry/vendor-wry.mjs update <version> [--allow-rejects]
//       Download wry <version> from crates.io (checksum-verified), apply every patch in
//       order and replace src-tauri/vendor/wry. Nothing changes if a patch fails, unless
//       --allow-rejects is given: then the hunks that apply are kept and the rest are
//       left as *.rej files to resolve by hand before running refresh-patches.
//   node scripts/wry/vendor-wry.mjs verify
//       Check that src-tauri/vendor/wry is exactly the upstream crate plus the patches.
//   node scripts/wry/vendor-wry.mjs refresh-patches
//       Rewrite each patch's diff from the vendored tree (after resolving rejects, or
//       after editing a patched file). Each patch keeps its description and the files
//       it covers. To add a patch, create NNNN-<name>.patch holding a description and a
//       `diff --git a/<file> b/<file>` line per file, then run this.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const CRATE = 'wry'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const VENDOR_DIR = path.join(ROOT, 'src-tauri', 'vendor', CRATE)
const PATCH_DIR = path.join(ROOT, 'src-tauri', 'vendor', `${CRATE}-patches`)
const USER_AGENT = 'rayfin-fabricator vendor-wry (https://github.com/spatney/rayfin-fabricator)'
const DIFF_HEADER = /^diff --git a\/(\S+) b\/(\S+)$/gm

class UsageError extends Error {}

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/')
}

function vendoredVersion() {
  const manifest = fs.readFileSync(path.join(VENDOR_DIR, 'Cargo.toml'), 'utf8')
  const pkg = manifest.split(/^\[/m).find((section) => section.startsWith('package]'))
  const version = pkg?.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
  if (!version) throw new Error(`Couldn't read the version from ${rel(VENDOR_DIR)}/Cargo.toml`)
  return version
}

async function get(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res
  } catch (error) {
    throw new Error(`Couldn't download ${url}: ${error.cause?.message ?? error.message}`, { cause: error })
  }
}

async function download(version) {
  const meta = (await (await get(`https://crates.io/api/v1/crates/${CRATE}/${version}`)).json())
    .version
  if (meta.yanked) console.warn(`warning: ${CRATE} ${version} is yanked on crates.io`)
  const url = `https://static.crates.io/crates/${CRATE}/${CRATE}-${version}.crate`
  const crate = Buffer.from(await (await get(url)).arrayBuffer())
  const actual = createHash('sha256').update(crate).digest('hex')
  if (actual !== meta.checksum) {
    throw new Error(`Checksum mismatch for ${url}: expected ${meta.checksum}, got ${actual}`)
  }
  return untar(crate, `${CRATE}-${version}`)
}

// Minimal reader for the gzipped tarballs `cargo package` produces (ustar/GNU headers,
// GNU long names, pax `path` records). Avoids depending on whichever `tar` is on PATH.
function untar(gzipped, topDir) {
  const tar = gunzipSync(gzipped)
  const files = new Map()
  let longName = null
  let paxPath = null
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) break
    const field = (start, len) => {
      const raw = header.subarray(start, start + len)
      const end = raw.indexOf(0)
      return raw.subarray(0, end === -1 ? len : end).toString('utf8')
    }
    const size = parseInt(field(124, 12).trim() || '0', 8)
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156])
    const data = tar.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512

    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0+$/, '')
      continue
    }
    if (type === 'x') {
      paxPath = paxRecord(data, 'path') ?? paxPath
      continue
    }
    if (type === 'g' || type === 'K' || type === '5') continue
    const ustar = header.subarray(257, 263).toString('latin1') === 'ustar\0'
    const prefix = ustar ? field(345, 155) : ''
    const name = longName ?? paxPath ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100))
    longName = null
    paxPath = null
    if (type !== '0') throw new Error(`Unsupported tar entry type '${type}' for ${name}`)

    const inner = name.startsWith(`${topDir}/`) ? name.slice(topDir.length + 1) : null
    const parts = inner?.split('/') ?? []
    if (!inner || parts.some((p) => p === '' || p === '.' || p === '..')) {
      throw new Error(`Unexpected path in crate archive: ${name}`)
    }
    files.set(inner, Buffer.from(data))
  }
  return files
}

function paxRecord(data, key) {
  let found = null
  for (let i = 0; i < data.length; ) {
    const space = data.indexOf(0x20, i)
    if (space === -1) break
    const len = parseInt(data.subarray(i, space).toString('ascii'), 10)
    if (!(len > 0)) break
    const record = data.subarray(space + 1, i + len - 1).toString('utf8')
    const eq = record.indexOf('=')
    if (eq > 0 && record.slice(0, eq) === key) found = record.slice(eq + 1)
    i += len
  }
  return found
}

function writeTree(files, dir) {
  for (const [file, content] of files) {
    const target = path.join(dir, ...file.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
}

function readTree(dir, prefix = '', files = new Map()) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = prefix ? `${prefix}/${entry.name}` : entry.name
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) readTree(full, file, files)
    else files.set(file, fs.readFileSync(full))
  }
  return files
}

function patches() {
  return fs
    .readdirSync(PATCH_DIR)
    .filter((name) => name.endsWith('.patch'))
    .sort()
    .map((name) => path.join(PATCH_DIR, name))
}

function git(args, cwd) {
  // The ceiling keeps git from treating any repository above `cwd` as the one to
  // patch, and fixed line endings keep results identical on every OS.
  return spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(cwd) }
  })
}

function applyPatches(dir, { allowRejects = false } = {}) {
  const failed = []
  for (const patch of patches()) {
    const result = git(['apply', '--verbose', ...(allowRejects ? ['--reject'] : []), patch], dir)
    if (result.error) throw result.error
    if (result.status === 0) {
      console.log(`✓ ${path.basename(patch)}`)
      continue
    }
    failed.push(path.basename(patch))
    console.error(`\n✗ ${path.basename(patch)} didn't apply cleanly:\n${result.stderr.trim()}`)
    if (!allowRejects) break
  }
  return failed
}

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `vendor-${CRATE}-${label}-`))
}

async function update(version, { allowRejects }) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? ''))
    throw new UsageError('update needs a version, e.g. 0.57.0')
  const files = await download(version)
  const work = tempDir('update')
  const staging = path.join(work, `${CRATE}-${version}`)
  try {
    writeTree(files, staging)
    const failed = applyPatches(staging, { allowRejects })
    if (failed.length && !allowRejects) {
      throw new Error(
        `Left ${rel(VENDOR_DIR)} unchanged. Re-run with --allow-rejects to keep the hunks that ` +
          'apply, resolve the *.rej files, then run refresh-patches.'
      )
    }
    fs.rmSync(VENDOR_DIR, { recursive: true, force: true })
    fs.cpSync(staging, VENDOR_DIR, { recursive: true })
    console.log(`\nVendored ${CRATE} ${version} into ${rel(VENDOR_DIR)}.`)
    if (failed.length) {
      console.log(`\nResolve the *.rej files for ${failed.join(', ')}, delete them, then run:`)
      console.log('  node scripts/wry/vendor-wry.mjs refresh-patches')
    }
    console.log('\nNext:')
    console.log(
      `  cd src-tauri; cargo update -p ${CRATE}  # point Cargo.lock at the vendored version`
    )
    console.log(
      '  cargo test --lib vendor_guard          # the [patch] is live and every patch is present'
    )
    console.log('  node scripts/wry/vendor-wry.mjs verify')
    console.log('  Then update the version table in docs/VENDORED-WRY-PATCH.md.')
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

async function verify() {
  const version = vendoredVersion()
  const work = tempDir('verify')
  const expectedDir = path.join(work, `${CRATE}-${version}`)
  try {
    writeTree(await download(version), expectedDir)
    if (applyPatches(expectedDir).length) {
      throw new Error(`The patches in ${rel(PATCH_DIR)} no longer apply to ${CRATE} ${version}.`)
    }
    const expected = readTree(expectedDir)
    const actual = readTree(VENDOR_DIR)
    const problems = []
    for (const [file, content] of expected) {
      if (!actual.has(file)) problems.push(`missing: ${file}`)
      else if (!actual.get(file).equals(content)) problems.push(`differs: ${file}`)
    }
    for (const file of actual.keys()) if (!expected.has(file)) problems.push(`unexpected: ${file}`)
    if (problems.length) {
      throw new Error(
        `${rel(VENDOR_DIR)} is not ${CRATE} ${version} plus the patches in ${rel(PATCH_DIR)}:\n  ` +
          `${problems.join('\n  ')}\nChange vendored files only through a patch (edit them, then run refresh-patches).`
      )
    }
    console.log(`\n${rel(VENDOR_DIR)} is ${CRATE} ${version} plus ${patches().length} patches.`)
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

async function refreshPatches() {
  const upstream = await download(vendoredVersion())
  const vendored = readTree(VENDOR_DIR)
  const changed = [...new Set([...upstream.keys(), ...vendored.keys()])].filter((file) => {
    const before = upstream.get(file)
    const after = vendored.get(file)
    return !before || !after || !before.equals(after)
  })
  const owner = new Map()
  const work = tempDir('refresh')
  try {
    for (const patch of patches()) {
      const name = path.basename(patch)
      const text = fs.readFileSync(patch, 'utf8')
      const start = text.search(DIFF_HEADER)
      const files = [...text.matchAll(DIFF_HEADER)].map((match) => match[1])
      if (start === -1)
        throw new Error(`${name} names no files (add a "diff --git a/<file> b/<file>" line)`)
      let diff = ''
      for (const file of files) {
        if (owner.has(file)) throw new Error(`${file} is in both ${owner.get(file)} and ${name}`)
        owner.set(file, name)
        if (!upstream.has(file) || !vendored.has(file)) {
          throw new Error(
            `${file} must exist both upstream and in ${rel(VENDOR_DIR)}; edit ${name} by hand`
          )
        }
        writeTree(
          new Map([
            [`a/${file}`, upstream.get(file)],
            [`b/${file}`, vendored.get(file)]
          ]),
          work
        )
        const result = git(['diff', '--no-index', '--no-prefix', `a/${file}`, `b/${file}`], work)
        if (result.error || result.status > 1) throw result.error ?? new Error(result.stderr)
        diff += result.stdout.replace(/^index [0-9a-f]+\.\.[0-9a-f]+.*\n/m, '')
      }
      if (!diff)
        console.warn(`warning: ${name} has no changes left; delete it if upstream adopted it`)
      fs.writeFileSync(patch, text.slice(0, start).replace(/\r\n/g, '\n') + diff)
      console.log(`✓ refreshed ${name}`)
    }
    const uncovered = changed.filter((file) => !owner.has(file))
    if (uncovered.length) {
      throw new Error(
        `These files differ from upstream but no patch covers them:\n  ${uncovered.join('\n  ')}\n` +
          'Add each to a patch (a "diff --git a/<file> b/<file>" line), then run refresh-patches again.'
      )
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

const [command, ...args] = process.argv.slice(2)
const commands = {
  update: () =>
    update(
      args.find((arg) => !arg.startsWith('--')),
      { allowRejects: args.includes('--allow-rejects') }
    ),
  verify,
  'refresh-patches': refreshPatches
}

try {
  if (!Object.hasOwn(commands, command ?? ''))
    throw new UsageError(`Unknown command: ${command ?? '(none)'}`)
  await commands[command]()
} catch (error) {
  console.error(`\n${error.message}`)
  if (error instanceof UsageError) {
    console.error(
      'Usage: node scripts/wry/vendor-wry.mjs update <version> [--allow-rejects] | verify | refresh-patches'
    )
  }
  process.exit(1)
}
