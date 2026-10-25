import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { ease, fadeOut, pop, ramp, track } from '../anim';
import { Burst, DizzyStars } from '../fx/Burst';
import { OVERLAP } from '../timing';
import { AppWindow, Patch, SHOTS, Typed } from '../ui/AppWindow';
import { AppTile, FabricPortal, Wordmark } from '../ui/Brand';
import { Cursor } from '../ui/Cursor';
import { FIRST_TURN_DONE, FIRST_TURN_ROWS, FirstTurn } from '../ui/FirstTurn';
import { BrowserWindow, KineticTitle, Terminal } from '../ui/Kit';
import { FONT, alpha, useTheme } from '../theme';
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
    const C = useTheme();
    const fab = ctx.w('Fabricator');
    const end = ctx.span.duration;
    const mouth = rayAt(helloRay(ctx).keys, ctx.w('hi'));
    return (
      <AbsoluteFill>
        <Burst kind="bubbles" at={ctx.w('hi')} x={mouth.x} y={mouth.y + 20} count={9} seed={1} />
        <Wordmark x={960} y={780} size={118} from={fab} opacity={fadeOut(frame, end, 12)} />
        <Burst kind="sparkles" at={fab + 2} x={960} y={780} count={14} seed={2} spread={2.6} />
        <AbsoluteFill style={{ background: C.fadeIn, opacity: 1 - ramp(frame, 0, 14) }} />
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
    const C = useTheme();
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
        <AbsoluteFill style={{ background: `radial-gradient(circle at 50% 50%, ${alpha(C.sweep, Math.round(sweep * 120) / 255)}, transparent 40%)` }} />
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
    const C = useTheme();
    const p = pop(frame, fps, 4, 12, 0.8);
    const ring = ramp(frame, ctx.w('one'), 26, ease.out);
    const out = fadeOut(frame, ctx.span.duration, 10);
    return (
      <AbsoluteFill style={{ opacity: out }}>
        <AppWindow shot={SHOTS.workbench} x={960} y={560} width={1400} scale={0.2 + 0.8 * p} opacity={Math.min(1, p * 2)} />
        {ring > 0 && ring < 1 ? (
          <div style={{ position: 'absolute', left: 960 - 700 - ring * 40, top: 560 - 437.5 - ring * 40, width: 1400 + ring * 80, height: 875 + ring * 80, borderRadius: 26, border: `4px solid ${C.accent}`, opacity: 1 - ring, boxShadow: C.glow(C.accent, 40) }} />
        ) : null}
        <AbsoluteFill style={{ background: '#fff', opacity: Math.max(0, 0.35 - frame / 20) }} />
      </AbsoluteFill>
    );
  },
};

/* ------------------------------- 4. Describe it ------------------------------- */

/** The first prompt, typed into the new project's chat: the gist of the one the sample app was built from. */
const PROMPT = 'Build an expense tracker for my team, with a monthly total and a chart by category';

/** The describe scene's beats, from the words. */
function describeBeats(c: SceneCtx) {
  const create = c.wEnd('app') - 2;
  const send = c.w('agent') - 3;
  const rowsFrom = send + 18;
  const rowsTo = c.wEnd('code') + 2;
  return {
    name: c.w('Name'),
    create,
    title: c.w('describe') - 3,
    typeFrom: create + 12,
    typeTo: send - 6,
    send,
    rows: Array.from({ length: FIRST_TURN_ROWS }, (_, i) => Math.round(rowsFrom + (i * (rowsTo - rowsFrom)) / (FIRST_TURN_ROWS - 1))),
    pullOut: rowsTo + 2,
    app: rowsTo + 16,
    cheer: c.w('cheer'),
  };
}

