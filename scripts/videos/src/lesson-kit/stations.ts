import type { Ease } from '../anim';
import type { RayKey } from '../ray/RayActor';

/**
 * Where Ray likes to be in a lesson, as his center and scale. Scenes can still place him
 * anywhere; these keep his spots consistent from lesson to lesson.
 */
export const STATIONS = {
  /** Front and center, for talking to the viewer. */
  center: { x: 960, y: 500, s: 1 },
  /** Center, smaller, above something on the bottom half. */
  top: { x: 960, y: 250, s: 0.62 },
  /** Beside content on the right half, presenting it. */
  left: { x: 330, y: 560, s: 0.8 },
  /** Beside content on the left half. */
  right: { x: 1590, y: 560, s: 0.8 },
  /** Small in a corner, while a screen or code fills the frame. */
  perchTR: { x: 1760, y: 180, s: 0.46 },
  perchBR: { x: 1765, y: 925, s: 0.46 },
  perchBL: { x: 160, y: 925, s: 0.46 },
  perchTL: { x: 165, y: 185, s: 0.46 },
  /** Just off screen, for entrances and exits. */
  offLeft: { x: -260, y: 560, s: 0.8 },
  offRight: { x: 2180, y: 560, s: 0.8 },
  offBottom: { x: 960, y: 1300, s: 0.8 },
} as const;

export type Station = keyof typeof STATIONS;

/** A key that puts Ray at a station (or a spot) at frame `f`, eased into it. */
export function at(f: number, where: Station | { x: number; y: number; s?: number }, e?: Ease, r?: number): RayKey {
  const spot = typeof where === 'string' ? STATIONS[where] : where;
  return { f, x: spot.x, y: spot.y, s: spot.s, e, r };
}
