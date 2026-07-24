#!/usr/bin/env node
/**
 * Build the Universal template's install-acceleration artifacts:
 *
 *   resources/fabricator-universal-deps/node_modules.tgz  — prebuilt deps for the
 *     lean base (+ package-lock.json), extracted on create after a
 *     `rayfin init --skip-install` scaffold.
 *   resources/fabricator-universal-deps/npm-cache.tgz     — a warm npm cache
 *     covering the base AND every capability pack's modules, so the capability
 *     router's on-demand `npm install`s resolve offline.
 *
 * Run per-platform in CI (the tarballs are platform-specific because they include
 * native binaries). Best-effort: if the base install can't run (e.g. no registry
 * access in this environment), it emits a warning and exits 0 without artifacts —
 * Fabricator then falls back to a normal network install at runtime.
 *
 * Usage: node scripts/build-universal-deps.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, cpSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const templateDir = join(repoRoot, 'resources', 'fabricator-templates', 'fabricator-universal');
const skillsDir = join(templateDir, '.agents', 'skills');
const outDir = join(repoRoot, 'resources', 'fabricator-universal-deps');

/** Extra runtime modules a capability pack installs on demand that aren't in the base. */
const EXTRA_APP_MODULES = ['@microsoft/rayfin-data'];

const warn = (msg) => console.log(`::warning::[build-universal-deps] ${msg}`);
const log = (msg) => console.log(`[build-universal-deps] ${msg}`);

function npm(args, cwd, cacheDir) {
  execFileSync('npm', [...args, '--no-audit', '--no-fund', '--loglevel=warn', '--cache', cacheDir], {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32', // resolve npm.cmd on Windows
  });
}

function tarCzf(outFile, cwd, entries) {
  // On Windows the release step runs under Git Bash, whose GNU tar reads the
  // drive-letter colon in an absolute archive path (e.g. `D:\…\node_modules.tgz`)
  // as a remote `host:path` spec and aborts with "Cannot connect to D: resolve
  // failed". --force-local tells tar to treat the path as a local file.
  const forceLocal = process.platform === 'win32' ? ['--force-local'] : [];
  execFileSync('tar', [...forceLocal, '-czf', outFile, '-C', cwd, ...entries], { stdio: 'inherit' });
}

/** Parse a capability pack's MODULES.md into a flat list of `name@range` specs. */
function parseModulesMd(file) {
  if (!existsSync(file)) return [];
  const specs = [];
  const re = /^\s*-\s*`([^`]+)`\s*:\s*`([^`]+)`/;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(re);
    if (m) specs.push(`${m[1]}@${m[2]}`);
  }
  return specs;
}

/** Every module the capability packs may install on demand (for cache warming). */
function supersetModules() {
  const specs = new Set(EXTRA_APP_MODULES);
  // Analytics pack (and any future pack) ships a MODULES.md listing its deps.
  for (const packModules of ['analytics']) {
    for (const s of parseModulesMd(join(skillsDir, packModules, 'MODULES.md'))) specs.add(s);
  }
  return [...specs];
}

function main() {
  if (!existsSync(templateDir)) {
    warn(`template not found at ${templateDir}; skipping`);
    return;
  }
  mkdirSync(outDir, { recursive: true });

  const cacheDir = mkdtempSync(join(tmpdir(), 'univ-npm-cache-'));
  const workDir = mkdtempSync(join(tmpdir(), 'univ-base-'));
  const superDir = mkdtempSync(join(tmpdir(), 'univ-super-'));

  try {
    // 1) Prebuilt node_modules for the lean base (also warms the cache with base deps).
    log('installing base dependencies…');
    cpSync(templateDir, workDir, {
      recursive: true,
      filter: (src) => !src.includes(`${join('', 'node_modules')}`),
    });
    rmSync(join(workDir, 'node_modules'), { recursive: true, force: true });
    try {
      npm(['install'], workDir, cacheDir);
    } catch (err) {
      warn(`base npm install failed (${err.message}); skipping artifact generation`);
      return; // graceful: no artifacts → runtime falls back to a normal install
    }

    // 2) Warm the cache with the superset of on-demand capability-pack modules.
    const extras = supersetModules();
    if (extras.length) {
      log(`warming cache with ${extras.length} capability-pack modules…`);
      execFileSync('npm', ['init', '-y'], { cwd: superDir, stdio: 'ignore', shell: process.platform === 'win32' });
      try {
        // Populate the cache tarballs; the resolved tree itself is discarded.
        // --legacy-peer-deps: the superset unions every pack's modules, whose peer
        // ranges can conflict (e.g. eslint@10 vs typescript-eslint's eslint 8||9
        // peer). We only need the downloaded tarballs in the cache, not a valid
        // tree, so skip strict peer resolution to keep the warm cache complete.
        npm(['install', '--legacy-peer-deps', ...extras], superDir, cacheDir);
      } catch (err) {
        warn(`cache warm for capability modules was partial (${err.message}); continuing`);
      }
    }

    // 3) Tar the base node_modules (+ lockfile) and the warm cache into the deps dir.
    log('packing node_modules.tgz…');
    const baseEntries = ['node_modules'];
    if (existsSync(join(workDir, 'package-lock.json'))) baseEntries.push('package-lock.json');
    tarCzf(join(outDir, 'node_modules.tgz'), workDir, baseEntries);

    log('packing npm-cache.tgz…');
    tarCzf(join(outDir, 'npm-cache.tgz'), cacheDir, ['.']);

    log('done: node_modules.tgz + npm-cache.tgz');
  } finally {
    for (const d of [cacheDir, workDir, superDir]) rmSync(d, { recursive: true, force: true });
  }
}

main();
