import type { ReactNode } from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { ease, fadeOut, pop, ramp, track } from '../anim';
import { Burst } from '../fx/Burst';
import { AppWindow, Patch, SHOTS, Spotlight, Typed } from '../ui/AppWindow';
import { AppTile } from '../ui/Brand';
import { Cursor } from '../ui/Cursor';
import { Chip, KineticTitle } from '../ui/Kit';
import { C, FONT } from '../theme';
import type { SceneCtx, SceneDef } from './types';

const icon = (d: ReactNode, size = 60, color: string = C.accent) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    {d}
  </svg>
);

const ICONS = {
  database: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>
  ),
  apis: <path d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1" />,
  signin: (
    <>
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="M10.7 12.3 20 3M16 7l3 3M18 5l2 2" />
    </>
  ),
  storage: <path d="M3 7h18v13H3zM3 7l2-4h14l2 4M9 11h6" />,
  functions: (
    <>
      <path d="M10 20c2.2 0 2.8-1.8 3.2-4.4l1.5-8.2C15.1 5 15.8 3.8 18 3.8" />
      <path d="M8.5 10.5h8" />
      <path d="M3.5 8l-1.5 4 1.5 4M20.5 13l1.5 3.5-1.5 3.5" />
    </>
  ),
  hosting: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </>
  ),
  scale: <path d="M7 18V8M3.5 11.5 7 8l3.5 3.5M17 21V5M13.5 8.5 17 5l3.5 3.5" />,
  shield: (
    <>
      <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
      <path d="M8.5 12l2.5 2.5 4.5-5" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.5v3M12 18.5v3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M2.5 12h3M18.5 12h3M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" />
    </>
  ),
};

/* -------------------------------- 5. Backend -------------------------------- */

const TILES = [
  { word: 'database', label: 'Database', sub: 'From your TypeScript', icon: ICONS.database },
  { word: 'APIs', label: 'APIs', sub: 'Type-safe', icon: ICONS.apis },
  { word: 'auth', label: 'Auth', sub: 'Microsoft Entra ID', icon: ICONS.signin },
  { word: 'storage', label: 'Storage', sub: 'Blob storage', icon: ICONS.storage },
  { word: 'functions', label: 'Functions', sub: 'Server-side code', icon: ICONS.functions },
  { word: 'hosting', label: 'Hosting', sub: 'Static hosting', icon: ICONS.hosting },
] as const;

const TILE_W = 210;
const tileX = (i: number) => 960 + (i - (TILES.length - 1) / 2) * 234;
const TILE_Y = 615;

