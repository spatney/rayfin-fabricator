import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { ease, fadeOut, pop, ramp, track } from '../anim';
import { Burst, DizzyStars } from '../fx/Burst';
import { AppWindow, Patch, SHOTS, Typed } from '../ui/AppWindow';
import { AppTile, FabricPortal, Wordmark } from '../ui/Brand';
import { Cursor } from '../ui/Cursor';
import { BrowserWindow, Terminal } from '../ui/Kit';
import { C } from '../theme';
import { rayAt, type SceneCtx, type SceneDef } from './types';

/* --------------------------------- 1. Hello --------------------------------- */

const helloRay = (c: SceneCtx) => {
  const fab = c.w('Fabricator');
  return {
    keys: [
      { f: 0, x: -260, y: 1250, s: 0.85 },
      { f: 16, x: 620, y: 640, s: 1, e: ease.linear },
      { f: 32, x: 960, y: 470, e: ease.out },
      { f: fab - 4, x: 960, y: 470 },
      { f: fab + 14, x: 960, y: 395, s: 0.9, e: ease.out },
    ],
  };
};

export const hello: SceneDef = {
  id: 'hello',
  ray: (c) => ({
    ...helloRay(c),
    moods: [{ f: 0, mood: 'happy' }],
    rolls: [5],
    squishes: [33],
    waves: [c.w('hi')],
    gaze: [
      [0, 0.7, -0.3],
      [30, 0, 0.1],
    ],
  }),
  sfx: (c) => [
    { f: 0, id: 'swim-whoosh', volume: 0.55 },
    { f: c.w('hi'), id: 'bubbles', volume: 0.3 },
    { f: c.w('Fabricator'), id: 'shimmer', volume: 0.45 },
  ],
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const fab = ctx.w('Fabricator');
    const end = ctx.span.duration;
    const mouth = rayAt(helloRay(ctx).keys, ctx.w('hi'));
    return (
      <AbsoluteFill>
        <Burst kind="bubbles" at={ctx.w('hi')} x={mouth.x} y={mouth.y + 20} count={9} seed={1} />
        <Wordmark x={960} y={780} size={118} from={fab} opacity={fadeOut(frame, end, 12)} />
        <Burst kind="sparkles" at={fab + 2} x={960} y={780} count={14} seed={2} spread={2.6} />
        <AbsoluteFill style={{ background: '#000', opacity: 1 - ramp(frame, 0, 14) }} />
      </AbsoluteFill>
    );
  },
};

/* -------------------------------- 2. Old way -------------------------------- */

type PileItem =
  | { at: number; x: number; y: number; rot: number; kind: 'term'; title: string; lines: Array<{ text: string; color?: string }> }
  | { at: number; x: number; y: number; rot: number; kind: 'browser'; url: string };

const PROMPT_COLOR = '#f9f1a5';

function pile(c: SceneCtx): PileItem[] {
  const browser = c.w('browser');
  return [
    { at: c.w('Rayfin') - 2, x: 470, y: 300, rot: -5, kind: 'term', title: 'PowerShell', lines: [{ text: 'PS> npm create @microsoft/rayfin', color: PROMPT_COLOR }, { text: '√ Project name … contoso-expenses' }, { text: '√ Template … Universal App' }] },
    { at: c.w('juggling') - 2, x: 860, y: 480, rot: 4, kind: 'term', title: 'PowerShell', lines: [{ text: 'PS> rayfin up', color: PROMPT_COLOR }, { text: '[rayfin] workspace: Resolving workspace' }, { text: '[rayfin] data: Applying database…' }] },
    { at: c.w('Copilot') - 2, x: 430, y: 650, rot: -2, kind: 'term', title: 'Copilot CLI', lines: [{ text: 'PS> copilot', color: PROMPT_COLOR }, { text: '> Build an expense tracker for my team', color: '#9ccfff' }, { text: '● Thinking…', color: '#7d7d7d' }] },
    { at: c.w('git') - 2, x: 930, y: 260, rot: 6, kind: 'term', title: 'Git Bash', lines: [{ text: '$ git commit -am "fix?"', color: PROMPT_COLOR }, { text: '[main 4aeae0d] fix?' }, { text: ' 7 files changed' }] },
    { at: browser - 2, x: 700, y: 560, rot: -3, kind: 'browser', url: 'localhost:5173' },
    { at: browser + 8, x: 330, y: 420, rot: 8, kind: 'term', title: 'PowerShell', lines: [{ text: 'PS> npm install', color: PROMPT_COLOR }, { text: 'added 1,204 packages in 2m' }] },
    { at: browser + 14, x: 1000, y: 720, rot: -7, kind: 'term', title: 'PowerShell', lines: [{ text: 'PS> rayfin up', color: PROMPT_COLOR }, { text: '× Deployment failed', color: '#ff7b8d' }] },
    { at: browser + 20, x: 560, y: 840, rot: 3, kind: 'term', title: 'Git Bash', lines: [{ text: '$ git push', color: PROMPT_COLOR }, { text: 'Everything up-to-date' }] },
  ];
}

