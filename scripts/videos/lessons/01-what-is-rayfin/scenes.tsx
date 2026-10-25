import type { ReactNode } from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { ease, fadeOut, pop, ramp, track } from '../../src/anim';
import { Burst, DizzyStars } from '../../src/fx/Burst';
import {
  ApiBody,
  ArtifactCard,
  AutocompleteBody,
  Challenge,
  ChapterTag,
  CodeCard,
  CommandCard,
  DeepDiveTitle,
  DepthGauge,
  EndScreen,
  Icon,
  Objectives,
  Quiz,
  Recap,
  RowSecurityBody,
  SeriesBumper,
  ServiceTiles,
  Sonar,
  TableBody,
  ValidationBody,
  at,
  locate,
  type IconName,
} from '../../src/lesson-kit';
import type { RayKey } from '../../src/ray/RayActor';
import type { LessonCtx, LessonScene } from '../../src/show/types';
import type { Shot } from '../../src/shots';
import { FONT, MONO, alpha, useTheme } from '../../src/theme';
import { AppWindow, SHOTS, Spotlight } from '../../src/ui/AppWindow';
import { FIRST_TURN_ROWS, FirstTurn } from '../../src/ui/FirstTurn';
import { Chip } from '../../src/ui/Kit';
import { SERIES } from '../series';
import { SCRIPT } from './script';
import { CLIENT_METHODS, SNIPPETS } from './snippets';
import { YOUTUBE } from './youtube';

/** Where Ray is when one scene hands him to the next. */
const SPOT = {
  hook: { x: 960, y: 905, s: 0.72 },
  welcome: { x: 960, y: 560, s: 1 },
  today: { x: 330, y: 600, s: 0.85 },
  tangle: { x: 960, y: 590, s: 0.85 },
  flow: { x: 250, y: 640, s: 0.72 },
  entity: { x: 150, y: 950, s: 0.42 },
  deep: { x: 1530, y: 815, s: 0.5 },
  ship: { x: 1725, y: 935, s: 0.46 },
  fabricator: { x: 1790, y: 170, s: 0.4 },
  quiz: { x: 1700, y: 260, s: 0.5 },
  recap: { x: 1785, y: 945, s: 0.42 },
  challenge: { x: 1620, y: 560, s: 0.8 },
  end: { x: 1500, y: 250, s: 0.5 },
  fact: { x: 1155, y: 600, s: 0.6 },
} as const;

const swim = (f: number, spot: keyof typeof SPOT, e = ease.inOut): RayKey => at(f, SPOT[spot], e);

const EXPENSE = SNIPPETS.expense.code;
/** The class itself, without the import: what the cold open types out. */
const CLASS_ONLY = EXPENSE.split('\n').slice(2).join('\n');
const FILE = SNIPPETS.expense.file;

/** The Fabricator screenshots this lesson shows that the intro doesn't. */
const CHAT_DIFF: Shot = { id: 'chat-diff', w: 1080, h: 1290 };
const MODEL: Shot = { id: 'model', w: 1600, h: 778 };

/** The Contoso Expenses sample app's first prompt, as in the intro. */
const PROMPT = 'Build an expense tracker for my team, with a monthly total and a chart by category';

/* ------------------------------------------------------------------------------------------ */
/*                                          Pieces                                            */
/* ------------------------------------------------------------------------------------------ */

/** A small glowing tile: an icon and a name. */
function MiniTile({ icon, label, x, y, from, color }: { icon: IconName; label: string; x: number; y: number; from: number; color?: string }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  if (frame < from) return null;
  const p = pop(frame, fps, from, 11, 0.6);
  const ring = color ?? C.accent2;
  return (
    <div style={{ position: 'absolute', left: x, top: y, transform: `translate(-50%, -50%) scale(${0.5 + 0.5 * p})`, opacity: Math.min(1, p * 1.6), display: 'flex', alignItems: 'center', gap: 18, padding: '20px 30px 20px 22px', borderRadius: 24, background: C.panel.bg, border: `3px solid ${alpha(ring, 0.8)}`, boxShadow: `${C.shadow.panel}, ${C.glow(alpha(ring, 0.45), 40, 4)}`, whiteSpace: 'nowrap' }}>
      <div style={{ width: 66, height: 66, borderRadius: 18, display: 'grid', placeItems: 'center', background: alpha(ring, 0.16) }}>
        <Icon name={icon} color={ring} size={44} />
      </div>
      <span style={{ fontFamily: FONT, fontWeight: 750, fontSize: 40, color: C.ink }}>{label}</span>
    </div>
  );
}