function Keycap({ x, y, from }: { x: number; y: number; from: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { keycap } = useTheme();
  if (frame < from || frame > from + 22) return null;
  const p = pop(frame, fps, from, 10, 0.5);
  const press = frame - from < 5 ? 3 : 0;
  return (
    <div style={{ position: 'absolute', left: x, top: y + press, transform: `translate(-50%, -50%) scale(${p})`, opacity: fadeOut(frame, from + 22, 6), padding: '8px 18px', borderRadius: 10, background: keycap.bg, border: `2px solid ${keycap.border}`, boxShadow: `0 ${6 - press}px 0 ${keycap.edge}`, color: keycap.text, fontFamily: FONT, fontSize: 26, fontWeight: 600, whiteSpace: 'nowrap' }}>
      Enter ↵
    </div>
  );
}

/** The cheer: confetti and bubbles by Ray. The next scene carries on with them, so they end together. */
function Cheer({ at }: { at: number }): JSX.Element {
  return (
    <>
      <Burst kind="confetti" at={at} x={1650} y={720} count={46} seed={31} />
      <Burst kind="bubbles" at={at + 4} x={1650} y={760} count={8} seed={32} />
    </>
  );
}

export const describe: SceneDef = {
  id: 'describe',
  ray: (c) => {
    const b = describeBeats(c);
    return {
      keys: [
        { f: 0, x: 1715, y: 205, s: 0.55 },
        { f: b.create, x: 1715, y: 205 },
        { f: b.create + 26, x: 1790, y: 945, s: 0.45, e: ease.inOut },
        { f: c.w('and') - 4, x: 1790, y: 945 },
        { f: b.cheer - 2, x: 1650, y: 800, s: 0.6, e: ease.out },
      ],
      moods: [
        { f: 0, mood: 'happy' },
        { f: b.create + 28, mood: 'idle' },
        { f: c.w('agent'), mood: 'surprised' },
        { f: c.w('and'), mood: 'happy' },
      ],
      hops: [b.create + 2, b.cheer, b.cheer + 18],
      squishes: [b.cheer + 9],
      gaze: [
        [0, -0.5, 0.4],
        [b.create + 8, -0.8, 0.6],
        [b.typeFrom + 4, -1, 0.3],
        [c.w('agent'), -0.9, -0.5],
        [c.w('and'), 0, 0.1],
      ],
    };
  },
  sfx: (c) => {
    const b = describeBeats(c);
    return [
      { f: b.name, id: 'typing', volume: 0.3, duration: 18 },
      { f: b.create, id: 'click', volume: 0.55 },
      { f: b.create + 4, id: 'swim-whoosh', volume: 0.22 },
      { f: b.typeFrom, id: 'typing', volume: 0.32, duration: b.typeTo - b.typeFrom },
      { f: b.send, id: 'click', volume: 0.6 },
      { f: b.app, id: 'chime', volume: 0.3 },
      { f: b.cheer, id: 'confetti', volume: 0.5 },
    ];
  },
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const C = useTheme();
    const b = describeBeats(ctx);
    // Name it: the new-project form, which makes way for the chat once it's created.
    const form = pop(frame, fps, 0, 13, 0.7) * (1 - ramp(frame, b.create + 4, 8, ease.in));
    const enter = pop(frame, fps, b.create + 2, 13, 0.8);
    // Close on the composer as the prompt types; follow it up to the top of the chat as it's sent
    // (in step with its bubble, from where the camera stops being held by the window's bottom
    // edge); then pull out to the whole window as the app comes up in the preview.
    const zoom = track(frame, [
      [b.pullOut, 1.8],
      [b.pullOut + 30, 1],
    ]);
    const fx = track(frame, [
      [b.pullOut, 400],
      [b.pullOut + 30, 800],
    ]);
    const fy = track(frame, [
      [b.send, 722],
      [b.send + 18, 330],
      [b.pullOut, 330],
      [b.pullOut + 30, 500],
    ]);
    // From the next scene's first frame, it carries on with the window and the cheer.
    const handOff = ctx.span.duration - OVERLAP;
    return (
      <AbsoluteFill>
        {form > 0.01 ? (
          <AppWindow shot={SHOTS.newProject} x={960} y={420} width={1500} scale={0.9 + 0.1 * form} opacity={form}>
            <Patch x={418} y={212} w={330} h={30} color={C.field}>
              <Typed text="Contoso Expenses" frame={frame} from={b.name} to={b.name + 16} style={{ position: 'absolute', left: 5, top: 2, fontSize: 17, color: C.text }} />
            </Patch>
            <Cursor frame={frame} keys={[{ f: b.name, x: 900, y: 330 }, { f: b.create - 3, x: 1126, y: 388 }]} clicks={[b.create]} scale={1.1} opacity={ramp(frame, b.name, 6)} />
          </AppWindow>
        ) : null}
        {frame > b.create && frame < handOff ? (
          <AppWindow shot={SHOTS.chatWorking} x={960} y={1450 - (1450 - 560) * enter} width={1400} zoom={zoom} fx={fx} fy={fy}>
            <FirstTurn prompt={PROMPT} typeFrom={b.typeFrom} typeTo={b.typeTo} sent={b.send} rows={b.rows} app={b.app} />
          </AppWindow>
        ) : null}
        <Keycap x={1440} y={958} from={b.send - 2} />
        <KineticTitle text="Describe it." from={b.title} to={b.title + 30} />
        {frame < handOff ? <Cheer at={b.cheer} /> : null}
      </AbsoluteFill>
    );
  },
};

/* --------------------------- 5. Deploy it, to Fabric --------------------------- */

