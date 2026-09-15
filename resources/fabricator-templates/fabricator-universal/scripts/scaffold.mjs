#!/usr/bin/env node
// scripts/scaffold.mjs — general capability-pack scaffolder for the universal app.
//
// One command turns a capability pack ON: it reads the pack's declarative
// manifest (`.agents/skills/<pack>/pack.json`) and, in one idempotent pass:
//   1. patches Fabric service flags in `rayfin/rayfin.yml`,
//   2. merges the pack's pinned dependencies + scripts into `package.json`,
//   3. copies the pack's kit files into the project,
//   4. runs a single batched `npm install`.
//
// This replaces the slow, error-prone "copy ~60 files by hand + install ~40
// packages + rewire scripts" flow with `npm run pack:add <pack>`. It is
// pack-agnostic: future connectors/capabilities just ship their own `pack.json`.
//
// Usage:
//   node scripts/scaffold.mjs <pack> [--no-install] [--dry-run]
//   npm run pack:add -- <pack> [--no-install] [--dry-run]
//
// Flags:
//   --no-install   Do everything except `npm install` (fast; install yourself).
//   --dry-run      Print the planned actions without writing anything.

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = join(ROOT, '.agents', 'skills');

function parseArgs(argv) {
  const out = { pack: undefined, flags: {} };
  for (const a of argv) {
    if (a.startsWith('--')) out.flags[a.slice(2)] = true;
    else if (!out.pack) out.pack = a;
  }
  return out;
}

const log = (...m) => console.log(...m);
const warn = (...m) => console.warn(...m);

/** Set `services.<service>.enabled` in a rayfin.yml string, adding the block if absent. */
function setServiceEnabled(text, service, enabled) {
  const lines = text.split(/\r?\n/);
  const svcRe = new RegExp(`^  ${service}:\\s*$`);
  const enabledRe = /^ {4}enabled:\s*(true|false)\s*$/;
  const svcIdx = lines.findIndex((l) => svcRe.test(l));

  if (svcIdx === -1) {
    const servicesIdx = lines.findIndex((l) => /^services:\s*$/.test(l));
    const block = [`  ${service}:`, `    enabled: ${enabled}`];
    if (servicesIdx === -1) return [...lines, 'services:', ...block].join('\n');
    lines.splice(servicesIdx + 1, 0, ...block);
    return lines.join('\n');
  }

  for (let j = svcIdx + 1; j < lines.length; j++) {
    const line = lines[j];
    if (line.trim() === '') continue;
    // Dedent to another top-level service (<=2-space indent) ends this block.
    if (/^ {0,2}\S/.test(line)) break;
    if (enabledRe.test(line)) {
      lines[j] = `    enabled: ${enabled}`;
      return lines.join('\n');
    }
  }
  lines.splice(svcIdx + 1, 0, `    enabled: ${enabled}`);
  return lines.join('\n');
}

/** Alpha-sort a dependency map for deterministic diffs. */
function sortDeps(map) {
  if (!map) return map;
  return Object.fromEntries(Object.keys(map).sort().map((k) => [k, map[k]]));
}

function copyDir(fromDir, toDir, onFile, dryRun) {
  for (const name of readdirSync(fromDir)) {
    const from = join(fromDir, name);
    const to = join(toDir, name);
    if (statSync(from).isDirectory()) copyDir(from, to, onFile, dryRun);
    else {
      if (!dryRun) {
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
      }
      onFile(to);
    }
  }
}

