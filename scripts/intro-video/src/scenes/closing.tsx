import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { ease, fadeOut, pop, ramp } from '../anim';
import { Burst } from '../fx/Burst';
import { RayActor } from '../ray/RayActor';
import { AppWindow, SHOTS, Spotlight, type Shot } from '../ui/AppWindow';
import { EndCard } from '../ui/Brand';
import { Chip } from '../ui/Kit';
import type { SceneDef } from './types';

/* ---------------------------------- 9. Tricks ---------------------------------- */

/** A screen that slides in from the right and leaves to the left. */
function Card({ shot, from, to, zoom, fx, fy, shake = false, children }: { shot: Shot; from: number; to: number; zoom?: number; fx?: number; fy?: number; shake?: boolean; children?: React.ReactNode }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < from || frame > to + 14) return null;
  const inP = pop(frame, fps, from, 14, 0.8);
  const outP = ramp(frame, to, 14, ease.in);
  const jiggle = shake ? Math.sin((frame - from) * 2.2) * 14 * Math.max(0, 1 - (frame - from) / 18) : 0;
  return (
    <AppWindow
      shot={shot}
      x={1100 + (1 - inP) * 1300 - outP * 500 + jiggle}
      y={560}
      width={1300}
      zoom={zoom}
      fx={fx}
      fy={fy}
      opacity={Math.min(1, inP * 1.5) * (1 - outP)}
      scale={1 - outP * 0.12}
    >
      {children}
    </AppWindow>
  );
}

export const tricks: SceneDef = {
  id: 'tricks',
  ray: (c) => ({
    keys: [
      { f: 0, x: 230, y: 760, s: 0.6 },
      { f: 20, x: 290, y: 640, s: 0.64, e: ease.inOut },
      { f: c.w('dig') - 4, x: 290, y: 640 },
      { f: c.w('dig') + 8, x: 300, y: 620 },
    ],
    moods: [
      { f: 0, mood: 'read', glasses: true },
      { f: c.w('History') - 2, mood: 'surprised' },
      { f: c.w('keeps') + 6, mood: 'happy' },
      { f: c.w('something'), mood: 'worried' },
      { f: c.w('dig') - 2, mood: 'read', glasses: true },
      { f: c.w('you'), mood: 'happy' },
    ],
    rolls: [c.w('History')],
    hops: [c.wEnd('you')],
    gaze: [
      [0, 1, -0.2],
      [c.w('History'), 1, 0],
      [c.w('something'), 1, 0.2],
      [c.w('you'), 0, 0.1],
    ],
  }),
  sfx: (c) => [
    { f: 2, id: 'swim-whoosh', volume: 0.25 },
    { f: c.w('grades'), id: 'stamp', volume: 0.6 },
    { f: c.w('History') - 2, id: 'rewind', volume: 0.5 },
    { f: c.w('breaks'), id: 'thud', volume: 0.55 },
    { f: c.w('dig'), id: 'sweep', volume: 0.25 },
    { f: c.w('logs'), id: 'shimmer', volume: 0.3 },
  ],
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const history = ctx.w('History') - 4;
    const breaks = ctx.w('something') - 4;
    const help = ctx.w("I'll") - 4;
    const end = ctx.span.duration;
    return (
      <AbsoluteFill>
        <Card shot={SHOTS.advisor} from={0} to={history} zoom={1.2} fx={790} fy={230}>
          <Spotlight x={138} y={140} w={92} h={92} radius={46} opacity={ramp(frame, ctx.w('grades'), 6) * fadeOut(frame, history, 6)} />
        </Card>
        <Card shot={SHOTS.history} from={history} to={breaks} zoom={1.4} fx={480} fy={330}>
          <Spotlight x={6} y={244} w={312} h={182} radius={10} opacity={ramp(frame, ctx.w('keeps'), 6) * fadeOut(frame, breaks, 6)} />
        </Card>
        <Card shot={SHOTS.deployError} from={breaks} to={help} shake />
        <Card shot={SHOTS.help} from={help} to={end - 12} zoom={1.12} fx={760} fy={260}>
          <Spotlight x={336} y={140} w={920} h={330} radius={14} dim={0.35} opacity={ramp(frame, ctx.w('logs') - 2, 8)} />
        </Card>
        <Chip x={1100} y={118} from={2} to={history - 2}>
          The Advisor
        </Chip>
        <Chip x={1100} y={118} from={history + 4} to={breaks - 2}>
          History
        </Chip>
        <Chip x={1100} y={218} from={help + 4} to={end - 12}>
          Help
        </Chip>
        <Burst kind="sparkles" at={ctx.w('grades')} x={1100 - 650 + 184 * (1300 / 1600) * 1.2} y={300} count={10} seed={61} spread={1.5} />
      </AbsoluteFill>
    );
  },
};