const oldWayRay = (c: SceneCtx) => {
  const whoa = c.w('whoa');
  const spin = c.w('The');
  const end = c.wEnd('spinning');
  return {
    keys: [
      { f: 0, x: 960, y: 395, s: 0.9 },
      { f: 26, x: 1480, y: 560, s: 0.85, e: ease.inOut },
      { f: whoa - 4, x: 1480, y: 560 },
      { f: whoa + 6, x: 1500, y: 600, r: -14, e: ease.out },
      { f: spin, x: 1490, y: 590, r: 10 },
      { f: spin + 14, x: 1470, y: 570, r: -12 },
      { f: spin + 28, x: 1490, y: 590, r: 9 },
      { f: end + 4, x: 1480, y: 570, r: 0 },
    ],
  };
};

export const oldWay: SceneDef = {
  id: 'old-way',
  ray: (c) => ({
    ...oldWayRay(c),
    moods: [
      { f: 0, mood: 'idle' },
      { f: c.w('juggling'), mood: 'surprised' },
      { f: c.w('whoa') - 3, mood: 'dizzy' },
      { f: c.wEnd('spinning') + 6, mood: 'worried' },
    ],
    squishes: [c.w('whoa') - 3],
    rolls: [c.w('whoa') + 2],
    gaze: [
      [0, -0.3, 0.1],
      [c.w('CLIs'), -0.8, 0],
      [c.w('git'), -0.6, -0.5],
      [c.w('browser'), -0.9, 0.2],
    ],
  }),
  sfx: (c) => {
    const items = pile(c);
    return [
      { f: 2, id: 'swim-whoosh', volume: 0.35 },
      ...items.map((it, i) => ({ f: it.at + 6, id: 'thud' as const, volume: 0.32 + (i % 3) * 0.06 })),
      { f: c.w('whoa') - 3, id: 'boing', volume: 0.55 },
      { f: c.w('whoa'), id: 'dizzy', volume: 0.5 },
      { f: c.span.duration - 18, id: 'sweep', volume: 0.55 },
    ];
  },
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const items = pile(ctx);
    const spinFrom = ctx.w('The');
    const spinTo = ctx.wEnd('spinning');
    const roomRot = track(frame, [
      [spinFrom, 0],
      [spinFrom + 12, 9],
      [spinFrom + 26, -6],
      [spinTo, 5],
      [spinTo + 10, 3],
    ]);
    const sweepStart = ctx.span.duration - 17;
    const sweep = ramp(frame, sweepStart, 14, ease.in);
    const head = rayAt(oldWayRay(ctx).keys, ctx.w('whoa'));
    return (
      <AbsoluteFill>
        <AbsoluteFill style={{ transform: `rotate(${roomRot}deg)`, transformOrigin: '42% 50%' }}>
          {items.map((it, i) => {
            if (frame < it.at) return null;
            const p = pop(frame, fps, it.at, 10, 0.7);
            const drop = (1 - p) * -760;
            const x = it.x + (960 - it.x) * sweep;
            const y = it.y + drop + (540 - it.y) * sweep;
            const scale = (0.86 + 0.14 * p) * (1 - sweep * 0.96);
            const rot = it.rot * (1 + (1 - p) * 3) + sweep * 160;
            return (
              <div key={i} style={{ position: 'absolute', left: x, top: y, transform: `translate(-50%, -50%) rotate(${rot}deg) scale(${scale})`, opacity: 1 - ramp(frame, sweepStart + 9, 6) }}>
                {it.kind === 'term' ? <Terminal title={it.title} lines={it.lines} width={540} /> : <BrowserWindow url={it.url} width={560} />}
              </div>
            );
          })}
        </AbsoluteFill>
        {/* The one that lands on his head. */}
        {(() => {
          const hit = ctx.w('whoa') - 3;
          if (frame < hit - 10 || frame > hit + 24) return null;
          const t = (frame - (hit - 10)) / 10;
          const x = frame < hit ? 1880 - (1880 - 1490) * t : 1490 + (frame - hit) * 9;
          const y = frame < hit ? -200 + (330 + 200) * t : 330 + (frame - hit) * (frame - hit) * 2.4 + (frame - hit) * -6;
          return (
            <div style={{ position: 'absolute', left: x, top: y, transform: `translate(-50%, -50%) rotate(${frame < hit ? -18 : -18 + (frame - hit) * 9}deg) scale(0.7)` }}>
              <Terminal title="PowerShell" lines={[{ text: 'PS> rayfin up --again', color: PROMPT_COLOR }]} width={460} />
            </div>
          );
        })()}
        <DizzyStars x={head.x} y={head.y - 120} radius={150} from={ctx.w('whoa')} to={ctx.wEnd('spinning') + 4} />
        {/* Everything gets swept into one place. */}
        <AbsoluteFill style={{ background: `radial-gradient(circle at 50% 50%, ${C.accent}${Math.round(sweep * 120).toString(16).padStart(2, '0')}, transparent 40%)` }} />
      </AbsoluteFill>
    );
  },
};

