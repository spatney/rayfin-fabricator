/**
 * Ray's body mechanics as pure functions of time, mirroring mascot.css and Roamer.tsx in the
 * app: the same wing angles, body rise, tail sway, bob and blink, so he moves in the video
 * the way he moves in Fabricator.
 */

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export const smoothstep = (lo: number, hi: number, v: number): number => {
  const t = clamp((v - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Half a wingbeat (one way), in seconds: idle and swimming, as in mascot.css. */
const FLAP_IDLE = 1.5;
const FLAP_SWIM = 0.42;

/** Angular speed of the wingbeat for an effort between 0 (idle) and 1 (swimming). */
export function flapSpeed(effort: number): number {
  const half = lerp(FLAP_IDLE, FLAP_SWIM, clamp(effort, 0, 1));
  return Math.PI / half;
}

export interface WingPose {
  wingL: number;
  wingR: number;
  rise: number;
  sway: number;
}

/**
 * Wings, body and tail for a wingbeat phase (radians). Effort deepens the beat as it does
 * while he swims: lift 8°→15°, beat 6°→11°.
 */
export function wings(phase: number, effort: number): WingPose {
  const e = clamp(effort, 0, 1);
  const lift = lerp(8, 15, e);
  const beat = lerp(6, 11, e);
  const w = (1 - Math.cos(phase)) / 2;
  const left = lift - (lift + beat) * w;
  const tail = (1 - Math.cos(phase / 1.4)) / 2;
  return { wingL: left, wingR: -left, rise: 1.5 - 3 * w, sway: -7 + 14 * tail };
}

/** His right wing during a hello: five quick beats over 1.3 s, blended in and out. */
export function waveWing(t: number, flapAngle: number): number {
  if (t < 0 || t > 1.3) return flapAngle;
  const p = t / 1.3;
  const beat = 5 - 25 * ((1 - Math.cos(Math.PI * 5 * p)) / 2);
  const blend = smoothstep(0, 0.08, p) * (1 - smoothstep(0.88, 1, p));
  return lerp(flapAngle, beat, blend);
}

/** A small deterministic random generator, so every render draws the same blinks. */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

/** Blink times (s) for `duration` seconds: 2.2–6.4 s apart, sometimes a double blink. */
export function blinkSchedule(seed: number, duration: number): number[] {
  const random = rng(seed);
  const times: number[] = [];
  let t = 1.4 + random() * 2.6;
  while (t < duration) {
    times.push(t);
    t += random() < 0.14 ? 0.17 + 0.12 : 2.2 + random() * 4.2;
  }
  return times;
}

/** Eye openness (1 open, 0.1 shut) at time t for a blink schedule; a blink lasts 0.12 s. */
export function eyesAt(t: number, blinks: readonly number[]): number {
  for (const b of blinks) {
    const d = t - b;
    if (d >= 0 && d <= 0.12) {
      const p = d / 0.12;
      const shut = p < 0.4 ? p / 0.4 : 1 - (p - 0.4) / 0.6;
      return lerp(1, 0.1, shut);
    }
  }
  return 1;
}

/** The gentle bob he does while hovering, in his own widths (mascotBob: -3px…4px at ~110px). */
export function bob(t: number): number {
  const p = (1 - Math.cos((Math.PI * t) / 2.8)) / 2;
  return lerp(-3, 4, p) / 110;
}
