import { useMemo } from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { rng } from '../ray/rig';
import { H, W, useTheme } from '../theme';

/**
 * The deep water of a Deep Dive, laid over the Ocean: the light from the surface fades, the
 * water darkens toward the bottom, and bioluminescent specks and marine snow drift by.
 * `depth` is 0 (nothing drawn) … 1 (the deep). Every motion is a function of the frame.
 */
export function Depths({ depth }: { depth: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  const specks = useMemo(() => {
    const random = rng(2024);
    return Array.from({ length: 46 }, () => ({
      x: random() * W,
      y: random() * H,
      size: 2 + random() * 4.5,
      drift: 4 + random() * 10,
      phase: random() * Math.PI * 2,
      pulse: 0.6 + random() * 1.4,
      teal: random() < 0.6,
    }));
  }, []);
  const snow = useMemo(() => {
    const random = rng(77);
    return Array.from({ length: 60 }, () => ({
      x: random() * W,
      y0: random() * (H + 40),
      size: 1.5 + random() * 2.5,
      speed: 10 + random() * 22,
      sway: 4 + random() * 10,
      phase: random() * Math.PI * 2,
    }));
  }, []);
  if (depth <= 0.001) return null;
  const t = frame / fps;
  const dark = C.name === 'dark';
  const shade = dark
    ? `linear-gradient(180deg, rgba(2,6,14,${(0.5 * depth).toFixed(3)}) 0%, rgba(1,3,9,${(0.93 * depth).toFixed(3)}) 100%)`
    : `linear-gradient(180deg, rgba(14,74,120,${(0.42 * depth).toFixed(3)}) 0%, rgba(6,38,74,${(0.86 * depth).toFixed(3)}) 100%)`;
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <AbsoluteFill style={{ background: shade }} />
      {snow.map((s, i) => {
        const y = (s.y0 + s.speed * t) % (H + 40) - 20;
        const x = s.x + Math.sin(t * 0.7 + s.phase) * s.sway;
        return <div key={`s${i}`} style={{ position: 'absolute', left: x, top: y, width: s.size, height: s.size, borderRadius: '50%', background: '#d9ecff', opacity: 0.35 * depth }} />;
      })}
      {specks.map((s, i) => {
        const glow = 0.5 + 0.5 * Math.sin(t * s.pulse * 2 + s.phase);
        const x = s.x + Math.sin(t * 0.3 + s.phase) * s.drift;
        const y = s.y + Math.cos(t * 0.25 + s.phase) * s.drift;
        const color = s.teal ? C.accent2 : C.accent;
        return (
          <div
            key={`b${i}`}
            style={{
              position: 'absolute',
              left: x,
              top: y,
              width: s.size,
              height: s.size,
              borderRadius: '50%',
              background: color,
              boxShadow: `0 0 ${8 + 10 * glow}px ${2 + 3 * glow}px ${color}`,
              opacity: depth * (0.25 + 0.75 * glow),
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
}
