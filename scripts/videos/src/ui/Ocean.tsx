import { useMemo } from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { rng } from '../ray/rig';
import { H, W, useTheme } from '../theme';

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

/** Two sets of wavy lines that cross, like the net of light the sun throws through shallow water. */
const RIPPLES = (() => {
  const random = rng(42);
  return [
    { angle: 16, gap: 70 },
    { angle: -27, gap: 82 },
  ].flatMap(({ angle, gap }) => {
    const a = (angle * Math.PI) / 180;
    return Array.from({ length: 24 }, (_, i) => ({
      along: [Math.cos(a), Math.sin(a)] as const,
      across: [-Math.sin(a), Math.cos(a)] as const,
      offset: (i - 11.5) * gap + (random() - 0.5) * gap * 0.5,
      amp: 10 + random() * 16,
      wave: 0.006 + random() * 0.008,
      wave2: 0.017 + random() * 0.012,
      speed: (random() < 0.5 ? -1 : 1) * (0.5 + random() * 0.6),
      phase: random() * Math.PI * 2,
      shimmer: random() * Math.PI * 2,
    }));
  });
})();

function Ripples({ t, strength }: { t: number; strength: number }): JSX.Element {
  const steps = 48;
  const half = 1300;
  return (
    <svg
      width={W}
      height={H}
      style={{
        position: 'absolute',
        inset: 0,
        opacity: strength,
        filter: 'blur(1.4px)',
        maskImage: 'linear-gradient(180deg, black 0%, rgba(0,0,0,0.6) 30%, transparent 62%)',
      }}
    >
      {RIPPLES.map((r, i) => {
        const ox = W / 2 + r.across[0] * r.offset;
        const oy = 120 + r.across[1] * r.offset;
        let d = '';
        for (let k = 0; k <= steps; k++) {
          const u = -half + (k / steps) * 2 * half;
          const w = r.amp * (Math.sin(u * r.wave + t * r.speed + r.phase) + 0.45 * Math.sin(u * r.wave2 - t * r.speed * 1.6 + r.phase * 2));
          const x = ox + r.along[0] * u + r.across[0] * w;
          const y = oy + r.along[1] * u + r.across[1] * w;
          d += `${k ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
        }
        return <path key={i} d={d} fill="none" stroke="#ffffff" strokeWidth={2.6} strokeLinejoin="round" opacity={0.55 + 0.45 * Math.sin(t * 0.8 + r.shimmer)} />;
      })}
    </svg>
  );
}

interface OceanProps {
  /** 0…1: calms the water so busy screens in front of it read clearly. */
  dim?: number;
}

/**
 * The water Ray swims in: the docs site's grid with its charge pulses, under light from the
 * surface, with bubbles drifting up. Deep blue in the dark cut; sunlit shallows, with the
 * light rippling near the surface, in the light one. Every motion is a function of the frame.
 */
export function Ocean({ dim = 0 }: OceanProps): JSX.Element {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const water = useTheme().water;
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
    <AbsoluteFill style={{ overflow: 'hidden', background: water.background }}>
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
              background: water.shafts,
              transform: `skewX(${-16 + i * 3}deg)`,
              opacity: 0.6 + 0.4 * Math.sin(t * 0.5 + i),
            }}
          />
        );
      })}
      {water.caustics > 0 ? <Ripples t={t} strength={water.caustics} /> : null}

      {/* The grid, drifting slowly. */}
      <AbsoluteFill
        style={{
          backgroundImage: `linear-gradient(to right, ${water.grid} 1px, transparent 1px), linear-gradient(to bottom, ${water.grid} 1px, transparent 1px)`,
          backgroundSize: `${GRID}px ${GRID}px`,
          backgroundPosition: `${W / 2}px ${drift}px`,
          maskImage: 'radial-gradient(ellipse 75% 80% at 50% 30%, black, transparent)',
        }}
      />
      <AbsoluteFill
        style={{
          backgroundImage: `linear-gradient(to right, ${water.charge} 1px, transparent 1px), linear-gradient(to bottom, ${water.charge} 1px, transparent 1px)`,
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
              background: water.pulse,
              boxShadow: water.pulseGlow,
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
              border: `1.5px solid ${water.bubbleRing}`,
              background: water.bubbleFill,
              opacity: b.alpha,
            }}
          />
        );
      })}

      <AbsoluteFill style={{ background: water.vignette }} />
      {dim > 0 ? <AbsoluteFill style={{ background: water.calm(dim) }} /> : null}
    </AbsoluteFill>
  );
}
