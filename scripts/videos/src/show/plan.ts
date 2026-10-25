/**
 * Where everything in a lesson sits in time. Pure and React-free: the lesson scenes use it,
 * and so do the lesson tools (through Node's type stripping) to place captions and chapters
 * exactly where the voice is.
 *
 * A lesson is a list of scenes, and each scene is a list of beats. A beat is one of Ray's
 * lines, with its own voice clip, or a silent hold (the bumper's jingle, a quiz countdown).
 * Beats play one after another with a little quiet before each. A scene starts `lead`
 * seconds before its first beat and keeps running OVERLAP frames into the next scene, so the
 * next one can transition in.
 */
import { spokenText } from '../../script/lines.ts';
import { OVERLAP, wordFrames, type Span, type Timeline, type TimelineLine, type Word } from '../timing.ts';

export interface LineSpec {
  /** Unique within the lesson. Names the voice clip and lets scenes find the line's timing. */
  id: string;
  /** What Ray says, with ElevenLabs audio tags such as `[excited]`. Omit for a silent hold. */
  text?: string;
  /** Seconds of silence: a beat without speech, such as the bumper's jingle or a countdown. */
  hold?: number;
  /** Seconds of quiet before this beat. Defaults to GAP_SCENE for a scene's first beat, GAP_LINE otherwise. */
  gap?: number;
  /** Overrides the voice's seed, for a retake of this line without changing its words. */
  seed?: number;
  /**
   * Words the voice says wrong, and how to say them: `{ APIs: "API's" }`, or several words, such
   * as `{ 'rayfin.yml': 'rayfin dot yaml' }`. The voice reads the respelling; the captions and
   * word cues keep the word as written, timed from the respelling's first word to its last. Write
   * the parts as separate words: in a made-up compound such as rayfin-dot-yaml, the voice reads
   * each hyphen as "dash".
   */
  say?: Readonly<Record<string, string>>;
  /**
   * The pages each claim in the line rests on: rayfin.ai for Rayfin, the Fabricator docs for
   * Fabricator. They become the "Learn more" links in the lesson's YouTube description.
   */
  sources?: readonly string[];
}

export interface SceneSpec {
  /** Unique within the lesson; the scene definition in scenes.tsx has the same id. */
  id: string;
  /** Starts a YouTube chapter with this title. */
  chapter?: string;
  /** Seconds the scene starts before its first beat. Defaults to LEAD. */
  lead?: number;
  beats: readonly LineSpec[];
}

export interface LessonScript {
  /** The lesson's number in the series. */
  number: number;
  /** The lesson's folder in lessons/, such as `01-what-is-rayfin`. */
  slug: string;
  /** The lesson's title, as on its bumper and thumbnail. */
  title: string;
  /** The Rayfin release every claim and snippet in the lesson was checked against. */
  rayfinVersion: string;
  scenes: readonly SceneSpec[];
  /** Seconds the picture holds after the last beat. Defaults to END_HOLD. */
  endHold?: number;
}

/** Quiet before a scene's first beat, and between beats in a scene, in seconds. */
export const GAP_SCENE = 0.55;
export const GAP_LINE = 0.3;
/** Seconds a scene starts before its first beat. */
export const LEAD = 0.35;
export const END_HOLD = 1.5;
/** Ray's speaking rate at tempo 1, in characters a second: sizes the draft timeline. */
export const DRAFT_RATE = 13.5;

export interface Beat {
  id: string;
  scene: string;
  /** Absolute frames. */
  from: number;
  duration: number;
  /** The voiced line's timing; none for a silent hold. */
  line?: TimelineLine;
}

export interface Chapter {
  title: string;
  /** Absolute frame where the chapter's scene starts. */
  from: number;
}

export interface Plan {
  fps: number;
  total: number;
  /** Every beat, by id, in absolute frames. */
  beats: Record<string, Beat>;
  /** Beat ids in order. */
  order: string[];
  /** Each scene, including its overlap with the next; `first` is its first beat's frame. */
  scenes: Record<string, Span & { first: number }>;
  chapters: Chapter[];
}

/** Every beat of a lesson, in order. */
export function beatsOf(script: LessonScript): LineSpec[] {
  return script.scenes.flatMap((scene) => scene.beats);
}

/** The voiced lines of a lesson: the beats with text. */
export function voicedLines(script: LessonScript): Array<LineSpec & { text: string }> {
  return beatsOf(script).filter((b): b is LineSpec & { text: string } => typeof b.text === 'string');
}

