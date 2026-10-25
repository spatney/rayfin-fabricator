// Type-checks the code a lesson shows against the real Rayfin packages, at the lesson's
// Rayfin version (script.ts's rayfinVersion).
//
//   npm run lesson:snippets -- 1
//   npm run lesson:snippets -- 1 --refresh    scaffold the scratch app again
//
// The first run scaffolds a scratch Universal App for that version in
// .cache/rayfin-check/<version>/app with create-rayfin (a minute or two, with an npm install);
// later runs reuse it. Its .agents/skills/rayfin/SKILL.md and its packages' own docs
// (node_modules/@microsoft/rayfin-*/assets/docs) are the version-locked reference for writing
// the lesson, too.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { lessonArg, loadLesson } from './lesson.mjs';
import { ROOT } from './paths.mjs';

/** A check-only tsconfig on top of the app's own: no emit, no project references. */
const TSCONFIG = {
  extends: './tsconfig.base.json',
  compilerOptions: {
    composite: false,
    incremental: false,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
    noEmit: true,
    noUnusedLocals: false,
    noUnusedParameters: false,
    allowImportingTsExtensions: true,
    lib: ['ES2022', 'DOM', 'DOM.Iterable', 'ESNext.Decorators'],
    types: [],
    skipLibCheck: true,
  },
  include: ['lesson-check/**/*.ts'],
};

function run(command, args, cwd, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    // npx is a .cmd on Windows, which needs a shell; node itself doesn't (and its path has spaces).
    const shell = process.platform === 'win32' && command === 'npx';
    const child = spawn(command, args, { cwd, shell, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', windowsHide: true });
    let out = '';
    if (capture) {
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
    }
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));
  });
}

async function scaffold(base, version) {
  await mkdir(base, { recursive: true });
  console.log(`Scaffolding a scratch Universal App with Rayfin ${version} in ${path.relative(ROOT, base)}…`);
  let { code } = await run('npx', ['-y', `@microsoft/create-rayfin@${version}`, '--project-name', 'app', '--template', 'blankapp'], base);
  if (code !== 0) {
    console.warn(`! create-rayfin@${version} failed; trying the latest. The installed version is checked below.`);
    await rm(path.join(base, 'app'), { recursive: true, force: true });
    ({ code } = await run('npx', ['-y', '@microsoft/create-rayfin@latest', '--project-name', 'app', '--template', 'blankapp'], base));
  }
  if (code !== 0) throw new Error('create-rayfin failed; see its output above.');
}

async function main() {
  const n = lessonArg();
  const lesson = await loadLesson(n);
  const entries = Object.entries(lesson.snippets);
  if (!entries.length) {
    console.log(`Lesson ${n} shows no code (lessons/${lesson.slug}/snippets.ts has none).`);
    return;
  }
  const version = lesson.script.rayfinVersion;
  const base = path.join(ROOT, '.cache', 'rayfin-check', version);
  const app = path.join(base, 'app');
  if (process.argv.includes('--refresh')) await rm(app, { recursive: true, force: true });
  if (!existsSync(path.join(app, 'package.json'))) await scaffold(base, version);

  const installed = JSON.parse(readFileSync(path.join(app, 'node_modules', '@microsoft', 'rayfin-core', 'package.json'), 'utf8')).version;
  if (installed !== version) console.warn(`! The scratch app has @microsoft/rayfin-core ${installed}, but lesson ${n} is checked against ${version}.`);

  await writeFile(path.join(app, 'tsconfig.lesson.json'), `${JSON.stringify(TSCONFIG, null, 2)}\n`);
  const dir = path.join(app, 'lesson-check', lesson.slug);
  await rm(path.join(app, 'lesson-check'), { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const byFile = new Map();
  for (const [key, snippet] of entries) {
    const name = snippet.checkAs ?? path.basename(snippet.file);
    if (byFile.has(name)) throw new Error(`Snippets "${byFile.get(name)}" and "${key}" are both ${name}; snippets are checked side by side, so give one a checkAs name.`);
    byFile.set(name, key);
    await writeFile(path.join(dir, name), `${snippet.code}\n`);
  }

  const tsc = path.join(app, 'node_modules', 'typescript', 'bin', 'tsc');
  const { code, out } = await run(process.execPath, [tsc, '-p', 'tsconfig.lesson.json', '--pretty', 'false'], app, { capture: true });
  if (code !== 0) {
    const pattern = new RegExp(`lesson-check[\\\\/]${lesson.slug}[\\\\/]([^(]+)\\(`, 'g');
    console.error(out.replace(pattern, (_, file) => `snippets.${byFile.get(file) ?? file} (${file}, line `).trim());
    throw new Error(`Lesson ${n}'s code doesn't compile against Rayfin ${installed}. Fix it in lessons/${lesson.slug}/snippets.ts.`);
  }
  for (const [key, snippet] of entries) console.log(`✓ ${key.padEnd(14)} ${snippet.file}${snippet.hidden ? '  (hidden check)' : ''}`);
  console.log(`\nLesson ${n}'s ${entries.length} snippets compile against @microsoft/rayfin-core ${installed}.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
