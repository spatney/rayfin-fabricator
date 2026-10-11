// Masters the rendered cuts' audio: two-pass EBU R128 normalization to -16 LUFS with true
// peaks under -1.5 dBTP, leaving the video stream untouched. Runs after every render.
//
//   node tools/master.mjs [file...]      defaults to out/fabricator-intro.mp4
//
// The cuts share their sound, so when a later file's audio is identical to the first one's,
// it gets the first one's mastered audio instead of being mastered again.
import { createHash } from 'node:crypto';
import { rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { loudness, run } from './audio.mjs';
import { CUTS, OUT } from './paths.mjs';

const I = -16;
const TP = -1.5;
const LRA = 11;

/** A hash of the decoded audio, to tell whether two renders sound the same. */
async function audioHash(file) {
  const { stdout } = await run('ffmpeg', ['-hide_banner', '-v', 'error', '-i', file, '-map', '0:a:0', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1']);
  return createHash('sha256').update(stdout).digest('hex');
}

/** Replaces `file` with what `write(temp)` produces. */
async function replace(file, write) {
  const temp = file.replace(/\.mp4$/, '.mastering.mp4');
  await write(temp);
  await rm(file);
  await rename(temp, file);
}

async function master(file) {
  const m = await loudness(file, { i: I, tp: TP, lra: LRA });
  await replace(file, (temp) =>
    run('ffmpeg', [
      '-hide_banner', '-y', '-i', file,
      '-map', '0:v:0', '-map', '0:a:0',
      '-c:v', 'copy',
      '-af',
      `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:measured_I=${m.integrated}:measured_TP=${m.truePeak}` +
        `:measured_LRA=${m.range}:measured_thresh=${m.threshold}:offset=${m.offset}:linear=true`,
      '-ar', '48000', '-c:a', 'libfdk_aac', '-b:a', '160k',
      '-movflags', '+faststart',
      temp,
    ]),
  );
  const after = await loudness(file, { i: I, tp: TP, lra: LRA });
  console.log(`${path.basename(file)}: ${m.integrated.toFixed(1)} → ${after.integrated.toFixed(1)} LUFS, peak ${m.truePeak.toFixed(1)} → ${after.truePeak.toFixed(1)} dBTP`);
}

/** Gives `file` the already mastered audio of `from`, keeping its own picture. */
async function reuse(file, from) {
  await replace(file, (temp) =>
    run('ffmpeg', [
      '-hide_banner', '-y', '-i', file, '-i', from,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c', 'copy',
      '-movflags', '+faststart',
      temp,
    ]),
  );
  console.log(`${path.basename(file)}: same sound as ${path.basename(from)}, so it takes its mastered audio`);
}

async function main() {
  const args = process.argv.slice(2);
  const files = (args.length ? args : [path.join(OUT, CUTS.dark.video)]).map((f) => path.resolve(f));
  const hashes = files.length > 1 ? await Promise.all(files.map(audioHash)) : [];
  await master(files[0]);
  for (const [i, file] of files.entries()) {
    if (i === 0) continue;
    if (hashes[i] === hashes[0]) await reuse(file, files[0]);
    else await master(file);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
