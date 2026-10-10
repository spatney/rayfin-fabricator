import type { CSSProperties, ReactNode } from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import { ease, pop, ramp } from '../anim';
import { C, FONT, MONO } from '../theme';

/** Ray's speech bubble, as in the app: flat, bordered, its tail pointing at him. */
export function SpeechBubble({
  text,
  x,
  y,
  from,
  to,
  width = 420,
  size = 30,
  typeFrames,
}: {
  text: string;
  /** Where the tail points (his mouth or head), on screen. */
  x: number;
  y: number;
  from: number;
  to: number;
  width?: number;
  size?: number;
  /** Frames to type the text out; defaults to about one character a frame. */
  typeFrames?: number;
}): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < from || frame > to + 8) return null;
  const s = pop(frame, fps, from, 12, 0.6);
  const out = 1 - ramp(frame, to, 8, ease.in);
  const chars = Array.from(text);
  const n = Math.min(chars.length, Math.round(((frame - from) / (typeFrames ?? chars.length * 0.9)) * chars.length));
  return (
    <div
      style={{
        position: 'absolute',
        left: x - width / 2,
        bottom: 1080 - y + 22,
        width,
        display: 'flex',
        justifyContent: 'center',
        transform: `scale(${s * out})`,
        transformOrigin: '50% 100%',
        opacity: out,
      }}
    >
      <div
        style={{
          position: 'relative',
          padding: '14px 22px 15px',
          borderRadius: 18,
          border: `1.5px solid ${C.border}`,
          background: C.bgElev,
          color: C.text,
          fontFamily: FONT,
          fontSize: size,
          lineHeight: 1.3,
          textAlign: 'center',
          boxShadow: '0 14px 40px rgba(0,0,0,0.45)',
        }}
      >
        <span>{chars.slice(0, n).join('')}</span>
        <span style={{ color: 'transparent' }}>{chars.slice(n).join('')}</span>
        <div
          style={{
            position: 'absolute',
            left: '50%',
            bottom: -9,
            width: 16,
            height: 16,
            marginLeft: -8,
            background: C.bgElev,
            borderRight: `1.5px solid ${C.border}`,
            borderBottom: `1.5px solid ${C.border}`,
            transform: 'rotate(45deg)',
          }}
        />
      </div>
    </div>
  );
}

/** Big words that land one after another; the last one in the accent gradient. */
export function KineticTitle({ text, from, to, y = 540, size = 150 }: { text: string; from: number; to: number; y?: number; size?: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < from || frame > to + 12) return null;
  const words = text.split(' ');
  const exit = ramp(frame, to, 12, ease.in);
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: y - size * 0.62,
        display: 'flex',
        justifyContent: 'center',
        gap: size * 0.26,
        fontFamily: FONT,
        fontWeight: 800,
        fontSize: size,
        letterSpacing: '-0.035em',
        lineHeight: 1.1,
        transform: `translateY(${-exit * 60}px) scale(${1 + exit * 0.06})`,
        opacity: 1 - exit,
      }}
    >
      {words.map((word, i) => {
        const p = pop(frame, fps, from + i * 4, 13, 0.6);
        const last = i === words.length - 1;
        const style: CSSProperties = last
          ? { backgroundImage: `linear-gradient(100deg, ${C.accent}, ${C.accent2})`, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }
          : { color: '#f4f8fc' };
        return (
          <span key={i} style={{ display: 'inline-block', transform: `translateY(${(1 - p) * 70}px)`, opacity: Math.min(1, p * 1.4), textShadow: last ? 'none' : '0 8px 30px rgba(0,0,0,0.5)', ...style }}>
            {word}
          </span>
        );
      })}
    </div>
  );
}

/** A small rounded label, for naming what's on screen. */
export function Chip({ children, x, y, from, to, accent = C.accent, size = 30 }: { children: ReactNode; x: number; y: number; from: number; to: number; accent?: string; size?: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < from || frame > to + 8) return null;
  const s = pop(frame, fps, from, 12, 0.6);
  const out = 1 - ramp(frame, to, 8, ease.in);
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        transform: `translate(-50%, -50%) scale(${s * out})`,
        opacity: out,
        padding: `${size * 0.32}px ${size * 0.7}px`,
        borderRadius: 999,
        background: 'rgba(12,18,28,0.88)',
        border: `2px solid ${accent}`,
        color: '#f4f8fc',
        fontFamily: FONT,
        fontWeight: 650,
        fontSize: size,
        whiteSpace: 'nowrap',
        boxShadow: `0 10px 30px rgba(0,0,0,0.4), 0 0 24px ${accent}44`,
      }}
    >
      {children}
    </div>
  );
}

/** A Windows Terminal window running a command, for the "before" montage. */
export function Terminal({ title, lines, width = 560, accent = C.accent }: { title: string; lines: ReadonlyArray<{ text: string; color?: string }>; width?: number; accent?: string }): JSX.Element {
  return (
    <div style={{ width, borderRadius: 12, overflow: 'hidden', background: '#0c0c0c', boxShadow: '0 0 0 1px rgba(255,255,255,0.09), 0 24px 60px rgba(0,0,0,0.6)', fontFamily: MONO }}>
      <div style={{ display: 'flex', alignItems: 'center', height: 40, background: '#202020', padding: '0 14px', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px', background: '#0c0c0c', borderRadius: '8px 8px 0 0', marginTop: 6, color: '#e6e6e6', fontFamily: FONT, fontSize: 15 }}>
          <span style={{ color: accent, fontSize: 14 }}>❯</span>
          {title}
        </div>
        <div style={{ flex: 1 }} />
        <span style={{ color: '#9a9a9a', fontSize: 15, letterSpacing: 18 }}>─ ☐ ✕</span>
      </div>
      <div style={{ padding: '14px 18px 18px', fontSize: 19, lineHeight: 1.55 }}>
        {lines.map((line, i) => (
          <div key={i} style={{ color: line.color ?? '#cccccc', whiteSpace: 'pre' }}>
            {line.text}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A browser window with a page that never finishes loading. */
export function BrowserWindow({ url, width = 560 }: { url: string; width?: number }): JSX.Element {
  const frame = useCurrentFrame();
  return (
    <div style={{ width, borderRadius: 12, overflow: 'hidden', background: '#f3f4f6', boxShadow: '0 0 0 1px rgba(255,255,255,0.1), 0 24px 60px rgba(0,0,0,0.6)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, height: 46, background: '#dfe3e8', padding: '0 14px' }}>
        <span style={{ color: '#5b6470', fontSize: 18 }}>←  →  ⟳</span>
        <div style={{ flex: 1, height: 28, borderRadius: 14, background: '#fff', display: 'flex', alignItems: 'center', padding: '0 14px', fontFamily: FONT, fontSize: 16, color: '#3a414b' }}>{url}</div>
      </div>
      <div style={{ height: 210, display: 'grid', placeItems: 'center' }}>
        <div
          style={{
            width: 54,
            height: 54,
            borderRadius: '50%',
            border: '6px solid #c9d2dc',
            borderTopColor: C.brand,
            transform: `rotate(${frame * 14}deg)`,
          }}
        />
      </div>
    </div>
  );
}
