// The series' music bed: one instrumental, made once and looped under every lesson (see
// lessons/series.ts). The lessons duck it under Ray's voice.
//
//   npm run lesson:music              makes it, unless it's there already
//   npm run lesson:music -- --force   makes a new take (it costs credits again)
//
// Cached like the other tools: the same prompt and length cost nothing twice.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { durationSeconds, normalize } from './audio.mjs';
import { ensureCredits, music } from './elevenlabs.mjs';
import { OUT, PUBLIC } from './paths.mjs';
import { SERIES } from '../lessons/series.ts';

async function main() {
  const file = path.join(PUBLIC, ...SERIES.music.bed.split('/'));
  if (existsSync(file) && !process.argv.includes('--force')) {
    console.log(`${path.relative(process.cwd(), file)} is there already (${(await durationSeconds(file)).toFixed(1)} s). --force makes a new one.`);
    return;
  }
  const lengthMs = SERIES.music.seconds * 1000;
  // About 900 credits a minute.
  await ensureCredits(Math.ceil((lengthMs / 60000) * 900), 'the series music');
  const { audio, fresh } = await music({ prompt: SERIES.music.prompt, lengthMs });
  const raw = path.join(OUT, 'music-raw', 'lessons-bed.mp3');
  await mkdir(path.dirname(raw), { recursive: true });
  await writeFile(raw, audio);
  await mkdir(path.dirname(file), { recursive: true });
  await normalize(raw, file, { i: -16, tp: -1.5, bitrate: '192k', channels: 2 });
  console.log(`music ${fresh ? 'new' : 'cached'}: ${(await durationSeconds(file)).toFixed(1)} s → ${path.relative(process.cwd(), file)}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
