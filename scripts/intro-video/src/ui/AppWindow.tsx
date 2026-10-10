import type { CSSProperties, ReactNode } from 'react';
import { Img, staticFile } from 'remotion';
import { C, FONT, MONO } from '../theme';

export interface Shot {
  src: string;
  w: number;
  h: number;
}

/** The scrubbed sample-data screenshots, copied from website/public by `npm run assets`. */
export const SHOTS = {
  workbench: { src: 'ui/workbench.webp', w: 1600, h: 1000 },
  chatWorking: { src: 'ui/chat-working.webp', w: 1600, h: 1000 },
  newProject: { src: 'ui/new-project.webp', w: 1600, h: 422 },
  deployProgress: { src: 'ui/deploy-progress.webp', w: 1140, h: 1080 },
  design: { src: 'ui/design.webp', w: 1080, h: 1290 },
  advisor: { src: 'ui/advisor.webp', w: 1600, h: 1000 },
  history: { src: 'ui/history.webp', w: 1600, h: 1000 },
  help: { src: 'ui/help.webp', w: 1600, h: 756 },
  share: { src: 'ui/share.webp', w: 960, h: 630 },
  deployError: { src: 'ui/deploy-error.webp', w: 1356, h: 201 },
} satisfies Record<string, Shot>;

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
  const fit = width / shot.w;
  const h = height ?? shot.h * fit;
  const s = fit * zoom;
  const cx = fx ?? shot.w / 2;
  const cy = fy ?? shot.h / 2;
  const tx = Math.min(0, Math.max(width - shot.w * s, width / 2 - cx * s));
  const ty = Math.min(0, Math.max(h - shot.h * s, h / 2 - cy * s));

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
        boxShadow: `0 0 0 1px rgba(255,255,255,0.08), 0 30px 90px rgba(0,0,0,0.55), 0 20px 70px rgba(15,108,189,0.22)`,
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
        <Img src={staticFile(shot.src)} style={{ display: 'block', width: shot.w, height: shot.h }} />
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
        boxShadow: `0 0 0 4000px rgba(3,7,13,${dim * opacity}), 0 0 0 3px ${C.accent}, 0 0 28px 6px ${C.accent}88`,
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