/* ----------------------------------- 10. Outro ----------------------------------- */

export const outro: SceneDef = {
  id: 'outro',
  ray: (c) => ({
    keys: [
      { f: 0, x: 300, y: 620, s: 0.64 },
      { f: 26, x: 1600, y: 280, s: 0.62, e: ease.inOut },
    ],
    moods: [{ f: 0, mood: 'happy' }],
    waves: [c.w('hi') - 6],
    hops: [c.w('come')],
    gaze: [
      [0, 1, -0.4],
      [26, -0.5, 0.2],
      [c.w('Download'), -0.4, 0.6],
      [c.w('come'), 0, 0.1],
    ],
  }),
  sfx: (c) => [
    { f: 0, id: 'swim-whoosh', volume: 0.35 },
    { f: 4, id: 'shimmer', volume: 0.4 },
    { f: c.w('Download'), id: 'pop', volume: 0.5 },
    { f: c.w('hi'), id: 'bubbles', volume: 0.35 },
  ],
  View: ({ ctx }) => (
    <AbsoluteFill>
      <EndCard start={2} copilotAt={ctx.w('GitHub')} downloadAt={ctx.w('Download')} />
      <Burst kind="sparkles" at={4} x={960} y={270} count={14} seed={71} spread={3} />
      <Burst kind="hearts" at={ctx.w('hi')} x={1600} y={190} count={6} seed={72} />
      <Burst kind="bubbles" at={ctx.w('hi') + 3} x={1600} y={300} count={8} seed={73} />
    </AbsoluteFill>
  ),
};

/* ---------------------------------- 11. Stinger ---------------------------------- */

const FEVER = [0, 1, 2, 3, 4, 5, 6].map((i) => ({
  delay: i * 4,
  y: 230 + ((i * 137) % 600),
  size: 70 + ((i * 37) % 50),
  bob: (i % 2 ? 1 : -1) * (20 + i * 4),
}));

export const stinger: SceneDef = {
  id: 'stinger',
  ray: (c) => {
    const back = c.wEnd('up') + 4;
    return {
      keys: [
        { f: 0, x: 1600, y: 280, s: 0.62 },
        { f: 16, x: 1630, y: 790, s: 1.2, e: ease.out },
        { f: c.w('fever'), x: 1620, y: 780 },
        { f: c.w('fever') + 10, x: 1645, y: 805, r: 8 },
        { f: c.w("I'm"), x: 1630, y: 790, r: 0 },
        { f: back, x: 1630, y: 790 },
        { f: back + 22, x: 1600, y: 280, s: 0.62, e: ease.inOut },
      ],
      moods: [
        { f: 0, mood: 'idle' },
        { f: c.w('fever') + 2, mood: 'happy' },
        { f: c.w("I'm"), mood: 'idle' },
        { f: c.w('up'), mood: 'happy' },
      ],
      squishes: [c.wEnd('up') - 4],
      waves: [back + 24],
      gaze: [
        [0, -0.2, 0.2],
        [16, 0, 0.1],
        [c.w('fever'), -0.9, -0.3],
        [c.w("I'm"), 0, 0.1],
      ],
    };
  },
  sfx: (c) => [
    { f: 0, id: 'swim-whoosh', volume: 0.35 },
    { f: c.w('fever'), id: 'bubbles', volume: 0.4 },
    { f: c.w('fever') + 6, id: 'swim-whoosh', volume: 0.3 },
    { f: c.wEnd('up') + 4, id: 'swim-whoosh', volume: 0.4 },
  ],
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const fever = ctx.w('fever') - 4;
    const back = ctx.wEnd('up') + 4;
    const dim = ramp(frame, 0, 14) * (1 - ramp(frame, back, 18));
    return (
      <AbsoluteFill>
        <EndCard start={-200} copilotAt={-200} downloadAt={-200} dim={dim} />
        {/* A fever of stingrays. */}
        {FEVER.map((r, i) => (
          <RayActor
            key={i}
            size={r.size}
            seed={80 + i}
            keys={[
              { f: fever + r.delay, x: -160, y: r.y },
              { f: fever + r.delay + 40, x: 900, y: r.y + r.bob, e: ease.linear },
              { f: fever + r.delay + 80, x: 2100, y: r.y, e: ease.linear },
            ]}
            moods={[{ f: 0, mood: 'happy' }]}
            style={{ opacity: frame >= fever + r.delay ? 1 : 0 }}
          />
        ))}
        <Burst kind="bubbles" at={back + 4} x={1630} y={720} count={10} seed={91} />
      </AbsoluteFill>
    );
  },
};
