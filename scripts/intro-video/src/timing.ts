/**
 * Where everything sits in time. Pure and React-free: the scenes use it, and so does
 * tools/publish.mjs (through Node's type stripping) to place the captions exactly where
 * the voice is.
 *
 * Each line of the voiceover belongs to the scene of the same id. Lines play one after
 * another with a gap before each; a gap splits into the previous scene's tail and the next
 * scene's lead-in. Scenes overlap by OVERLAP frames so the next one can transition in.
 */

export interface Word {
  text: string;
  startMs: number;
  endMs: number;
}

export interface TimelineLine {
  id: string;
  file: string;
  durationMs: number;
  speechStartMs: number;
  speechEndMs: number;
  caption: string;
  words: Word[];
  /** Mouth openness per video frame, 0…1. */
  envelope: number[];
}

export interface Timeline {
  fps: number;
  tempo: number;
  voice: { name: string; voiceId: string; modelId: string; seed: number };
  lines: TimelineLine[];
}

export const SCENE_IDS = [
  'hello',
  'old-way',
  'one-window',
  'fabric',
  'backend',
  'describe',
  'preview',
  'ship',
  'tricks',
  'outro',
  'stinger',
] as const;

export type SceneId = (typeof SCENE_IDS)[number];

/** Seconds of quiet before each line: room for a gag, a title or a breath. */
export const GAP_BEFORE: Record<SceneId, number> = {
  hello: 0.8,
  'old-way': 0.35,
  'one-window': 0.6,
  fabric: 0.45,
  backend: 0.35,
  describe: 0.9,
  preview: 0.8,
  ship: 0.8,
  tricks: 0.5,
  outro: 0.6,
  stinger: 1.2,
};

/** How much of that gap is the next scene's lead-in (the rest is the previous scene's tail). */
export const LEAD: Record<SceneId, number> = {
  hello: 0.8,
  'old-way': 0.25,
  'one-window': 0.45,
  fabric: 0.3,
  backend: 0.2,
  describe: 0.75,
  preview: 0.65,
  ship: 0.65,
  tricks: 0.3,
  outro: 0.45,
  stinger: 0.5,
};

/** Seconds the picture holds after the last line: Ray swims back to the end card and waves. */
export const END_HOLD = 2.0;
/** Frames each scene keeps running under the next one's entrance. */
export const OVERLAP = 10;

export interface Span {
  from: number;
  duration: number;
}

export interface Layout {
  fps: number;
  total: number;
  /** Where each line's audio starts and how long it plays, in frames. */
  lines: Record<string, Span>;
  /** Each scene, including its overlap with the next. */
  scenes: Record<string, Span>;
  /** Each scene's lead-in: frames from the scene's start to its line. */
  leads: Record<string, number>;
}

export function layout(timeline: Timeline): Layout {
  const fps = timeline.fps;
  const byId = new Map(timeline.lines.map((l) => [l.id, l]));
  const toFrames = (s: number) => Math.round(s * fps);

  const lines: Record<string, Span> = {};
  const leads: Record<string, number> = {};
  let cursor = 0;
  for (const id of SCENE_IDS) {
    const line = byId.get(id);
    if (!line) throw new Error(`timeline.json has no line "${id}". Run npm run voice.`);
    cursor += toFrames(GAP_BEFORE[id]);
    const duration = Math.ceil((line.durationMs / 1000) * fps);
    lines[id] = { from: cursor, duration };
    leads[id] = toFrames(LEAD[id]);
    cursor += duration;
  }
  const total = cursor + toFrames(END_HOLD);

  const scenes: Record<string, Span> = {};
  SCENE_IDS.forEach((id, i) => {
    const from = Math.max(0, lines[id].from - leads[id]);
    const next = SCENE_IDS[i + 1];
    const end = next ? lines[next].from - leads[next] + OVERLAP : total;
    scenes[id] = { from, duration: end - from };
  });
  return { fps, total, lines, scenes, leads };
}

/** A line's words with their start and end in frames, relative to the line's start. */
export function wordFrames(line: TimelineLine, fps: number): Array<{ text: string; start: number; end: number }> {
  return line.words.map((w) => ({
    text: w.text,
    start: Math.round((w.startMs / 1000) * fps),
    end: Math.round((w.endMs / 1000) * fps),
  }));
}

/**
 * The frame, relative to the line's start, where the `nth` word matching `match` begins
 * (or ends). Matching ignores case and punctuation. Throws when the word isn't in the line,
 * so a script edit can't silently desync a cue.
 */
export function wordAt(line: TimelineLine, fps: number, match: string, { nth = 1, edge = 'start' as 'start' | 'end' } = {}): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
  const want = norm(match);
  let seen = 0;
  for (const w of wordFrames(line, fps)) {
    if (norm(w.text) === want && ++seen === nth) return edge === 'start' ? w.start : w.end;
  }
  throw new Error(`"${match}" (#${nth}) isn't in line "${line.id}".`);
}