export const backend: SceneDef = {
  id: 'backend',
  ray: (c) => ({
    keys: [
      { f: 0, x: 520, y: 590, s: 0.85 },
      { f: 30, x: 1720, y: 940, s: 0.48, e: ease.inOut },
      { f: c.w('You') - 8, x: 1720, y: 940 },
      { f: c.w('You') + 10, x: 960, y: 930, s: 0.55, e: ease.inOut },
    ],
    moods: [
      { f: 0, mood: 'surprised' },
      { f: c.w('database') - 6, mood: 'happy' },
      { f: c.w('governed'), mood: 'surprised' },
      { f: c.w('boundary'), mood: 'happy' },
    ],
    waves: [c.w('fin') - 4],
    hops: [c.wEnd('fin')],
    gaze: [
      [0, 0.4, -0.3],
      [30, -0.9, -0.5],
      ...TILES.map((t, i) => [c.w(t.word), (tileX(i) - 1720) / 900, -0.7] as const),
      [c.w('inside'), -0.6, -0.8],
      [c.w('You'), 0, 0.1],
    ],
  }),
  sfx: (c) => [
    { f: 4, id: 'swim-whoosh', volume: 0.3 },
    { f: c.w('sets'), id: 'sweep', volume: 0.3 },
    ...TILES.map((t) => ({ f: c.w(t.word), id: 'pop' as const, volume: 0.6 })),
    { f: c.w('Scalable'), id: 'chime', volume: 0.35 },
    { f: c.w('governed'), id: 'stamp', volume: 0.55 },
    { f: c.w('inside'), id: 'shimmer', volume: 0.35 },
    { f: c.w('fin'), id: 'bubbles', volume: 0.3 },
  ],
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const shrink = ramp(frame, 0, 16, ease.inOut);
    const app = pop(frame, fps, 10, 12, 0.7);
    const panel = ramp(frame, ctx.w('sets') - 4, 22, ease.out);
    const auto = pop(frame, fps, ctx.w('automatically'), 12, 0.6);
    const scaleOut = ctx.w('Scalable');
    const boundary = ramp(frame, ctx.w('inside') - 4, ctx.wEnd('boundary') - ctx.w('inside') + 8, ease.inOut);
    const out = fadeOut(frame, ctx.span.duration, 10);

    return (
      <AbsoluteFill style={{ opacity: out }}>
        {shrink < 1 ? (
          <AppWindow shot={SHOTS.deployProgress} x={1170 + (960 - 1170) * shrink} y={545 + (205 - 545) * shrink} width={740} scale={1 - 0.8 * shrink} opacity={1 - shrink} />
        ) : null}

        {/* The organization's boundary, drawn around everything. */}
        {boundary > 0 ? (
          <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0 }}>
            <defs>
              <mask id="boundary-draw">
                <rect x="200" y="100" width="1520" height="745" rx="40" fill="none" stroke="#fff" strokeWidth="14" pathLength={1} strokeDasharray={`${boundary} 1`} />
              </mask>
            </defs>
            <rect x="200" y="100" width="1520" height="745" rx="40" fill={`rgba(70,204,176,${0.05 * boundary})`} stroke={C.accent2} strokeWidth="4" strokeDasharray="18 12" mask="url(#boundary-draw)" />
          </svg>
        ) : null}
        <Chip x={560} y={100} from={ctx.w("organization's")} to={ctx.span.duration + 20} accent={C.accent2} size={26}>
          Your organization’s boundary · Microsoft Fabric
        </Chip>

        <AppTile x={960} y={205} scale={0.85 * app} opacity={Math.min(1, app * 1.5)} live />

        {/* Connectors from each service up to the app. */}
        <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0 }}>
          {TILES.map((t, i) => {
            const p = ramp(frame, ctx.w(t.word) + 2, 12, ease.out);
            if (p <= 0) return null;
            const x = tileX(i);
            return (
              <path
                key={t.word}
                d={`M ${x} ${TILE_Y - 100} C ${x} ${TILE_Y - 200}, 960 ${360}, 960 ${262}`}
                fill="none"
                stroke={C.accent}
                strokeWidth={3}
                strokeOpacity={0.7}
                pathLength={1}
                strokeDasharray={`${p} 1`}
              />
            );
          })}
        </svg>

        {/* The platform the services sit on. */}
        <div
          style={{
            position: 'absolute',
            left: 250,
            top: 405,
            width: 1420,
            height: 390,
            borderRadius: 30,
            background: 'rgba(12,19,30,0.92)',
            border: `2px solid ${C.border}`,
            boxShadow: '0 30px 80px rgba(0,0,0,0.45)',
            transform: `scaleX(${panel})`,
            opacity: Math.min(1, panel * 2),
          }}
        >
          <div style={{ position: 'absolute', left: 36, top: 22, fontFamily: FONT, fontSize: 30, fontWeight: 700, color: '#f4f8fc', opacity: ramp(frame, ctx.w('Rayfin') - 4, 8) }}>
            Rayfin <span style={{ color: C.dim, fontWeight: 500 }}>backend</span>
          </div>
          <div style={{ position: 'absolute', right: 36, top: 18, display: 'flex', alignItems: 'center', gap: 10, fontFamily: FONT, fontSize: 26, color: C.accent2, opacity: Math.min(1, auto * 1.4), transform: `scale(${0.7 + 0.3 * auto})` }}>
            <span style={{ display: 'inline-block', transform: `rotate(${frame * 4}deg)` }}>{icon(ICONS.gear, 34, C.accent2)}</span>
            Set up automatically on deploy
          </div>
        </div>

        {TILES.map((t, i) => {
          const at = ctx.w(t.word);
          const p = pop(frame, fps, at, 11, 0.6);
          if (frame < at) return null;
          const ghosts = [1, 2].map((g) => pop(frame, fps, scaleOut + i * 2 + g * 3, 12, 0.6));
          const card = (key: string, dx: number, dy: number, alpha: number) => (
            <div
              key={key}
              style={{
                position: 'absolute',
                left: tileX(i) - TILE_W / 2 + dx,
                top: TILE_Y - 100 + dy,
                width: TILE_W,
                height: 200,
                borderRadius: 22,
                background: '#152033',
                border: `2px solid ${C.accent}66`,
                opacity: alpha,
              }}
            />
          );
          return (
            <div key={t.word}>
              {ghosts[1] > 0.01 ? card('g2', 26 * ghosts[1], -26 * ghosts[1], 0.35 * ghosts[1]) : null}
              {ghosts[0] > 0.01 ? card('g1', 13 * ghosts[0], -13 * ghosts[0], 0.6 * ghosts[0]) : null}
              <div
                style={{
                  position: 'absolute',
                  left: tileX(i) - TILE_W / 2,
                  top: TILE_Y - 100,
                  width: TILE_W,
                  height: 200,
                  borderRadius: 22,
                  background: 'linear-gradient(180deg, #1a2940, #121c2c)',
                  border: `2px solid ${C.accent}`,
                  boxShadow: `0 14px 40px rgba(0,0,0,0.45), 0 0 26px ${C.accent}33`,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  transform: `translateY(${(1 - p) * 60}px) scale(${0.5 + 0.5 * p})`,
                  opacity: Math.min(1, p * 1.6),
                  fontFamily: FONT,
                }}
              >
                {icon(t.icon, 58)}
                <div style={{ fontSize: 32, fontWeight: 700, color: '#f4f8fc' }}>{t.label}</div>
                <div style={{ fontSize: 19, color: C.dim, whiteSpace: 'nowrap' }}>{t.sub}</div>
              </div>
            </div>
          );
        })}

        <Chip x={470} y={330} from={ctx.w('Scalable')} to={ctx.span.duration + 20} size={30}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            {icon(ICONS.scale, 34)} Scalable
          </span>
        </Chip>
        <Chip x={1450} y={330} from={ctx.w('governed')} to={ctx.span.duration + 20} accent={C.accent2} size={30}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            {icon(ICONS.shield, 34, C.accent2)} Governed
          </span>
        </Chip>
        <Burst kind="sparkles" at={ctx.w('governed')} x={1450} y={330} count={10} seed={21} spread={1.6} />
        <Burst kind="bubbles" at={ctx.w('fin')} x={960} y={900} count={8} seed={22} />
      </AbsoluteFill>
    );
  },
};

