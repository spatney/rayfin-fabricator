import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { spokenText } from '../../script/lines';
import { ramp } from '../anim';
import { FONT, useTheme } from '../theme';
import { at } from '../lesson-kit/stations';
import type { LessonScript } from './plan';
import type { LessonCtx, LessonScene } from './types';

/** A draft scene for every scene of a script: the lesson as an animatic. */
export function draftScenes(script: LessonScript): LessonScene[] {
  return script.scenes.map((scene) =>
    draftScene(scene.id, Object.fromEntries(scene.beats.flatMap((b) => (b.text ? [[b.id, spokenText(b.text)] as const] : [])))),
  );
}

/**
 * A stand-in scene: the scene's id, and what Ray says as subtitles, with Ray front and center.
 * `npm run lesson:new` starts every scene as one, so a lesson plays as an animatic from the
 * start; replace each with the real scene as you build it.
 */
export function draftScene(id: string, lines: Record<string, string>): LessonScene {
  return {
    id,
    ray: () => ({ keys: [at(0, 'center')], moods: [{ f: 0, mood: 'happy' }] }),
    View: ({ ctx }: { ctx: LessonCtx }) => <DraftView ctx={ctx} lines={lines} />,
  };
}

function DraftView({ ctx, lines }: { ctx: LessonCtx; lines: Record<string, string> }): JSX.Element {
  const frame = useCurrentFrame();
  const C = useTheme();
  const current = Object.keys(lines).find((id) => {
    const b = ctx.beat(id);
    return frame >= b.from && frame < b.to + 8;
  });
  return (
    <AbsoluteFill>
      <div style={{ position: 'absolute', left: 48, top: 40, padding: '8px 20px', borderRadius: 999, border: `2px dashed ${C.border}`, fontFamily: FONT, fontSize: 26, color: C.inkDim, opacity: ramp(frame, 0, 8) }}>draft · {ctx.id}</div>
      {current ? (
        <div style={{ position: 'absolute', left: 160, right: 160, bottom: 90, textAlign: 'center', fontFamily: FONT, fontWeight: 600, fontSize: 46, lineHeight: 1.3, color: C.ink, textShadow: C.shadow.title }}>{lines[current]}</div>
      ) : null}
    </AbsoluteFill>
  );
}