/** Throws on a script that can't be laid out: duplicate ids, empty scenes, beats that are neither said nor held. */
export function checkScript(script: LessonScript): void {
  const ids = new Set<string>();
  const sceneIds = new Set<string>();
  for (const scene of script.scenes) {
    if (sceneIds.has(scene.id)) throw new Error(`Scene "${scene.id}" appears twice in lesson ${script.number}.`);
    sceneIds.add(scene.id);
    if (!scene.beats.length) throw new Error(`Scene "${scene.id}" has no beats.`);
    for (const beat of scene.beats) {
      if (ids.has(beat.id)) throw new Error(`Beat "${beat.id}" appears twice in lesson ${script.number}.`);
      ids.add(beat.id);
      const said = typeof beat.text === 'string' && spokenText(beat.text).length > 0;
      if (said === (beat.hold !== undefined)) throw new Error(`Beat "${beat.id}" needs either text or a hold, not ${said ? 'both' : 'neither'}.`);
      for (const [word, respelled] of Object.entries(beat.say ?? {})) {
        if (!respelled.trim()) throw new Error(`Beat "${beat.id}" respells "${word}" as nothing; give the voice something to say.`);
        if (sayText(beat.text ?? '', { [word]: respelled }) === beat.text) throw new Error(`Beat "${beat.id}" respells "${word}", but its text doesn't have that word.`);
      }
    }
  }
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** `word` on its own, not inside another word. */
const wholeWord = (word: string) => new RegExp(`(?<![\\p{L}\\p{N}'’])${escapeRegExp(word)}(?![\\p{L}\\p{N}'’])`, 'gu');

/** What the voice reads for a line: its text with each word in `say` respelled. */
export function sayText(text: string, say?: Readonly<Record<string, string>>): string {
  let out = text;
  for (const [word, respelled] of Object.entries(say ?? {})) out = out.replace(wholeWord(word), respelled.trim());
  return out;
}

/**
 * The voice's word timings, with each respelling turned back into the word as written. A
 * respelling of several words becomes one word again, from the start of its first to the end of
 * its last; punctuation the voice read after it stays on.
 */
export function unsayWords(words: readonly Word[], say?: Readonly<Record<string, string>>): Word[] {
  const plain = (s: string) => s.replace(/’/g, "'");
  const back = Object.entries(say ?? {}).map(([word, respelled]) => ({ word, parts: plain(respelled).trim().split(/\s+/) }));
  // Only a respelling's last part may carry the punctuation that follows it.
  const matches = (text: string, part: string, last: boolean) => text === part || (last && text.startsWith(part) && /^[,.!?…:;]+$/.test(text.slice(part.length)));
  const out: Word[] = [];
  for (let i = 0; i < words.length; i++) {
    const hit = back.find((b) => b.parts.every((part, k) => i + k < words.length && matches(plain(words[i + k].text), part, k === b.parts.length - 1)));
    if (!hit) {
      out.push(words[i]);
      continue;
    }
    const last = words[i + hit.parts.length - 1];
    const tail = plain(last.text).slice(hit.parts[hit.parts.length - 1].length);
    out.push({ ...words[i], text: hit.word + tail, endMs: last.endMs });
    i += hit.parts.length - 1;
  }
  return out;
}

/** Lays a lesson out on its timeline. Throws when a voiced line has no timing yet. */
export function planLesson(script: LessonScript, timeline: Timeline): Plan {
  checkScript(script);
  const fps = timeline.fps;
  const toFrames = (s: number) => Math.round(s * fps);
  const lines = new Map(timeline.lines.map((l) => [l.id, l]));

  const beats: Record<string, Beat> = {};
  const order: string[] = [];
  const firsts: Array<{ id: string; first: number; lead: number }> = [];
  let cursor = 0;
  for (const scene of script.scenes) {
    scene.beats.forEach((spec, i) => {
      cursor += toFrames(spec.gap ?? (i === 0 ? GAP_SCENE : GAP_LINE));
      if (i === 0) firsts.push({ id: scene.id, first: cursor, lead: toFrames(scene.lead ?? LEAD) });
      let duration: number;
      let line: TimelineLine | undefined;
      if (spec.hold !== undefined) duration = toFrames(spec.hold);
      else {
        line = lines.get(spec.id);
        if (!line) throw new Error(`The timeline has no line "${spec.id}". Run npm run lesson:voice -- ${script.number}.`);
        if (line.caption !== spokenText(spec.text ?? '')) {
          throw new Error(`Line "${spec.id}" changed since it was voiced. Run npm run lesson:voice -- ${script.number} ${spec.id}.`);
        }
        duration = Math.ceil((line.durationMs / 1000) * fps);
      }
      beats[spec.id] = { id: spec.id, scene: scene.id, from: cursor, duration, line };
      order.push(spec.id);
      cursor += duration;
    });
  }
  const total = cursor + toFrames(script.endHold ?? END_HOLD);

  const scenes: Plan['scenes'] = {};
  firsts.forEach(({ id, first, lead }, i) => {
    // The first scene opens the video.
    const from = i === 0 ? 0 : Math.max(0, first - lead);
    const next = firsts[i + 1];
    const end = next ? Math.max(0, next.first - next.lead) + OVERLAP : total;
    scenes[id] = { from, duration: end - from, first };
  });

  const chapters = script.scenes
    .filter((scene) => scene.chapter)
    .map((scene) => ({ title: scene.chapter as string, from: scenes[scene.id].from }));
  return { fps, total, beats, order, scenes, chapters };
}

/**
 * A stand-in timeline for a lesson that hasn't been voiced yet, or has lines that changed
 * since: each line timed at Ray's usual pace, its words spread by length, and a steady voice
 * for his lips. Scenes can be built and checked against it before any credits are spent; the
 * real timings replace it line by line as the voice is made.
 */
export function draftTimeline(script: LessonScript, base: Timeline): Timeline {
  const fps = base.fps;
  const real = new Map(base.lines.map((l) => [l.id, l]));
  const lines = voicedLines(script).map((spec): TimelineLine => {
    const caption = spokenText(spec.text);
    const voiced = real.get(spec.id);
    if (voiced && voiced.caption === caption) return voiced;
    const leadMs = 120;
    const speechMs = Math.round((caption.length / DRAFT_RATE) * 1000);
    const parts = caption.split(' ');
    const weight = parts.reduce((n, w) => n + w.length + 1, 0);
    const words: Word[] = [];
    let t = leadMs;
    for (const text of parts) {
      const span = (speechMs * (text.length + 1)) / weight;
      words.push({ text, startMs: Math.round(t), endMs: Math.round(t + span * 0.88) });
      t += span;
    }
    const durationMs = leadMs + speechMs + 200;
    const frames = Math.ceil((durationMs / 1000) * fps);
    const envelope = Array.from({ length: frames }, (_, f) => {
      const ms = (f / fps) * 1000;
      return words.some((w) => ms >= w.startMs && ms < w.endMs) ? 0.6 : 0;
    });
    return { id: spec.id, file: '', durationMs, speechStartMs: words[0]?.startMs ?? 0, speechEndMs: words[words.length - 1]?.endMs ?? 0, caption, words, envelope };
  });
  return { ...base, lines };
}

/** True when every voiced line of the lesson has a clip whose words match the script. */
export function isVoiced(script: LessonScript, timeline: Timeline): boolean {
  const real = new Map(timeline.lines.map((l) => [l.id, l]));
  return voicedLines(script).every((spec) => {
    const line = real.get(spec.id);
    return Boolean(line && line.file && line.caption === spokenText(spec.text));
  });
}

/**
 * How words are compared: case, punctuation and the kind of apostrophe don't matter, so
 * `c.w("Let's")` finds "Let’s".
 */
export function normWord(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}']/gu, '');
}

/** The frame, relative to the line's start, where the `nth` word matching `match` starts or ends; -1 when it isn't there. */
function wordIn(line: TimelineLine, fps: number, match: string, nth: number, edge: 'start' | 'end'): number {
  const want = normWord(match);
  let seen = 0;
  for (const w of wordFrames(line, fps)) {
    if (normWord(w.text) === want && ++seen === nth) return edge === 'start' ? w.start : w.end;
  }
  return -1;
}

/**
 * The absolute frame where the `nth` word matching `match` starts (or ends), searching the
 * given beats in order. Throws when the word isn't there, so a script edit can't silently
 * desync a cue.
 */
export function findWord(beats: readonly Beat[], fps: number, match: string, { nth = 1, edge = 'start' as 'start' | 'end' } = {}): number {
  let seen = 0;
  const want = normWord(match);
  for (const beat of beats) {
    if (!beat.line) continue;
    const count = beat.line.words.filter((w) => normWord(w.text) === want).length;
    if (seen + count >= nth) return beat.from + wordIn(beat.line, fps, match, nth - seen, edge);
    seen += count;
  }
  const where = beats.map((b) => b.id).join(', ');
  throw new Error(`"${match}" (#${nth}) isn't in ${where || 'these beats'}.`);
}