const fabricRay = (c: SceneCtx) => {
  const swim = c.w('swim');
  const fabric = c.w('Fabric');
  const hey = c.w('Hey');
  return {
    keys: [
      { f: 0, x: 1650, y: 800, s: 0.6 },
      { f: swim - 14, x: 1640, y: 700, s: 0.6 },
      { f: swim, x: 760, y: 660, s: 0.62, e: ease.inOut },
      { f: fabric - 2, x: 1280, y: 560, s: 0.62, e: ease.inOut },
      { f: fabric + 6, x: 1240, y: 600 },
      { f: hey - 2, x: 520, y: 600, s: 0.85, e: ease.inOut },
      { f: c.span.duration, x: 520, y: 590 },
    ],
  };
};

/** Where the app's window shrinks to: its tile, waiting for Ray. */
const TILE = { x: 760, y: 690, scale: 0.75 };

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
      [0, -0.6, -0.1],
      [c.w('Deploy') + 4, -0.9, 0.2],
      [c.w('swim'), 0.8, 0],
      [c.w('Hey'), 1, -0.1],
      [c.w("that's"), 0.2, 0.1],
      [c.w('Fins'), 1, -0.3],
    ],
  }),
  sfx: (c) => [
    { f: c.w('Deploy'), id: 'sweep', volume: 0.25 },
    { f: c.w('swim') - 6, id: 'swim-whoosh', volume: 0.5 },
    { f: c.w('Fabric') + 2, id: 'pop', volume: 0.55 },
    { f: c.w('Fabric') + 3, id: 'shimmer', volume: 0.3 },
    { f: c.w('Hey'), id: 'boing', volume: 0.45 },
    { f: c.w('me'), id: 'bubbles', volume: 0.3 },
  ],
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const C = useTheme();
    const deploy = ctx.w('Deploy');
    const swim = ctx.w('swim');
    const fabricWord = ctx.w('Fabric');
    const hey = ctx.w('Hey');
    const keys = fabricRay(ctx).keys;

    // "Deploy it": the app's window, as the last scene left it, shrinks into the app's tile.
    const shrink = ramp(frame, deploy, 20, ease.inOut);
    const tileIn = ramp(frame, deploy + 12, 8);
    // The tile rides under Ray from when he picks it up until it drops into the portal.
    const drop = fabricWord + 2;
    const carried = frame >= swim;
    const ray = rayAt(keys, Math.min(frame, drop));
    const tileX = carried ? ray.x : TILE.x;
    const tileY = carried ? ray.y + 120 : TILE.y;
    const into = ramp(frame, drop, 8, ease.in);
    const progress = pop(frame, fps, hey - 10, 13, 0.7);
    const fins = ramp(frame, ctx.w('Fins') - 4, 10) * fadeOut(frame, ctx.span.duration - 12, 8);
    // From the next scene's first frame, it carries on with the deploy screen.
    const handOff = ctx.span.duration - OVERLAP;

    return (
      <AbsoluteFill>
        {tileIn < 1 ? (
          <AppWindow
            shot={SHOTS.chatWorking}
            x={960 + (TILE.x - 960) * shrink}
            y={560 + (TILE.y - 560) * shrink}
            width={1400}
            scale={1 - 0.79 * shrink}
            opacity={1 - tileIn}
          >
            <FirstTurn prompt={PROMPT} {...FIRST_TURN_DONE} />
          </AppWindow>
        ) : null}
        <Cheer at={ctx.at('describe', 'cheer')} />
        {tileIn > 0 && frame < drop + 10 ? (
          <AppTile x={tileX + (1520 - tileX) * into} y={tileY + (540 - tileY) * into} scale={TILE.scale * (0.92 + 0.08 * tileIn) * (1 - into * 0.9)} opacity={tileIn * (1 - into)} />
        ) : null}
        <FabricPortal x={1520} y={520} from={swim - 8} to={hey - 10} />
        <Burst kind="sparkles" at={drop + 4} x={1520} y={520} count={16} seed={4} spread={2.2} />
        {frame >= hey - 10 && frame < handOff ? (
          <AppWindow shot={SHOTS.deployProgress} x={1170} y={545} width={740} scale={0.85 + 0.15 * progress} opacity={Math.min(1, progress * 1.6)}>
            {fins > 0 ? <div style={{ position: 'absolute', left: 392, top: 176, width: 360, height: 296, borderRadius: 24, boxShadow: `0 0 0 4000px ${C.scrim(0.5 * fins)}, 0 0 0 4px ${C.accent}, ${C.glow(`${C.accent}88`, 34, 8)}`, opacity: fins }} /> : null}
          </AppWindow>
        ) : null}
        <Burst kind="hearts" at={ctx.w('me')} x={520} y={470} count={6} seed={5} />
      </AbsoluteFill>
    );
  },
};
