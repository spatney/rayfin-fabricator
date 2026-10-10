// Masters the rendered cut's audio: two-pass EBU R128 normalization to -16 LUFS with true
// peaks under -1.5 dBTP, leaving the video stream untouched. Runs after every render.
import { rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { loudness, run } from './audio.mjs';
import { OUT } from './paths.mjs';

const I = -16;
const TP = -1.5;
const LRA = 11;

async function main() {
  const file = path.resolve(process.argv[2] ?? path.join(OUT, 'fabricator-intro.mp4'));
  const temp = file.replace(/\.mp4$/, '.mastering.mp4');
  const m = await loudness(file, { i: I, tp: TP, lra: LRA });
  await run('ffmpeg', [
    '-hide_banner', '-y', '-i', file,
    '-map', '0:v:0', '-map', '0:a:0',
    '-c:v', 'copy',
    '-af',
    `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:measured_I=${m.integrated}:measured_TP=${m.truePeak}` +
      `:measured_LRA=${m.range}:measured_thresh=${m.threshold}:offset=${m.offset}:linear=true`,
    '-ar', '48000', '-c:a', 'libfdk_aac', '-b:a', '160k',
    '-movflags', '+faststart',
    temp,
  ]);
  await rm(file);
  await rename(temp, file);
  const after = await loudness(file, { i: I, tp: TP, lra: LRA });
  console.log(`mastered: ${m.integrated.toFixed(1)} → ${after.integrated.toFixed(1)} LUFS, peak ${m.truePeak.toFixed(1)} → ${after.truePeak.toFixed(1)} dBTP`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
