import type { CSSProperties, ReactNode } from 'react';
import { Img, staticFile } from 'remotion';
import { shotFile, type Shot } from '../shots';
import { FONT, MONO, useTheme } from '../theme';

export { SHOTS, type Shot } from '../shots';

export interface AppWindowProps {
  shot: Shot;
  /** Center of the window on screen. */
  x: number;
  y: number;
  /** Width of the window on screen; its height follows the image unless given. */
  width: number;
  height?: number;
  /** Camera: zoom ≥ 1 and the image point (px) to center on. */
  zoom?: number;
  fx?: number;
  fy?: number;
  opacity?: number;
  scale?: number;
  rotate?: number;
  /** Overlays in image pixels; they move with the camera. */
  children?: ReactNode;
  style?: CSSProperties;
}

/** Where a window sits on screen and where its camera points: AppWindow's layout props. */
type Framing = Pick<AppWindowProps, 'shot' | 'x' | 'y' | 'width' | 'height' | 'zoom' | 'fx' | 'fy'>;

/** The camera's pan (tx, ty) and scale (s), and the window's height. */
function camera({ shot, width, height, zoom = 1, fx, fy }: Framing) {
  const fit = width / shot.w;
  const h = height ?? shot.h * fit;
  const s = fit * zoom;
  const cx = fx ?? shot.w / 2;
  const cy = fy ?? shot.h / 2;
  const tx = Math.min(0, Math.max(width - shot.w * s, width / 2 - cx * s));
  const ty = Math.min(0, Math.max(h - shot.h * s, h / 2 - cy * s));
  return { h, s, tx, ty };
}

/**
 * Where a pixel of a window's screenshot is on screen (at the window's own scale 1), for
 * effects that must not be clipped by the window, such as sparkles.
 */
export function onScreen(framing: Framing, px: number, py: number): { x: number; y: number } {
  const { h, s, tx, ty } = camera(framing);
  return { x: framing.x - framing.width / 2 + tx + px * s, y: framing.y - h / 2 + ty + py * s };
}

/** A screenshot in a floating window, with a camera that can push in on any part of it. */
export function AppWindow({
  shot,
  x,
  y,
  width,
  height,
  zoom = 1,
  fx,
  fy,
  opacity = 1,
  scale = 1,
  rotate = 0,
  children,
  style,
}: AppWindowProps): JSX.Element {
  const C = useTheme();
  const { h, s, tx, ty } = camera({ shot, x, y, width, height, zoom, fx, fy });

  return (
    <div
      style={{
        position: 'absolute',
        left: x - width / 2,
        top: y - h / 2,
        width,
        height: h,
        borderRadius: 18,
        overflow: 'hidden',
        background: C.bg,
        opacity,
        transform: `scale(${scale}) rotate(${rotate}deg)`,
        boxShadow: C.shadow.window,
        ...style,
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: shot.w,
          height: shot.h,
          transformOrigin: '0 0',
          transform: `translate(${tx}px, ${ty}px) scale(${s})`,
        }}
      >
        <Img src={staticFile(`ui/${shotFile(shot, C.name)}`)} style={{ display: 'block', width: shot.w, height: shot.h }} />
        {children}
      </div>
    </div>
  );
}

interface RectProps {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Dims everything but a rounded rect, ringed in the accent color. In image pixels. */
export function Spotlight({ x, y, w, h, opacity = 1, radius = 12, dim = 0.55 }: RectProps & { opacity?: number; radius?: number; dim?: number }): JSX.Element | null {
  const C = useTheme();
  if (opacity <= 0.001) return null;
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: w,
        height: h,
        borderRadius: radius,
        boxShadow: `0 0 0 4000px ${C.scrim(dim * opacity)}, 0 0 0 3px ${C.accent}, ${C.glow(`${C.accent}88`, 28, 6)}`,
        opacity: Math.min(1, opacity * 1.2),
        pointerEvents: 'none',
      }}
    />
  );
}

/** A plain patch of color, to hide part of a screenshot. In image pixels. */
export function Patch({ x, y, w, h, color, radius = 0, opacity = 1, children }: RectProps & { color: string; radius?: number; opacity?: number; children?: ReactNode }): JSX.Element {
  return (
    <div style={{ position: 'absolute', left: x, top: y, width: w, height: h, background: color, borderRadius: radius, opacity, overflow: 'hidden' }}>
      {children}
    </div>
  );
}

/**
 * The same region of another screenshot of the same size, laid over this one: a moment the shot
 * doesn't show, such as the composer before a turn starts. Its edges must fall where the two
 * screenshots are alike. In image pixels.
 */
export function ShotRegion({ shot, x, y, w, h }: RectProps & { shot: Shot }): JSX.Element {
  const C = useTheme();
  return (
    <div style={{ position: 'absolute', left: x, top: y, width: w, height: h, overflow: 'hidden' }}>
      <Img src={staticFile(`ui/${shotFile(shot, C.name)}`)} style={{ position: 'absolute', left: -x, top: -y, width: shot.w, height: shot.h, maxWidth: 'none' }} />
    </div>
  );
}

/** Text that types itself out between two frames, with a caret while it types. */
export function Typed({
  text,
  frame,
  from,
  to,
  style,
  caret = true,
  mono = false,
}: {
  text: string;
  frame: number;
  from: number;
  to: number;
  style?: CSSProperties;
  caret?: boolean;
  mono?: boolean;
}): JSX.Element {
  const C = useTheme();
  const chars = Array.from(text);
  const n = Math.round(Math.min(1, Math.max(0, (frame - from) / Math.max(1, to - from))) * chars.length);
  const typing = frame >= from && frame <= to + 12;
  const showCaret = caret && typing && Math.floor(frame / 8) % 2 === 0;
  return (
    <span style={{ fontFamily: mono ? MONO : FONT, whiteSpace: 'pre-wrap', ...style }}>
      {chars.slice(0, n).join('')}
      <span style={{ opacity: showCaret || (caret && frame >= from && n < chars.length) ? 1 : 0, color: C.accent }}>▍</span>
    </span>
  );
}
