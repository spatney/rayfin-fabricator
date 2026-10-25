import { useMemo, type ReactNode } from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import { ease, pop, ramp } from '../anim';
import { FONT, MONO, useTheme } from '../theme';
import { CODE_PALETTES, colorOf, tokenize, type CodeLanguage } from './code';

/** A glowing box around part of a line (1-based), with an optional label beside it. */
export interface CodeMark {
  line: number;
  /** Columns, 0-based; the whole line when omitted. */
  from?: number;
  to?: number;
  /** Frames (in the current sequence) it shows. */
  at: number;
  until: number;
  color?: string;
  label?: ReactNode;
  /** Where the label sits, from the end of the line. Defaults to the right. */
  labelSide?: 'right' | 'below' | 'above';
  /** Extra columns between the line's end and a right-hand label. */
  labelGap?: number;
  /** The column a label above or below starts at, to clear the line next to it. The mark's start when omitted. */
  labelFrom?: number;
}

/** A stretch of frames where only some lines are in focus; the others dim. */
export interface CodeFocus {
  lines: readonly number[];
  from: number;
  to: number;
}

export interface CodeCardProps {
  code: string;
  /** The file's path, as in Fabricator's editor; its last part is the bright one. */
  file: string;
  /** A small badge before the path, such as "NEW FILE". */
  badge?: string;
  /** Center on screen. */
  x: number;
  y: number;
  width: number;
  fontSize?: number;
  /** Frame it pops in; it's there from the start when omitted. */
  from?: number;
  /** Frame it starts to leave; it stays when omitted. */
  to?: number;
  /** Frames over which the code types itself out; all there when omitted. */
  typeFrom?: number;
  typeTo?: number;
  focus?: readonly CodeFocus[];
  marks?: readonly CodeMark[];
  scale?: number;
  opacity?: number;
  /** First line number shown. */
  firstLine?: number;
  /** How to color the code. TypeScript when omitted. */
  language?: CodeLanguage;
  /**
   * Lines of code the card has room for. When the code is longer, the editor scrolls it under
   * its header: `scroll` is the number of lines scrolled past (animate it to pan).
   */
  rows?: number;
  scroll?: number;
}

const PAD_X = 0.9;

/**
 * Code in a window like Fabricator's editor: the file's path on top, line numbers, and the
 * editor's colors. It can type itself out, dim all but a few lines, and ring parts of lines
 * with labels. Mark and label positions are in characters, so they land on the code exactly.
 */
export function CodeCard({
  code,
  file,
  badge,
  x,
  y,
  width,
  fontSize = 30,
  from,
  to,
  typeFrom,
  typeTo,
  focus = [],
  marks = [],
  scale = 1,
  opacity = 1,
  firstLine = 1,
  language = 'typescript',
  rows,
  scroll = 0,
}: CodeCardProps): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  const P = CODE_PALETTES[C.name];
  const lines = useMemo(() => tokenize(code, language), [code, language]);
  if (from !== undefined && frame < from) return null;
  if (to !== undefined && frame > to + 12) return null;

  const enter = from === undefined ? 1 : pop(frame, fps, from, 13, 0.7);
  const leave = to === undefined ? 1 : 1 - ramp(frame, to, 12, ease.in);
  const lineH = fontSize * 1.55;
  const total = lines.reduce((n, l) => n + l.reduce((m, t) => m + t.text.length, 0) + 1, 0);
  const typed = typeFrom === undefined || typeTo === undefined ? Infinity : Math.round(ramp(frame, typeFrom, typeTo - typeFrom, ease.linear) * total);
  const typing = typed < total && frame >= (typeFrom ?? 0);

  // How much each line is in focus: 1 normally; while a focus is active, 1 for its lines and dim for the rest.
  const focusOf = (n: number) => {
    let dim = 0;
    let lit = 0;
    for (const f of focus) {
      const p = ramp(frame, f.from, 8) * (1 - ramp(frame, f.to, 8));
      if (p <= 0) continue;
      if (f.lines.includes(n)) lit = Math.max(lit, p);
      else dim = Math.max(dim, p);
    }
    return { opacity: 1 - 0.68 * dim * (1 - lit), lit };
  };

  const header = file.split('/');
  const name = header.pop();
  let shown = 0;
  const padTop = fontSize * 0.6;
  const padBottom = fontSize * 0.75;
  // A scrolling editor keeps its height and clips lines above and below it, but not labels beside them.
  const viewport = rows === undefined ? {} : { height: padTop + rows * lineH + padBottom, clipPath: 'inset(0 -2000px 0 -2000px)' };
  return (
    <div
      style={{
        position: 'absolute',
        left: x - width / 2,
        top: y,
        width,
        transform: `translateY(-50%) scale(${scale * (0.9 + 0.1 * enter) * (0.94 + 0.06 * leave)})`,
        opacity: opacity * Math.min(1, enter * 1.4) * leave,
        borderRadius: 18,
        background: P.bg,
        boxShadow: C.shadow.window,
        overflow: 'visible',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, height: fontSize * 1.9, padding: `0 ${fontSize * 0.8}px`, background: P.header, borderBottom: `1.5px solid ${P.border}`, borderRadius: '18px 18px 0 0', fontFamily: MONO, fontSize: fontSize * 0.7, color: P.gutter, whiteSpace: 'nowrap', overflow: 'hidden' }}>
        {badge ? (
          <span style={{ fontFamily: FONT, fontWeight: 700, fontSize: fontSize * 0.55, letterSpacing: '0.06em', color: C.ok, background: `${C.ok}22`, padding: '4px 10px', borderRadius: 6 }}>{badge}</span>
        ) : null}
        <span>
          {header.length ? `${header.join('/')}/` : ''}
          <span style={{ color: P.headerText, fontWeight: 600 }}>{name}</span>
        </span>
      </div>
      <div style={{ position: 'relative', padding: `${padTop}px 0 ${padBottom}px`, fontFamily: MONO, fontSize, lineHeight: `${lineH}px`, fontVariantLigatures: 'contextual', ...viewport }}>
        <div style={{ transform: rows === undefined || !scroll ? undefined : `translateY(${-scroll * lineH}px)` }}>
        {lines.map((tokens, i) => {
          const n = i + 1;
          const f = focusOf(n);
          const start = shown;
          const length = tokens.reduce((m, t) => m + t.text.length, 0);
          shown += length + 1;
          const visible = Math.max(0, Math.min(length, typed - start));
          let left = visible;
          const caretHere = typing && typed >= start && typed <= start + length;
          return (
            <div key={i} style={{ position: 'relative', display: 'flex', opacity: f.opacity }}>
              {f.lit > 0 ? <div style={{ position: 'absolute', inset: 0, background: P.focusLine, opacity: f.lit }} /> : null}
              <span style={{ position: 'relative', width: `${PAD_X + 2.6}ch`, flex: 'none', textAlign: 'right', paddingRight: '1.4ch', color: f.lit > 0.5 ? P.gutterActive : P.gutter }}>{firstLine + i}</span>
              <span style={{ whiteSpace: 'pre', position: 'relative' }}>
                {tokens.map((t, k) => {
                  if (left <= 0) return null;
                  const text = t.text.slice(0, left);
                  left -= text.length;
                  return (
                    <span key={k} style={{ color: colorOf(t, P), fontStyle: t.kind === 'comment' ? 'italic' : 'normal' }}>
                      {text}
                    </span>
                  );
                })}
                {caretHere ? <span style={{ color: C.accent, opacity: Math.floor(frame / 8) % 2 === 0 ? 1 : 0.2 }}>▍</span> : null}
                {marks
                  .filter((m) => m.line === n)
                  .map((m, k) => (
                    <Mark key={k} mark={m} lineLength={length} fontSize={fontSize} lineH={lineH} />
                  ))}
              </span>
            </div>
          );
        })}
        </div>
      </div>
    </div>
  );
}

