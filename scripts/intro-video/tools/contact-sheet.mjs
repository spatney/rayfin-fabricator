// Contact sheet: renders stills of a composition and tiles them into one image, for reviewing
// framing, legibility and timing without watching the whole cut.
//
//   node tools/contact-sheet.mjs                       24 evenly spaced frames of the dark cut
//   node tools/contact-sheet.mjs --theme light         the same of the light cut
//   node tools/contact-sheet.mjs --count 40
//   node tools/contact-sheet.mjs --frames 30,95,400    exact frames
//   node tools/contact-sheet.mjs --scenes              the middle of every scene, plus its first word
//   node tools/contact-sheet.mjs --composition RayCheck --frames 10,30,60
//
// Writes out/contact-sheet.jpg (out/contact-sheet.light.jpg for the light cut, and
// out/contact-sheet-<id>.jpg for any other composition) and keeps the full-size stills in
// out/stills/.
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { ensureBrowser, renderStill, selectComposition } from '@remotion/renderer';
import { webpackOverride } from '../webpack-override.mjs';
import { CUTS, OUT, REPO, ROOT, TIMELINE } from './paths.mjs';
import { layout } from '../src/timing.ts';

const sharp = createRequire(path.join(REPO, 'website', 'package.json'))('sharp');

function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = process.argv[i + 1];
  return value === undefined || value.startsWith('--') ? true : value;
}

async function framesToShow(composition) {
  const explicit = option('frames');
  if (typeof explicit === 'string') return explicit.split(',').map((f) => Number(f.trim()));
  if (option('scenes') === true) {
    const timeline = JSON.parse(await readFile(TIMELINE, 'utf8'));
    const l = layout(timeline);
    return Object.values(l.scenes).flatMap((s) => [s.from + 8, s.from + Math.floor(s.duration / 2)]);
  }
  const count = Number(option('count', 24));
  const last = composition.durationInFrames - 1;
  return Array.from({ length: count }, (_, i) => Math.round((i * last) / Math.max(1, count - 1)));
}

async function main() {
  const theme = option('theme', 'dark');
  const cut = CUTS[theme];
  if (!cut) throw new Error(`--theme must be one of ${Object.keys(CUTS).join(', ')}.`);
  const id = option('composition', cut.composition);
  await ensureBrowser();
  const serveUrl = await bundle({ entryPoint: path.join(ROOT, 'src', 'index.ts'), webpackOverride: webpackOverride(ROOT) });
  const composition = await selectComposition({ serveUrl, id });
  const frames = await framesToShow(composition);
  const dir = path.join(OUT, 'stills');
  await mkdir(dir, { recursive: true });

  const tiles = [];
  for (const frame of frames) {
    const output = path.join(dir, `${id}-${String(frame).padStart(5, '0')}.png`);
    await renderStill({ serveUrl, composition, frame, output, imageFormat: 'png' });
    tiles.push({ frame, output });
    process.stdout.write(`${frame} `);
  }
  process.stdout.write('\n');

  const tileW = Number(option('tile', 480));
  const tileH = Math.round((tileW * composition.height) / composition.width);
  const cols = Math.min(Number(option('cols', 4)), tiles.length);
  const rows = Math.ceil(tiles.length / cols);
  const label = 26;
  const composites = [];
  for (const [i, tile] of tiles.entries()) {
    const left = (i % cols) * tileW;
    const top = Math.floor(i / cols) * (tileH + label);
    composites.push({ input: await sharp(tile.output).resize(tileW, tileH).toBuffer(), left, top: top + label });
    const secs = (tile.frame / composition.fps).toFixed(2);
    const svg = `<svg width="${tileW}" height="${label}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#111"/><text x="8" y="18" font-family="Segoe UI, sans-serif" font-size="15" fill="#ddd">frame ${tile.frame} · ${secs}s</text></svg>`;
    composites.push({ input: Buffer.from(svg), left, top });
  }
  const named = { [CUTS.dark.composition]: 'contact-sheet', [CUTS.light.composition]: 'contact-sheet.light' };
  const sheet = path.join(OUT, `${named[id] ?? `contact-sheet-${id}`}.jpg`);
  await sharp({ create: { width: cols * tileW, height: rows * (tileH + label), channels: 3, background: '#000' } })
    .composite(composites)
    .jpeg({ quality: 82 })
    .toFile(sheet);
  console.log(path.relative(ROOT, sheet));
}

main().catch((err) => {
  console.error(err.stack ?? err.message);
  process.exit(1);
});
