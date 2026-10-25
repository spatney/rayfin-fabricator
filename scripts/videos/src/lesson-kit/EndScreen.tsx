import type { ReactNode } from 'react';
import { Img, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { ease, pop, ramp } from '../anim';
import { END_SLOTS } from '../show/youtube';
import { FONT, alpha, useTheme } from '../theme';

export { END_SLOTS };

/**
 * The last 15–20 seconds: the next lesson in a 16:9 slot and a round subscribe slot, for
 * YouTube's end-screen elements to sit on, with the series name, where to get Fabricator, and
 * the series' disclaimer. Ray waves beside the subscribe slot (the scene places him).
 */
export function EndScreen({ series, next, from, to, fabricator, disclaimer }: { series: string; next: { number: number; title: string } | null; from: number; to: number; fabricator: ReactNode; disclaimer: ReactNode }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  if (frame < from || frame > to + 12) return null;
  const p = pop(frame, fps, from, 13, 0.7);
  const slot = pop(frame, fps, from + 8, 12, 0.6);
  const sub = pop(frame, fps, from + 14, 12, 0.6);
  const foot = ramp(frame, from + 20, 16);
  const out = 1 - ramp(frame, to, 12, ease.in);
  const v = END_SLOTS.video;
  const s = END_SLOTS.subscribe;
  const [first, ...rest] = series.split(' with ');
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: out }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 96, textAlign: 'center', fontFamily: FONT, fontWeight: 800, fontSize: 84, letterSpacing: '-0.03em', opacity: Math.min(1, p * 1.4), transform: `translateY(${(1 - p) * -30}px)` }}>
        <span style={{ color: C.ink, textShadow: C.shadow.title }}>{first}</span>
        {rest.length ? (
          <span style={{ backgroundImage: `linear-gradient(100deg, ${C.accent}, ${C.accent2})`, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}> with {rest.join(' with ')}</span>
        ) : null}
      </div>
      <div style={{ position: 'absolute', left: v.x, top: v.y - 58, fontFamily: FONT, fontWeight: 750, fontSize: 32, letterSpacing: '0.14em', color: C.accent2, opacity: Math.min(1, slot * 1.4) }}>{next ? 'NEXT UP' : 'WATCH NEXT'}</div>
      <div style={{ position: 'absolute', left: v.x, top: v.y, width: v.w, height: v.h, borderRadius: 22, background: `linear-gradient(140deg, ${alpha(C.brand, 0.85)}, ${alpha(C.accent2, 0.55)})`, border: `3px solid ${alpha(C.accent2, 0.7)}`, boxShadow: `${C.shadow.panel}, ${C.glow(alpha(C.accent2, 0.35), 40)}`, transform: `scale(${0.85 + 0.15 * slot})`, opacity: Math.min(1, slot * 1.4), display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '0 52px', overflow: 'hidden' }}>
        {next ? (
          <>
            <div style={{ fontFamily: FONT, fontWeight: 750, fontSize: 34, letterSpacing: '0.1em', color: 'rgba(255,255,255,0.85)' }}>LESSON {next.number}</div>
            <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: 70, lineHeight: 1.08, letterSpacing: '-0.03em', color: '#ffffff', marginTop: 10 }}>{next.title}</div>
          </>
        ) : (
          <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: 64, color: '#ffffff' }}>The whole series</div>
        )}
      </div>
      <div style={{ position: 'absolute', left: s.x - s.r, top: s.y - s.r, width: s.r * 2, height: s.r * 2, borderRadius: '50%', border: `4px dashed ${alpha(C.accent, 0.8)}`, background: alpha(C.accent, 0.08), transform: `scale(${sub})`, display: 'grid', placeItems: 'center' }}>
        <Img src={staticFile('ui/fabricator-logo.png')} style={{ width: s.r * 1.1, height: s.r * 1.1, opacity: 0.9 }} />
      </div>
      <div style={{ position: 'absolute', left: s.x - 200, top: s.y + s.r + 22, width: 400, textAlign: 'center', fontFamily: FONT, fontWeight: 700, fontSize: 36, color: C.ink, opacity: Math.min(1, sub * 1.4) }}>Subscribe</div>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 86, textAlign: 'center', fontFamily: FONT, fontSize: 32, color: C.inkDim, opacity: foot }}>{fabricator}</div>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 34, textAlign: 'center', fontFamily: FONT, fontSize: 21, color: C.inkFaint, opacity: foot }}>{disclaimer}</div>
    </div>
  );
}