/* ------------------------------- 3. One window ------------------------------ */

export const oneWindow: SceneDef = {
  id: 'one-window',
  ray: (c) => ({
    keys: [
      { f: 0, x: 1480, y: 570, s: 0.85 },
      { f: 24, x: 1715, y: 205, s: 0.55, e: ease.inOut },
    ],
    moods: [{ f: 0, mood: 'happy' }],
    squishes: [6],
    hops: [c.w('one')],
    gaze: [
      [0, -0.4, 0.2],
      [26, -0.7, 0.5],
    ],
  }),
  sfx: (c) => [{ f: c.w('one'), id: 'chime', volume: 0.42 }],
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const p = pop(frame, fps, 4, 12, 0.8);
    const ring = ramp(frame, ctx.w('one'), 26, ease.out);
    const out = fadeOut(frame, ctx.span.duration, 10);
    return (
      <AbsoluteFill style={{ opacity: out }}>
        <AppWindow shot={SHOTS.workbench} x={960} y={560} width={1400} scale={0.2 + 0.8 * p} opacity={Math.min(1, p * 2)} />
        {ring > 0 && ring < 1 ? (
          <div style={{ position: 'absolute', left: 960 - 700 - ring * 40, top: 560 - 437.5 - ring * 40, width: 1400 + ring * 80, height: 875 + ring * 80, borderRadius: 26, border: `4px solid ${C.accent}`, opacity: 1 - ring, boxShadow: `0 0 40px ${C.accent}` }} />
        ) : null}
        <AbsoluteFill style={{ background: '#fff', opacity: Math.max(0, 0.35 - frame / 20) }} />
      </AbsoluteFill>
    );
  },
};

/* ------------------------------- 4. To Fabric ------------------------------- */

const fabricRay = (c: SceneCtx) => {
  const swim = c.w('swim');
  const fabric = c.w('Fabric');
  const hey = c.w('Hey');
  return {
    keys: [
      { f: 0, x: 1715, y: 205, s: 0.55 },
      { f: swim - 14, x: 1640, y: 700, s: 0.6 },
      { f: swim, x: 760, y: 660, s: 0.62, e: ease.inOut },
      { f: fabric - 2, x: 1280, y: 560, s: 0.62, e: ease.inOut },
      { f: fabric + 6, x: 1240, y: 600 },
      { f: hey - 2, x: 520, y: 600, s: 0.85, e: ease.inOut },
      { f: c.span.duration, x: 520, y: 590 },
    ],
  };
};