/* ------------------------------- 6. Describe it ------------------------------- */

const PROMPT = 'Build an expense tracker for my team…';

function Keycap({ x, y, from }: { x: number; y: number; from: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < from || frame > from + 22) return null;
  const p = pop(frame, fps, from, 10, 0.5);
  const press = frame - from < 5 ? 3 : 0;
  return (
    <div style={{ position: 'absolute', left: x, top: y + press, transform: `translate(-50%, -50%) scale(${p})`, opacity: fadeOut(frame, from + 22, 6), padding: '8px 18px', borderRadius: 10, background: '#2b3445', border: '2px solid #46536a', boxShadow: `0 ${6 - press}px 0 #161c26`, color: '#f4f8fc', fontFamily: FONT, fontSize: 26, fontWeight: 600, whiteSpace: 'nowrap' }}>
      Enter ↵
    </div>
  );
}

export const describe: SceneDef = {
  id: 'describe',
  ray: (c) => ({
    keys: [
      { f: 0, x: 960, y: 930, s: 0.55 },
      { f: 30, x: 1790, y: 945, s: 0.45, e: ease.inOut },
      { f: c.w('and', 1) - 4, x: 1790, y: 945 },
      { f: c.w('cheer') - 2, x: 1650, y: 800, s: 0.6, e: ease.out },
      { f: c.span.duration, x: 1660, y: 790 },
    ],
    moods: [
      { f: 0, mood: 'happy' },
      { f: 34, mood: 'idle' },
      { f: c.w('GitHub'), mood: 'surprised' },
      { f: c.w('and', 1), mood: 'happy' },
    ],
    hops: [c.w('cheer'), c.w('cheer') + 18],
    squishes: [c.w('cheer') + 9],
    gaze: [
      [0, 0, 0.1],
      [32, -1, 0.3],
      [c.w('GitHub'), -0.9, -0.4],
      [c.w('and', 1), 0, 0.1],
    ],
  }),
  sfx: (c) => [
    { f: 2, id: 'swim-whoosh', volume: 0.25 },
    { f: c.w('describe'), id: 'typing', volume: 0.32, duration: c.w('English') + 10 - c.w('describe') },
    { f: c.w('English') + 16, id: 'click', volume: 0.6 },
    { f: c.w('code') + 2, id: 'chime', volume: 0.3 },
    { f: c.w('cheer'), id: 'confetti', volume: 0.5 },
  ],
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const enter = pop(frame, fps, 28, 13, 0.8);
    const typeFrom = ctx.w('describe');
    const send = ctx.w('English') + 16;
    const reveal = ramp(frame, send + 2, ctx.w('code') - send, ease.out);
    const swap = ramp(frame, ctx.w('code') + 2, 12);
    const zoom = track(frame, [
      [28, 1.55],
      [send, 1.55],
      [send + 30, 1.25],
      [ctx.w('code'), 1.25],
      [ctx.w('code') + 30, 1, ease.inOut],
    ]);
    const fy = track(frame, [
      [28, 700],
      [send, 700],
      [send + 30, 480],
      [ctx.w('code') + 30, 500],
    ]);
    const fx = track(frame, [
      [28, 400],
      [ctx.w('code'), 400],
      [ctx.w('code') + 30, 800],
    ]);
    const y = 1450 - (1450 - 560) * enter;
    const cam = { zoom, fx, fy };
    return (
      <AbsoluteFill>
        {frame >= 26 ? (
          <>
            <AppWindow shot={SHOTS.chatWorking} x={960} y={y} width={1400} {...cam}>
              {/* An empty chat until the prompt is sent; then the turn appears as Copilot works. */}
              <Patch x={0} y={100 + (848 - 100) * reveal} w={800} h={(848 - 100) * (1 - reveal)} color={C.bg} />
              {frame < send + 2 ? (
                <Patch x={30} y={866} w={560} h={32} color={C.composer}>
                  <Typed text={PROMPT} frame={frame} from={typeFrom} to={ctx.w('English') + 10} style={{ position: 'absolute', left: 2, top: 3, fontSize: 18, color: C.text }} />
                </Patch>
              ) : null}
            </AppWindow>
            {swap > 0 ? <AppWindow shot={SHOTS.workbench} x={960} y={y} width={1400} {...cam} opacity={swap} /> : null}
          </>
        ) : null}
        <Keycap x={1160} y={960} from={send - 2} />
        <KineticTitle text="Describe it." from={0} to={30} />
        <Burst kind="confetti" at={ctx.w('cheer')} x={1650} y={720} count={46} seed={31} />
        <Burst kind="bubbles" at={ctx.w('cheer') + 4} x={1650} y={760} count={8} seed={32} />
      </AbsoluteFill>
    );
  },
};

