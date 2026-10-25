import type { CSSProperties, ReactNode } from 'react';
import { Img, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { ease, pop, ramp } from '../anim';
import { Burst } from '../fx/Burst';
import { FONT, MONO, useTheme } from '../theme';
import { Icon } from './icons';

/** 0→1 as a card pops in at `from`, and 1→0 as it leaves at `to`. */
function useLife(from: number, to: number, leave = 12): { p: number; out: number; frame: number } | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < from || frame > to + leave) return null;
  return { p: pop(frame, fps, from, 13, 0.7), out: 1 - ramp(frame, to, leave, ease.in), frame };
}

const gradientText = (a: string, b: string): CSSProperties => ({
  backgroundImage: `linear-gradient(100deg, ${a}, ${b})`,
  WebkitBackgroundClip: 'text',
  backgroundClip: 'text',
  color: 'transparent',
});

/* ------------------------------- Series bumper ------------------------------- */

/** "Learn Rayfin with Ray" with the lesson's number and title, after a splash. */
export function SeriesBumper({ series, number, title, from, to }: { series: string; number: number; title: string; from: number; to: number }): JSX.Element | null {
  const { fps } = useVideoConfig();
  const C = useTheme();
  const life = useLife(from, to);
  if (!life) return null;
  const { frame, out } = life;
  const ring = ramp(frame, from, 26, ease.out);
  const [first, ...restWords] = series.split(' with ');
  const words = first.split(' ');
  const withRay = restWords.length ? `with ${restWords.join(' with ')}` : '';
  const tag = pop(frame, fps, from + 16, 12, 0.6);
  const name = pop(frame, fps, from + 22, 13, 0.7);
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: out, transform: `scale(${1 + (1 - out) * 0.08})` }}>
      {ring < 1 ? (
        <div style={{ position: 'absolute', left: 960 - 80 - ring * 700, top: 430 - 80 - ring * 700, width: 160 + ring * 1400, height: 160 + ring * 1400, borderRadius: '50%', border: `6px solid ${C.accent2}`, opacity: 1 - ring }} />
      ) : null}
      <Burst kind="bubbles" at={from} x={960} y={440} count={16} seed={11} spread={2.4} />
      <div style={{ position: 'absolute', left: 0, right: 0, top: 300, display: 'flex', justifyContent: 'center', gap: 36, fontFamily: FONT, fontWeight: 800, fontSize: 150, letterSpacing: '-0.035em', lineHeight: 1 }}>
        {words.map((word, i) => {
          const p = pop(frame, fps, from + 2 + i * 4, 12, 0.6);
          return (
            <span key={i} style={{ display: 'inline-block', color: C.ink, textShadow: C.shadow.title, transform: `translateY(${(1 - p) * 80}px) scale(${0.8 + 0.2 * p})`, opacity: Math.min(1, p * 1.4) }}>
              {word}
            </span>
          );
        })}
      </div>
      {withRay ? (
        <div style={{ position: 'absolute', left: 0, right: 0, top: 462, textAlign: 'center', fontFamily: FONT, fontWeight: 800, fontSize: 96, letterSpacing: '-0.03em', lineHeight: 1.05, transform: `translateY(${(1 - tag) * 40}px)`, opacity: Math.min(1, tag * 1.4) }}>
          <span style={gradientText(C.accent, C.accent2)}>{withRay}</span>
        </div>
      ) : null}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 640, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 22, transform: `translateY(${(1 - name) * 30}px)`, opacity: Math.min(1, name * 1.4) }}>
        <span style={{ padding: '10px 24px', borderRadius: 999, background: `linear-gradient(100deg, ${C.brand}, ${C.accent})`, color: '#fff', fontFamily: FONT, fontWeight: 750, fontSize: 34, letterSpacing: '0.08em' }}>LESSON {number}</span>
        <span style={{ fontFamily: FONT, fontWeight: 650, fontSize: 56, color: C.inkSoft, letterSpacing: '-0.02em' }}>{title}</span>
      </div>
    </div>
  );
}

/* -------------------------------- Objectives -------------------------------- */

