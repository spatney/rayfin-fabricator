import type { MoodCue, RayKey } from '../ray/RayActor';
import type { SfxId as IntroSfxId } from '../scenes/types';
import type { Span, Timeline, TimelineLine } from '../timing';
import type { LessonScript } from './plan';
import type { YouTubeSpec } from './youtube';

/** Ids of the clips in public/audio/sfx: the intro's, and the lessons' own (see tools/sfx.mjs). */
export type SfxId = IntroSfxId | 'jingle' | 'dive' | 'surface' | 'tick' | 'correct' | 'sonar';

export interface SfxCue {
  /** Scene-relative frame. */
  f: number;
  id: SfxId;
  volume?: number;
  /** Frames to play; the whole clip when omitted. */
  duration?: number;
}

/** A beat as a scene sees it: scene-relative frames (negative before the scene starts). */
export interface BeatSpan {
  from: number;
  to: number;
  line?: TimelineLine;
}

export interface LessonCtx {
  id: string;
  /** The scene on the video's timeline, in absolute frames. */
  span: Span;
  fps: number;
  /** Scene-relative frame where the scene's first beat starts. */
  lead: number;
  /** Any beat of the lesson, by id. */
  beat: (id: string) => BeatSpan;
  /** Scene-relative frame where the `nth` match of `word` starts, searching this scene's lines in order. */
  w: (word: string, nth?: number) => number;
  /** Scene-relative frame where it ends. */
  wEnd: (word: string, nth?: number) => number;
  /** Where `word` starts in one line of the lesson, any scene's, scene-relative. */
  at: (lineId: string, word: string, nth?: number) => number;
  /** Where it ends. */
  atEnd: (lineId: string, word: string, nth?: number) => number;
}

/** Ray's part in a scene, in scene-relative frames. Scenes hand him over to each other. */
export interface RayPart {
  keys: RayKey[];
  moods?: MoodCue[];
  waves?: number[];
  hops?: number[];
  rolls?: number[];
  squishes?: number[];
  /** Where he looks: [frame, x, y], each -1…1. */
  gaze?: Array<readonly [number, number, number]>;
}

export interface LessonScene {
  /** The id of its scene in script.ts. */
  id: string;
  View: (props: { ctx: LessonCtx }) => JSX.Element | null;
  ray: (ctx: LessonCtx) => RayPart;
  sfx?: (ctx: LessonCtx) => SfxCue[];
  /** How deep the water is, 0 (near the surface) … 1 (the deep): the Deep Dive darkens it. */
  depth?: number;
  /** How much the water calms behind busy screens, 0…1. */
  dim?: number;
  /** The music bed's level in this scene, as a multiple: 0 silences it, as under the jingle. */
  bed?: number;
}

/** Everything a lesson's video is made from. */
export interface Episode {
  script: LessonScript;
  /** The voiced timeline (lessons/<slug>/timeline.json), drafted where lines aren't voiced yet. */
  timeline: Timeline;
  scenes: readonly LessonScene[];
}

/** A lesson, as lessons/index.ts registers it. */
export interface Lesson {
  episode: Episode;
  youtube: YouTubeSpec;
  /** True when every line has its real voice clip; otherwise the draft timings stand in. */
  voiced: boolean;
}
