import type { ReactNode } from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import { ease, pop, ramp } from '../anim';
import { Burst } from '../fx/Burst';
import { FONT, MONO, useTheme } from '../theme';
import { Icon } from './icons';

export interface QuizOption {
  text: ReactNode;
  /** Shown in the editor's monospace font. */
  code?: boolean;
  /** Frame the option pops in. */
  at: number;
}

/** Where the options sit, for aiming effects at them. */
export function quizOptionY(i: number, count: number): number {
  return 600 + (i - (count - 1) / 2) * 150;
}

/**
 * Ray's pop quiz: a question, three answers that pop in on their cues, a bubble countdown for
 * pausing and guessing, then the right answer lights up (with confetti) and the others dim.
 */
export function Quiz({ question, options, answer, countdown, revealAt, from, to, x = 900 }: { question: ReactNode; options: readonly QuizOption[]; answer: number; countdown?: { from: number; step: number }; revealAt: number; from: number; to: number; x?: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  if (frame < from || frame > to + 12) return null;
  const p = pop(frame, fps, from, 13, 0.7);
  const out = 1 - ramp(frame, to, 12, ease.in);
  const revealed = frame >= revealAt;
  const width = 1180;
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: out }}>
      <div style={{ position: 'absolute', left: x - width / 2, top: 92, width, display: 'flex', alignItems: 'center', gap: 22, opacity: Math.min(1, p * 1.4), transform: `translateY(${(1 - p) * -30}px)` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 24px 10px 16px', borderRadius: 999, background: C.star, color: '#1b1200', fontFamily: FONT, fontWeight: 800, fontSize: 32, letterSpacing: '0.1em', transform: `rotate(${-3 + Math.sin(frame / 9) * 1.5}deg)` }}>
          <Icon name="question" color="#1b1200" size={36} stroke={2.4} />
          POP QUIZ
        </div>
      </div>
      <div style={{ position: 'absolute', left: x - width / 2, top: 196, width, fontFamily: FONT, fontWeight: 750, fontSize: 58, lineHeight: 1.18, letterSpacing: '-0.02em', color: C.ink, textShadow: C.shadow.title, opacity: Math.min(1, p * 1.4) }}>{question}</div>
      {options.map((opt, i) => {
        const q = frame < opt.at ? 0 : pop(frame, fps, opt.at, 12, 0.6);
        const right = i === answer;
        const r = revealed ? pop(frame, fps, revealAt, 11, 0.6) : 0;
        const color = revealed && right ? C.ok : C.accent;
        const y = quizOptionY(i, options.length);
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: x - width / 2,
              top: y - 58,
              width,
              height: 116,
              display: 'flex',
              alignItems: 'center',
              gap: 28,
              padding: '0 34px',
              borderRadius: 24,
              background: revealed && right ? `${C.ok}26` : C.panel.bg,
              border: `3px solid ${revealed && right ? C.ok : C.panel.border}`,
              boxShadow: `${C.shadow.panel}${revealed && right ? `, ${C.glow(`${C.ok}66`, 36, 4)}` : ''}`,
              opacity: Math.min(1, q * 1.5) * (revealed && !right ? 1 - 0.55 * Math.min(1, r) : 1),
              transform: `translateX(${(1 - q) * 120}px) scale(${revealed && right ? 1 + 0.04 * Math.min(1, r) : 1})`,
            }}
          >
            <div style={{ width: 64, height: 64, flex: 'none', borderRadius: 16, display: 'grid', placeItems: 'center', background: color, color: '#fff', fontFamily: FONT, fontWeight: 800, fontSize: 36 }}>
              {revealed && right ? <Icon name="check" color="#fff" size={40} stroke={3} /> : String.fromCharCode(65 + i)}
            </div>
            <div style={{ fontFamily: opt.code ? MONO : FONT, fontWeight: opt.code ? 500 : 650, fontSize: opt.code ? 42 : 46, color: C.ink, whiteSpace: 'nowrap' }}>{opt.text}</div>
          </div>
        );
      })}
      {countdown ? <Countdown from={countdown.from} step={countdown.step} x={x + width / 2 + 170} y={600} /> : null}
      {revealed ? <Burst kind="confetti" at={revealAt} x={x} y={quizOptionY(answer, options.length)} count={52} seed={41} spread={1.4} /> : null}
    </div>
  );
}

/** Three bubbles that pop, 3, 2, 1: time to pause the video and guess. */
function Countdown({ from, step, x, y }: { from: number; step: number; x: number; y: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  if (frame < from || frame > from + step * 3 + 8) return null;
  const i = Math.min(2, Math.floor((frame - from) / step));
  const local = frame - from - i * step;
  const p = pop(local, fps, 0, 9, 0.5);
  const burst = local > step - 5 ? ramp(local, step - 5, 5) : 0;
  return (
    <div style={{ position: 'absolute', left: x - 110, top: y - 110, width: 220, height: 220, borderRadius: '50%', display: 'grid', placeItems: 'center', border: `5px solid ${C.bubble.ring}`, background: C.bubble.fill, boxShadow: C.glow(`${C.bubble.ring}66`, 30), transform: `scale(${p * (1 + burst * 0.4)})`, opacity: 1 - burst, fontFamily: FONT, fontWeight: 800, fontSize: 120, color: C.ink }}>
      {3 - i}
    </div>
  );
}
