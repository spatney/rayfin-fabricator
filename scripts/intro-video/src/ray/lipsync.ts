/**
 * Ray's lip sync: the shape of his mouth on every frame of a line, from its word timings and
 * its loudness. Pure and React-free, so tools/lipsync.test.mjs can check it.
 *
 * timeline.json has each word's start and end but not its letters', so a word's letters are
 * spread across its span, vowels held longer than consonants, and each sound picks one of a
 * few mouth shapes (visemes). Lips meet for m, b and p, and stay shut for at least two frames
 * so it reads. The mouth moves a couple of frames ahead of the sound, as animators time it,
 * and rests in any pause longer than about 120 ms. Loudness opens it wider on stressed words.
 */
import type { RayMood } from './RayActor';
import type { TimelineLine } from '../timing';

export type Viseme = 'rest' | 'closed' | 'open' | 'wide' | 'mid' | 'round' | 'teeth';

/**
 * A mouth, in the units of Ray's drawing (Ray.tsx: 160 × 128, mouth at RAY_MOUTH, 80 × 55).
 * The lips meet along a curve through (80, 55 + y); its corners sit `smile` higher (lower, for
 * a frown), and the mouth opens `top` above and `bottom` below it.
 */
export interface MouthShape {
  /** Half the mouth's width. */
  w: number;
  y: number;
  top: number;
  bottom: number;
  smile: number;
  /** 0…1: the tongue of his happy grin. */
  tongue: number;
}

const shape = (w: number, y: number, top: number, bottom: number, smile: number, tongue = 0): MouthShape => ({ w, y, top, bottom, smile, tongue });

/**
 * Each mood's mouth when he's quiet: the app's own mouths (Ray.tsx's Mouth), drawn the same
 * way as the visemes so he can ease from one to the other. Dizzy keeps the app's wavy mouth.
 */
export const MOOD_MOUTH: Record<RayMood, MouthShape | null> = {
  idle: shape(6.5, 1.25, 0, 0, 2.75),
  talk: shape(4, 0, 1.1, 1.1, 0),
  happy: shape(7.5, 1, 4, 2.25, 4, 1),
  love: shape(7.5, 1, 4, 2.25, 4, 1),
  surprised: shape(3.5, 0.5, 3.8, 3.8, 0),
  blow: shape(3.5, 0.5, 3.8, 3.8, 0),
  sleep: shape(4.5, 1, 0, 0, 1),
  read: shape(4.5, 1, 0, 0, 1),
  worried: shape(5.5, 0, 0, 0, -2.5),
  dizzy: null,
};

/** The talking shapes, before mood and loudness shape them. */
const VISEME: Record<Exclude<Viseme, 'rest'>, MouthShape> = {
  /** m, b, p: lips pressed together. */
  closed: shape(5.4, 1, 0, 0, 1.6),
  /** a: open wide, jaw down. */
  open: shape(5.8, 1, 2.4, 6.4, 0.8),
  /** e, i, y: spread. */
  wide: shape(7.2, 1, 1.5, 3.6, 1.8),
  /** Most consonants: barely open. */
  mid: shape(6.2, 1, 1, 2.4, 1.4),
  /** o, u, w, oo, sh: rounded and pursed. */
  round: shape(3.4, 1, 3.2, 3.8, 0),
  /** f, v: lip tucked under the teeth. */
  teeth: shape(5.8, 1, 0.4, 1.6, 1),
};

/** Frames the mouth moves ahead of the sound. */
export const LEAD = 2;
/** A gap between words longer than this is a pause, and the mouth rests. */
const PAUSE_MS = 120;
/** Below this loudness (0…1) the voice is silent. */
const SILENT = 0.04;

interface Sound {
  v: Viseme;
  /** How long it's held, relative to the word's other sounds. */
  weight: number;
}

/** Spellings read as one sound, longest first. */
const GROUPS: ReadonlyArray<readonly [string, Viseme, number]> = [
  ['ough', 'round', 2],
  ['igh', 'wide', 2],
  ['oo', 'round', 2.2],
  ['ou', 'round', 2.2],
  ['ow', 'round', 2],
  ['ew', 'round', 2],
  ['ue', 'round', 2],
  ['oa', 'round', 2],
  ['au', 'open', 2],
  ['aw', 'open', 2],
  ['ee', 'wide', 2.2],
  ['ea', 'wide', 2.2],
  ['ai', 'wide', 2],
  ['ay', 'wide', 2],
  ['ey', 'wide', 2],
  ['ie', 'wide', 2],
  ['th', 'mid', 1],
  ['sh', 'round', 1.2],
  ['ch', 'round', 1.2],
  ['ph', 'teeth', 1],
  ['wh', 'round', 1],
  ['qu', 'round', 1.4],
  ['ck', 'mid', 1],
  ['ng', 'mid', 1],
];

const LETTER: Record<string, Sound> = {
  a: { v: 'open', weight: 2 },
  e: { v: 'wide', weight: 1.8 },
  i: { v: 'wide', weight: 1.8 },
  o: { v: 'round', weight: 2 },
  u: { v: 'open', weight: 1.8 },
  y: { v: 'wide', weight: 1.5 },
  m: { v: 'closed', weight: 1 },
  b: { v: 'closed', weight: 1 },
  p: { v: 'closed', weight: 1 },
  f: { v: 'teeth', weight: 1 },
  v: { v: 'teeth', weight: 1 },
  w: { v: 'round', weight: 1.1 },
  h: { v: 'mid', weight: 0.6 },
};

