import { Easing, spring } from 'remotion';

export type Ease = (t: number) => number;

export const ease = {
  linear: (t: number) => t,
  inOut: Easing.inOut(Easing.cubic),
  out: Easing.out(Easing.cubic),
  in: Easing.in(Easing.cubic),
  /** Overshoots a little, for things that pop in. */
  back: Easing.out(Easing.back(1.7)),
  quintOut: Easing.out(Easing.poly(5)),
} satisfies Record<string, Ease>;

export const clamp01 = (t: number): number => Math.min(1, Math.max(0, t));

/** A keyframe: at frame `f` the value is `v`; `e` eases the move into this key. */
export type Key = readonly [f: number, v: number, e?: Ease];

/** The value of a keyframed track at `frame`. Before the first key and after the last, it holds. */
export function track(frame: number, keys: readonly Key[]): number {
  if (keys.length === 0) return 0;
  if (frame <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [f1, v1, e = ease.inOut] = keys[i];
    const [f0, v0] = keys[i - 1];
    if (frame <= f1) {
      const t = f1 === f0 ? 1 : (frame - f0) / (f1 - f0);
      return v0 + (v1 - v0) * e(clamp01(t));
    }
  }
  return keys[keys.length - 1][1];
}

/** 0→1 over `duration` frames starting at `from`, eased. */
export function ramp(frame: number, from: number, duration: number, e: Ease = ease.inOut): number {
  return e(clamp01((frame - from) / Math.max(1, duration)));
}

/** 1→0 over `duration` frames ending at `to`. */
export function fadeOut(frame: number, to: number, duration: number, e: Ease = ease.inOut): number {
  return 1 - ramp(frame, to - duration, duration, e);
}

/** A springy 0→1 (with a little overshoot) starting at `from`. */
export function pop(frame: number, fps: number, from: number, damping = 11, mass = 0.7): number {
  return spring({ frame: frame - from, fps, config: { damping, mass, stiffness: 170 } });
}