/** "Today you'll learn", with numbered objectives that pop in on their cues. */
export function Objectives({ items, from, to, x = 200, y = 250, heading = 'Today you’ll learn' }: { items: ReadonlyArray<{ text: ReactNode; at: number }>; from: number; to: number; x?: number; y?: number; heading?: string }): JSX.Element | null {
  const { fps } = useVideoConfig();
  const C = useTheme();
  const life = useLife(from, to);
  if (!life) return null;
  const { frame, p, out } = life;
  return (
    <div style={{ position: 'absolute', left: x, top: y, opacity: out, transform: `translateX(${-(1 - out) * 80}px)` }}>
      <div style={{ fontFamily: FONT, fontWeight: 750, fontSize: 36, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.accent2, opacity: Math.min(1, p * 1.4), transform: `translateY(${(1 - p) * 20}px)` }}>{heading}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 34, marginTop: 40 }}>
        {items.map((item, i) => {
          const q = frame < item.at ? 0 : pop(frame, fps, item.at, 12, 0.6);
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 30, opacity: Math.min(1, q * 1.5), transform: `translateX(${(1 - q) * -60}px)` }}>
              <div style={{ width: 84, height: 84, flex: 'none', borderRadius: '50%', display: 'grid', placeItems: 'center', background: `linear-gradient(140deg, ${C.brand}, ${C.accent})`, color: '#fff', fontFamily: FONT, fontWeight: 800, fontSize: 44, boxShadow: C.glow(`${C.accent}66`, 26), transform: `scale(${0.6 + 0.4 * q})` }}>{i + 1}</div>
              <div style={{ fontFamily: FONT, fontWeight: 650, fontSize: 58, color: C.ink, letterSpacing: '-0.02em', textShadow: C.shadow.title }}>{item.text}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* --------------------------------- Chapters --------------------------------- */

/** A chapter's opening title: its number small, its name big. */
export function ChapterTitle({ label, title, from, to, y = 470, size = 120 }: { label: string; title: string; from: number; to: number; y?: number; size?: number }): JSX.Element | null {
  const { fps } = useVideoConfig();
  const C = useTheme();
  const life = useLife(from, to);
  if (!life) return null;
  const { frame, p, out } = life;
  const words = title.split(' ');
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, top: y - size, textAlign: 'center', opacity: out, transform: `translateY(${-(1 - out) * 50}px)` }}>
      <div style={{ fontFamily: FONT, fontWeight: 750, fontSize: 34, letterSpacing: '0.14em', textTransform: 'uppercase', color: C.accent2, opacity: Math.min(1, p * 1.4) }}>{label}</div>
      <div style={{ display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: `0 ${size * 0.26}px`, marginTop: 10, fontFamily: FONT, fontWeight: 800, fontSize: size, letterSpacing: '-0.035em', lineHeight: 1.1 }}>
        {words.map((word, i) => {
          const q = pop(frame, fps, from + 3 + i * 3, 13, 0.6);
          const last = i === words.length - 1;
          return (
            <span key={i} style={{ display: 'inline-block', transform: `translateY(${(1 - q) * 60}px)`, opacity: Math.min(1, q * 1.4), ...(last ? gradientText(C.accent, C.accent2) : { color: C.ink, textShadow: C.shadow.title }) }}>
              {word}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** A small tag in the top-left corner naming the chapter, while it plays. */
export function ChapterTag({ text, from, to }: { text: string; from: number; to: number }): JSX.Element | null {
  const C = useTheme();
  const life = useLife(from, to, 10);
  if (!life) return null;
  const { p, out } = life;
  return (
    <div style={{ position: 'absolute', left: 48, top: 40, display: 'flex', alignItems: 'center', gap: 12, padding: '10px 22px 10px 16px', borderRadius: 999, background: C.chip.bg, border: `2px solid ${C.border}`, boxShadow: C.shadow.chip, fontFamily: FONT, fontWeight: 650, fontSize: 26, color: C.inkSoft, opacity: Math.min(1, p * 1.4) * out, transform: `translateX(${-(1 - p) * 40}px)` }}>
      <span style={{ width: 12, height: 12, borderRadius: '50%', background: C.accent2 }} />
      {text}
    </div>
  );
}

/* ----------------------------------- Recap ----------------------------------- */

/** Three takeaways, side by side, each checked off on its cue. */
export function Recap({ items, from, to, y = 560, heading = 'Recap' }: { items: ReadonlyArray<{ text: ReactNode; at: number }>; from: number; to: number; y?: number; heading?: string }): JSX.Element | null {
  const { fps } = useVideoConfig();
  const C = useTheme();
  const life = useLife(from, to);
  if (!life) return null;
  const { frame, p, out } = life;
  const width = 500;
  const gap = 40;
  const left = 960 - (items.length * width + (items.length - 1) * gap) / 2;
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: out }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: y - 300, textAlign: 'center', fontFamily: FONT, fontWeight: 800, fontSize: 92, letterSpacing: '-0.03em', color: C.ink, textShadow: C.shadow.title, opacity: Math.min(1, p * 1.4), transform: `translateY(${(1 - p) * 30}px)` }}>{heading}</div>
      {items.map((item, i) => {
        const q = frame < item.at ? 0 : pop(frame, fps, item.at, 12, 0.6);
        const tick = frame < item.at + 6 ? 0 : pop(frame, fps, item.at + 6, 10, 0.5);
        return (
          <div key={i} style={{ position: 'absolute', left: left + i * (width + gap), top: y - 140, width, minHeight: 280, padding: '34px 34px 30px', borderRadius: 26, background: C.panel.bg, border: `2px solid ${q > 0.9 ? C.ok : C.panel.border}`, boxShadow: `${C.shadow.panel}, ${C.glow(`${C.ok}33`, 30)}`, opacity: Math.min(1, q * 1.5), transform: `translateY(${(1 - q) * 60}px) scale(${0.9 + 0.1 * q})` }}>
            <div style={{ width: 64, height: 64, borderRadius: '50%', display: 'grid', placeItems: 'center', background: `${C.ok}22`, transform: `scale(${tick})` }}>
              <Icon name="check" color={C.ok} size={40} stroke={2.6} />
            </div>
            <div style={{ marginTop: 22, fontFamily: FONT, fontWeight: 650, fontSize: 40, lineHeight: 1.25, color: C.ink }}>{item.text}</div>
          </div>
        );
      })}
    </div>
  );
}

