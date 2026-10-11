// Publishes the approved cuts to the docs site, which plays the one that matches its theme:
//   website/public/video/fabricator-intro.mp4                 the dark cut (from out/, after `npm run render`)
//   website/public/video/fabricator-intro.light.mp4           the light cut
//   website/public/video/fabricator-intro-poster.webp         the dark poster: Ray saying hi (the Poster still)
//   website/public/video/fabricator-intro-poster.light.webp   the light poster (the PosterLight still)
//   website/public/video/fabricator-intro.en.vtt              English captions, timed from the voiceover, for both
//   website/lib/intro-video.json                              files, duration and transcript, for the page and its .md mirror
//
// It refuses cuts rendered before their screenshots last changed, or with a stand-in for a
// light screenshot the site doesn't have yet (see sync-assets.mjs).
import { createRequire } from 'node:module';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { ensureBrowser, renderStill, selectComposition } from '@remotion/renderer';
import { webpackOverride } from '../webpack-override.mjs';
import { durationSeconds } from './audio.mjs';
import { toVtt, videoCues } from './captions.mjs';
import { CUTS, OUT, REPO, ROOT, TIMELINE } from './paths.mjs';
import { SCENE_IDS, layout } from '../src/timing.ts';
import { SHOTS, shotFile } from '../src/shots.ts';

const sharp = createRequire(path.join(REPO, 'website', 'package.json'))('sharp');
const SITE = path.join(REPO, 'website');
const DEST = path.join(SITE, 'public', 'video');
const SCREENSHOTS = path.join(SITE, 'public', 'screenshots');
const NAME = 'fabricator-intro';

/**
 * Each cut must show the site's own screenshots in its theme: none missing (the light cut
 * would have been rendered with stand-ins) and none changed since it was rendered.
 */
async function checkScreenshots() {
  const problems = [];
  for (const [theme, cut] of Object.entries(CUTS)) {
    const rendered = (await stat(path.join(OUT, cut.video))).mtimeMs;
    for (const shot of Object.values(SHOTS)) {
      const file = path.join(SCREENSHOTS, shotFile(shot, theme));
      if (!existsSync(file)) problems.push(`${path.relative(REPO, file)} is missing, so the ${theme} cut was rendered with a stand-in.`);
      else if ((await stat(file)).mtimeMs > rendered) problems.push(`${path.relative(REPO, file)} changed after the ${theme} cut was rendered.`);
    }
  }
  if (problems.length) throw new Error(`${problems.join('\n')}\nAdd or keep the screenshots, then render both cuts again (npm run render).`);
}

async function main() {
  const cuts = Object.values(CUTS);
  const videos = cuts.map((cut) => path.join(OUT, cut.video));
  const missing = videos.filter((video) => !existsSync(video));
  if (missing.length) throw new Error(`Render both cuts first (npm run render): ${missing.map((v) => path.relative(ROOT, v)).join(' and ')} ${missing.length > 1 ? 'are' : 'is'} missing.`);
  await checkScreenshots();
  const lengths = await Promise.all(videos.map(durationSeconds));
  if (Math.max(...lengths) - Math.min(...lengths) > 0.05) {
    throw new Error(`The cuts differ in length (${lengths.map((s) => `${s.toFixed(2)} s`).join(', ')}). Render both again (npm run render).`);
  }
  const timeline = JSON.parse(await readFile(TIMELINE, 'utf8'));
  const l = layout(timeline);
  await mkdir(DEST, { recursive: true });

  const starts = Object.fromEntries(timeline.lines.map((line) => [line.id, (l.lines[line.id].from / l.fps) * 1000]));
  await writeFile(path.join(DEST, `${NAME}.en.vtt`), toVtt(videoCues(timeline.lines, starts)));

  await ensureBrowser();
  const serveUrl = await bundle({ entryPoint: path.join(ROOT, 'src', 'index.ts'), webpackOverride: webpackOverride(ROOT) });
  const composition = await selectComposition({ serveUrl, id: CUTS.dark.composition });
  for (const cut of cuts) {
    const poster = await selectComposition({ serveUrl, id: cut.poster });
    const png = path.join(OUT, `${cut.poster}.png`);
    await renderStill({ serveUrl, composition: poster, frame: 0, output: png, imageFormat: 'png' });
    await sharp(png).webp({ quality: 80 }).toFile(path.join(DEST, cut.posterFile));
    await copyFile(path.join(OUT, cut.video), path.join(DEST, cut.video));
  }

  const byId = new Map(timeline.lines.map((line) => [line.id, line]));
  const meta = {
    src: `/video/${CUTS.dark.video}`,
    poster: `/video/${CUTS.dark.posterFile}`,
    light: {
      src: `/video/${CUTS.light.video}`,
      poster: `/video/${CUTS.light.posterFile}`,
    },
    captions: `/video/${NAME}.en.vtt`,
    width: composition.width,
    height: composition.height,
    durationSeconds: Math.round(lengths[0] * 10) / 10,
    transcript: SCENE_IDS.map((id) => byId.get(id).caption),
  };
  await writeFile(path.join(SITE, 'lib', 'intro-video.json'), `${JSON.stringify(meta, null, 2)}\n`);

  for (const file of [...cuts.flatMap((cut) => [cut.video, cut.posterFile]), `${NAME}.en.vtt`]) console.log(path.relative(REPO, path.join(DEST, file)));
  console.log(path.relative(REPO, path.join(SITE, 'lib', 'intro-video.json')));
}

main().catch((err) => {
  console.error(err.stack ?? err.message);
  process.exit(1);
});
