import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
// Ray himself, straight from the app, so the video always shows the real character.
import { Ray, RAY_VIEWBOX, type RayMood } from '../../../../src/renderer/src/components/mascot/Ray';
import type { TimelineLine } from '../timing';
import { ease, track, type Ease, type Key } from '../anim';
import { blinkSchedule, bob, clamp, eyesAt, flapSpeed, smoothstep, waveWing, wings } from './rig';
import './ray-video.css';

export type { RayMood };

/** Where Ray is at frame `f`: center x/y in px, scale `s`, extra rotation `r` in degrees. */
export interface RayKey {
  f: number;
  x: number;
  y: number;
  s?: number;
  r?: number;
  /** Easing into this key. */
  e?: Ease;
}

export interface MoodCue {
  f: number;
  mood: RayMood;
  glasses?: boolean;
}

/** A line he says, starting at frame `f` (relative to his sequence). */
export interface Speech {
  f: number;
  line: TimelineLine;
}

export interface RayActorProps {
  keys: readonly RayKey[];
  /** His width in px at scale 1. */
  size: number;
  moods?: readonly MoodCue[];
  speech?: readonly Speech[];
  /** Frames where a wave starts. */
  waves?: readonly number[];
  /** Frames where a happy hop starts. */
  hops?: readonly number[];
  /** Frames where a full roll (a loop-de-loop) starts. */
  rolls?: readonly number[];
  /** Frames where he gets a squish, as when he's petted. */
  squishes?: readonly number[];
  /** Where he looks, -1…1 on each axis. Defaults to the viewer. */
  gaze?: (frame: number) => { x: number; y: number };
  seed?: number;
  /** Overlays drawn with him, in his own box (particles, a bubble). */
  children?: ReactNode;
  style?: CSSProperties;
}

const NO_TALK: ReadonlySet<RayMood> = new Set(['dizzy', 'sleep', 'blow']);
const SPEED_SAMPLE = 3;

function prop(keys: readonly RayKey[], get: (k: RayKey) => number | undefined, fallback: number): Key[] {
  let last = fallback;
  return keys.map((k) => {
    const v = get(k);
    if (v !== undefined) last = v;
    return [k.f, last, k.e ?? ease.inOut] as const;
  });
}

