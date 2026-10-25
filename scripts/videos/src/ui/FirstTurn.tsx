import { Img, staticFile, useCurrentFrame } from 'remotion';
import { ease, ramp } from '../anim';
import { shotFile } from '../shots';
import { FONT, useTheme } from '../theme';
import { Patch, SHOTS, ShotRegion, Typed } from './AppWindow';

/** Image pixels per CSS pixel in the app's 1600-wide screenshots. */
const K = 1.104;

/**
 * chat-working's turn in image pixels: its prompt's bubble, then its work log, whose rows lie
 * between these lines (each one in the gap between two rows, so a row shows whole).
 */
const BUBBLE = { right: 769, bottom: 499.5, maxWidth: 633 };
const ROWS = [520, 596, 629, 662, 696, 729, 762, 801, 845] as const;
/** Where a fresh chat's first message starts, as in the workbench shot. */
const FIRST_TOP = 117;
/** Where its bubble starts rising from as it's sent: just above the composer. */
const RISE_FROM = 800;

/** Narration rows that talk about the shot's own prompt, and what they say for this one instead. */
const NOTES: Readonly<Record<number, { top: number; text: string }>> = {
  1: { top: 600, text: "Now I'll add the dashboard: this month's total, the chart by category and the expense form." },
  3: { top: 667, text: 'Now add the table of recent expenses, newest first, under the chart:' },
};

export interface FirstTurnProps {
  /** What the user types into the composer and sends. */
  prompt: string;
  /** Frames: the prompt types out between `typeFrom` and `typeTo` and is sent at `sent`. */
  typeFrom: number;
  typeTo: number;
  sent: number;
  /** The frame each of the work log's rows shows, top to bottom. */
  rows: readonly number[];
  /** The frame the app shows up in the preview. */
  app: number;
}

/** The number of rows in the work log. */
export const FIRST_TURN_ROWS = ROWS.length - 1;

/** The finished turn, for a scene that starts where it left off. */
export const FIRST_TURN_DONE: Omit<FirstTurnProps, 'prompt'> = {
  typeFrom: -1000,
  typeTo: -1000,
  sent: -1000,
  rows: new Array(FIRST_TURN_ROWS).fill(-1000),
  app: -1000,
};

/**
 * A new project's first chat turn, over chat-working (as an AppWindow's children): the chat
 * starts empty with the prompt typing into the idle composer; once sent, the prompt rises to the
 * top of the chat as its bubble and the shot's own work log fills in under it, row by row; then
 * the app shows up in the preview. The bubble and the narration are drawn as the app draws them.
 */
export function FirstTurn({ prompt, typeFrom, typeTo, sent, rows, app }: FirstTurnProps): JSX.Element {
  const frame = useCurrentFrame();
  const C = useTheme();
  const src = staticFile(`ui/${shotFile(SHOTS.chatWorking, C.name)}`);
  const shown = ramp(frame, sent, 4);
  const rise = 1 - ramp(frame, sent, 18, ease.inOut);
  return (
    <>
      {/* An empty chat, and a blank preview until the app is built. */}
      <Patch x={0} y={96} w={799} h={753} color={C.bg} />
      <Patch x={805} y={97} w={795} h={862} color={C.sampleApp.bg} opacity={1 - ramp(frame, app, 10)} />

      <div style={{ position: 'absolute', left: 0, top: FIRST_TOP, width: BUBBLE.right, display: 'flex', flexDirection: 'column' }}>
        <div
          style={{
            alignSelf: 'flex-end',
            boxSizing: 'border-box',
            maxWidth: BUBBLE.maxWidth,
            padding: `${9 * K}px ${14 * K}px`,
            border: `${K}px solid ${C.chat.bubbleBorder}`,
            borderRadius: `${18 * K}px ${18 * K}px ${6 * K}px ${18 * K}px`,
            background: C.chat.bubble,
            color: C.chat.text,
            fontFamily: FONT,
            fontSize: 14 * K,
            lineHeight: 1.55,
            whiteSpace: 'pre-wrap',
            opacity: shown,
            transform: `translateY(${rise * (RISE_FROM - FIRST_TOP)}px)`,
          }}
        >
          {prompt}
        </div>
        <div style={{ height: ROWS[0] - BUBBLE.bottom }} />
        {ROWS.slice(0, -1).map((top, i) => {
          const note = NOTES[i];
          return (
            <div key={top} style={{ position: 'relative', width: 784, height: ROWS[i + 1] - top, overflow: 'hidden', opacity: ramp(frame, rows[i], 5) }}>
              <Img src={src} style={{ position: 'absolute', left: 0, top: -top, width: SHOTS.chatWorking.w, height: SHOTS.chatWorking.h, maxWidth: 'none' }} />
              {note ? (
                <div style={{ position: 'absolute', left: 36, right: 0, top: 0, bottom: 0, background: C.bg }}>
                  <div style={{ position: 'absolute', left: 42 - 36, top: note.top - top, fontFamily: FONT, fontSize: 13 * K, lineHeight: 1.55, color: C.chat.note, whiteSpace: 'nowrap' }}>{note.text}</div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {frame < sent ? (
        <>
          {/* Until it's sent, the composer is idle, as in the workbench shot, and the prompt types into it. */}
          <ShotRegion shot={SHOTS.workbench} x={4} y={844} w={789} h={109} />
          {frame >= typeFrom ? <Patch x={28} y={866} w={326} h={28} color={C.composer} /> : null}
          <Typed text={prompt} frame={frame} from={typeFrom} to={typeTo} style={{ position: 'absolute', left: 32, top: 868, fontSize: 14 * K, lineHeight: '22px', color: C.chat.text, whiteSpace: 'nowrap' }} />
        </>
      ) : null}
    </>
  );
}