/** A word's sounds, read from its spelling: English is irregular, but a cartoon needs little. */
export function soundsOf(word: string): Sound[] {
  let s = word.toLowerCase().replace(/[^a-z]/g, '');
  // Silent letters: a final e after a consonant ("make"), kn and wr at the start.
  if (s.length > 3 && s.endsWith('e') && !/[aeiouy]e$/.test(s)) s = s.slice(0, -1);
  s = s.replace(/^kn/, 'n').replace(/^wr/, 'r');
  const sounds: Sound[] = [];
  for (let i = 0; i < s.length; ) {
    const group = GROUPS.find(([g]) => s.startsWith(g, i));
    if (group) {
      sounds.push({ v: group[1], weight: group[2] });
      i += group[0].length;
      continue;
    }
    sounds.push(LETTER[s[i]] ?? { v: 'mid', weight: 1 });
    i++;
  }
  return sounds;
}

export interface LipTrack {
  /** The track's first frame, relative to the line's start: negative, since it leads the sound. */
  start: number;
  /** The shape to aim for on each frame from `start`; 'rest' in pauses. */
  visemes: Viseme[];
  /** How loud the voice is at the sound each frame shows, 0…1. */
  loud: number[];
}

/** The mouth shapes for a line, frame by frame. */
export function lipTrack(line: TimelineLine, fps: number): LipTrack {
  const env = line.envelope;
  const level = (f: number) => env[Math.min(env.length - 1, Math.max(0, Math.round(f)))] ?? 0;
  const toFrame = (ms: number) => (ms / 1000) * fps;
  const words = line.words.filter((w) => /[\p{L}\p{N}]/u.test(w.text));
  const last = words.length ? toFrame(words[words.length - 1].endMs) : 0;
  const start = -LEAD - 1;
  const length = Math.ceil(last) + LEAD + 4 - start;
  const visemes: Viseme[] = new Array(length).fill('rest');
  const at = (f: number) => Math.round(f) - LEAD - start;
  // Fills frames [from, to), never before `pos`, so a closure's frames can't be overwritten.
  let pos = 0;
  const fill = (from: number, to: number, v: Viseme) => {
    const a = Math.max(pos, from);
    for (let i = Math.max(0, a); i < Math.min(length, to); i++) visemes[i] = v;
    pos = Math.max(pos, to);
  };

  words.forEach((word, n) => {
    const from = toFrame(word.startMs);
    // A word's end can run into the silence after it; end it where the voice falls quiet.
    let to = toFrame(word.endMs);
    while (to - 1 > from + 1 && level(to - 1) < SILENT) to--;
    const sounds = soundsOf(word.text);
    const total = sounds.reduce((sum, s) => sum + s.weight, 0) || 1;
    let t = from;
    for (const sound of sounds) {
      const end = t + ((to - from) * sound.weight) / total;
      const a = Math.max(pos, at(t));
      fill(a, sound.v === 'closed' ? Math.max(at(end), a + 2) : at(end), sound.v);
      t = end;
    }
    // Between words: hold the last sound through a short gap, rest through a pause.
    const next = words[n + 1];
    if (next && next.startMs - word.endMs <= PAUSE_MS) fill(at(to), at(toFrame(next.startMs)), visemes[pos - 1] ?? 'mid');
  });

  // Where the voice is silent for longer than a pause, rest whatever the timings say.
  const quiet = Math.round(toFrame(PAUSE_MS));
  const loud: number[] = [];
  let run = 0;
  for (let i = 0; i < length; i++) {
    const f = i + start + LEAD;
    loud.push(Math.max(level(f - 1), level(f), level(f + 1)));
    run = level(f) < SILENT ? run + 1 : 0;
    if (run === quiet) for (let k = i - run + 1; k <= i; k++) visemes[k] = 'rest';
    else if (run > quiet) visemes[i] = 'rest';
  }
  return { start, visemes, loud };
}

/** A talking shape in a mood, opened wider the louder he speaks. */
export function voiced(v: Exclude<Viseme, 'rest'>, mood: RayMood, loud: number): MouthShape {
  const base = VISEME[v];
  const open = Math.min(1.2, Math.max(0.5, 0.5 + 0.7 * loud));
  // Moods bend the corners less on a narrow, rounded mouth.
  const bend = Math.min(1, base.w / 7);
  let { w, smile, top, bottom } = base;
  top *= open;
  bottom *= open;
  if (mood === 'happy' || mood === 'love') {
    smile += 1.2 * bend;
    w += 0.3;
  } else if (mood === 'worried') {
    smile -= 2.2 * bend;
    w -= 0.3;
  } else if (mood === 'surprised') {
    top *= 1.15;
    bottom *= 1.15;
    w -= 0.4;
  }
  return { ...base, w, smile, top, bottom };
}

/**
 * One frame's step from shape to shape: quick to close (lips meet within two frames), a little
 * slower to open, so nothing flickers for a single frame.
 */
export function settle(from: MouthShape, to: MouthShape): MouthShape {
  const k = openness(to) === 0 && to.tongue === 0 ? 0.85 : openness(to) < openness(from) ? 0.7 : 0.6;
  const mix = (a: number, b: number) => a + (b - a) * k;
  return { w: mix(from.w, to.w), y: mix(from.y, to.y), top: mix(from.top, to.top), bottom: mix(from.bottom, to.bottom), smile: mix(from.smile, to.smile), tongue: mix(from.tongue, to.tongue) };
}

/** How far the mouth is open. */
export function openness(m: MouthShape): number {
  return m.top + m.bottom;
}
