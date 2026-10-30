#!/usr/bin/env node
// Installs rayfin-local, the local Rayfin backend Fabricator runs for each project, as the
// app's Tauri sidecar: src-tauri/binaries/rayfin-local-<target triple>[.exe]. tauri.conf.json
// lists it in bundle.externalBin, so every Cargo build of src-tauri needs it, and Tauri copies
// it next to the app's executable.
//
//   node scripts/rayfin-local/fetch.mjs [--target <triple>] [--optional] [--force]
//
// Downloads the release that rayfin-local.json pins, checks the archive against the pinned
// SHA-256 and unpacks it with the system tar. A stamp file next to the binary skips the
// download while the binary matches the pin, so a binary signed after the fetch stays signed.
//   --target <triple>  Rust target triple. Defaults to TAURI_ENV_TARGET_TRIPLE, else rustc's host.
//   --optional         Warn instead of failing, and skip targets rayfin-local.json doesn't pin
//                      (such as Linux). npm's postinstall runs it this way.
//   --force            Download again even when the binary matches the pin.
// FABRICATOR_RAYFIN_LOCAL_BIN=<path> copies that binary instead, unverified, to bundle a
// rayfin-local you built yourself. A .js or .mjs script there is for the app to run with node,
// so the bundle gets the pinned release.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PIN_FILE = path.join(ROOT, 'rayfin-local.json')
const BIN_DIR = path.join(ROOT, 'src-tauri', 'binaries')
const OVERRIDE_VAR = 'FABRICATOR_RAYFIN_LOCAL_BIN'
const USER_AGENT =
  'rayfin-fabricator rayfin-local fetch (https://github.com/spatney/rayfin-fabricator)'
const USAGE =
  'Usage: node scripts/rayfin-local/fetch.mjs [--target <triple>] [--optional] [--force]'
const SAFE_NAME = /^[\w.+-]+$/

class UsageError extends Error {}

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/')
}

function log(message) {
  console.log(`rayfin-local: ${message}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sha256 = (data) => createHash('sha256').update(data).digest('hex')

function parseArgs(args) {
  const options = { target: undefined, optional: false, force: false, help: false }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--optional') options.optional = true
    else if (arg === '--force') options.force = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--target' || arg.startsWith('--target=')) {
      const value = arg === '--target' ? args[++i] : arg.slice('--target='.length)
      if (!value || value.startsWith('-')) {
        throw new UsageError('--target needs a target triple, such as x86_64-pc-windows-msvc')
      }
      options.target = value
    } else throw new UsageError(`Unknown option: ${arg}`)
  }
  return options
}

// rustup's default host triple for the platform and CPU Node runs on.
function nodeTriple() {
  const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch]
  const os = { win32: 'pc-windows-msvc', darwin: 'apple-darwin', linux: 'unknown-linux-gnu' }[
    process.platform
  ]
  return arch && os ? `${arch}-${os}` : undefined
}

function resolveTarget(cliTarget) {
  let triple = cliTarget ?? process.env.TAURI_ENV_TARGET_TRIPLE?.trim()
  if (!triple) {
    const rustc = spawnSync('rustc', ['-vV'], {
      cwd: path.join(ROOT, 'src-tauri'),
      encoding: 'utf8'
    })
    triple = /^host:\s*(\S+)/m.exec(rustc.stdout ?? '')?.[1]
    if (!triple) {
      const why = rustc.error ? "rustc isn't on PATH" : '`rustc -vV` failed'
      triple = nodeTriple()
      if (!triple) {
        throw new Error(
          `Couldn't tell which Rust target to fetch rayfin-local for: ${why}. Pass --target <triple>.`
        )
      }
      log(`${why}, so this assumes ${triple}. Pass --target <triple> to choose another.`)
    }
  }
  if (!SAFE_NAME.test(triple)) throw new Error(`"${triple}" isn't a Rust target triple.`)
  return triple
}

function readPin() {
  let pin
  try {
    pin = JSON.parse(fs.readFileSync(PIN_FILE, 'utf8'))
  } catch (error) {
    throw new Error(`Couldn't read ${rel(PIN_FILE)}: ${error.message}`, { cause: error })
  }
  const valid =
    SAFE_NAME.test(pin?.version ?? '') &&
    /^[\w.-]+\/[\w.-]+$/.test(pin.repository ?? '') &&
    typeof pin.targets === 'object' &&
    pin.targets !== null
  if (!valid) {
    throw new Error(`${rel(PIN_FILE)} needs "version", "repository" (owner/name) and "targets".`)
  }
  return pin
}

function readStamp(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function stampMatches(stamp, expected) {
  return !!stamp && Object.entries(expected).every(([key, value]) => stamp[key] === value)
}

function writeStamp(file, stamp) {
  fs.writeFileSync(file, `${JSON.stringify(stamp, null, 2)}\n`)
}

async function download(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(300_000)
      })
      if (!res.ok) {
        await res.body?.cancel()
        throw Object.assign(new Error(`HTTP ${res.status} ${res.statusText}`.trim()), {
          status: res.status
        })
      }
      return Buffer.from(await res.arrayBuffer())
    } catch (error) {
      const reason = error.cause?.message ?? error.message
      const retry = !error.status || error.status >= 500 || [408, 429].includes(error.status)
      if (attempt < 2 && retry) {
        log(`Downloading ${url} failed (${reason}), retrying...`)
        await sleep(2000)
        continue
      }
      throw Object.assign(new Error(`Couldn't download ${url}: ${reason}`, { cause: error }), {
        status: error.status
      })
    }
  }
}

