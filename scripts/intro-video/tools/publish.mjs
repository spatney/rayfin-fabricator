// Publishes the approved cut to the docs site:
//   website/public/video/fabricator-intro.mp4           the video (from out/, after `npm run render`)
//   website/public/video/fabricator-intro-poster.webp   the poster: Ray saying hi (the Poster still)
//   website/public/video/fabricator-intro.en.vtt        English captions, timed from the voiceover
//   website/lib/intro-video.json                        duration and transcript, for the page and its .md mirror
import { createRequire } from 'node:module';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { ensureBrowser, renderStill, selectComposition } from '@remotion/renderer';
import { webpackOverride } from '../webpack-override.mjs';
import { durationSeconds } from './audio.mjs';
import { toVtt, videoCues } from './captions.mjs';
import { OUT, REPO, ROOT, TIMELINE } from './paths.mjs';
import { SCENE_IDS, layout } from '../src/timing.ts';

const sharp = createRequire(path.join(REPO, 'website', 'package.json'))('sharp');
const SITE = path.join(REPO, 'website');
const DEST = path.join(SITE, 'public', 'video');
const NAME = 'fabricator-intro';

async function main() {
  const video = path.join(OUT, `${NAME}.mp4`);
  if (!existsSync(video)) throw new Error(`Render the video first (npm run render): ${path.relative(ROOT, video)} is missing.`);
  const timeline = JSON.parse(await readFile(TIMELINE, 'utf8'));
  const l = layout(timeline);
  await mkdir(DEST, { recursive: true });

  const starts = Object.fromEntries(timeline.lines.map((line) => [line.id, (l.lines[line.id].from / l.fps) * 1000]));
  await writeFile(path.join(DEST, `${NAME}.en.vtt`), toVtt(videoCues(timeline.lines, starts)));

  await ensureBrowser();
  const serveUrl = await bundle({ entryPoint: path.join(ROOT, 'src', 'index.ts'), webpackOverride: webpackOverride(ROOT) });
  const composition = await selectComposition({ serveUrl, id: 'FabricatorIntro' });
  const poster = await selectComposition({ serveUrl, id: 'Poster' });
  const png = path.join(OUT, 'poster.png');
  await renderStill({ serveUrl, composition: poster, frame: 0, output: png, imageFormat: 'png' });
  await sharp(png).webp({ quality: 80 }).toFile(path.join(DEST, `${NAME}-poster.webp`));

  await copyFile(video, path.join(DEST, `${NAME}.mp4`));

  const byId = new Map(timeline.lines.map((line) => [line.id, line]));
  const meta = {
    src: `/video/${NAME}.mp4`,
    poster: `/video/${NAME}-poster.webp`,
    captions: `/video/${NAME}.en.vtt`,
    width: composition.width,
    height: composition.height,
    durationSeconds: Math.round((await durationSeconds(video)) * 10) / 10,
    transcript: SCENE_IDS.map((id) => byId.get(id).caption),
  };
  await writeFile(path.join(SITE, 'lib', 'intro-video.json'), `${JSON.stringify(meta, null, 2)}\n`);

  for (const file of [`${NAME}.mp4`, `${NAME}-poster.webp`, `${NAME}.en.vtt`]) console.log(path.relative(REPO, path.join(DEST, file)));
  console.log(path.relative(REPO, path.join(SITE, 'lib', 'intro-video.json')));
}

main().catch((err) => {
  console.error(err.stack ?? err.message);
  process.exit(1);
});