/** A curved line from one point to another that draws itself on. */
function Beam({ from, to, at: start, color, width = 4 }: { from: readonly [number, number]; to: readonly [number, number]; at: number; color: string; width?: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const p = ramp(frame, start, 14, ease.out);
  if (p <= 0) return null;
  const [x1, y1] = from;
  const [x2, y2] = to;
  const my = (y1 + y2) / 2;
  const d = `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`;
  return (
    <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
      <path d={d} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" pathLength={1} strokeDasharray={`${p} 1`} />
    </svg>
  );
}

/** One step of a flow: an icon over a short label. */
function FlowNode({ icon, label, x, y, from }: { icon: IconName; label: ReactNode; x: number; y: number; from: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  if (frame < from) return null;
  const p = pop(frame, fps, from, 12, 0.6);
  return (
    <div style={{ position: 'absolute', left: x - 170, top: y - 150, width: 340, height: 300, borderRadius: 28, background: C.panel.bg, border: `2px solid ${alpha(C.accent, 0.6)}`, boxShadow: `${C.shadow.panel}, ${C.glow(alpha(C.accent, 0.3), 34)}`, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 22, padding: '0 26px', opacity: Math.min(1, p * 1.5), transform: `translateY(${(1 - p) * 40}px) scale(${0.8 + 0.2 * p})` }}>
      <Icon name={icon} color={C.accent} size={86} />
      <div style={{ fontFamily: FONT, fontWeight: 700, fontSize: 36, lineHeight: 1.2, color: C.ink, textAlign: 'center' }}>{label}</div>
    </div>
  );
}

/** An arrow between flow steps that grows on. */
function Arrow({ x, y, from }: { x: number; y: number; from: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const C = useTheme();
  const p = ramp(frame, from, 10, ease.out);
  if (p <= 0) return null;
  return (
    <svg width={90} height={40} style={{ position: 'absolute', left: x - 45, top: y - 20, overflow: 'visible' }}>
      <path d={`M 4 20 L ${4 + 70 * p} 20`} stroke={C.accent2} strokeWidth={6} strokeLinecap="round" />
      {p > 0.8 ? <path d="M 62 8 L 78 20 L 62 32" fill="none" stroke={C.accent2} strokeWidth={6} strokeLinecap="round" strokeLinejoin="round" /> : null}
    </svg>
  );
}

/** A pill that gets a line struck through it on its cue. */
function Struck({ text, x, y, from, strike, to }: { text: string; x: number; y: number; from: number; strike: number; to: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  if (frame < from || frame > to + 12) return null;
  const p = pop(frame, fps, from, 12, 0.6);
  const s = ramp(frame, strike, 8, ease.out);
  const out = 1 - ramp(frame, to, 12, ease.in);
  const red = '#ff6b81';
  return (
    <div style={{ position: 'absolute', left: x, top: y, transform: `translate(-50%, -50%) scale(${(0.7 + 0.3 * p) * (1 - 0.06 * s)}) rotate(${-3 * s}deg)`, opacity: Math.min(1, p * 1.5) * out * (1 - 0.3 * s), padding: '18px 40px', borderRadius: 999, background: C.panel.bg, border: `3px solid ${s > 0 ? alpha(red, 0.4 + 0.6 * s) : C.panel.border}`, boxShadow: C.shadow.panel, fontFamily: MONO, fontWeight: 600, fontSize: 52, color: C.ink, whiteSpace: 'nowrap' }}>
      {text}
      <div style={{ position: 'absolute', left: 24, top: '50%', height: 7, width: `calc(${s} * (100% - 48px))`, borderRadius: 4, background: red, transform: 'rotate(-6deg)' }} />
    </div>
  );
}

/** The class Rayfin makes everything from, shrunk to a glowing chip. */
function ClassSeed({ x, y, from, glow = 0 }: { x: number; y: number; from: number; glow?: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  if (frame < from) return null;
  const p = pop(frame, fps, from, 11, 0.6);
  return (
    <div style={{ position: 'absolute', left: x, top: y, transform: `translate(-50%, -50%) scale(${(0.6 + 0.4 * p) * (1 + 0.12 * glow)})`, opacity: Math.min(1, p * 1.5), padding: '16px 34px', borderRadius: 18, background: '#0f1014', border: `3px solid ${C.accent2}`, boxShadow: `${C.shadow.panel}, ${C.glow(alpha(C.accent2, 0.35 + 0.5 * glow), 36 + 40 * glow, 4 + 8 * glow)}`, fontFamily: MONO, fontSize: 38, whiteSpace: 'nowrap' }}>
      <span style={{ color: '#dcdcaa' }}>@entity</span>
      <span style={{ color: '#ffd700' }}>()</span>
      <span style={{ color: '#569cd6' }}> class </span>
      <span style={{ color: '#4ec9b0' }}>Expense</span>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */
/*                                     1. The cold open                                       */
/* ------------------------------------------------------------------------------------------ */

const TEASER = [
  { word: 'database', icon: 'database', label: 'Database', x: 470, y: 300 },
  { word: 'API', icon: 'api', label: 'API', x: 1450, y: 300 },
  { word: 'typed', icon: 'client', label: 'Typed client', x: 470, y: 770 },
  { word: 'security', icon: 'lock', label: 'Security rules', x: 1450, y: 770 },
] as const;

const coldOpen: LessonScene = {
  id: 'cold-open',
  ray: (c) => ({
    keys: [
      { f: 0, x: 960, y: 1250, s: 0.72 },
      swim(c.lead + 4, 'hook', ease.out),
      swim(c.w('Watch') - 2, 'hook'),
      { f: c.w('Watch') + 12, x: 960, y: 930, s: 0.66, e: ease.out },
      { f: c.span.duration, x: 960, y: 920, s: 0.66 },
    ],
    moods: [
      { f: 0, mood: 'idle' },
      { f: c.w('No'), mood: 'happy' },
      { f: c.w('security'), mood: 'surprised' },
      { f: c.wEnd('rules') + 4, mood: 'happy' },
    ],
    rolls: [6],
    hops: [c.w('Watch')],
    gaze: [
      [0, 0, -0.8],
      [c.w('class'), 0, -0.9],
      [c.w('No'), 0, 0.1],
      ...TEASER.map((t) => [c.w(t.word), (t.x - 960) / 600, -0.8] as const),
    ],
  }),
  sfx: (c) => [
    { f: 4, id: 'swim-whoosh', volume: 0.4 },
    { f: c.w('was'), id: 'typing', volume: 0.28, duration: c.wEnd('class') - c.w('was') + 6 },
    { f: c.wEnd('class'), id: 'shimmer', volume: 0.35 },
    ...TEASER.map((t) => ({ f: c.w(t.word), id: 'pop' as const, volume: 0.55 })),
    { f: c.span.duration - 16, id: 'sweep', volume: 0.45 },
  ],
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const C = useTheme();
    const shrink = ramp(frame, ctx.w('No'), 18, ease.inOut);
    const exit = ramp(frame, ctx.span.duration - 18, 16, ease.in);
    return (
      <AbsoluteFill>
        <AbsoluteFill style={{ transform: `scale(${1 - 0.9 * exit})`, opacity: 1 - exit }}>
          {TEASER.map((t) => (
            <Beam key={t.word} from={[960, 535]} to={[t.x, t.y]} at={ctx.w(t.word) - 4} color={alpha(C.accent2, 0.7)} />
          ))}
          <CodeCard code={CLASS_ONLY} file={FILE} firstLine={3} x={960} y={440 + 95 * shrink} width={1080} fontSize={30} from={ctx.w('whole') - 6} typeFrom={ctx.w('was')} typeTo={ctx.wEnd('class') - 2} scale={1 - 0.42 * shrink} />
          {TEASER.map((t, i) => (
            <MiniTile key={t.word} icon={t.icon} label={t.label} x={t.x} y={t.y} from={ctx.w(t.word)} color={i % 2 ? C.accent : C.accent2} />
          ))}
          {TEASER.map((t, i) => (
            <Burst key={`b${t.word}`} kind="sparkles" at={ctx.w(t.word) + 2} x={t.x} y={t.y} count={10} seed={100 + i} spread={1.6} />
          ))}
        </AbsoluteFill>
        <AbsoluteFill style={{ background: C.fadeIn, opacity: 1 - ramp(frame, 0, 14) }} />
      </AbsoluteFill>
    );
  },
};

/* ------------------------------------------------------------------------------------------ */
/*                                     2. The bumper                                          */
/* ------------------------------------------------------------------------------------------ */

const bumper: LessonScene = {
  id: 'bumper',
  bed: 0,
  ray: (c) => ({
    keys: [
      { f: 0, x: 960, y: 920, s: 0.66 },
      { f: 18, x: 1560, y: 860, s: 0.66 },
      { f: 40, x: 1500, y: 880, s: 0.66 },
      { f: c.span.duration - 20, x: 1500, y: 880, s: 0.66 },
      { f: c.span.duration, x: 960, y: 880, s: 0.7 },
    ],
    moods: [{ f: 0, mood: 'happy' }],
    rolls: [20],
    squishes: [46],
    gaze: [
      [0, 0.6, -0.2],
      [30, -0.8, -0.6],
    ],
  }),
  sfx: (c) => [{ f: c.lead, id: 'jingle', volume: 1 }],
  View: ({ ctx }) => <SeriesBumper series={SERIES.name} number={SCRIPT.number} title={SCRIPT.title} from={ctx.lead} to={ctx.span.duration - 16} />,
};

/* ------------------------------------------------------------------------------------------ */
/*                                     3. Welcome                                             */
/* ------------------------------------------------------------------------------------------ */

const welcome: LessonScene = {
  id: 'welcome',
  ray: (c) => ({
    keys: [
      { f: 0, x: 960, y: 880, s: 0.7 },
      swim(c.lead + 18, 'welcome', ease.out),
      swim(c.beat('today').from - 2, 'welcome'),
      swim(c.beat('today').from + 22, 'today'),
      swim(c.w('dive') - 6, 'today'),
      { f: c.w('dive') + 10, x: 330, y: 560, s: 0.85, e: ease.out },
      { f: c.span.duration, ...SPOT.tangle },
    ],
    moods: [
      { f: 0, mood: 'happy' },
      { f: c.w('Today'), mood: 'idle' },
      { f: c.w('dive'), mood: 'happy' },
    ],
    waves: [c.w('Hi') - 4],
    hops: [c.w("Let's")],
    gaze: [
      [0, 0, 0.1],
      [c.w('Today'), 0.8, -0.3],
      [c.w('dive'), 0, 0.1],
    ],
  }),
  sfx: (c) => [
    { f: c.w('Hi'), id: 'bubbles', volume: 0.35 },
    { f: c.w('what'), id: 'pop', volume: 0.5 },
    { f: c.w('how'), id: 'pop', volume: 0.5 },
    { f: c.w('how', 2), id: 'pop', volume: 0.5 },
    { f: c.w('dive'), id: 'swim-whoosh', volume: 0.4 },
  ],
  View: ({ ctx }) => (
    <AbsoluteFill>
      <Burst kind="bubbles" at={ctx.w('Hi')} x={1000} y={470} count={10} seed={21} />
      <Chip x={960} y={790} from={ctx.w("I'm")} to={ctx.beat('today').from} accent="#46ccb0" size={36}>
        <span>
          Ray <span style={{ fontWeight: 500, opacity: 0.8 }}>· your guide to Rayfin</span>
        </span>
      </Chip>
      <Objectives
        x={700}
        y={300}
        from={ctx.w('Today') - 4}
        to={ctx.w('dive') - 4}
        items={[
          { text: 'What Rayfin is', at: ctx.w('what') },
          { text: 'How one class becomes a backend', at: ctx.w('how') },
          { text: 'How it ships to Microsoft Fabric', at: ctx.w('how', 2) },
        ]}
      />
    </AbsoluteFill>
  ),
};

/* ------------------------------------------------------------------------------------------ */
/*                                   4. What is Rayfin?                                       */
/* ------------------------------------------------------------------------------------------ */

const TANGLE = [
  { word: 'database', icon: 'database', label: 'Database', x: 560, y: 300 },
  { word: 'migrations', icon: 'migrate', label: 'Migrations', x: 1380, y: 280 },
  { word: 'APIs', icon: 'api', label: 'APIs', x: 360, y: 590 },
  { word: 'sign-in', icon: 'signin', label: 'Sign-in', x: 1560, y: 580 },
  { word: 'hosting', icon: 'hosting', label: 'Hosting', x: 620, y: 860 },
  { word: 'security', icon: 'lock', label: 'Security rules', x: 1340, y: 860 },
] as const;
const KNOTS: ReadonlyArray<readonly [number, number]> = [
  [0, 3],
  [1, 4],
  [2, 5],
  [0, 5],
  [1, 2],
  [3, 4],
  [0, 1],
];

const problem: LessonScene = {
  id: 'problem',
  ray: (c) => {
    const all = c.w('all');
    const is = c.beat('rayfin-is').from;
    return {
      keys: [
        { f: 0, ...SPOT.tangle },
        { f: all - 2, ...SPOT.tangle },
        { f: all + 8, x: 980, y: 610, s: 0.85, r: -12, e: ease.out },
        { f: all + 22, x: 945, y: 600, s: 0.85, r: 10 },
        { f: all + 36, x: 975, y: 605, s: 0.85, r: -8 },
        { f: is, x: 960, y: 590, s: 0.85, r: 0 },
        swim(is + 20, 'flow'),
        swim(c.span.duration, 'flow'),
      ],
      moods: [
        { f: 0, mood: 'idle' },
        { f: c.w('database'), mood: 'surprised' },
        { f: all - 2, mood: 'dizzy' },
        { f: is, mood: 'happy' },
      ],
      squishes: [all - 2],
      hops: [c.w('Rayfin')],
      gaze: [
        [0, 0, 0.1],
        ...TANGLE.map((t) => [c.w(t.word), (t.x - 960) / 600, (t.y - 590) / 400] as const),
        [c.w('Rayfin'), 0.4, -0.6],
        [c.w('describe'), 0.6, 0],
        [c.w('generates'), 0.9, 0],
        [c.w('runs'), 1, 0],
      ],
    };
  },
  sfx: (c) => [
    ...TANGLE.map((t, i) => ({ f: c.w(t.word), id: 'thud' as const, volume: 0.3 + (i % 3) * 0.05 })),
    { f: c.w('all') - 2, id: 'boing', volume: 0.45 },
    { f: c.w('all'), id: 'dizzy', volume: 0.45 },
    { f: c.beat('rayfin-is').from - 4, id: 'sweep', volume: 0.5 },
    { f: c.w('Rayfin'), id: 'shimmer', volume: 0.35 },
    { f: c.w('describe'), id: 'pop', volume: 0.5 },
    { f: c.w('generates'), id: 'pop', volume: 0.5 },
    { f: c.w('runs'), id: 'chime', volume: 0.35 },
  ],
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const C = useTheme();
    const all = ctx.w('all');
    const sweepAt = ctx.beat('rayfin-is').from - 6;
    const sweep = ramp(frame, sweepAt, 16, ease.in);
    const shaking = frame >= all && frame < sweepAt;
    const title = pop(frame, fps, ctx.w('Rayfin'), 12, 0.6);
    const sub = pop(frame, fps, ctx.w('platform'), 12, 0.6);
    return (
      <AbsoluteFill style={{ opacity: fadeOut(frame, ctx.span.duration, 12) }}>
        {sweep < 1 ? (
          <AbsoluteFill style={{ transform: `rotate(${shaking ? Math.sin((frame - all) * 1.3) * 2 : 0}deg) scale(${1 - 0.9 * sweep})`, opacity: 1 - sweep, transformOrigin: '50% 55%' }}>
            {KNOTS.map(([a, b], i) => (
              <Beam key={i} from={[TANGLE[a].x, TANGLE[a].y]} to={[TANGLE[b].x, TANGLE[b].y]} at={Math.max(ctx.w(TANGLE[a].word), ctx.w(TANGLE[b].word))} color={alpha(C.accent, 0.45)} width={3} />
            ))}
            {TANGLE.map((t, i) => (
              <div key={t.word} style={{ position: 'absolute', inset: 0, transform: shaking ? `translate(${Math.sin(frame / 3 + i) * 5}px, ${Math.cos(frame / 4 + i) * 5}px)` : undefined }}>
                <MiniTile icon={t.icon} label={t.label} x={t.x} y={t.y} from={ctx.w(t.word)} color={i % 2 ? C.accent : C.accent2} />
              </div>
            ))}
            <DizzyStars x={960} y={470} radius={150} from={all} to={sweepAt} />
          </AbsoluteFill>
        ) : null}
        {frame >= ctx.w('Rayfin') ? (
          <div style={{ position: 'absolute', left: 0, right: 0, top: 150, textAlign: 'center', opacity: Math.min(1, title * 1.4), transform: `translateY(${(1 - title) * 40}px)` }}>
            <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: 132, letterSpacing: '-0.04em', lineHeight: 1, backgroundImage: `linear-gradient(100deg, ${C.accent}, ${C.accent2})`, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent', display: 'inline-block' }}>Rayfin</div>
            <div style={{ marginTop: 18, fontFamily: FONT, fontWeight: 650, fontSize: 48, color: C.inkSoft, opacity: Math.min(1, sub * 1.4) }}>A backend platform for TypeScript developers</div>
          </div>
        ) : null}
        {/* Between Ray (on the left) and the frame's right edge: boxes span 540–1770. */}
        <FlowNode icon="file" label="Your data, in TypeScript" x={710} y={680} from={ctx.w('describe')} />
        <Arrow x={932} y={680} from={ctx.w('generates') - 6} />
        <FlowNode icon="cog" label="Rayfin generates the backend" x={1155} y={680} from={ctx.w('generates')} />
        <Arrow x={1377} y={680} from={ctx.w('runs') - 6} />
        <FlowNode icon="cloud" label="It runs on Microsoft Fabric" x={1600} y={680} from={ctx.w('runs')} />
      </AbsoluteFill>
    );
  },
};

/* ------------------------------------------------------------------------------------------ */
/*                                   5. Meet the entity                                       */
/* ------------------------------------------------------------------------------------------ */

const L_ENTITY = locate(EXPENSE, '@entity()');
const L_ROLE = locate(EXPENSE, "@role('authenticated', '*', {");
const L_POLICY = locate(EXPENSE, 'claims.sub.eq(item.owner_id)');
const L_TEXT = locate(EXPENSE, '@text({ max: 200 })');
const L_DECIMAL = locate(EXPENSE, '@decimal()');
const L_DATE = locate(EXPENSE, '@date()');
const L_CLASS = locate(EXPENSE, 'export class Expense {');
const L_OWNER = locate(EXPENSE, 'owner_id!');

const entity: LessonScene = {
  id: 'entity',
  dim: 0.3,
  ray: (c) => ({
    keys: [{ f: 0, ...SPOT.flow }, swim(24, 'entity'), swim(c.span.duration, 'entity')],
    moods: [
      { f: 0, mood: 'happy' },
      { f: 26, mood: 'idle' },
      { f: c.at('entity-4', 'only'), mood: 'happy' },
    ],
    hops: [c.at('entity-2', 'entity')],
    gaze: [
      [0, 0.6, -0.4],
      [30, 0.9, -0.8],
    ],
  }),
  sfx: (c) => [
    { f: 4, id: 'swim-whoosh', volume: 0.3 },
    { f: c.at('entity-2', 'entity'), id: 'pop', volume: 0.45 },
    { f: c.at('entity-3', 'text'), id: 'pop', volume: 0.4 },
    { f: c.at('entity-3', 'decimal'), id: 'pop', volume: 0.4 },
    { f: c.at('entity-3', 'date'), id: 'pop', volume: 0.4 },
    { f: c.at('entity-4', 'role'), id: 'stamp', volume: 0.45 },
    { f: c.at('entity-4', 'only'), id: 'chime', volume: 0.3 },
  ],
  View: ({ ctx }) => {
    const e2 = ctx.at('entity-2', 'entity');
    const e3 = ctx.beat('entity-3').from;
    const e4 = ctx.beat('entity-4').from;
    const end = ctx.span.duration - 14;
    return (
      <AbsoluteFill>
        <ChapterTag text="Meet the entity" from={ctx.lead} to={end} />
        <CodeCard
          code={EXPENSE}
          file={FILE}
          x={1010}
          y={510}
          width={1500}
          fontSize={27}
          from={ctx.lead + 4}
          to={end}
          focus={[
            { lines: [L_ENTITY.line, L_CLASS.line], from: e2 - 4, to: e3 },
            { lines: [L_TEXT.line - 1, L_TEXT.line, L_DECIMAL.line, L_DATE.line, L_OWNER.line], from: e3, to: e4 },
            { lines: [L_ROLE.line, L_POLICY.line, L_POLICY.line + 1, L_OWNER.line], from: e4, to: end + 20 },
          ]}
          marks={[
            { line: L_ENTITY.line, from: L_ENTITY.from, to: L_ENTITY.to, at: e2, until: e3 - 2, label: 'Data that Rayfin stores and serves' },
            { line: L_TEXT.line, from: L_TEXT.from, to: L_TEXT.to, at: ctx.at('entity-3', 'text'), until: e4 - 2, label: 'Text, at most 200 characters', labelGap: 7 },
            { line: L_DECIMAL.line, from: L_DECIMAL.from, to: L_DECIMAL.to, at: ctx.at('entity-3', 'decimal'), until: e4 - 2, label: 'A decimal', labelGap: 15 },
            { line: L_DATE.line, from: L_DATE.from, to: L_DATE.to, at: ctx.at('entity-3', 'date'), until: e4 - 2, label: 'A date', labelGap: 19 },
            { line: L_ROLE.line, from: L_ROLE.from, to: L_ROLE.to, at: ctx.at('entity-4', 'role'), until: end, label: 'Who can touch it' },
            { line: L_POLICY.line, from: L_POLICY.from, to: L_POLICY.to, at: ctx.at('entity-4', 'policy'), until: end, label: 'Only your own rows', color: '#46ccb0' },
          ]}
        />
        <Chip x={1010} y={930} from={ctx.at('entity-4', 'only') + 10} to={end} size={28} accent="#46ccb0">
          <span>
            Same rule, shorter: <span style={{ fontFamily: MONO, fontWeight: 500 }}>@authenticated('*', {'{'} policy {'}'})</span>
          </span>
        </Chip>
      </AbsoluteFill>
    );
  },
};

/* ------------------------------------------------------------------------------------------ */
/*                                     6. Deep Dive                                           */
/* ------------------------------------------------------------------------------------------ */

const SEED = { x: 960, y: 135 } as const;
/** Clear of the depth gauge on the left, which runs to x 250 with its reading. */
const CARDS = {
  table: { x: 550, y: 420, w: 540 },
  api: { x: 1070, y: 380, w: 440 },
  client: { x: 1560, y: 420, w: 480 },
  rls: { x: 550, y: 805, w: 540 },
  validation: { x: 1070, y: 800, w: 440 },
} as const;
type Card = keyof typeof CARDS;
const CARD_IDS = Object.keys(CARDS) as Card[];

const deepDive: LessonScene = {
  id: 'deep-dive',
  depth: 1,
  ray: (c) => ({
    keys: [{ f: 0, ...SPOT.entity }, swim(30, 'deep'), swim(c.span.duration, 'deep')],
    moods: [
      { f: 0, mood: 'happy' },
      { f: c.w('table'), mood: 'idle' },
      { f: c.w('validation') - 2, mood: 'surprised' },
      { f: c.w('No'), mood: 'idle' },
      { f: c.w('Just'), mood: 'happy' },
    ],
    rolls: [6],
    hops: [c.w('validation') + 10, c.w('Just')],
    gaze: [
      [0, 0, 0.4],
      [c.w('table'), -1, -0.3],
      [c.w('REST'), -0.6, -0.6],
      [c.w('client'), 0, -0.9],
      [c.w('Row-level'), -1, 0],
      [c.w('validation'), -0.6, 0],
      [c.w('No'), -0.8, -0.3],
      [c.w('Just'), -0.6, -0.9],
    ],
  }),
  sfx: (c) => [
    { f: 0, id: 'dive', volume: 0.55 },
    { f: c.w('class'), id: 'shimmer', volume: 0.3 },
    { f: c.w('table'), id: 'sonar', volume: 0.3 },
    { f: c.w('REST'), id: 'sonar', volume: 0.25 },
    { f: c.w('client'), id: 'sonar', volume: 0.3 },
    { f: c.w('Row-level'), id: 'sonar', volume: 0.25 },
    { f: c.w('validation'), id: 'pop', volume: 0.5 },
    { f: c.w('SQL'), id: 'stamp', volume: 0.4 },
    { f: c.w('schema'), id: 'stamp', volume: 0.4 },
    { f: c.w('contract'), id: 'stamp', volume: 0.4 },
    { f: c.w('Just'), id: 'chime', volume: 0.4 },
  ],
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const C = useTheme();
    const end = ctx.span.duration - 14;
    const noSql = ctx.beat('no-sql').from;
    const just = ctx.w('Just');
    const dim = 1 - 0.7 * ramp(frame, noSql, 10) * (1 - ramp(frame, just, 10));
    const glow = ramp(frame, just, 10) * (0.6 + 0.4 * Math.sin((frame - just) / 5));
    const appear: Record<Card, number> = {
      table: ctx.w('table'),
      api: ctx.w('REST'),
      client: ctx.w('client'),
      rls: ctx.w('Row-level'),
      validation: ctx.w('validation'),
    };
    const top = (k: Card) => [CARDS[k].x, CARDS[k].y - (k === 'rls' || k === 'validation' ? 130 : 150)] as const;
    return (
      <AbsoluteFill style={{ opacity: fadeOut(frame, ctx.span.duration, 12) }}>
        <DeepDiveTitle from={ctx.lead} to={end} tuckAt={ctx.w("Let's")} />
        <DepthGauge from={0} to={ctx.span.duration - 20} />
        <div style={{ position: 'absolute', inset: 0, opacity: dim }}>
          {CARD_IDS.map((k) => (
            <Beam key={k} from={[SEED.x, SEED.y + 30]} to={top(k)} at={appear[k] - 6} color={alpha(C.accent2, 0.55)} width={3} />
          ))}
          <ArtifactCard x={CARDS.table.x} y={CARDS.table.y} width={CARDS.table.w} icon="table" title="A database table" subtitle="expenses" at={appear.table} lit={0.5}>
            <TableBody
              columns={['title', 'amount', 'spentOn', 'owner_id']}
              rows={[
                ['Team lunch', '42.50', 'Oct 2', 'avery'],
                ['Taxi', '18.20', 'Oct 3', 'jordan'],
                ['Coffee', '6.75', 'Oct 4', 'avery'],
              ]}
              rowsFrom={appear.table + 8}
            />
          </ArtifactCard>
          <ArtifactCard x={CARDS.api.x} y={CARDS.api.y} width={CARDS.api.w} icon="api" title="REST and GraphQL APIs" at={appear.api}>
            <ApiBody rest="Read and write expenses" graphql="Just the fields you need" />
          </ArtifactCard>
          <ArtifactCard x={CARDS.client.x} y={CARDS.client.y} width={CARDS.client.w} icon="client" title="A type-safe client" at={appear.client}>
            <AutocompleteBody prefix="client.data.Expense" items={CLIENT_METHODS.filter((m) => !['groupBy', 'orderBy', 'delete'].includes(m))} from={appear.client + 8} pick={3} />
          </ArtifactCard>
          <ArtifactCard x={CARDS.rls.x} y={CARDS.rls.y} width={CARDS.rls.w} icon="lock" title="Row-level security" at={appear.rls}>
            <RowSecurityBody
              people={[
                { name: 'Avery', color: '#35a3ea' },
                { name: 'Jordan', color: '#46ccb0' },
              ]}
              rows={[
                { text: 'Team lunch', owner: 0 },
                { text: 'Taxi', owner: 1 },
                { text: 'Coffee', owner: 0 },
              ]}
              split={ctx.w('only')}
            />
          </ArtifactCard>
          <ArtifactCard x={CARDS.validation.x} y={CARDS.validation.y} width={CARDS.validation.w} icon="form" title="Form validation" at={appear.validation}>
            <ValidationBody
              fields={[
                { label: 'Amount', value: '42.50' },
                { label: 'Title', value: 'A title that just keeps going and going and going…', error: 'At most 200 characters' },
              ]}
              failAt={appear.validation + 10}
            />
          </ArtifactCard>
          {CARD_IDS.map((k, i) => (
            <Sonar key={k} x={CARDS[k].x} y={CARDS[k].y} at={appear[k]} size={420} rings={2} color={alpha(i % 2 ? C.accent : C.accent2, 0.7)} />
          ))}
        </div>
        <ClassSeed x={SEED.x} y={SEED.y} from={ctx.w('class') - 2} glow={glow} />
        <Struck text="SQL" x={560} y={540} from={ctx.w('SQL') - 4} strike={ctx.w('SQL') + 4} to={just} />
        <Struck text="schema files" x={960} y={540} from={ctx.w('schema') - 4} strike={ctx.w('schema') + 4} to={just} />
        <Struck text="API contracts" x={1400} y={540} from={ctx.w('contract') - 6} strike={ctx.w('contract') + 4} to={just} />
        <Burst kind="sparkles" at={just} x={SEED.x} y={SEED.y} count={16} seed={61} spread={2.4} />
      </AbsoluteFill>
    );
  },
};

/* ------------------------------------------------------------------------------------------ */
/*                                   7. Ship it to Fabric                                     */
/* ------------------------------------------------------------------------------------------ */

const ship: LessonScene = {
  id: 'ship',
  ray: (c) => ({
    keys: [{ f: 0, ...SPOT.deep }, swim(28, 'ship'), swim(c.span.duration, 'ship')],
    moods: [
      { f: 0, mood: 'happy' },
      { f: c.w('database'), mood: 'idle' },
      { f: c.w('lift'), mood: 'happy' },
    ],
    waves: [c.w('lift') - 4],
    hops: [c.w('fin')],
    gaze: [
      [0, -0.6, -0.8],
      [c.w('database'), -1, -0.6],
      [c.w('lift'), 0, 0.1],
    ],
  }),
  sfx: (c) => [
    { f: 0, id: 'surface', volume: 0.5 },
    { f: c.w('rayfin') - 2, id: 'typing', volume: 0.3, duration: 18 },
    { f: c.w('deploys'), id: 'stamp', volume: 0.4 },
    { f: c.w('Fabric'), id: 'chime', volume: 0.35 },
    ...['database', 'APIs', 'sign-in', 'frontend'].map((w) => ({ f: c.w(w), id: 'pop' as const, volume: 0.5 })),
    { f: c.w('inside'), id: 'shimmer', volume: 0.35 },
    { f: c.w('fin'), id: 'bubbles', volume: 0.35 },
  ],
  View: ({ ctx }) => {
    const C = useTheme();
    const two = ctx.beat('ship-2').from;
    return (
      <AbsoluteFill>
        <ChapterTag text="Ship it to Microsoft Fabric" from={ctx.lead} to={ctx.span.duration - 14} />
        <CommandCard
          command="npx rayfin up"
          output={[{ text: '✓ Deployed to Microsoft Fabric', at: ctx.w('Fabric'), color: C.ok }]}
          from={ctx.lead + 2}
          to={two - 4}
          typeFrom={ctx.w('rayfin') - 2}
          typeTo={ctx.w('rayfin') + 14}
          tagAt={ctx.w('deploys')}
          x={960}
          y={470}
          width={900}
          scale={1.45}
        />
        <ServiceTiles
          y={560}
          boundaryAt={ctx.w('inside') - 4}
          boundaryLabel="Microsoft Fabric · inside your organization’s tenant"
          tiles={[
            { icon: 'database', label: 'Database', sub: 'Your data, in Fabric', at: ctx.w('database') },
            { icon: 'api', label: 'APIs', sub: 'REST and GraphQL', at: ctx.w('APIs') },
            { icon: 'signin', label: 'Sign-in', sub: 'Microsoft Entra ID', at: ctx.w('sign-in') },
            { icon: 'hosting', label: 'Hosting', sub: 'Your app’s frontend', at: ctx.w('frontend') },
          ]}
          until={ctx.span.duration - 14}
          extra={{ text: '+ Functions and storage, when you turn them on', at: ctx.w('tenant') + 8 }}
        />
        <Burst kind="bubbles" at={ctx.w('fin')} x={SPOT.ship.x} y={SPOT.ship.y - 40} count={10} seed={71} />
      </AbsoluteFill>
    );
  },
};

/* ------------------------------------------------------------------------------------------ */
/*                                 8. See it in Fabricator                                    */
/* ------------------------------------------------------------------------------------------ */

/** Pixels in the screenshots this scene points at. */
const DIFF = { entity: { x: 132, y: 844, w: 112, h: 28 }, role: { x: 132, y: 871, w: 588, h: 82 } } as const;
const BLUEPRINT = { fields: { x: 606, y: 392, w: 394, h: 262 }, types: { x: 898, y: 392, w: 100, h: 262 }, access: { x: 608, y: 670, w: 182, h: 32 } } as const;
const REDEPLOY = { x: 1316, y: 5, w: 92, h: 38 } as const;

/** A window's fade and scale as it comes in at `from` and leaves at `to`; null while it's away. */
function windowLife(frame: number, fps: number, from: number, to: number): { opacity: number; scale: number } | null {
  if (frame < from || frame > to + 10) return null;
  const p = pop(frame, fps, from, 14, 0.8);
  const out = 1 - ramp(frame, to, 10, ease.in);
  return { opacity: Math.min(1, p * 1.6) * out, scale: (0.92 + 0.08 * p) * (0.96 + 0.04 * out) };
}

function fabricatorBeats(c: LessonCtx) {
  const sent = c.beat('fab-2').from + 2;
  const writes = c.w('writes');
  const rowsTo = writes + 4;
  return {
    typeFrom: c.w('Describe'),
    typeTo: c.wEnd('English') - 4,
    sent,
    rows: Array.from({ length: FIRST_TURN_ROWS }, (_, i) => Math.round(sent + 10 + (i * (rowsTo - sent - 10)) / (FIRST_TURN_ROWS - 1))),
    diff: writes + 2,
    blueprint: c.beat('fab-3').from,
    redeploy: c.beat('fab-4').from,
  };
}

const fabricator: LessonScene = {
  id: 'fabricator',
  dim: 0.35,
  ray: (c) => ({
    keys: [{ f: 0, ...SPOT.ship }, swim(28, 'fabricator'), swim(c.span.duration, 'fabricator')],
    moods: [
      { f: 0, mood: 'happy' },
      { f: 30, mood: 'idle' },
      { f: c.w('See') - 2, mood: 'surprised' },
      { f: c.w('entity', 2), mood: 'happy' },
    ],
    hops: [c.w('See'), c.w('redeploys')],
    gaze: [
      [0, -0.6, -0.4],
      [30, -0.9, 0.5],
      [c.w('See'), -1, 0.3],
      [c.w('Blueprint'), -1, 0.4],
      [c.w('runs'), -0.6, -0.2],
    ],
  }),
  sfx: (c) => {
    const b = fabricatorBeats(c);
    return [
      { f: b.typeFrom, id: 'typing', volume: 0.3, duration: b.typeTo - b.typeFrom },
      { f: b.sent, id: 'click', volume: 0.55 },
      { f: b.diff, id: 'swim-whoosh', volume: 0.3 },
      { f: c.w('See'), id: 'pop', volume: 0.45 },
      { f: b.blueprint, id: 'swim-whoosh', volume: 0.3 },
      { f: c.w('who'), id: 'chime', volume: 0.3 },
      { f: b.redeploy, id: 'swim-whoosh', volume: 0.3 },
      { f: c.w('runs'), id: 'click', volume: 0.5 },
      { f: c.w('redeploys'), id: 'chime', volume: 0.35 },
    ];
  },
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const b = fabricatorBeats(ctx);
    const end = ctx.span.duration - 14;
    const chat = windowLife(frame, fps, ctx.lead, b.diff);
    const diff = windowLife(frame, fps, b.diff, b.blueprint);
    const model = windowLife(frame, fps, b.blueprint, b.redeploy);
    const bench = windowLife(frame, fps, b.redeploy, end);
    const fy = track(frame, [
      [b.sent, 722],
      [b.sent + 18, 330],
    ]);
    const modelZoom = track(frame, [
      [b.blueprint + 6, 1],
      [b.blueprint + 30, 1.6],
    ]);
    const benchZoom = track(frame, [
      [b.redeploy + 6, 1],
      [ctx.w('runs') - 4, 2.1],
    ]);
    // Pushes in on the decorators as Ray points them out.
    const look = ctx.w('See');
    const diffCam = {
      zoom: track(frame, [
        [look - 6, 1.4],
        [look + 16, 1.78],
      ]),
      fx: track(frame, [
        [look - 6, 520],
        [look + 16, 420],
      ]),
      fy: track(frame, [
        [look - 6, 715],
        [look + 16, 905],
      ]),
    };
    return (
      <AbsoluteFill>
        <ChapterTag text="See it in Fabricator" from={ctx.lead} to={end} />
        {chat ? (
          <AppWindow shot={SHOTS.chatWorking} x={960} y={560} width={1400} zoom={1.8} fx={400} fy={fy} opacity={chat.opacity} scale={chat.scale}>
            <FirstTurn prompt={PROMPT} typeFrom={b.typeFrom} typeTo={b.typeTo} sent={b.sent} rows={b.rows} app={b.diff + 30} />
          </AppWindow>
        ) : null}
        {diff ? (
          <AppWindow shot={CHAT_DIFF} x={960} y={560} width={1000} height={860} {...diffCam} opacity={diff.opacity} scale={diff.scale}>
            <Spotlight {...DIFF.entity} radius={8} opacity={ramp(frame, ctx.w('entity', 2) - 2, 6) * (1 - ramp(frame, ctx.w('role') - 4, 6))} />
            <Spotlight {...DIFF.role} radius={10} opacity={ramp(frame, ctx.w('role') - 2, 6)} />
          </AppWindow>
        ) : null}
        {model ? (
          <AppWindow shot={MODEL} x={960} y={560} width={1500} zoom={modelZoom} fx={800} fy={540} opacity={model.opacity} scale={model.scale}>
            <Spotlight {...BLUEPRINT.fields} radius={14} dim={0.45} opacity={ramp(frame, ctx.w('field') - 2, 6) * (1 - ramp(frame, ctx.w('type') - 2, 6))} />
            <Spotlight {...BLUEPRINT.types} radius={12} dim={0.45} opacity={ramp(frame, ctx.w('type') - 2, 6) * (1 - ramp(frame, ctx.w('who') - 2, 6))} />
            <Spotlight {...BLUEPRINT.access} radius={10} dim={0.45} opacity={ramp(frame, ctx.w('who') - 2, 6)} />
          </AppWindow>
        ) : null}
        {bench ? (
          <AppWindow shot={SHOTS.workbench} x={960} y={540} width={1400} zoom={benchZoom} fx={1300} fy={160} opacity={bench.opacity} scale={bench.scale}>
            <Spotlight {...REDEPLOY} radius={8} opacity={ramp(frame, ctx.w('runs'), 6)} />
          </AppWindow>
        ) : null}
        <Chip x={960} y={960} from={ctx.w('runs') + 2} to={ctx.w('redeploys') - 2} size={32}>
          <span>
            Runs <span style={{ fontFamily: MONO, fontWeight: 500 }}>rayfin up</span> for you
          </span>
        </Chip>
        <Chip x={960} y={960} from={ctx.w('redeploys')} to={end} size={32}>
          …and redeploys after every successful chat turn
        </Chip>
      </AbsoluteFill>
    );
  },
};

/* ------------------------------------------------------------------------------------------ */
/*                                     9. Pop quiz                                            */
/* ------------------------------------------------------------------------------------------ */

const quiz: LessonScene = {
  id: 'quiz',
  dim: 0.15,
  bed: 0.8,
  ray: (c) => {
    const reveal = c.beat('quiz-answer').from + 3;
    return {
      keys: [{ f: 0, ...SPOT.fabricator }, swim(26, 'quiz'), swim(c.span.duration, 'quiz')],
      moods: [
        { f: 0, mood: 'happy' },
        { f: c.beat('quiz-options').from, mood: 'idle' },
        { f: c.beat('quiz-pause').from, mood: 'surprised' },
        { f: c.beat('countdown').from, mood: 'idle' },
        { f: reveal, mood: 'happy' },
      ],
      hops: [c.w('Pop'), reveal, reveal + 18],
      squishes: [c.beat('quiz-pause').from],
      gaze: [
        [0, -0.6, 0.2],
        [c.beat('quiz-options').from, -1, 0.4],
        [c.beat('quiz-pause').from, 0, 0.1],
        [reveal, -0.9, 0.6],
      ],
    };
  },
  sfx: (c) => {
    const count = c.beat('countdown').from;
    const reveal = c.beat('quiz-answer').from + 3;
    return [
      { f: c.w('Pop'), id: 'boing', volume: 0.4 },
      ...['A', 'B', 'C'].map((l) => ({ f: c.at('quiz-options', l), id: 'pop' as const, volume: 0.5 })),
      { f: count, id: 'tick', volume: 0.6 },
      { f: count + 30, id: 'tick', volume: 0.6 },
      { f: count + 60, id: 'tick', volume: 0.6 },
      { f: reveal, id: 'correct', volume: 0.6 },
      { f: reveal + 2, id: 'confetti', volume: 0.45 },
    ];
  },
  View: ({ ctx }) => (
    <Quiz
      question="Which part of an entity decides who can see each row?"
      options={[
        { text: '@entity()', code: true, at: ctx.at('quiz-options', 'A') },
        { text: '@text({ max: 200 })', code: true, at: ctx.at('quiz-options', 'B') },
        { text: "@role('authenticated', …, { policy })", code: true, at: ctx.at('quiz-options', 'C') },
      ]}
      answer={2}
      countdown={{ from: ctx.beat('countdown').from, step: 30 }}
      revealAt={ctx.beat('quiz-answer').from + 3}
      from={ctx.lead}
      to={ctx.span.duration - 14}
      x={880}
    />
  ),
};

/* ------------------------------------------------------------------------------------------ */
/*                                10. Recap, 11. Challenge                                    */
/* ------------------------------------------------------------------------------------------ */

const recap: LessonScene = {
  id: 'recap',
  ray: (c) => ({
    keys: [{ f: 0, ...SPOT.quiz }, swim(26, 'recap'), swim(c.span.duration, 'recap')],
    moods: [{ f: 0, mood: 'happy' }],
    hops: [c.w('entity'), c.w('makes'), c.w('ships')],
    gaze: [
      [0, -0.6, 0.6],
      [30, -0.9, -0.7],
    ],
  }),
  sfx: (c) => ['entity', 'makes', 'ships'].map((w) => ({ f: c.w(w) + 6, id: 'stamp' as const, volume: 0.4 })),
  View: ({ ctx }) => (
    <Recap
      from={ctx.lead}
      to={ctx.span.duration - 14}
      items={[
        { text: 'An entity is a TypeScript class with decorators', at: ctx.w('entity') },
        { text: 'Rayfin makes the table, APIs, typed client and security', at: ctx.w('makes') },
        {
          text: (
            <span>
              <span style={{ fontFamily: MONO, fontWeight: 500 }}>rayfin up</span> ships it all to Microsoft Fabric
            </span>
          ),
          at: ctx.w('ships'),
        },
      ]}
    />
  ),
};

const challenge: LessonScene = {
  id: 'challenge',
  ray: (c) => ({
    keys: [{ f: 0, ...SPOT.recap }, swim(26, 'challenge'), swim(c.span.duration, 'challenge')],
    moods: [{ f: 0, mood: 'happy' }],
    waves: [c.beat('challenge-2').from],
    gaze: [
      [0, -0.4, -0.4],
      [30, -1, -0.2],
      [c.beat('challenge-2').from, 0, 0.1],
    ],
  }),
  sfx: (c) => [
    { f: c.w('open'), id: 'typing', volume: 0.28, duration: c.w('find') + 20 - c.w('open') },
    { f: c.beat('challenge-2').from, id: 'pop', volume: 0.5 },
  ],
  View: ({ ctx }) => <Challenge prompt={YOUTUBE.challenge.prompt} from={ctx.lead} to={ctx.span.duration - 14} typeFrom={ctx.w('open')} typeTo={ctx.w('find') + 20} cta={YOUTUBE.challenge.question} ctaAt={ctx.beat('challenge-2').from} />,
};

/* ------------------------------------------------------------------------------------------ */
/*                                12. Next up, 13. Ray fact                                   */
/* ------------------------------------------------------------------------------------------ */

function TheEnd({ from, to }: { from: number; to: number }): JSX.Element {
  return (
    <EndScreen
      series={SERIES.name}
      next={YOUTUBE.next}
      from={from}
      to={to}
      fabricator={
        <span>
          Build along with <b>Fabricator</b>, free and open source · spatney.github.io/rayfin-fabricator
        </span>
      }
      disclaimer={SERIES.disclaimer}
    />
  );
}

const next: LessonScene = {
  id: 'next',
  bed: 1.2,
  ray: (c) => ({
    keys: [{ f: 0, ...SPOT.challenge }, swim(24, 'end'), swim(c.span.duration, 'end')],
    moods: [{ f: 0, mood: 'happy' }],
    waves: [c.w('See') - 4],
    hops: [c.w('water')],
    gaze: [
      [0, -0.8, 0.3],
      [c.w('See'), 0, 0.1],
    ],
  }),
  sfx: (c) => [
    { f: 2, id: 'swim-whoosh', volume: 0.35 },
    { f: 8, id: 'shimmer', volume: 0.35 },
    { f: c.w('See'), id: 'bubbles', volume: 0.35 },
  ],
  View: ({ ctx }) => <TheEnd from={2} to={ctx.span.duration + 400} />,
};

const stinger: LessonScene = {
  id: 'stinger',
  bed: 1.2,
  ray: (c) => {
    const back = c.wEnd('Bendy') + 8;
    return {
      keys: [{ f: 0, ...SPOT.end }, swim(20, 'fact', ease.out), swim(back, 'fact'), swim(back + 22, 'end'), swim(c.span.duration, 'end')],
      moods: [
        { f: 0, mood: 'idle' },
        { f: c.w('cousins'), mood: 'happy' },
        { f: c.w('Our'), mood: 'idle' },
        { f: c.w('Bendy') - 2, mood: 'happy' },
      ],
      squishes: [c.w('Bendy') - 2, c.w('Bendy') + 10],
      waves: [back + 24],
      gaze: [
        [0, 0, 0.1],
        [c.w('cousins'), -0.4, 0],
        [c.w('Our'), 0, 0.1],
      ],
    };
  },
  sfx: (c) => [
    { f: 2, id: 'swim-whoosh', volume: 0.3 },
    { f: c.w('Bendy'), id: 'boing', volume: 0.35 },
    { f: c.wEnd('Bendy') + 8, id: 'swim-whoosh', volume: 0.3 },
  ],
  View: ({ ctx }) => (
    <AbsoluteFill>
      <TheEnd from={-400} to={ctx.span.duration + 400} />
      <Chip x={SPOT.fact.x} y={430} from={10} to={ctx.wEnd('Bendy') + 6} accent="#ffb547" size={26}>
        RAY FACT
      </Chip>
      <Burst kind="bubbles" at={ctx.w('Bendy')} x={SPOT.fact.x} y={SPOT.fact.y} count={10} seed={91} />
    </AbsoluteFill>
  ),
};

/** Lesson 1's scenes, in the script's order. */
export const SCENES: readonly LessonScene[] = [coldOpen, bumper, welcome, problem, entity, deepDive, ship, fabricator, quiz, recap, challenge, next, stinger];
