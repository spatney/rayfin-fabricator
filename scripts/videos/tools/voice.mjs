// Ray's voiceover: one clip per script line, with word timings.
//
//   node tools/voice.mjs             every line
//   node tools/voice.mjs tricks      only the lines named; the others keep their clips and timings
//
// For each line in script/lines.ts this asks ElevenLabs for speech with character timings,
// normalizes the clip's loudness, and records the clip's length, word timings and a per-frame
// mouth envelope in src/timeline.json, which the scenes are timed from.
//
// Requests are cached, so rerunning only pays for lines whose text, voice or seed changed.
// The cache (.cache/) isn't committed, though, and without it every line is a new take that
// sounds and times differently: then name the lines that changed.
// To retake a line without changing its words, give it a different `seed` in lines.ts.
// The read is sped up 6% (pitch preserved) to keep the cut inside 90 s; VO_TEMPO overrides it.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureCredits, speak } from './elevenlabs.mjs';
import { durationSeconds, mouthEnvelope, normalize } from './audio.mjs';
import { wordsFromAlignment } from './captions.mjs';
import { FPS, OUT, PUBLIC, TIMELINE } from './paths.mjs';
import { LINES, VOICE, spokenText } from '../script/lines.ts';

const TEMPO = Number(process.env.VO_TEMPO ?? 1.06);
/** Integrated loudness of each clip; the music and effects are mixed under it. */
const LUFS = -16;

/** JSON with number arrays kept on one line. */
function format(value) {
  return JSON.stringify(value, null, 2).replace(/\[\s+([-\d.,\s]+?)\s+\]/g, (_, nums) => `[${nums.replace(/\s+/g, '')}]`);
}

/**
 * With line ids given, every other line keeps its clip and timings from timeline.json, as long
 * as its words are still the script's.
 */
async function keptLines(only) {
  if (!only.length) return new Map();
  const unknown = only.filter((id) => !LINES.some((line) => line.id === id));
  if (unknown.length) throw new Error(`script/lines.ts has no line ${unknown.map((id) => `"${id}"`).join(', ')}.`);
  const timeline = JSON.parse(await readFile(TIMELINE, 'utf8'));
  if (timeline.tempo !== TEMPO || JSON.stringify(timeline.voice) !== JSON.stringify(VOICE)) {
    throw new Error('The voice or tempo changed since timeline.json was made, so every line needs a new take. Run without line ids.');
  }
  const kept = new Map();
  for (const line of LINES) {
    if (only.includes(line.id)) continue;
    const old = timeline.lines.find((l) => l.id === line.id);
    if (!old || old.caption !== spokenText(line.text)) throw new Error(`"${line.id}" is new or changed in script/lines.ts; name it too.`);
    kept.set(line.id, old);
  }
  return kept;
}

async function main() {
  const kept = await keptLines(process.argv.slice(2));
  const characters = LINES.filter((line) => !kept.has(line.id)).reduce((n, line) => n + line.text.length, 0);
  await ensureCredits(characters, 'the voiceover');

  const rawDir = path.join(OUT, 'vo-raw');
  const voDir = path.join(PUBLIC, 'audio', 'vo');
  await mkdir(rawDir, { recursive: true });
  await mkdir(voDir, { recursive: true });

  const lines = [];
  for (const line of LINES) {
    const old = kept.get(line.id);
    if (old) {
      lines.push(old);
      console.log(`${line.id.padEnd(12)} ${(old.durationMs / 1000).toFixed(2).padStart(6)} s  kept`);
      continue;
    }
    const result = await speak({
      voiceId: VOICE.voiceId,
      modelId: VOICE.modelId,
      text: line.text,
      seed: line.seed ?? VOICE.seed,
    });
    if (!result.alignment) throw new Error(`No timings came back for "${line.id}".`);
    const raw = path.join(rawDir, `${line.id}.mp3`);
    await writeFile(raw, result.audio);
    const file = path.join(voDir, `${line.id}.mp3`);
    await normalize(raw, file, { i: LUFS, tempo: TEMPO });

    const durationMs = Math.round((await durationSeconds(file)) * 1000);
    const words = wordsFromAlignment(result.alignment, { tempo: TEMPO });
    lines.push({
      id: line.id,
      file: `audio/vo/${line.id}.mp3`,
      durationMs,
      speechStartMs: words[0].startMs,
      speechEndMs: words[words.length - 1].endMs,
      caption: spokenText(line.text),
      words,
      envelope: await mouthEnvelope(file, FPS),
    });
    console.log(`${line.id.padEnd(12)} ${(durationMs / 1000).toFixed(2).padStart(6)} s  ${result.fresh ? 'new' : 'cached'}`);
  }

  await writeFile(TIMELINE, `${format({ fps: FPS, voice: VOICE, tempo: TEMPO, lines })}\n`);
  const total = lines.reduce((ms, l) => ms + l.durationMs, 0);
  console.log(`\n${lines.length} lines, ${(total / 1000).toFixed(1)} s of voice → ${path.relative(process.cwd(), TIMELINE)}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
