import { AbsoluteFill } from 'remotion';
import { RayActor, type RayMood } from '../ray/RayActor';
import { RAY_SIZE } from '../scenes/types';
import { FONT, MONO, THEMES, ThemeProvider, alpha, type ThemeName } from '../theme';
import { Ocean } from '../ui/Ocean';
import { CODE_PALETTES, colorOf, tokenize } from './code';

export interface ThumbnailSpec {
  /** Big words, one line each. Keep it to two or three short lines. */
  lines: ReadonlyArray<{ text: string; accent?: boolean }>;
  /** A small line above them, such as the lesson's question. */
  kicker: string;
  /** A short piece of code on a chip by Ray. */
  code?: string;
  mood?: RayMood;
  /** The big words' size in px, 176 unless a line is long enough to reach Ray. */
  size?: number;
}

/**
 * A lesson's YouTube thumbnail, drawn at 1920×1080 and scaled to 1280×720 when packaged:
 * big words on the left, Ray on the right, the series badge and the lesson's number. It has to
 * read at the size of a postage stamp, so it says little, in big type.
 */
export function LessonThumbnail({ series, number, spec, theme = 'dark' }: { series: string; number: number; spec: ThumbnailSpec; theme?: ThemeName }): JSX.Element {
  const C = THEMES[theme];
  const P = CODE_PALETTES[theme];
  return (
    <ThemeProvider value={C}>
      <AbsoluteFill style={{ background: C.base }}>
        <Ocean />
        <AbsoluteFill style={{ background: `radial-gradient(ellipse 60% 70% at 78% 55%, ${alpha(C.accent, 0.28)}, transparent 70%)` }} />
        <div style={{ position: 'absolute', left: 96, top: 92, display: 'flex', alignItems: 'center', gap: 22 }}>
          <div style={{ width: 112, height: 112, borderRadius: '50%', display: 'grid', placeItems: 'center', background: `linear-gradient(140deg, ${C.brand}, ${C.accent})`, color: '#fff', fontFamily: FONT, fontWeight: 800, fontSize: 68, boxShadow: C.glow(alpha(C.accent, 0.6), 30) }}>{number}</div>
          <div style={{ padding: '14px 30px', borderRadius: 999, background: C.chip.bg, border: `3px solid ${C.accent2}`, fontFamily: FONT, fontWeight: 800, fontSize: 40, letterSpacing: '0.08em', color: C.chip.text }}>{series.toUpperCase()}</div>
        </div>
        <div style={{ position: 'absolute', left: 100, top: 300, fontFamily: FONT, fontWeight: 750, fontSize: 58, letterSpacing: '0.02em', color: C.accent2 }}>{spec.kicker}</div>
        <div style={{ position: 'absolute', left: 92, top: 380, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {spec.lines.map((line, i) => (
            <div
              key={i}
              style={{
                fontFamily: FONT,
                fontWeight: 800,
                fontSize: spec.size ?? 176,
                lineHeight: 1,
                letterSpacing: '-0.04em',
                whiteSpace: 'nowrap',
                ...(line.accent
                  ? { backgroundImage: `linear-gradient(100deg, ${C.accent}, ${C.accent2})`, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent', filter: theme === 'dark' ? 'drop-shadow(0 8px 26px rgba(0,0,0,0.55))' : 'none' }
                  : { color: C.ink, textShadow: theme === 'dark' ? '0 10px 34px rgba(0,0,0,0.6)' : 'none' }),
              }}
            >
              {line.text}
            </div>
          ))}
        </div>
        <RayActor size={RAY_SIZE} keys={[{ f: 0, x: 1490, y: 470, s: 1.55, r: -8 }]} moods={[{ f: 0, mood: spec.mood ?? 'happy' }]} gaze={() => ({ x: -0.5, y: 0.2 })} seed={5} />
        {spec.code ? (
          <div style={{ position: 'absolute', left: 1230, top: 800, padding: '18px 30px', borderRadius: 20, background: P.bg, border: `3px solid ${C.accent2}`, boxShadow: `${C.shadow.panel}, ${C.glow(alpha(C.accent2, 0.5), 34, 4)}`, fontFamily: MONO, fontSize: 52, whiteSpace: 'pre', transform: 'rotate(-4deg)' }}>
            {tokenize(spec.code)[0].map((t, i) => (
              <span key={i} style={{ color: colorOf(t, P) }}>
                {t.text}
              </span>
            ))}
          </div>
        ) : null}
      </AbsoluteFill>
    </ThemeProvider>
  );
}