// The hash the release's SHA256SUMS.txt lists for an asset, to explain a mismatch with the pin.
async function listedHash(releaseUrl, archive) {
  try {
    const sums = (await download(`${releaseUrl}/SHA256SUMS.txt`)).toString('utf8')
    for (const line of sums.split(/\r?\n/)) {
      const [, hash, name] = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim()) ?? []
      if (name === archive) return hash.toLowerCase()
    }
  } catch {
    // Only the pin decides. Without SHA256SUMS.txt the message is less specific.
  }
  return undefined
}

async function checksumError({ releaseUrl, triple, archive, expected, actual }) {
  const listed = await listedHash(releaseUrl, archive)
  const lines = [
    `The SHA-256 of ${archive} doesn't match ${rel(PIN_FILE)}.`,
    `  pinned (targets.${triple}.sha256): ${expected}`,
    `  downloaded: ${actual}`
  ]
  if (listed === actual) {
    lines.push(
      "The release's SHA256SUMS.txt lists the downloaded hash, so the pin and the release disagree.",
      `If you're updating the pin, set targets.${triple}.sha256 to ${actual}.`,
      'Otherwise the release asset changed after it was pinned: find out why before you change the pin.'
    )
  } else if (listed === expected) {
    lines.push(
      "The release's SHA256SUMS.txt agrees with the pin, so the download was corrupted or altered on the way.",
      'Try again, and check your network or proxy if it keeps failing.'
    )
  } else {
    lines.push(
      listed
        ? `The release's SHA256SUMS.txt lists ${listed}, which matches neither.`
        : "Couldn't read the release's SHA256SUMS.txt to tell why.",
      `Try again. If you changed ${rel(PIN_FILE)}, compare it with ${releaseUrl}/SHA256SUMS.txt.`
    )
  }
  return new Error(lines.join('\n'))
}

function tarCommand() {
  if (process.platform !== 'win32') return 'tar'
  // Windows 10 and later ship bsdtar, which also reads zip archives. The GNU tar that Git for
  // Windows puts first on PATH in Git Bash can't, so don't look tar up on PATH.
  const systemTar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  if (!fs.existsSync(systemTar)) {
    throw new Error(
      `${systemTar} is missing (Windows 10 version 1803 and later include it), so the archive can't be unpacked.`
    )
  }
  return systemTar
}

function unpack(archive, dir) {
  const result = spawnSync(tarCommand(), ['-xf', archive, '-C', dir], { encoding: 'utf8' })
  if (result.error) {
    throw new Error(`Couldn't run tar to unpack ${path.basename(archive)}: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.status}`
    throw new Error(`tar couldn't unpack ${path.basename(archive)}: ${detail}`)
  }
}

function findFiles(dir, name) {
  const found = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...findFiles(entryPath, name))
    else if (entry.isFile() && entry.name === name) found.push(entryPath)
  }
  return found
}

async function moveIntoPlace(from, to) {
  if (process.platform !== 'win32') fs.chmodSync(from, 0o755)
  // tar and copyFile keep the source's modification time, which can be older than tauri-build's
  // last run, so Cargo wouldn't copy the new binary next to the app's executable.
  const now = new Date()
  fs.utimesSync(from, now, now)
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to)
      return
    } catch (error) {
      // Windows can't replace a file that's open, and antivirus scans hold new binaries briefly.
      if (attempt < 20 && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) {
        await sleep(250)
        continue
      }
      throw new Error(
        `Couldn't write ${rel(to)}: ${error.message}\nIf a rayfin-local started from there is running, stop it and try again.`,
        { cause: error }
      )
    }
  }
}