/* --------------------------------- Challenge --------------------------------- */

/** Ray's challenge: a prompt typed into a composer like Fabricator's, and a question for the comments. */
export function Challenge({ prompt, from, to, typeFrom, typeTo, cta, ctaAt, heading = 'Ray’s challenge' }: { prompt: string; from: number; to: number; typeFrom: number; typeTo: number; cta: ReactNode; ctaAt: number; heading?: string }): JSX.Element | null {
  const { fps } = useVideoConfig();
  const C = useTheme();
  const life = useLife(from, to);
  if (!life) return null;
  const { frame, p, out } = life;
  const chars = Array.from(prompt);
  const n = Math.round(ramp(frame, typeFrom, typeTo - typeFrom, ease.linear) * chars.length);
  const typing = frame >= typeFrom && n < chars.length;
  const c = frame < ctaAt ? 0 : pop(frame, fps, ctaAt, 12, 0.6);
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: out }}>
      <div style={{ position: 'absolute', left: 170, top: 150, display: 'flex', alignItems: 'center', gap: 20, opacity: Math.min(1, p * 1.4), transform: `translateY(${(1 - p) * 30}px)` }}>
        <Icon name="star" color={C.star} size={64} stroke={2.2} />
        <span style={{ fontFamily: FONT, fontWeight: 800, fontSize: 84, letterSpacing: '-0.03em', color: C.ink, textShadow: C.shadow.title }}>{heading}</span>
      </div>
      <div style={{ position: 'absolute', left: 170, top: 320, width: 1180, minHeight: 300, padding: '34px 38px 96px', borderRadius: 26, background: C.composer, border: `2px solid ${C.border}`, boxShadow: C.shadow.window, opacity: Math.min(1, p * 1.4), transform: `scale(${0.92 + 0.08 * p})`, transformOrigin: '30% 50%' }}>
        <div style={{ fontFamily: FONT, fontSize: 40, lineHeight: 1.4, color: C.text, minHeight: 170 }}>
          {chars.slice(0, n).join('')}
          {typing ? <span style={{ color: C.accent }}>▍</span> : null}
          {n === 0 ? <span style={{ color: C.dim }}>Message Fabricator…</span> : null}
        </div>
        <div style={{ position: 'absolute', left: 38, right: 30, bottom: 26, display: 'flex', alignItems: 'center', gap: 22, fontFamily: FONT, fontSize: 30, color: C.dim }}>
          <span style={{ fontSize: 44, lineHeight: 1 }}>+</span>
          <span>Auto ⌄</span>
          <span style={{ flex: 1 }} />
          <span style={{ width: 62, height: 62, borderRadius: '50%', display: 'grid', placeItems: 'center', background: n >= chars.length ? C.accent : C.border, color: '#fff', fontSize: 34 }}>↑</span>
        </div>
      </div>
      <div style={{ position: 'absolute', left: 170, top: 760, display: 'flex', alignItems: 'center', gap: 18, padding: '18px 30px', borderRadius: 999, background: C.chip.bg, border: `2px solid ${C.accent2}`, boxShadow: `${C.shadow.chip}, ${C.glow(`${C.accent2}44`, 24)}`, fontFamily: FONT, fontWeight: 650, fontSize: 38, color: C.chip.text, opacity: Math.min(1, c * 1.4), transform: `translateY(${(1 - c) * 30}px) scale(${0.9 + 0.1 * c})`, transformOrigin: '0% 50%' }}>
        <Icon name="comment" color={C.accent2} size={40} stroke={2.2} />
        {cta}
      </div>
    </div>
  );
}

