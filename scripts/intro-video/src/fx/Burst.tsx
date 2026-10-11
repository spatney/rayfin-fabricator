import { useMemo } from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import { rng } from '../ray/rig';
import { useTheme } from '../theme';

export type BurstKind = 'bubbles' | 'confetti' | 'hearts' | 'sparkles';

const LIFE: Record<BurstKind, number> = { bubbles: 1.6, confetti: 2.2, hearts: 1.5, sparkles: 1.1 };

interface Particle {
  dx: number;
  dy: number;
  size: number;
  rot: number;
  spin: number;
  delay: number;
  color: string;
  wobble: number;
}

interface BurstProps {
  kind: BurstKind;
  /** Frame (in the current sequence) it starts. */
  at: number;
  x: number;
  y: number;
  count?: number;
  seed?: number;
  /** Multiplies how far particles travel. */
  spread?: number;
}

/** A one-off burst of particles, the same on every render. */
export function Burst({ kind, at, x, y, count = 12, seed = 1, spread = 1 }: BurstProps): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  const confetti = C.confetti;
  const parts = useMemo<Particle[]>(() => {
    const random = rng(seed * 7919 + count);
    return Array.from({ length: count }, (_, i) => {
      const a = kind === 'confetti' ? -Math.PI / 2 + (random() - 0.5) * 2.4 : (random() - 0.5) * 1.6 - Math.PI / 2;
      const power = kind === 'confetti' ? 380 + random() * 420 : kind === 'sparkles' ? 60 + random() * 120 : 120 + random() * 160;
      return {
        dx: Math.cos(a) * power * spread * (kind === 'sparkles' ? (random() < 0.5 ? -1 : 1) : 1),
        dy: Math.sin(a) * power * spread,
        size: kind === 'confetti' ? 10 + random() * 10 : kind === 'hearts' ? 26 + random() * 18 : kind === 'sparkles' ? 14 + random() * 16 : 10 + random() * 16,
        rot: random() * 360,
        spin: (random() - 0.5) * 900,
        delay: kind === 'bubbles' ? i * 0.05 + random() * 0.15 : random() * 0.12,
        color: confetti[Math.floor(random() * confetti.length)],
        wobble: random() * Math.PI * 2,
      };
    });
  }, [kind, count, seed, spread, confetti]);

  const age = (frame - at) / fps;
  if (age < 0 || age > LIFE[kind] + 0.4) return null;

  return (
    <div style={{ position: 'absolute', left: x, top: y, width: 0, height: 0, pointerEvents: 'none' }}>
      {parts.map((p, i) => {
        const t = age - p.delay;
        if (t < 0) return null;
        const life = LIFE[kind];
        const k = t / life;
        if (k > 1) return null;
        let px = 0;
        let py = 0;
        let opacity = 1;
        let scale = 1;
        let content: JSX.Element;
        switch (kind) {
          case 'confetti': {
            px = p.dx * (1 - Math.exp(-3 * t)) / 1.6;
            py = (p.dy * (1 - Math.exp(-3 * t))) / 1.6 + 420 * t * t;
            opacity = k < 0.75 ? 1 : 1 - (k - 0.75) / 0.25;
            content = (
              <div style={{ width: p.size, height: p.size * 0.55, background: p.color, borderRadius: 2, transform: `rotate(${p.rot + p.spin * t}deg) rotateX(${t * 720}deg)` }} />
            );
            break;
          }
          case 'hearts': {
            px = p.dx * 0.35 * k + Math.sin(t * 6 + p.wobble) * 8;
            py = -160 * k - 20;
            opacity = k < 0.2 ? k / 0.2 : 1 - (k - 0.2) / 0.8;
            scale = k < 0.25 ? 0.4 + (k / 0.25) * 0.75 : 1.15 - (k - 0.25) * 0.3;
            content = (
              <svg width={p.size} height={p.size} viewBox="0 0 24 24" style={{ display: 'block' }}>
                <path d="M12 21s-7.5-4.6-9.6-9.2C.8 8.2 3 4.5 6.6 4.5c2.2 0 3.6 1.2 5.4 3.2 1.8-2 3.2-3.2 5.4-3.2 3.6 0 5.8 3.7 4.2 7.3C19.5 16.4 12 21 12 21z" fill={C.pink} />
              </svg>
            );
            break;
          }
          case 'sparkles': {
            px = p.dx * k * 0.6;
            py = p.dy * k * 0.6;
            opacity = Math.sin(Math.min(1, k) * Math.PI);
            scale = 0.4 + Math.sin(Math.min(1, k) * Math.PI) * 0.8;
            content = (
              <svg width={p.size} height={p.size} viewBox="0 0 24 24" style={{ display: 'block' }}>
                <path d="M12 0 L14.2 9.8 L24 12 L14.2 14.2 L12 24 L9.8 14.2 L0 12 L9.8 9.8 Z" fill={C.sparkle[i % 3 === 0 ? 0 : 1]} />
              </svg>
            );
            break;
          }
          default: {
            px = p.dx * 0.25 * k + Math.sin(t * 5 + p.wobble) * 10;
            py = -(p.dy < 0 ? -p.dy : p.dy) * 1.2 * k - 10;
            opacity = k < 0.15 ? k / 0.15 : 1 - Math.max(0, (k - 0.55) / 0.45);
            scale = 0.5 + Math.min(1, k * 3) * 0.6;
            content = (
              <div style={{ width: p.size, height: p.size, borderRadius: '50%', border: `2px solid ${C.bubble.ring}`, background: C.bubble.fill }} />
            );
          }
        }
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: px - p.size / 2,
              top: py - p.size / 2,
              opacity: Math.max(0, opacity),
              transform: `scale(${scale})`,
            }}
          >
            {content}
          </div>
        );
      })}
    </div>
  );
}

/** Little stars circling his head while he's dizzy. */
export function DizzyStars({ x, y, radius, from, to }: { x: number; y: number; radius: number; from: number; to: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  if (frame < from || frame > to) return null;
  const t = (frame - from) / fps;
  const fade = Math.min(1, (frame - from) / 6, (to - frame) / 6);
  return (
    <div style={{ position: 'absolute', left: x, top: y, width: 0, height: 0, opacity: fade }}>
      {[0, 1, 2, 3].map((i) => {
        const a = t * 5 + (i * Math.PI) / 2;
        const sx = Math.cos(a) * radius;
        const sy = Math.sin(a) * radius * 0.32;
        const front = Math.sin(a) > 0;
        return (
          <svg key={i} width="30" height="30" viewBox="0 0 24 24" style={{ position: 'absolute', left: sx - 15, top: sy - 15, opacity: front ? 1 : 0.55, transform: `scale(${front ? 1 : 0.75})` }}>
            <path d="M12 1.5l3 6.6 7.2.8-5.4 4.9 1.5 7.1L12 17.3 5.7 20.9l1.5-7.1L1.8 8.9 9 8.1z" fill={C.star} />
          </svg>
        );
      })}
    </div>
  );
}
