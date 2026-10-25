// The music bed: an instrumental track from Eleven Music, as long as the cut. The scenes duck
// it under Ray's voice. Cached: rerunning with the same prompt and length costs nothing.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureCredits, music, soundEffect } from './elevenlabs.mjs';
import { durationSeconds, normalize } from './audio.mjs';
import { OUT, PUBLIC, TIMELINE } from './paths.mjs';
import { layout } from '../src/timing.ts';

export const PROMPT =
  'Bright, playful, bouncy instrumental for a cheerful animated product explainer starring a cute cartoon stingray. ' +
  'Ukulele and marimba melody, pizzicato strings, light hand claps, a soft modern pop beat and bubbly underwater synth plucks. ' +
  '112 BPM, major key, warm and fun. A short intro, then an upbeat main groove, a lighter breakdown in the middle, ' +
  'and a big happy finale with a clean ending. No vocals.';

async function main() {
  const timeline = JSON.parse(await readFile(TIMELINE, 'utf8'));
  const { total, fps } = layout(timeline);
  const lengthMs = Math.ceil(((total / fps) + 1.5) * 1000);
  await mkdir(path.join(OUT, 'music-raw'), { recursive: true });
  const raw = path.join(OUT, 'music-raw', 'music.mp3');

  try {
    // About 900 credits a minute.
    await ensureCredits(Math.ceil((lengthMs / 60000) * 900), 'the music');
    const { audio, fresh } = await music({ prompt: PROMPT, lengthMs });
    await writeFile(raw, audio);
    console.log(`music ${fresh ? 'new' : 'cached'}`);
  } catch (err) {
    // Eleven Music is for paid plans. Without it, loop a short bed made as a sound effect.
    console.warn(`Eleven Music is unavailable (${err.message.slice(0, 160)}). Using a looping sound-effect bed.`);
    const { audio } = await soundEffect({
      text: 'Upbeat playful ukulele and marimba music loop with light claps and bubbly synth plucks, 112 BPM, cheerful, seamless loop',
      durationSeconds: 30,
      loop: true,
      promptInfluence: 0.6,
    });
    await writeFile(raw, audio);
  }

  const file = path.join(PUBLIC, 'audio', 'music.mp3');
  await normalize(raw, file, { i: -16, tp: -1.5, bitrate: '192k', channels: 2 });
  console.log(`${(await durationSeconds(file)).toFixed(1)} s → ${path.relative(process.cwd(), file)}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
