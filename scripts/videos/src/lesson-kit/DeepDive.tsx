import { useCurrentFrame, useVideoConfig } from 'remotion';
import { ease, pop, ramp, track } from '../anim';
import { FONT, MONO, useTheme } from '../theme';

/** The Deep Dive's title: a stamp that lands big, then tucks itself into the top-left corner. */
export function DeepDiveTitle({ from, to, subtitle = 'Under the surface', tuckAt }: { from: number; to: number; subtitle?: string; tuckAt?: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  if (frame < from || frame > to + 12) return null;
  const p = pop(frame, fps, from, 10, 0.6);
  const out = 1 - ramp(frame, to, 12, ease.in);
  const tuck = tuckAt === undefined ? 0 : ramp(frame, tuckAt, 18, ease.inOut);
  const x = 960 + (330 - 960) * tuck;
  const y = 470 + (92 - 470) * tuck;
  const s = (1 - 0.62 * tuck) * (1.25 - 0.25 * p);
  return (
    <div style={{ position: 'absolute', left: x, top: y, transform: `translate(-50%, -50%) scale(${s}) rotate(${-4 * (1 - tuck)}deg)`, opacity: Math.min(1, p * 1.5) * out, textAlign: 'center', whiteSpace: 'nowrap' }}>
      <div style={{ display: 'inline-block', padding: '14px 40px', borderRadius: 18, border: `5px solid ${C.accent2}`, color: C.accent2, fontFamily: FONT, fontWeight: 800, fontSize: 110, letterSpacing: '0.08em', lineHeight: 1, boxShadow: C.glow(`${C.accent2}55`, 40, 6), background: 'rgba(2,10,20,0.35)' }}>DEEP DIVE</div>
      <div style={{ marginTop: 18, fontFamily: FONT, fontWeight: 650, fontSize: 44, color: C.inkSoft, opacity: 1 - tuck }}>{subtitle}</div>
    </div>
  );
}

/**
 * A depth gauge down the left edge: the needle sinks as Ray dives and rises as he surfaces,
 * with the depth read out in meters. It's for fun: the meters measure nothing.
 */
export function DepthGauge({ from, to, diveFrames = 40, maxMeters = 200, x = 80 }: { from: number; to: number; diveFrames?: number; maxMeters?: number; x?: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const C = useTheme();
  if (frame < from || frame > to + 30) return null;
  const depth = track(frame, [
    [from, 0],
    [from + diveFrames, 1, ease.inOut],
    [to, 1],
    [to + 30, 0, ease.inOut],
  ]);
  const show = ramp(frame, from, 10) * (1 - ramp(frame, to + 18, 12));
  const top = 230;
  const height = 620;
  const meters = Math.round(depth * maxMeters + Math.sin(frame / 7) * 1.5 * depth);
  return (
    <div style={{ position: 'absolute', left: x, top, height, width: 120, opacity: show }}>
      <div style={{ position: 'absolute', left: 30, top: 0, bottom: 0, width: 4, borderRadius: 2, background: `linear-gradient(180deg, ${C.accent}, ${C.accent2} 60%, #0b3a46)` }} />
      {Array.from({ length: 11 }, (_, i) => (
        <div key={i} style={{ position: 'absolute', left: i % 5 === 0 ? 14 : 22, top: (i / 10) * height - 1, width: i % 5 === 0 ? 36 : 20, height: 2, background: C.inkDim, opacity: 0.7 }} />
      ))}
      <div style={{ position: 'absolute', left: 0, top: depth * height - 16, display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ width: 0, height: 0, borderTop: '16px solid transparent', borderBottom: '16px solid transparent', borderLeft: `26px solid ${C.accent2}` }} />
      </div>
      <div style={{ position: 'absolute', left: 62, top: depth * height - 22, fontFamily: MONO, fontWeight: 600, fontSize: 30, color: C.accent2, whiteSpace: 'nowrap', textShadow: C.name === 'dark' ? `0 0 14px ${C.accent2}88` : 'none' }}>−{meters} m</div>
      <div style={{ position: 'absolute', left: 4, top: -54, fontFamily: FONT, fontWeight: 750, fontSize: 22, letterSpacing: '0.16em', color: C.inkDim }}>DEPTH</div>
    </div>
  );
}

/** Sonar rings rippling out from a point, to say "look here". */
export function Sonar({ x, y, at, color, rings = 3, size = 260 }: { x: number; y: number; at: number; color?: string; rings?: number; size?: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const C = useTheme();
  const stroke = color ?? C.accent2;
  const life = 30;
  if (frame < at || frame > at + life + rings * 8) return null;
  return (
    <>
      {Array.from({ length: rings }, (_, i) => {
        const t = ramp(frame, at + i * 8, life, ease.out);
        if (t <= 0 || t >= 1) return null;
        const d = size * t;
        return <div key={i} style={{ position: 'absolute', left: x - d / 2, top: y - d / 2, width: d, height: d, borderRadius: '50%', border: `4px solid ${stroke}`, opacity: 1 - t }} />;
      })}
    </>
  );
}