function Mark({ mark, lineLength, fontSize, lineH }: { mark: CodeMark; lineLength: number; fontSize: number; lineH: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  if (frame < mark.at || frame > mark.until + 10) return null;
  const color = mark.color ?? C.accent;
  const p = pop(frame, fps, mark.at, 12, 0.6);
  const out = 1 - ramp(frame, mark.until, 10, ease.in);
  const from = mark.from ?? 0;
  const to = mark.to ?? lineLength;
  const side = mark.labelSide ?? 'right';
  const pad = 0.35;
  return (
    <>
      <span
        style={{
          position: 'absolute',
          left: `${from - pad}ch`,
          top: lineH * 0.04,
          width: `${to - from + pad * 2}ch`,
          height: lineH * 0.92,
          borderRadius: 8,
          border: `3px solid ${color}`,
          background: `${color}1f`,
          boxShadow: C.glow(`${color}88`, 18, 2),
          transform: `scale(${0.85 + 0.15 * p})`,
          opacity: Math.min(1, p * 1.5) * out,
        }}
      />
      {mark.label ? (
        // Placed in the code's own characters; the label inside has its own font.
        <span
          style={{
            position: 'absolute',
            ...(side === 'right'
              ? { left: `${Math.max(to, lineLength) + (mark.labelGap ?? 2)}ch`, top: lineH / 2, transform: `translateY(-50%) scale(${p})`, transformOrigin: '0% 50%' }
              : side === 'below'
                ? { left: `${mark.labelFrom ?? from}ch`, top: lineH * 1.08, transform: `scale(${p})`, transformOrigin: '0% 0%' }
                : { left: `${mark.labelFrom ?? from}ch`, bottom: lineH * 1.08, transform: `scale(${p})`, transformOrigin: '0% 100%' }),
            opacity: out,
            zIndex: 2,
          }}
        >
          <span
            style={{
              display: 'inline-block',
              padding: `${fontSize * 0.2}px ${fontSize * 0.55}px`,
              borderRadius: 999,
              background: C.chip.bg,
              border: `2px solid ${color}`,
              color: C.chip.text,
              fontFamily: FONT,
              fontWeight: 650,
              fontSize: fontSize * 0.9,
              lineHeight: 1.2,
              whiteSpace: 'nowrap',
              boxShadow: `${C.shadow.chip}, ${C.glow(`${color}44`, 20)}`,
            }}
          >
            {mark.label}
          </span>
        </span>
      ) : null}
    </>
  );
}
