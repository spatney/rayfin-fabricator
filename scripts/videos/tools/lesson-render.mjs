// Renders a lesson for YouTube and masters its audio to -16 LUFS, like the intro.
//
//   npm run lesson:render -- 1            out/lessons/01-…/01-….mp4
//   npm run lesson:render -- 1 --draft    out/lessons/01-…/01-….draft.mp4, before every line is voiced
//
// A final render refuses a lesson with lines that aren't voiced, and stops if any voice clip,
// effect or the music bed is missing from public/; a draft leaves them out.
// Settings match remotion.config.ts: H.264, yuv420p, BT.709, CRF 25, 160 kb/s audio.
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { ensureBrowser, renderMedia, selectComposition } from '@remotion/renderer';
import { webpackOverride } from '../webpack-override.mjs';
import { lessonArg, loadLesson } from './lesson.mjs';
import { ROOT } from './paths.mjs';
import { isVoiced } from '../src/show/plan.ts';

async function main() {
  const args = process.argv.slice(2);
  const n = lessonArg(args);
  const draft = args.includes('--draft');
  const lesson = await loadLesson(n);
  if (!draft && !isVoiced(lesson.script, lesson.timeline)) {
    throw new Error(`Lesson ${n} has lines without their voice yet (npm run lesson:voice -- ${n}). Use --draft to render with stand-in timings.`);
  }
  const output = draft ? lesson.video.replace(/\.mp4$/, '.draft.mp4') : lesson.video;
  await mkdir(path.dirname(output), { recursive: true });

  await ensureBrowser();
  const serveUrl = await bundle({ entryPoint: path.join(ROOT, 'src', 'index.ts'), webpackOverride: webpackOverride(ROOT) });
  const inputProps = { lesson: n, theme: 'dark', strict: !draft };
  const composition = await selectComposition({ serveUrl, id: lesson.composition, inputProps });
  console.log(`${lesson.composition}: ${composition.durationInFrames} frames (${(composition.durationInFrames / composition.fps).toFixed(1)} s)`);
  let shown = -1;
  await renderMedia({
    serveUrl,
    composition,
    inputProps,
    codec: 'h264',
    outputLocation: output,
    imageFormat: 'jpeg',
    jpegQuality: 92,
    pixelFormat: 'yuv420p',
    colorSpace: 'bt709',
    crf: 25,
    x264Preset: 'slow',
    audioBitrate: '160k',
    overwrite: true,
    // Generous: a frame that loads a new screenshot or seeks long audio can take a while on a busy machine.
    timeoutInMilliseconds: 120000,
    logLevel: 'warn',
    onProgress: ({ progress }) => {
      const tenth = Math.floor(progress * 10);
      if (tenth !== shown) {
        shown = tenth;
        process.stdout.write(`${tenth * 10}% `);
      }
    },
  });
  process.stdout.write('\n');

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'master.mjs'), output], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`master.mjs exited with ${code}`))));
  });
  console.log(path.relative(process.cwd(), output));
}

main().catch((err) => {
  console.error(err.stack ?? err.message);
  process.exit(1);
});