/* ------------------------------- 7. Watch it run ------------------------------- */

const DESIGN_W = Math.round((1080 * 940) / 1290);

export const preview: SceneDef = {
  id: 'preview',
  ray: (c) => ({
    keys: [
      { f: 0, x: 1660, y: 790, s: 0.6 },
      { f: 30, x: 235, y: 720, s: 0.58, e: ease.inOut },
      { f: c.w('See') - 4, x: 235, y: 720 },
      { f: c.w('See') + 16, x: 520, y: 640, s: 0.66, e: ease.inOut },
      { f: c.w('Point'), x: 560, y: 630, r: -14 },
      { f: c.w('Design'), x: 540, y: 640, r: 0 },
    ],
    moods: [
      { f: 0, mood: 'happy' },
      { f: 34, mood: 'idle' },
      { f: c.w('ask'), mood: 'happy' },
    ],
    waves: [c.w('Point')],
    hops: [c.wEnd('ask') + 8],
    gaze: [
      [0, -0.6, 0.2],
      [34, 1, -0.2],
      [c.w('right'), 0.6, -0.1],
      [c.w('See'), 1, 0],
      [c.w('ask'), 0.8, -0.2],
    ],
  }),
  sfx: (c) => [
    { f: 2, id: 'swim-whoosh', volume: 0.3 },
    { f: c.w('live'), id: 'pop', volume: 0.4 },
    { f: c.w('See') + 2, id: 'sweep', volume: 0.25 },
    { f: c.w('it', 1), id: 'click', volume: 0.6 },
    { f: c.w('ask') - 2, id: 'typing', volume: 0.3, duration: 22 },
    { f: c.wEnd('ask') + 18, id: 'click', volume: 0.55 },
    { f: c.wEnd('ask') + 20, id: 'shimmer', volume: 0.3 },
  ],
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const see = ctx.w('See');
    const dimTitle = 1 - ramp(frame, 26, 10);
    const zoom = track(frame, [
      [ctx.w('Your') - 4, 1],
      [ctx.w('live') - 2, 1.85],
      [ctx.w('right'), 1.85],
      [ctx.w('chat') + 2, 1, ease.inOut],
    ]);
    const fx = track(frame, [
      [ctx.w('Your') - 4, 800],
      [ctx.w('live') - 2, 1180],
      [ctx.w('right'), 1180],
      [ctx.w('chat') + 2, 800],
    ]);
    const fy = track(frame, [
      [ctx.w('Your') - 4, 500],
      [ctx.w('live') - 2, 330],
      [ctx.w('right'), 330],
      [ctx.w('chat') + 2, 500],
    ]);
    const liveSpot = ramp(frame, ctx.w('live'), 6) * fadeOut(frame, ctx.w('right') + 4, 8);
    const chatSpot = ramp(frame, ctx.w('next'), 8) * fadeOut(frame, see - 4, 8);
    const swap = ramp(frame, see, 14, ease.inOut);
    const design = pop(frame, fps, see + 2, 13, 0.8);
    const click = ctx.w('it', 1);
    const typeFrom = ctx.w('ask') - 2;
    const typeTo = typeFrom + 22;
    const add = ctx.wEnd('ask') + 18;
    const totalSpot = ramp(frame, click, 6) * fadeOut(frame, ctx.w('Design') - 2, 6);
    const designBtn = ramp(frame, ctx.w('Design') - 2, 6) * fadeOut(frame, ctx.w('ask') - 2, 6);
    const cardSpot = ramp(frame, ctx.w('ask') - 4, 6);

    return (
      <AbsoluteFill>
        {swap < 1 ? (
          <AppWindow shot={SHOTS.workbench} x={1080} y={560} width={1300} zoom={zoom} fx={fx} fy={fy} opacity={1 - swap} scale={1 - 0.05 * swap}>
            <Spotlight x={922} y={60} w={130} h={28} opacity={liveSpot} radius={14} />
            <Spotlight x={6} y={100} w={790} h={858} opacity={chatSpot} radius={10} dim={0.35} />
          </AppWindow>
        ) : null}
        {frame >= see ? (
          <AppWindow shot={SHOTS.design} x={1230} y={560} width={DESIGN_W} height={940} opacity={Math.min(1, design * 1.4)} scale={0.9 + 0.1 * design}>
            <Spotlight x={72} y={358} w={918} h={72} opacity={totalSpot} radius={8} />
            <Spotlight x={897} y={18} w={120} h={42} opacity={designBtn} radius={8} />
            <Spotlight x={80} y={443} w={466} h={510} opacity={cardSpot} radius={18} dim={0.4} />
            {frame >= typeFrom - 2 ? (
              <Patch x={110} y={538} w={410} h={64} color={C.field}>
                <Typed text="Make the total bigger and bolder" frame={frame} from={typeFrom} to={typeTo} style={{ position: 'absolute', left: 2, top: 4, fontSize: 21, lineHeight: 1.35, color: C.text }} />
              </Patch>
            ) : null}
            <Cursor
              frame={frame}
              keys={[
                { f: see + 6, x: 780, y: 1080 },
                { f: ctx.w('Point'), x: 460, y: 400 },
                { f: click + 4, x: 450, y: 398 },
                { f: typeTo + 2, x: 470, y: 690 },
                { f: add - 3, x: 492, y: 742 },
              ]}
              clicks={[click, add]}
              scale={1.3}
              opacity={ramp(frame, see + 6, 6)}
            />
          </AppWindow>
        ) : null}
        <Burst kind="sparkles" at={add + 2} x={1230 - DESIGN_W / 2 + (530 * DESIGN_W) / 1080} y={560 - 470 + (394 * 940) / 1290} count={14} seed={41} spread={2} />
        <AbsoluteFill style={{ background: 'rgba(4,8,14,0.6)', opacity: dimTitle }} />
        <KineticTitle text="Watch it run." from={0} to={26} />
      </AbsoluteFill>
    );
  },
};

