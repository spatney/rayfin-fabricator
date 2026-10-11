// Mirrors the docs site's screenshots and logo into public/ui/, where the scenes load them.
// <id>.webp is the dark theme and feeds the dark cut; <id>.light.webp is the light theme and
// feeds the light cut. Anything else in public/ui/ is removed, so a render never picks up a
// screenshot the site no longer has. The screenshots are scrubbed sample data (see
// scripts/docs-screenshots); refresh those first when the app's UI changes, then rerun this
// and render again.
//
// A screenshot the video uses (src/shots.ts) that has no light version on the site yet gets a
// stand-in, in public/ui/ only: its dark version with the colors inverted, so the light cut
// still renders for a look. `npm run publish` refuses to publish while any are in use.
import { createRequire } from 'node:module';
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { PUBLIC, REPO } from './paths.mjs';
import { SHOTS, shotFile } from '../src/shots.ts';

const sharp = createRequire(path.join(REPO, 'website', 'package.json'))('sharp');

const site = path.join(REPO, 'website', 'public');
const dest = path.join(PUBLIC, 'ui');
const LOGO = 'fabricator-logo.png';
await mkdir(dest, { recursive: true });

const shots = (await readdir(path.join(site, 'screenshots'))).filter((f) => f.endsWith('.webp'));
const used = Object.values(SHOTS);
const standIns = used.filter((shot) => shots.includes(shotFile(shot, 'dark')) && !shots.includes(shotFile(shot, 'light')));
const keep = new Set([...shots, ...standIns.map((shot) => shotFile(shot, 'light')), LOGO]);
const stale = (await readdir(dest)).filter((f) => !keep.has(f));
for (const file of stale) await rm(path.join(dest, file), { recursive: true, force: true });
for (const file of shots) await copyFile(path.join(site, 'screenshots', file), path.join(dest, file));
await copyFile(path.join(site, LOGO), path.join(dest, LOGO));
for (const shot of standIns) {
  await sharp(path.join(dest, shotFile(shot, 'dark')))
    .negate({ alpha: false })
    .modulate({ hue: 180 })
    .webp({ quality: 90 })
    .toFile(path.join(dest, shotFile(shot, 'light')));
}

const light = shots.filter((f) => f.endsWith('.light.webp'));
console.log(
  `${shots.length - light.length} dark and ${light.length} light screenshots, and the logo → ${path.relative(process.cwd(), dest)}` +
    `${stale.length ? ` (removed ${stale.length} stale)` : ''}`,
);

// The scenes place overlays in image pixels and use them in both cuts, so both versions of
// every screenshot the video shows must have the size src/shots.ts expects.
for (const shot of used) {
  for (const theme of ['dark', 'light']) {
    const file = shotFile(shot, theme);
    if (theme === 'dark' && !shots.includes(file)) {
      console.warn(`! ${file} is missing from website/public/screenshots; the video can't render without it.`);
      continue;
    }
    if (theme === 'light' && standIns.includes(shot)) continue;
    const { width, height } = await sharp(path.join(dest, file)).metadata();
    if (width !== shot.w || height !== shot.h) console.warn(`! ${file} is ${width}×${height}; the video expects ${shot.w}×${shot.h} (src/shots.ts).`);
  }
}
if (standIns.length) {
  console.warn(`! No light version of ${standIns.map((shot) => shot.id).join(', ')} yet: the light cut uses stand-ins (the dark ones, inverted). Don't publish it.`);
}
