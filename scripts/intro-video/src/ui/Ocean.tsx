import { useMemo } from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { rng } from '../ray/rig';
import { C, H, W } from '../theme';

/** Circuit-like routes on the grid, like the landing page's flowing pulses. */
const ROUTES: ReadonlyArray<{ points: ReadonlyArray<readonly [number, number]>; dur: number; delay: number }> = [
  { points: [[448, -80], [448, 256], [704, 256], [704, 1160]], dur: 9, delay: 0 },
  { points: [[1472, -80], [1472, 384], [1216, 384], [1216, 1160]], dur: 11, delay: 2.5 },
  { points: [[192, -80], [192, 192], [576, 192], [576, 576], [960, 576], [960, 1160]], dur: 15, delay: 5 },
  { points: [[1792, -80], [1792, 320], [1600, 320], [1600, 1160]], dur: 10, delay: 7.5 },
  { points: [[1024, -80], [1024, 448], [384, 448], [384, 1160]], dur: 13, delay: 3.8 },
  { points: [[-80, 832], [640, 832], [640, 704], [2000, 704]], dur: 12, delay: 6.2 },
];

const GRID = 64;

function along(points: ReadonlyArray<readonly [number, number]>, p: number) {
  const segs = points.slice(1).map((b, i) => {
    const a = points[i];
    return { a, b, len: Math.hypot(b[0] - a[0], b[1] - a[1]) };
  });
  const total = segs.reduce((n, s) => n + s.len, 0);
  let d = p * total;
  for (const s of segs) {
    if (d <= s.len) {
      const t = d / s.len;
      return {
        x: s.a[0] + (s.b[0] - s.a[0]) * t,
        y: s.a[1] + (s.b[1] - s.a[1]) * t,
        angle: (Math.atan2(s.b[1] - s.a[1], s.b[0] - s.a[0]) * 180) / Math.PI,
      };
    }
    d -= s.len;
  }
  const last = points[points.length - 1];
  return { x: last[0], y: last[1], angle: 90 };
}

interface OceanProps {
  /** 0…1: darkens the water so busy screens in front of it read clearly. */
  dim?: number;
}

/**
 * The water Ray swims in: the docs site's grid with its charge pulses, under deep-blue light
 * rays, with bubbles drifting up. Every motion is a function of the frame.
 */
export function Ocean({ dim = 0 }: OceanProps): JSX.Element {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  const bubbles = useMemo(() => {
    const random = rng(99);
    return Array.from({ length: 28 }, () => ({
      x: random() * W,
      y0: random() * (H + 80),
      size: 4 + random() * 12,
      speed: 26 + random() * 46,
      wobble: 6 + random() * 14,
      phase: random() * Math.PI * 2,
      alpha: 0.25 + random() * 0.45,
    }));
  }, []);

  const drift = (t * 6) % GRID;

  return (
    <AbsoluteFill style={{ overflow: 'hidden', background: 'radial-gradient(ellipse 85% 75% at 50% -5%, #123456 0%, #0b1a2d 42%, #070b12 100%)' }}>
      {/* Light from the surface. */}
      {[0, 1, 2, 3, 4].map((i) => {
        const sway = Math.sin(t * 0.35 + i * 1.7) * 40;
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              top: -200,
              left: 180 + i * 360 + sway,
              width: 150 + (i % 3) * 70,
              height: H + 400,
              background: 'linear-gradient(180deg, rgba(140,210,255,0.10), rgba(140,210,255,0.025) 55%, transparent 80%)',
              transform: `skewX(${-16 + i * 3}deg)`,
              opacity: 0.6 + 0.4 * Math.sin(t * 0.5 + i),
            }}
          />
        );
      })}

      {/* The grid, drifting slowly. */}
      <AbsoluteFill
        style={{
          backgroundImage:
            'linear-gradient(to right, rgba(120,170,220,0.075) 1px, transparent 1px), linear-gradient(to bottom, rgba(120,170,220,0.075) 1px, transparent 1px)',
          backgroundSize: `${GRID}px ${GRID}px`,
          backgroundPosition: `${W / 2}px ${drift}px`,
          maskImage: 'radial-gradient(ellipse 75% 80% at 50% 30%, black, transparent)',
        }}
      />
      <AbsoluteFill
        style={{
          backgroundImage: `linear-gradient(to right, ${C.accent}55 1px, transparent 1px), linear-gradient(to bottom, ${C.accent}55 1px, transparent 1px)`,
          backgroundSize: `${GRID}px ${GRID}px`,
          backgroundPosition: `${W / 2}px ${drift}px`,
          maskImage: 'radial-gradient(ellipse 34% 48% at 50% 18%, black, transparent 72%)',
          opacity: 0.25 + 0.2 * (0.5 + 0.5 * Math.sin((t / 7) * Math.PI * 2)),
        }}
      />

      {/* Charge pulses along the grid. */}
      {ROUTES.map((route, i) => {
        const p = ((t + route.delay) / route.dur) % 1;
        const fade = p < 0.08 ? p / 0.08 : p > 0.88 ? (1 - p) / 0.12 : 1;
        const at = along(route.points, p);
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: at.x - 70,
              top: at.y - 1.5,
              width: 70,
              height: 3,
              borderRadius: 2,
              transformOrigin: '100% 50%',
              transform: `rotate(${at.angle}deg)`,
              background: `linear-gradient(to right, transparent, ${C.accent2}22 45%, ${C.accent2}99 80%, #c9fff1)`,
              boxShadow: `0 0 12px ${C.accent2}88`,
              opacity: fade,
            }}
          />
        );
      })}

      {/* Bubbles drifting up. */}
      {bubbles.map((b, i) => {
        const y = ((((b.y0 - b.speed * t) % (H + 80)) + H + 80) % (H + 80)) - 40;
        const x = b.x + Math.sin(t * 1.3 + b.phase) * b.wobble;
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: x,
              top: y,
              width: b.size,
              height: b.size,
              borderRadius: '50%',
              border: `1.5px solid ${C.bubble}`,
              background: 'rgba(127,216,238,0.10)',
              opacity: b.alpha,
            }}
          />
        );
      })}

      <AbsoluteFill style={{ background: 'radial-gradient(ellipse 75% 70% at 50% 45%, transparent 55%, rgba(0,0,0,0.55))' }} />
      {dim > 0 ? <AbsoluteFill style={{ background: `rgba(4,8,14,${dim})` }} /> : null}
    </AbsoluteFill>
  );
}
