import type { MoodCue, RayKey } from '../ray/RayActor';
import { track } from '../anim';
import type { SceneId, Span, TimelineLine } from '../timing';

/** Ids of the clips in public/audio/sfx (see tools/sfx.mjs). */
export type SfxId =
  | 'swim-whoosh'
  | 'bubbles'
  | 'boing'
  | 'dizzy'
  | 'thud'
  | 'sweep'
  | 'typing'
  | 'click'
  | 'chime'
  | 'confetti'
  | 'rewind'
  | 'stamp'
  | 'pop'
  | 'shimmer';

export interface SfxCue {
  /** Scene-relative frame. */
  f: number;
  id: SfxId;
  volume?: number;
  /** Frames to play; the whole clip when omitted. */
  duration?: number;
}

export interface SceneCtx {
  id: SceneId;
  line: TimelineLine;
  /** Frame (scene-relative) where the line starts. */
  lead: number;
  /** The scene on the video's timeline, in absolute frames. */
  span: Span;
  fps: number;
  /** Scene-relative frame where the `nth` match of `word` starts. */
  w: (word: string, nth?: number) => number;
  /** Scene-relative frame where it ends. */
  wEnd: (word: string, nth?: number) => number;
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

export interface SceneDef {
  id: SceneId;
  View: (props: { ctx: SceneCtx }) => JSX.Element;
  ray: (ctx: SceneCtx) => RayPart;
  sfx?: (ctx: SceneCtx) => SfxCue[];
}

/** Ray's center at a frame of a scene, for aiming particles at him. */
export function rayAt(keys: readonly RayKey[], f: number): { x: number; y: number; s: number } {
  let s = 1;
  const sKeys = keys.map((k) => {
    if (k.s !== undefined) s = k.s;
    return [k.f, s, k.e] as const;
  });
  return {
    x: track(f, keys.map((k) => [k.f, k.x, k.e] as const)),
    y: track(f, keys.map((k) => [k.f, k.y, k.e] as const)),
    s: track(f, sKeys),
  };
}

/** Ray's width at scale 1. */
export const RAY_SIZE = 400;
