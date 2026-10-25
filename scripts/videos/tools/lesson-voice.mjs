// Ray's voice for a lesson: one clip per line, with word timings.
//
//   npm run lesson:voice -- 1               every line of lesson 1 that is new, changed or retaken
//   npm run lesson:voice -- 1 hook today    those lines again, even if they haven't changed
//   npm run lesson:voice -- 1 --dry         what it would make and cost, without calling ElevenLabs
//
// Each line in the lesson's script.ts is spoken by ElevenLabs with character timings, its
// loudness is normalized, and its length, word timings and a per-frame mouth envelope go into
// the lesson's timeline.json, which the scenes are timed from. A line is kept as it is while
// its words, seed and respellings are unchanged, so fixing one line costs one line. To retake
// a line without changing its words, give it a new `seed` in script.ts; to fix how the voice
// says a word, give the line a `say` respelling. Requests are cached in .cache/ by their
// content, so a rerun after a failure costs nothing twice.
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { durationSeconds, mouthEnvelope, normalize } from './audio.mjs';
import { wordsFromAlignment } from './captions.mjs';
import { ensureCredits, speak } from './elevenlabs.mjs';
import { lessonArg, loadLesson } from './lesson.mjs';
import { FPS } from './paths.mjs';
import { spokenText } from '../script/lines.ts';
import { SERIES } from '../lessons/series.ts';
import { checkScript, sayText, unsayWords, voicedLines } from '../src/show/plan.ts';

/** Integrated loudness of each clip; the music and effects are mixed under it. */
const LUFS = -16;

/** JSON with number arrays kept on one line. */
function format(value) {
  return JSON.stringify(value, null, 2).replace(/\[\s+([-\d.,\s]+?)\s+\]/g, (_, nums) => `[${nums.replace(/\s+/g, '')}]`);
}

async function main() {
  const args = process.argv.slice(2);
  const n = lessonArg(args);
  const dry = args.includes('--dry');
  const named = args.filter((a) => !/^\d+$/.test(a) && !a.startsWith('--'));
  const lesson = await loadLesson(n);
  checkScript(lesson.script);
  const lines = voicedLines(lesson.script);
  const unknown = named.filter((id) => !lines.some((l) => l.id === id));
  if (unknown.length) throw new Error(`Lesson ${n} has no voiced line ${unknown.map((id) => `"${id}"`).join(', ')}.`);

  const voice = SERIES.voice;
  const sameVoice = JSON.stringify(lesson.timeline.voice) === JSON.stringify(voice) && lesson.timeline.tempo === SERIES.tempo;
  const old = new Map((sameVoice ? lesson.timeline.lines : []).map((l) => [l.id, l]));
  const seedOf = (line) => line.seed ?? voice.seed;
  /** What the voice reads: the line with any `say` respellings. */
  const readOf = (line) => sayText(line.text, line.say);
  const stale = (line) => {
    const was = old.get(line.id);
    // A clip without `said` was read as written.
    return named.includes(line.id) || !was || was.caption !== spokenText(line.text) || was.seed !== seedOf(line) || (was.said ?? line.text) !== readOf(line);
  };
  const todo = lines.filter(stale);
  const unfinished = todo.filter((l) => /\bTODO\b/.test(l.text));
  if (unfinished.length) throw new Error(`Finish these lines before voicing them: ${unfinished.map((l) => l.id).join(', ')}.`);
  const characters = todo.reduce((sum, l) => sum + readOf(l).length, 0);

  console.log(`Lesson ${n}: ${lines.length} lines, ${todo.length} to voice (${characters} characters)${sameVoice ? '' : ', all of them because the voice or tempo changed'}.`);
  for (const line of todo) console.log(`  ${line.id}`);
  if (dry || !todo.length) return;
  await ensureCredits(characters, `lesson ${n}'s voice`);

  const rawDir = path.join(lesson.out, 'vo-raw');
  await mkdir(rawDir, { recursive: true });
  await mkdir(lesson.voDir, { recursive: true });

  const result = [];
  for (const line of lines) {
    if (!stale(line)) {
      result.push(old.get(line.id));
      continue;
    }
    const spoken = await speak({ voiceId: voice.voiceId, modelId: voice.modelId, text: readOf(line), seed: seedOf(line) });
    if (!spoken.alignment) throw new Error(`No timings came back for "${line.id}".`);
    const raw = path.join(rawDir, `${line.id}.mp3`);
    await writeFile(raw, spoken.audio);
    const file = path.join(lesson.voDir, `${line.id}.mp3`);
    await normalize(raw, file, { i: LUFS, tempo: SERIES.tempo });
    const durationMs = Math.round((await durationSeconds(file)) * 1000);
    const words = unsayWords(wordsFromAlignment(spoken.alignment, { tempo: SERIES.tempo }), line.say);
    result.push({
      id: line.id,
      file: `${lesson.voPublic}/${line.id}.mp3`,
      seed: seedOf(line),
      ...(readOf(line) !== line.text ? { said: readOf(line) } : {}),
      durationMs,
      speechStartMs: words[0].startMs,
      speechEndMs: words[words.length - 1].endMs,
      caption: spokenText(line.text),
      words,
      envelope: await mouthEnvelope(file, FPS),
    });
    console.log(`${line.id.padEnd(14)} ${(durationMs / 1000).toFixed(2).padStart(6)} s  ${spoken.fresh ? 'new' : 'cached'}`);
    // Saved as it goes, so a failure part way keeps what's done.
    await writeFile(lesson.timelinePath, `${format({ fps: FPS, voice, tempo: SERIES.tempo, lines: [...result, ...lines.slice(result.length).map((l) => old.get(l.id)).filter(Boolean)] })}\n`);
  }

  await writeFile(lesson.timelinePath, `${format({ fps: FPS, voice, tempo: SERIES.tempo, lines: result })}\n`);
  // Clips of lines the script no longer has.
  const keep = new Set(lines.map((l) => `${l.id}.mp3`));
  for (const file of await readdir(lesson.voDir)) if (!keep.has(file)) await rm(path.join(lesson.voDir, file));
  const total = result.reduce((ms, l) => ms + l.durationMs, 0);
  console.log(`\n${result.length} lines, ${(total / 1000).toFixed(1)} s of voice → ${path.relative(process.cwd(), lesson.timelinePath)}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