export function RayActor({
  keys,
  size,
  moods = [],
  speech = [],
  waves = [],
  hops = [],
  rolls = [],
  squishes = [],
  gaze,
  seed = 7,
  children,
  style,
}: RayActorProps): JSX.Element {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const tracks = useMemo(
    () => ({
      x: prop(keys, (k) => k.x, keys[0]?.x ?? 0),
      y: prop(keys, (k) => k.y, keys[0]?.y ?? 0),
      s: prop(keys, (k) => k.s, 1),
      r: prop(keys, (k) => k.r, 0),
    }),
    [keys],
  );

  // Speed per frame, in his own widths per second: drives the wingbeat, bank and tail.
  const motion = useMemo(() => {
    const n = durationInFrames + 1;
    const vx: number[] = [];
    const speed: number[] = [];
    for (let f = 0; f < n; f++) {
      const a = Math.max(0, f - SPEED_SAMPLE);
      const b = f + SPEED_SAMPLE;
      const dt = (b - a) / fps;
      const width = size * track(f, tracks.s);
      const dx = (track(b, tracks.x) - track(a, tracks.x)) / dt / width;
      const dy = (track(b, tracks.y) - track(a, tracks.y)) / dt / width;
      vx.push(dx);
      speed.push(Math.hypot(dx, dy));
    }
    const phase: number[] = [0];
    for (let f = 1; f < n; f++) {
      const effort = smoothstep(0.25, 1.6, speed[f - 1]);
      phase.push(phase[f - 1] + flapSpeed(effort) / fps);
    }
    return { vx, speed, phase };
  }, [tracks, size, fps, durationInFrames]);

  const blinks = useMemo(() => blinkSchedule(seed, durationInFrames / fps + 10), [seed, durationInFrames, fps]);

  const f = Math.min(frame, durationInFrames);
  const t = f / fps;
  const x = track(f, tracks.x);
  const y = track(f, tracks.y);
  const s = track(f, tracks.s);
  const extra = track(f, tracks.r);
  const width = size * s;
  const height = (width * RAY_VIEWBOX.h) / RAY_VIEWBOX.w;

  const speed = motion.speed[f] ?? 0;
  const effort = smoothstep(0.25, 1.6, speed);
  const pose = wings(motion.phase[f] ?? 0, effort);
  const lastWave = [...waves].reverse().find((w) => w <= f);
  if (lastWave !== undefined) pose.wingR = waveWing((f - lastWave) / fps, pose.wingR);

  // A ray turns like a glider: he banks into the turn, and his tail swings away from it.
  const vx = motion.vx[f] ?? 0;
  const bank = clamp(vx * 0.09, -0.34, 0.34);
  const steer = clamp(-vx * 11, -30, 30);

  // Hover bob fades out while he swims.
  const bobY = bob(t) * width * (1 - effort);

  let hopY = 0;
  for (const h of hops) {
    const p = (f - h) / (0.52 * fps);
    if (p >= 0 && p <= 1) hopY = -(12 / 110) * width * Math.sin(Math.PI * Math.min(1, p / 0.8)) * (p < 0.8 ? 1 : 0);
  }

  let roll = 0;
  for (const r of rolls) {
    const p = (f - r) / (0.65 * fps);
    if (p >= 0 && p <= 1) roll = -360 * ease.inOut(p);
  }

  let sx = 1;
  let sy = 1;
  for (const q of squishes) {
    const p = (f - q) / (0.42 * fps);
    if (p >= 0 && p <= 1) {
      sx = track(p * 3, [[0, 1], [1, 1.12], [2, 0.95], [3, 1]]);
      sy = track(p * 3, [[0, 1], [1, 0.86], [2, 1.07], [3, 1]]);
    }
  }

  // Mood, and talking: his mouth follows the voice; in a real pause his expression shows.
  const cue = [...moods].reverse().find((m) => m.f <= f);
  const base: RayMood = cue?.mood ?? 'idle';
  let mood: RayMood = base;
  let mouth = 0;
  for (const sp of speech) {
    const i = f - sp.f;
    const env = sp.line.envelope;
    if (i < 0 || i >= env.length) continue;
    let loud = 0;
    for (let k = Math.max(0, i - 4); k <= Math.min(env.length - 1, i + 4); k++) loud = Math.max(loud, env[k]);
    if (loud > 0.08 && !NO_TALK.has(base)) {
      mood = 'talk';
      mouth = env[i];
    }
  }

  const look = gaze ? gaze(f) : { x: 0, y: 0.15 };
  const eyes = eyesAt(t, blinks);

  const vars = {
    width,
    height,
    '--v-wing-l': `${pose.wingL.toFixed(2)}deg`,
    '--v-wing-r': `${pose.wingR.toFixed(2)}deg`,
    '--v-rise': `${pose.rise.toFixed(2)}px`,
    '--v-sway': `${pose.sway.toFixed(2)}deg`,
    '--v-eyes': eyes.toFixed(3),
    '--v-mouth': (0.15 + 0.85 * mouth).toFixed(3),
    '--v-spin': `${(t * 400) % 360}deg`,
    '--ray-steer': `${steer.toFixed(2)}deg`,
    '--ray-lx': look.x.toFixed(3),
    '--ray-ly': (base === 'read' && mood !== 'talk' ? 1 : look.y).toFixed(3),
  } as CSSProperties;

  return (
    <div
      style={{
        position: 'absolute',
        left: x - width / 2,
        top: y - height / 2,
        width,
        height,
        transform: `translateY(${(bobY + hopY).toFixed(2)}px) rotate(${(bank * 57.2958 + extra + roll).toFixed(2)}deg)`,
        transformOrigin: '50% 44%',
        ...style,
      }}
    >
      <div style={{ width: '100%', height: '100%', transform: `scale(${sx}, ${sy})`, transformOrigin: '50% 70%' }}>
        <Ray mood={mood} glasses={cue?.glasses ?? false} blink={false} className="video-ray" style={vars} />
      </div>
      {children}
    </div>
  );
}
