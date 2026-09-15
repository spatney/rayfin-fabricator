#!/usr/bin/env node
// scripts/warm-npm-cache.mjs — build the bundled "warm" npm cache.
//
// Creating a Universal App and deploying it triggers a first `npm install` that
// otherwise downloads ~30+ packages over the network (a slow first-run
// experience). This script pre-populates an npm cache (cacache) with every
// tarball that install needs — the base template plus each capability pack — so
// the shipped app can install `--prefer-offline` from a local cache instead.
//
// Output goes to `resources/npm-cache/_cacache`, which `tauri.conf.json` bundles
// as an app resource. It is warmed **per platform** (run in each OS's CI job) so
// each installer carries the right native optional deps (esbuild / SWC /
// tailwind-oxide / rollup) for its OS+arch; `--prefer-offline` covers any gaps.
//
// Usage:
//   node scripts/warm-npm-cache.mjs [--dry-run] [--out <dir>] [--keep-tmp]
//   npm run warm-cache
//
// Flags:
//   --dry-run    Print the plan (packs + dependency counts) without running npm.
//   --out <dir>  Override the cache output dir (default: resources/npm-cache).
//   --keep-tmp   Keep the throwaway install dirs (for debugging).

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_DIR = join(
  REPO_ROOT,
  'resources',
  'fabricator-templates',
  'fabricator-universal',
);
const SKILLS_DIR = join(TEMPLATE_DIR, '.agents', 'skills');

const log = (...m) => console.log(...m);
const warn = (...m) => console.warn(...m);

function parseArgs(argv) {
  const flags = { dryRun: false, keepTmp: false, out: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--keep-tmp') flags.keepTmp = true;
    else if (a === '--out') flags.out = argv[++i];
  }
  return flags;
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** Merge `{dependencies, devDependencies}` maps from `src` into `target` (in place). */
function mergeDeps(target, src) {
  for (const kind of ['dependencies', 'devDependencies']) {
    if (!src[kind]) continue;
    target[kind] = { ...(target[kind] ?? {}), ...src[kind] };
  }
  return target;
}

function countDeps(pkg) {
  return (
    Object.keys(pkg.dependencies ?? {}).length +
    Object.keys(pkg.devDependencies ?? {}).length
  );
}

/** Discover capability packs (skills that ship a `pack.json`) and their deps. */
function discoverPacks() {
  if (!existsSync(SKILLS_DIR)) return [];
  const packs = [];
  for (const name of readdirSync(SKILLS_DIR).sort()) {
    const manifest = join(SKILLS_DIR, name, 'pack.json');
    if (existsSync(manifest)) packs.push({ name, manifest: readJson(manifest) });
  }
  return packs;
}

/** Run one npm command in `cwd` with the cache pointed at `cacheDir`. */
function runNpm(args, cwd, cacheDir) {
  const res = spawnSync('npm', args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      npm_config_cache: cacheDir,
      npm_config_audit: 'false',
      npm_config_fund: 'false',
    },
  });
  if (res.status !== 0) {
    throw new Error(`npm ${args.join(' ')} failed (exit ${res.status ?? 'null'})`);
  }
}

/**
 * Warm `pkg` into `cacheDir` by installing it into a throwaway dir. Downloads
 * every tarball into the cache; node_modules is discarded. Uses `npm ci` when a
 * lockfile is supplied (deterministic, matches the runtime fast path), else
 * `npm install`.
 */
function warmInto(cacheDir, pkg, { lockfile, keepTmp }) {
  const tmp = mkdtempSync(join(tmpdir(), 'rayfin-warm-'));
  try {
    writeFileSync(join(tmp, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
    if (lockfile && existsSync(lockfile)) {
      cpSync(lockfile, join(tmp, 'package-lock.json'));
      runNpm(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], tmp, cacheDir);
    } else {
      runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund'], tmp, cacheDir);
    }
  } finally {
    if (!keepTmp) rmSync(tmp, { recursive: true, force: true });
  }
}

/** Clear a previous cache but keep the committed `.gitkeep` placeholder. */
function cleanOut(outDir) {
  mkdirSync(outDir, { recursive: true });
  for (const name of readdirSync(outDir)) {
    if (name === '.gitkeep') continue;
    rmSync(join(outDir, name), { recursive: true, force: true });
  }
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  const outDir = flags.out ? resolve(flags.out) : join(REPO_ROOT, 'resources', 'npm-cache');

  if (!existsSync(join(TEMPLATE_DIR, 'package.json'))) {
    warn(`No template package.json at ${TEMPLATE_DIR}`);
    process.exit(1);
  }

  const basePkg = readJson(join(TEMPLATE_DIR, 'package.json'));
  const baseLock = join(TEMPLATE_DIR, 'package-lock.json');
  const packs = discoverPacks();

  log(`\n> Warming npm cache for the Universal App`);
  log(`  template: ${TEMPLATE_DIR}`);
  log(`  out:      ${outDir}`);
  log(`  base:     ${countDeps(basePkg)} deps${existsSync(baseLock) ? ' (from lockfile)' : ' (no lockfile)'}`);
  for (const { name, manifest } of packs) {
    log(`  pack:     ${name} (+${countDeps(manifest)} deps)`);
  }

  if (flags.dryRun) {
    log('\n(dry run — nothing installed, no cache written)');
    return;
  }

  cleanOut(outDir);

  // Base — deterministic from the committed lockfile (matches runtime `npm ci`).
  log('\n> Warming base template…');
  const base = { name: 'rayfin-warm-base', version: '0.0.0', private: true };
  mergeDeps(base, basePkg);
  warmInto(outDir, base, { lockfile: baseLock, keepTmp: flags.keepTmp });

  // Packs — each on top of the base (mirrors `scaffold.mjs`: merge deps then
  // install), so the exact versions a pack install resolves to are cached.
  for (const { name, manifest } of packs) {
    log(`\n> Warming pack: ${name}…`);
    const merged = { name: `rayfin-warm-${name}`, version: '0.0.0', private: true };
    mergeDeps(merged, basePkg);
    mergeDeps(merged, manifest);
    warmInto(outDir, merged, { keepTmp: flags.keepTmp });
  }

  const cacache = join(outDir, '_cacache');
  if (!existsSync(cacache)) {
    warn('\n! Expected a _cacache directory but none was produced. Cache is empty.');
    process.exit(1);
  }
  log(`\n[done] Warm cache ready at ${cacache}`);
}

main();