/* --------------------------------- 8. Ship it --------------------------------- */

function DeployPill({ x, y, from, liveAt }: { x: number; y: number; from: number; liveAt: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < from) return null;
  const p = pop(frame, fps, from, 12, 0.6);
  const progress = ramp(frame, from, liveAt - from, ease.inOut);
  const live = frame >= liveAt;
  return (
    <div style={{ position: 'absolute', left: x, top: y, transform: `translate(-50%, 0) scale(${p})`, transformOrigin: '50% 0', padding: '8px 14px 10px', borderRadius: 10, background: live ? '#0f2a1d' : '#131a26', border: `1.5px solid ${live ? C.ok : C.accent}`, fontFamily: FONT, fontSize: 15, color: '#f4f8fc', whiteSpace: 'nowrap', boxShadow: '0 10px 24px rgba(0,0,0,0.5)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 9, height: 9, borderRadius: '50%', background: live ? C.ok : C.accent, display: 'inline-block' }} />
        {live ? 'Live in Microsoft Fabric ✓' : 'Redeploying to Fabric…'}
      </div>
      {!live ? (
        <div style={{ marginTop: 7, height: 4, borderRadius: 2, background: '#26303d' }}>
          <div style={{ width: `${progress * 100}%`, height: '100%', borderRadius: 2, background: C.accent }} />
        </div>
      ) : null}
    </div>
  );
}

export const ship: SceneDef = {
  id: 'ship',
  ray: (c) => ({
    keys: [
      { f: 0, x: 540, y: 640, s: 0.66 },
      { f: 28, x: 230, y: 760, s: 0.6, e: ease.inOut },
    ],
    moods: [
      { f: 0, mood: 'happy' },
      { f: 30, mood: 'idle' },
      { f: c.w('live') - 4, mood: 'happy' },
    ],
    hops: [c.w('live'), c.w('live') + 16],
    waves: [c.w('share')],
    gaze: [
      [0, 0.2, 0],
      [30, 1, -0.3],
      [c.w('Fabricator'), 1, -0.8],
      [c.w('Then'), 1, -0.2],
    ],
  }),
  sfx: (c) => [
    { f: 2, id: 'swim-whoosh', volume: 0.25 },
    { f: c.w('redeploys'), id: 'sweep', volume: 0.25 },
    { f: c.w('live'), id: 'chime', volume: 0.5 },
    { f: c.w('live') + 1, id: 'confetti', volume: 0.45 },
    { f: c.w('share'), id: 'click', volume: 0.55 },
    { f: c.w('share') + 4, id: 'pop', volume: 0.45 },
    { f: c.wEnd('organization') + 8, id: 'click', volume: 0.55 },
    { f: c.wEnd('organization') + 10, id: 'shimmer', volume: 0.3 },
  ],
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const dimTitle = 1 - ramp(frame, 24, 10);
    const turn = ctx.w('successful');
    const redeploy = ctx.w('Fabricator');
    const live = ctx.w('live');
    const then = ctx.w('Then');
    const zoom = track(frame, [
      [turn - 14, 1],
      [turn, 2.1],
      [redeploy - 2, 2.1],
      [redeploy + 14, 2.3],
      [then - 2, 2.3],
      [then + 14, 1, ease.inOut],
    ]);
    const fx = track(frame, [
      [turn - 14, 800],
      [turn, 330],
      [redeploy - 2, 330],
      [redeploy + 14, 1250],
      [then - 2, 1250],
      [then + 14, 800],
    ]);
    const fy = track(frame, [
      [turn - 14, 500],
      [turn, 300],
      [redeploy - 2, 300],
      [redeploy + 14, 120],
      [then - 2, 120],
      [then + 14, 500],
    ]);
    const turnSpot = ramp(frame, turn, 6) * fadeOut(frame, redeploy, 8);
    const deploySpot = ramp(frame, redeploy + 10, 6) * fadeOut(frame, then, 8);
    const share = ctx.w('share');
    const dialog = pop(frame, fps, share + 4, 13, 0.7);
    const people = ctx.w('people');
    const confirm = ctx.wEnd('organization') + 8;
    const winX = 1080;
    const winW = 1300;
    return (
      <AbsoluteFill>
        <AppWindow shot={SHOTS.workbench} x={winX} y={560} width={winW} zoom={zoom} fx={fx} fy={fy}>
          <Spotlight x={10} y={268} w={420} h={32} opacity={turnSpot} radius={8} />
          <Spotlight x={1118} y={6} w={316} h={38} opacity={deploySpot} radius={10} />
          <DeployPill x={1276} y={52} from={ctx.w('redeploys')} liveAt={live} />
          <Cursor frame={frame} keys={[{ f: then + 6, x: 1200, y: 300 }, { f: share - 2, x: 1468, y: 26 }]} clicks={[share]} scale={1.2} opacity={ramp(frame, then + 6, 6) * fadeOut(frame, share + 8, 6)} />
        </AppWindow>
        {frame >= share + 4 ? (
          <>
            <AbsoluteFill style={{ background: 'rgba(3,6,12,0.55)', opacity: Math.min(1, dialog) }} />
            <AppWindow shot={SHOTS.share} x={winX} y={560} width={860} scale={0.85 + 0.15 * dialog} opacity={Math.min(1, dialog * 1.5)}>
              <Spotlight x={152} y={378} w={656} h={58} opacity={ramp(frame, people, 6)} radius={10} dim={0.3} />
              <Cursor frame={frame} keys={[{ f: people, x: 600, y: 450 }, { f: confirm - 3, x: 762, y: 515 }]} clicks={[confirm]} scale={1.1} opacity={ramp(frame, people, 6)} />
            </AppWindow>
          </>
        ) : null}
        <Burst kind="confetti" at={live} x={1130} y={280} count={40} seed={51} />
        <Burst kind="sparkles" at={confirm + 2} x={winX + 120} y={680} count={12} seed={52} spread={1.8} />
        <AbsoluteFill style={{ background: 'rgba(4,8,14,0.6)', opacity: dimTitle }} />
        <KineticTitle text="Ship it." from={0} to={24} />
      </AbsoluteFill>
    );
  },
};

export type { SceneCtx };