function main() {
  const { pack, flags } = parseArgs(process.argv.slice(2));
  if (!pack) {
    warn('Usage: node scripts/scaffold.mjs <pack> [--no-install] [--dry-run]');
    process.exit(1);
  }

  const packDir = join(SKILLS, pack);
  const manifestPath = join(packDir, 'pack.json');
  if (!existsSync(manifestPath)) {
    warn(`No manifest for pack "${pack}" at ${manifestPath}`);
    warn('Available packs:', readdirSync(SKILLS)
      .filter((d) => existsSync(join(SKILLS, d, 'pack.json')))
      .join(', ') || '(none)');
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const dryRun = !!flags['dry-run'];
  log(`\n> Scaffolding pack: ${pack}${dryRun ? ' (dry run)' : ''}`);
  if (manifest.description) log(`  ${manifest.description}`);

  // 1) rayfin.yml service flags
  const svcEdits = manifest.rayfin?.services ?? {};
  const svcNames = Object.keys(svcEdits);
  if (svcNames.length) {
    const ymlPath = join(ROOT, 'rayfin', 'rayfin.yml');
    let yml = readFileSync(ymlPath, 'utf8');
    for (const name of svcNames) {
      yml = setServiceEnabled(yml, name, !!svcEdits[name].enabled);
      log(`  - rayfin.yml: ${name}.enabled = ${!!svcEdits[name].enabled}`);
    }
    if (!dryRun) writeFileSync(ymlPath, yml);
  }

  // 2) package.json deps + scripts
  const pkgPath = join(ROOT, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  let depCount = 0;
  for (const kind of ['dependencies', 'devDependencies']) {
    const add = manifest[kind];
    if (!add) continue;
    pkg[kind] = pkg[kind] ?? {};
    for (const [name, version] of Object.entries(add)) {
      if (pkg[kind][name] !== version) depCount++;
      pkg[kind][name] = version;
    }
    pkg[kind] = sortDeps(pkg[kind]);
  }
  if (manifest.scripts) {
    pkg.scripts = pkg.scripts ?? {};
    for (const [name, cmd] of Object.entries(manifest.scripts)) {
      pkg.scripts[name] = cmd;
      log(`  - package.json script: ${name}`);
    }
  }
  if (!dryRun) writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  log(`  - package.json: ${depCount} dependency change(s)`);

  // 3) copy kit files
  let copied = 0;
  const skipped = [];
  for (const entry of manifest.copy ?? []) {
    const from = join(packDir, entry.from);
    const to = join(ROOT, entry.to);
    if (!existsSync(from)) {
      warn(`  ! missing source: ${entry.from}`);
      continue;
    }
    // Seed files replace the base starter once, then never clobber user edits.
    if (entry.seedReplaceIfContains) {
      const present = existsSync(to);
      const isBaseSeed = present && readFileSync(to, 'utf8').includes(entry.seedReplaceIfContains);
      if (present && !isBaseSeed) {
        skipped.push(entry.to);
        continue;
      }
      if (!dryRun) {
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
      }
      copied++;
      continue;
    }
    if (statSync(from).isDirectory()) copyDir(from, to, () => copied++, dryRun);
    else {
      if (!dryRun) {
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
      }
      copied++;
    }
  }
  log(`  - copied ${copied} file(s)` + (skipped.length ? `; kept your ${skipped.join(', ')}` : ''));

  // 4) install
  if (dryRun) {
    log('\n(dry run - nothing written, nothing installed)');
  } else if (flags['no-install']) {
    log('\n(--no-install - run `npm install` to fetch the new dependencies)');
  } else {
    log('\n> Installing dependencies (npm install)...');
    // Single-string command with shell:true keeps this cross-platform (cmd.exe on
    // Windows, /bin/sh elsewhere) and avoids Node's DEP0190 args+shell warning.
    const res = spawnSync('npm install --no-audit --no-fund', {
      cwd: ROOT,
      stdio: 'inherit',
      shell: true,
    });
    if (res.status !== 0) {
      warn('\n! npm install failed - resolve the error above, then re-run.');
      process.exit(res.status ?? 1);
    }
  }

  if (Array.isArray(manifest.next) && manifest.next.length) {
    log('\n[done] Pack ready. Next, read these skills as you build:');
    for (const s of manifest.next) log(`  -> .agents/skills/${s}/SKILL.md`);
  } else {
    log('\n[done] Pack ready.');
  }
}

main();