/* ------------------------------- Under the hood ------------------------------- */

/** A Rayfin CLI command in a terminal, typed out, with a tag saying Fabricator runs it for you. */
export function CommandCard({
  command,
  output = [],
  from,
  to,
  typeFrom,
  typeTo,
  x,
  y,
  width = 900,
  tag = 'Fabricator runs this for you',
  tagAt,
  title = 'Under the hood',
  scale = 1,
}: {
  command: string;
  output?: ReadonlyArray<{ text: string; at: number; color?: string }>;
  from: number;
  to: number;
  typeFrom: number;
  typeTo: number;
  x: number;
  y: number;
  width?: number;
  tag?: string;
  tagAt?: number;
  title?: string;
  /** Scales the whole card, its type included. */
  scale?: number;
}): JSX.Element | null {
  const { fps } = useVideoConfig();
  const C = useTheme();
  const life = useLife(from, to);
  if (!life) return null;
  const { frame, p, out } = life;
  const chars = Array.from(command);
  const n = Math.round(ramp(frame, typeFrom, typeTo - typeFrom, ease.linear) * chars.length);
  const t = tagAt === undefined || frame < tagAt ? 0 : pop(frame, fps, tagAt, 12, 0.6);
  return (
    <div style={{ position: 'absolute', left: x - width / 2, top: y, width, transform: `translateY(-50%) scale(${scale * (0.9 + 0.1 * p) * (1 - (1 - out) * 0.06)})`, opacity: Math.min(1, p * 1.4) * out }}>
      <div style={{ borderRadius: 16, overflow: 'hidden', background: '#0c0c0c', boxShadow: C.shadow.terminal, fontFamily: MONO }}>
        <div style={{ display: 'flex', alignItems: 'center', height: 50, background: '#202020', padding: '0 18px', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 18px', background: '#0c0c0c', borderRadius: '10px 10px 0 0', marginTop: 8, color: '#e6e6e6', fontFamily: FONT, fontSize: 20 }}>
            <span style={{ color: C.accent2, fontSize: 18 }}>❯</span>
            {title}
          </div>
        </div>
        <div style={{ padding: '22px 28px 28px', fontSize: 34, lineHeight: 1.55, minHeight: 120 }}>
          <div style={{ color: '#f9f1a5', whiteSpace: 'pre' }}>
            <span style={{ color: '#7d7d7d' }}>PS&gt; </span>
            {chars.slice(0, n).join('')}
            {n < chars.length && frame >= typeFrom ? <span style={{ color: C.accent }}>▍</span> : null}
          </div>
          {output.map((line, i) =>
            frame >= line.at ? (
              <div key={i} style={{ color: line.color ?? '#cccccc', whiteSpace: 'pre', fontSize: 28, opacity: ramp(frame, line.at, 6) }}>
                {line.text}
              </div>
            ) : null,
          )}
        </div>
      </div>
      {tag ? (
        <div style={{ position: 'absolute', right: -16, top: -34, display: 'flex', alignItems: 'center', gap: 12, padding: '10px 22px 10px 12px', borderRadius: 999, background: C.chip.bg, border: `2px solid ${C.accent}`, boxShadow: `${C.shadow.chip}, ${C.glow(`${C.accent}44`, 22)}`, fontFamily: FONT, fontWeight: 650, fontSize: 28, color: C.chip.text, transform: `scale(${t}) rotate(${(1 - t) * -8}deg)`, transformOrigin: '90% 50%', whiteSpace: 'nowrap' }}>
          <Img src={staticFile('ui/fabricator-logo.png')} style={{ width: 38, height: 38 }} />
          {tag}
        </div>
      ) : null}
    </div>
  );
}