export const fabric: SceneDef = {
  id: 'fabric',
  ray: (c) => ({
    ...fabricRay(c),
    moods: [
      { f: 0, mood: 'happy' },
      { f: c.w('Hey') - 2, mood: 'surprised' },
      { f: c.w('me'), mood: 'love' },
      { f: c.w('Fins'), mood: 'happy' },
    ],
    hops: [c.w('Hey'), c.wEnd('crossed')],
    gaze: [
      [0, -0.4, 0.4],
      [c.w('swim'), 0.8, 0],
      [c.w('Hey'), 1, -0.1],
      [c.w("that's"), 0.2, 0.1],
      [c.w('Fins'), 1, -0.3],
    ],
  }),
  sfx: (c) => [
    { f: c.w('Name'), id: 'typing', volume: 0.3, duration: 18 },
    { f: c.w('and'), id: 'click', volume: 0.55 },
    { f: c.w('swim') - 6, id: 'swim-whoosh', volume: 0.5 },
    { f: c.w('Fabric') + 2, id: 'pop', volume: 0.55 },
    { f: c.w('Fabric') + 3, id: 'shimmer', volume: 0.3 },
    { f: c.w('Hey'), id: 'boing', volume: 0.45 },
    { f: c.w('me'), id: 'bubbles', volume: 0.3 },
  ],
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const name = ctx.w('Name');
    const click = ctx.w('and');
    const swim = ctx.w('swim');
    const fabricWord = ctx.w('Fabric');
    const hey = ctx.w('Hey');
    const keys = fabricRay(ctx).keys;

    const form = pop(frame, fps, 0, 13, 0.7) * (1 - ramp(frame, click + 6, 8, ease.in));
    // The tile rides under Ray from when he picks it up until it drops into the portal.
    const pickup = swim;
    const drop = fabricWord + 2;
    const tileIn = pop(frame, fps, click + 8, 12, 0.6);
    const carried = frame >= pickup;
    const ray = rayAt(keys, Math.min(frame, drop));
    const tileX = carried ? ray.x : 760;
    const tileY = carried ? ray.y + 120 : 690;
    const into = ramp(frame, drop, 8, ease.in);
    const deploy = pop(frame, fps, hey - 10, 13, 0.7);
    const fins = ramp(frame, ctx.w('Fins') - 4, 10) * fadeOut(frame, ctx.span.duration - 12, 8);

    return (
      <AbsoluteFill>
        {form > 0.01 ? (
          <AppWindow shot={SHOTS.newProject} x={960} y={420} width={1500} scale={0.9 + 0.1 * form} opacity={form}>
            <Patch x={418} y={212} w={330} h={30} color={C.field}>
              <Typed text="Contoso Expenses" frame={frame} from={name} to={name + 16} style={{ position: 'absolute', left: 5, top: 2, fontSize: 17, color: C.text }} />
            </Patch>
            <Cursor frame={frame} keys={[{ f: name, x: 900, y: 330 }, { f: click - 3, x: 1126, y: 388 }]} clicks={[click]} scale={1.1} opacity={ramp(frame, name, 6)} />
          </AppWindow>
        ) : null}
        {frame >= click + 8 && frame < drop + 10 ? (
          <AppTile x={tileX + (1520 - tileX) * into} y={tileY + (540 - tileY) * into} scale={(0.75 * tileIn) * (1 - into * 0.9)} opacity={1 - into} />
        ) : null}
        <FabricPortal x={1520} y={520} from={swim - 8} to={hey - 10} />
        <Burst kind="sparkles" at={drop + 4} x={1520} y={520} count={16} seed={4} spread={2.2} />
        {frame >= hey - 10 ? (
          <AppWindow shot={SHOTS.deployProgress} x={1170} y={545} width={740} scale={0.85 + 0.15 * deploy} opacity={Math.min(1, deploy * 1.6)}>
            {fins > 0 ? <div style={{ position: 'absolute', left: 392, top: 176, width: 360, height: 296, borderRadius: 24, boxShadow: `0 0 0 4000px rgba(3,7,13,${0.5 * fins}), 0 0 0 4px ${C.accent}, 0 0 34px 8px ${C.accent}88`, opacity: fins }} /> : null}
          </AppWindow>
        ) : null}
        <Burst kind="hearts" at={ctx.w('me')} x={520} y={470} count={6} seed={5} />
      </AbsoluteFill>
    );
  },
};
