import { track, type Key } from '../anim';
import { alpha, useTheme } from '../theme';

export interface CursorKey {
  f: number;
  x: number;
  y: number;
}

interface CursorProps {
  frame: number;
  keys: readonly CursorKey[];
  /** Frames where it clicks. */
  clicks?: readonly number[];
  /** Counter-scale when drawn inside a zoomed window, so it keeps its size on screen. */
  scale?: number;
  opacity?: number;
}

/** A pointer that glides between keys and clicks with a ripple. */
export function Cursor({ frame, keys, clicks = [], scale = 1, opacity = 1 }: CursorProps): JSX.Element | null {
  const C = useTheme();
  if (opacity <= 0.001 || keys.length === 0) return null;
  const xs: Key[] = keys.map((k) => [k.f, k.x] as const);
  const ys: Key[] = keys.map((k) => [k.f, k.y] as const);
  const x = track(frame, xs);
  const y = track(frame, ys);
  const last = [...clicks].reverse().find((c) => c <= frame);
  const since = last === undefined ? Infinity : frame - last;
  const press = since < 6 ? 1 - Math.sin((since / 6) * Math.PI) * 0.18 : 1;
  const ripple = since < 18 ? since / 18 : -1;

  return (
    <div style={{ position: 'absolute', left: x, top: y, width: 0, height: 0, opacity, transform: `scale(${scale})`, transformOrigin: '0 0', zIndex: 10 }}>
      {ripple >= 0 ? (
        <div
          style={{
            position: 'absolute',
            left: -40 * ripple - 6,
            top: -40 * ripple - 6,
            width: 80 * ripple + 12,
            height: 80 * ripple + 12,
            borderRadius: '50%',
            border: `3px solid ${alpha(C.accent, 1 - ripple)}`,
            background: alpha(C.accent, 0.25 * (1 - ripple)),
          }}
        />
      ) : null}
      <svg width="34" height="44" viewBox="0 0 34 44" style={{ position: 'absolute', left: -3, top: -2, transform: `scale(${press})`, transformOrigin: '3px 2px', filter: 'drop-shadow(0 4px 6px rgba(0,0,0,0.45))' }}>
        <path d="M3 2 L3 34 L11 26.5 L16.5 39.5 L22.5 37 L17 24.5 L28 24.5 Z" fill="#fff" stroke="#0b0e14" strokeWidth="2.4" strokeLinejoin="round" />
      </svg>
    </div>
  );
}