async function installOverride(source, { triple, binary, stampFile, force }) {
  const from = path.resolve(process.env.INIT_CWD ?? process.cwd(), source)
  if (!fs.statSync(from, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(
      `${OVERRIDE_VAR} is ${from}, which isn't a file. Point it at a rayfin-local binary you built, or unset it to use the release ${rel(PIN_FILE)} pins.`
    )
  }
  const expected = {
    source: OVERRIDE_VAR,
    path: from,
    sha256: sha256(fs.readFileSync(from)),
    target: triple
  }
  if (!force && fs.existsSync(binary) && stampMatches(readStamp(stampFile), expected)) {
    log(`${rel(binary)} is up to date with ${OVERRIDE_VAR} (${from}).`)
    return
  }
  fs.mkdirSync(BIN_DIR, { recursive: true })
  const partial = `${binary}.${process.pid}.partial`
  try {
    fs.copyFileSync(from, partial)
    await moveIntoPlace(partial, binary)
  } finally {
    fs.rmSync(partial, { force: true })
  }
  writeStamp(stampFile, expected)
  log(`Copied ${from} to ${rel(binary)} (${OVERRIDE_VAR}), unverified.`)
}

async function installRelease(pin, entry, { triple, binary, stampFile, force }) {
  if (!SAFE_NAME.test(entry?.archive ?? '') || !/^[0-9a-fA-F]{64}$/.test(entry.sha256 ?? '')) {
    throw new Error(
      `targets.${triple} in ${rel(PIN_FILE)} needs an "archive" file name and its 64-character hex "sha256".`
    )
  }
  const expected = {
    source: 'release',
    repository: pin.repository,
    version: pin.version,
    target: triple,
    archive: entry.archive,
    sha256: entry.sha256.toLowerCase()
  }
  if (!force && fs.existsSync(binary) && stampMatches(readStamp(stampFile), expected)) {
    log(`rayfin-local ${pin.version} for ${triple} is up to date (${rel(binary)}).`)
    return
  }

  const releaseUrl = `https://github.com/${pin.repository}/releases/download/v${pin.version}`
  const url = `${releaseUrl}/${entry.archive}`
  log(`Downloading rayfin-local ${pin.version} for ${triple}...`)
  let archive
  try {
    archive = await download(url)
  } catch (error) {
    const hint =
      error.status === 404
        ? `Check "version" and targets.${triple}.archive in ${rel(PIN_FILE)} against the release: https://github.com/${pin.repository}/releases/tag/v${pin.version}`
        : `Check your internet connection. Behind a proxy, set HTTPS_PROXY and NODE_USE_ENV_PROXY=1 (Node 24 and later). To build without downloading, set ${OVERRIDE_VAR} to a rayfin-local binary.`
    throw new Error(`${error.message}\n${hint}`, { cause: error })
  }
  const actual = sha256(archive)
  if (actual !== expected.sha256) {
    throw await checksumError({
      releaseUrl,
      triple,
      archive: entry.archive,
      expected: expected.sha256,
      actual
    })
  }

  fs.mkdirSync(BIN_DIR, { recursive: true })
  const staging = fs.mkdtempSync(path.join(BIN_DIR, `.staging-${triple}-`))
  try {
    const archivePath = path.join(staging, entry.archive)
    const unpacked = path.join(staging, 'unpacked')
    fs.writeFileSync(archivePath, archive)
    fs.mkdirSync(unpacked)
    unpack(archivePath, unpacked)
    const name = path.basename(binary).replace(`-${triple}`, '')
    const found = findFiles(unpacked, name)
    if (found.length !== 1) {
      throw new Error(`${entry.archive} should hold one ${name}, but it holds ${found.length}.`)
    }
    await moveIntoPlace(found[0], binary)
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
  writeStamp(stampFile, expected)
  log(`Installed rayfin-local ${pin.version} for ${triple} at ${rel(binary)}.`)
}

async function main({ target, optional, force }) {
  const pin = readPin()
  const triple = resolveTarget(target)
  const exe = triple.includes('windows') ? '.exe' : ''
  const binary = path.join(BIN_DIR, `rayfin-local-${triple}${exe}`)
  const stampFile = path.join(BIN_DIR, `.rayfin-local-${triple}.stamp`)
  const install = { triple, binary, stampFile, force }

  const override = process.env[OVERRIDE_VAR]?.trim()
  if (override && !/\.[cm]?js$/i.test(override)) return installOverride(override, install)
  // The app runs a script override with node, but the bundle needs an executable.
  if (override) log(`${OVERRIDE_VAR} is a script, so this bundles the pinned release instead.`)
  if (Object.hasOwn(pin.targets, triple)) return installRelease(pin, pin.targets[triple], install)

  const stamp = readStamp(stampFile)
  if (stamp?.source === OVERRIDE_VAR && fs.existsSync(binary)) {
    log(`Keeping ${rel(binary)}, copied from ${stamp.path} (${OVERRIDE_VAR}).`)
    return
  }
  const message = `${rel(PIN_FILE)} pins no rayfin-local build for ${triple}, only for ${Object.keys(pin.targets).join(', ')}.`
  if (!optional) {
    throw new Error(
      `${message}\nTo build Fabricator for ${triple}, set ${OVERRIDE_VAR} to a rayfin-local binary built for it.`
    )
  }
  log(`${message} Skipping it: Fabricator doesn't ship for this target.`)
}

// Exit codes go through process.exitCode: process.exit() while fetch still closes a connection
// trips a libuv assertion on Windows.
let options
try {
  options = parseArgs(process.argv.slice(2))
} catch (error) {
  console.error(`${error.message}\n${USAGE}`)
  process.exitCode = 2
}

if (options?.help) console.log(USAGE)
else if (options) {
  try {
    await main(options)
  } catch (error) {
    if (options.optional) {
      console.warn(`rayfin-local: warning: ${error.message}`)
      console.warn(
        'rayfin-local: Cargo builds of src-tauri need it. Run `npm run rayfin-local:fetch` to try again (`npm run dev` and `npm run build` fetch it too).'
      )
    } else {
      console.error(`\nrayfin-local: ${error.message}`)
      process.exitCode = 1
    }
  }
}
