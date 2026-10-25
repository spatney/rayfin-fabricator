import type { ReactNode } from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { ease, fadeOut, pop, ramp, track } from '../../src/anim';
import { Burst } from '../../src/fx/Burst';
import { Challenge, ChapterTag, CommandCard, DeepDiveTitle, DepthGauge, EndScreen, Icon, Objectives, Quiz, Recap, SeriesBumper, Sonar, at, type IconName } from '../../src/lesson-kit';
import type { RayKey } from '../../src/ray/RayActor';
import type { LessonCtx, LessonScene } from '../../src/show/types';
import type { Shot } from '../../src/shots';
import { FONT, MONO, alpha, useTheme } from '../../src/theme';
import { AppWindow, SHOTS, Spotlight } from '../../src/ui/AppWindow';
import { Chip } from '../../src/ui/Kit';
import { SERIES } from '../series';
import { SCRIPT } from './script';
import { TERMINALS } from './snippets';
import { YOUTUBE } from './youtube';

/** Where Ray is when one scene hands him to the next. */
const SPOT = {
  hook: { x: 960, y: 955, s: 0.56 },
  welcome: { x: 960, y: 560, s: 1 },
  today: { x: 330, y: 600, s: 0.85 },
  gear: { x: 330, y: 620, s: 0.8 },
  perchBL: { x: 165, y: 930, s: 0.44 },
  deep: { x: 1765, y: 930, s: 0.44 },
  ship: { x: 1765, y: 930, s: 0.44 },
  fabricator: { x: 1790, y: 170, s: 0.4 },
  quiz: { x: 1700, y: 260, s: 0.5 },
  recap: { x: 1785, y: 945, s: 0.42 },
  challenge: { x: 1620, y: 560, s: 0.8 },
  end: { x: 1500, y: 250, s: 0.5 },
  fact: { x: 1155, y: 600, s: 0.6 },
} as const;

const swim = (f: number, spot: keyof typeof SPOT, e = ease.inOut): RayKey => at(f, SPOT[spot], e);

/** The Fabricator screenshots this lesson shows that src/shots.ts doesn't list. */
const FIRST_DEPLOY: Shot = { id: 'first-deploy', w: 1600, h: 822 };
const PREVIEW_BAR: Shot = { id: 'preview-toolbar', w: 1080, h: 450 };

/** Pixels in the screenshots that scenes point at. */
const PX = {
  previewLive: { x: 166, y: 16, w: 580, h: 38 },
  projectTitle: { x: 403, y: 88, w: 145, h: 38 },
  projectName: { x: 409, y: 201, w: 782, h: 45 },
  createButton: { x: 1064, y: 363, w: 127, h: 41 },
  account: { x: 1553, y: 7, w: 36, h: 34 },
  workspaces: { x: 430, y: 345, w: 730, h: 250 },
  deployButton: { x: 1054, y: 670, w: 112, h: 40 },
  rayBubble: { x: 402, y: 187, w: 337, h: 64 },
  deploySteps: { x: 308, y: 632, w: 345, h: 296 },
  benchLive: { x: 921, y: 56, w: 432, h: 30 },
  composer: { x: 15, y: 852, w: 766, h: 90 },
} as const;

/* ------------------------------------------------------------------------------------------ */
/*                                          Pieces                                            */
/* ------------------------------------------------------------------------------------------ */

/** A window's fade and scale as it comes in at `from` and leaves at `to`; null while it's away. */
function windowLife(frame: number, fps: number, from: number, to: number): { opacity: number; scale: number } | null {
  if (frame < from || frame > to + 10) return null;
  const p = pop(frame, fps, from, 14, 0.8);
  const out = 1 - ramp(frame, to, 10, ease.in);
  return { opacity: Math.min(1, p * 1.6) * out, scale: (0.92 + 0.08 * p) * (0.96 + 0.04 * out) };
}

/** 0→1 as something pops in at `from`, times 1→0 as it leaves at `until`. */
function useShow(from: number, until?: number): { p: number; out: number; frame: number } | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < from || (until !== undefined && frame > until + 12)) return null;
  return { p: pop(frame, fps, from, 11, 0.6), out: until === undefined ? 1 : 1 - ramp(frame, until, 12, ease.in), frame };
}

/**
 * A tile: an icon over a name and a line under it. `off` greys it out behind a dashed border,
 * `glow` lights it up, and a `badge` sits on its corner.
 */
function Tile({ x, y, w = 300, h = 210, icon, label, sub, at: from, until, off = 0, glow = 0, badge, color, horizontal = false }: { x: number; y: number; w?: number; h?: number; icon: IconName; label: ReactNode; sub?: ReactNode; at: number; until?: number; off?: number; glow?: number; badge?: string; color?: string; horizontal?: boolean }): JSX.Element | null {
  const C = useTheme();
  const show = useShow(from, until);
  if (!show) return null;
  const { p, out } = show;
  const ring = color ?? C.accent;
  const lit = Math.min(1, p) * (1 - off);
  return (
    <div style={{ position: 'absolute', left: x - w / 2, top: y - h / 2, width: w, height: h, borderRadius: 24, background: off > 0.5 ? alpha(C.name === 'dark' ? '#0c1320' : '#ffffff', 0.55) : C.panel.tile, border: `2px ${off > 0.5 ? 'dashed' : 'solid'} ${alpha(ring, 0.3 + 0.55 * lit)}`, boxShadow: `${C.shadow.tile}, ${C.glow(alpha(ring, 0.25 * lit + 0.5 * glow), 30 + 30 * glow, 4 * glow)}`, display: 'flex', flexDirection: horizontal ? 'row' : 'column', alignItems: 'center', justifyContent: 'center', gap: horizontal ? 22 : 12, padding: '0 22px', opacity: Math.min(1, p * 1.5) * out * (1 - 0.35 * off), transform: `translateY(${(1 - p) * 40}px) scale(${(0.8 + 0.2 * p) * (1 + 0.04 * glow)})` }}>
      <Icon name={icon} color={off > 0.5 ? C.inkDim : ring} size={horizontal ? 60 : 64} />
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: horizontal ? 'flex-start' : 'center', gap: 6 }}>
        <div style={{ fontFamily: FONT, fontWeight: 750, fontSize: 36, color: C.ink, whiteSpace: 'nowrap' }}>{label}</div>
        {sub ? <div style={{ fontFamily: FONT, fontSize: 26, color: C.inkDim, textAlign: horizontal ? 'left' : 'center', lineHeight: 1.25 }}>{sub}</div> : null}
      </div>
      {badge ? (
        <div style={{ position: 'absolute', right: -14, top: -18, padding: '6px 16px', borderRadius: 999, background: C.chip.bg, border: `2px solid ${C.star}`, fontFamily: FONT, fontWeight: 700, fontSize: 22, color: C.star, whiteSpace: 'nowrap' }}>{badge}</div>
      ) : null}
    </div>
  );
}

/** A line from one point to another that draws itself on: dashed for a connection, solid otherwise. */
function Beam({ from, to, at: start, color, width = 4, dashed = false, until, bend = 0 }: { from: readonly [number, number]; to: readonly [number, number]; at: number; color: string; width?: number; dashed?: boolean; until?: number; bend?: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const p = ramp(frame, start, 16, ease.out);
  if (p <= 0 || (until !== undefined && frame > until + 12)) return null;
  const out = until === undefined ? 1 : 1 - ramp(frame, until, 12, ease.in);
  const [x1, y1] = from;
  const [x2, y2] = to;
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2 - bend;
  const d = `M ${x1} ${y1} Q ${mx} ${my} ${x2} ${y2}`;
  return (
    <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0, overflow: 'visible', opacity: out }}>
      <defs>
        <mask id={`m${start}${x1}${y1}`} maskUnits="userSpaceOnUse" x={0} y={0} width={1920} height={1080}>
          <path d={d} fill="none" stroke="#fff" strokeWidth={width + 4} strokeLinecap="round" pathLength={1} strokeDasharray={`${p} 1`} />
        </mask>
      </defs>
      <path d={d} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeDasharray={dashed ? '14 14' : undefined} mask={`url(#m${start}${x1}${y1})`} />
    </svg>
  );
}

/** A dot that travels along a straight line, over and over, to show something flowing. */
function Flow({ from, to, at: start, until, color, every = 36 }: { from: readonly [number, number]; to: readonly [number, number]; at: number; until?: number; color: string; every?: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  if (frame < start || (until !== undefined && frame > until)) return null;
  const dots = [0, 0.5].map((phase) => ((frame - start) / every + phase) % 1);
  return (
    <>
      {dots.map((t, i) => (
        <div key={i} style={{ position: 'absolute', left: from[0] + (to[0] - from[0]) * t - 9, top: from[1] + (to[1] - from[1]) * t - 9, width: 18, height: 18, borderRadius: '50%', background: color, boxShadow: `0 0 16px ${color}`, opacity: Math.sin(Math.PI * t) }} />
      ))}
    </>
  );
}

/** A small chip that flies from one point to another, then stays (or fades) where it lands. */
function Flyer({ from, to, at: start, frames = 22, stay = true, until, children, accent }: { from: readonly [number, number]; to: readonly [number, number]; at: number; frames?: number; stay?: boolean; until?: number; children: ReactNode; accent?: string }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  if (frame < start || (until !== undefined && frame > until + 10)) return null;
  const t = ramp(frame, start + 4, frames, ease.inOut);
  const p = pop(frame, fps, start, 12, 0.6);
  const land = stay ? 1 : 1 - ramp(frame, start + 4 + frames, 10, ease.in);
  const out = until === undefined ? 1 : 1 - ramp(frame, until, 10, ease.in);
  const x = from[0] + (to[0] - from[0]) * t;
  const y = from[1] + (to[1] - from[1]) * t - Math.sin(Math.PI * t) * 40;
  const ring = accent ?? C.accent2;
  return (
    <div style={{ position: 'absolute', left: x, top: y, transform: `translate(-50%, -50%) scale(${p * (0.85 + 0.15 * land)})`, opacity: Math.min(1, p * 1.5) * land * out, display: 'flex', alignItems: 'center', gap: 10, padding: '10px 20px', borderRadius: 999, background: C.chip.bg, border: `2px solid ${ring}`, boxShadow: `${C.shadow.chip}, ${C.glow(alpha(ring, 0.4), 22)}`, fontFamily: FONT, fontWeight: 650, fontSize: 28, color: C.chip.text, whiteSpace: 'nowrap' }}>
      {children}
    </div>
  );
}

/** An arrow between steps that grows on, and leaves at `until`. */
function Arrow({ x, y, from, until }: { x: number; y: number; from: number; until?: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const C = useTheme();
  const p = ramp(frame, from, 10, ease.out);
  if (p <= 0 || (until !== undefined && frame > until + 10)) return null;
  const out = until === undefined ? 1 : 1 - ramp(frame, until, 10, ease.in);
  return (
    <svg width={90} height={40} style={{ position: 'absolute', left: x - 45, top: y - 20, overflow: 'visible', opacity: out }}>
      <path d={`M 4 20 L ${4 + 70 * p} 20`} stroke={C.accent2} strokeWidth={6} strokeLinecap="round" />
      {p > 0.8 ? <path d="M 62 8 L 78 20 L 62 32" fill="none" stroke={C.accent2} strokeWidth={6} strokeLinecap="round" strokeLinejoin="round" /> : null}
    </svg>
  );
}

/** Code in a chip, for commands and file names in running text. */
const Mono = ({ children }: { children: ReactNode }) => <span style={{ fontFamily: MONO, fontWeight: 500 }}>{children}</span>;

/* ------------------------------------------------------------------------------------------ */
/*                                     1. The cold open                                       */
/* ------------------------------------------------------------------------------------------ */

/** An empty project folder: where every app starts. */
function EmptyFolder({ x, y, from, glow = 0 }: { x: number; y: number; from: number; glow?: number }): JSX.Element | null {
  const C = useTheme();
  const show = useShow(from);
  if (!show) return null;
  const { p } = show;
  return (
    <div style={{ position: 'absolute', left: x - 170, top: y - 150, width: 340, height: 300, borderRadius: 28, border: `3px dashed ${alpha(C.accent2, 0.7)}`, background: alpha(C.name === 'dark' ? '#0c1320' : '#ffffff', 0.6), boxShadow: C.glow(alpha(C.accent2, 0.2 + 0.5 * glow), 30 + 30 * glow), display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, opacity: Math.min(1, p * 1.5), transform: `scale(${0.7 + 0.3 * p})` }}>
      <Icon name="folder" color={C.accent2} size={120} stroke={1.6} />
      <div style={{ fontFamily: MONO, fontSize: 40, color: C.ink }}>my-app/</div>
      <div style={{ fontFamily: FONT, fontSize: 28, color: C.inkDim, fontStyle: 'italic' }}>empty</div>
    </div>
  );
}

/** A command on its own, as a pill: what one step of the journey runs. */
function CommandPill({ cmd, label, x, y, from }: { cmd: string; label: string; x: number; y: number; from: number }): JSX.Element | null {
  const C = useTheme();
  const show = useShow(from);
  if (!show) return null;
  const { p } = show;
  return (
    <div style={{ position: 'absolute', left: x, top: y, transform: `translate(-50%, -50%) scale(${0.6 + 0.4 * p})`, opacity: Math.min(1, p * 1.5), display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
      <div style={{ fontFamily: FONT, fontWeight: 700, fontSize: 30, letterSpacing: '0.06em', textTransform: 'uppercase', color: C.accent2 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 28px', borderRadius: 18, background: '#0c0c0c', boxShadow: `${C.shadow.terminal}, ${C.glow(alpha(C.accent, 0.4), 26)}`, fontFamily: MONO, fontSize: 38, color: '#f9f1a5', whiteSpace: 'nowrap' }}>
        <span style={{ color: '#7d7d7d' }}>&gt;</span>
        {cmd}
      </div>
    </div>
  );
}

const FOLDER = { x: 400, y: 380 } as const;
const LIVE = { x: 1395, y: 380, width: 860 } as const;
const JOURNEY = [
  { word: 'creates', cmd: 'npm create', label: 'Create it', x: 520 },
  { word: 'runs', cmd: 'npm run dev', label: 'Run it', x: 960 },
  { word: 'ships', cmd: 'rayfin up', label: 'Ship it', x: 1400 },
] as const;

const coldOpen: LessonScene = {
  id: 'cold-open',
  ray: (c) => ({
    keys: [
      { f: 0, x: 960, y: 1250, s: 0.6 },
      swim(c.lead + 4, 'hook', ease.out),
      swim(c.w('Watch') - 2, 'hook'),
      { f: c.w('Watch') + 12, x: 960, y: 940, s: 0.6, e: ease.out },
      { f: c.span.duration, x: 960, y: 930, s: 0.6 },
    ],
    moods: [
      { f: 0, mood: 'idle' },
      { f: c.w('live') - 2, mood: 'surprised' },
      { f: c.w('One'), mood: 'happy' },
    ],
    rolls: [6],
    hops: [c.w('Watch')],
    gaze: [
      [0, 0, -0.6],
      [c.w('empty'), -0.8, -0.7],
      [c.w('live'), 0.8, -0.7],
      ...JOURNEY.map((j) => [c.w(j.word), (j.x - 960) / 500, -0.5] as const),
      [c.w('Watch'), 0.7, -0.8],
    ],
  }),
  sfx: (c) => [
    { f: 4, id: 'swim-whoosh', volume: 0.4 },
    { f: c.w('empty'), id: 'pop', volume: 0.5 },
    { f: c.w('live'), id: 'shimmer', volume: 0.4 },
    ...JOURNEY.map((j) => ({ f: c.w(j.word), id: 'pop' as const, volume: 0.55 })),
    { f: c.w('Watch'), id: 'chime', volume: 0.4 },
    { f: c.span.duration - 16, id: 'sweep', volume: 0.45 },
  ],
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const C = useTheme();
    const live = windowLife(frame, fps, ctx.w('live'), ctx.span.duration + 20);
    const watch = ctx.w('Watch');
    const glow = ramp(frame, watch, 8) * (0.6 + 0.4 * Math.sin((frame - watch) / 4));
    const exit = ramp(frame, ctx.span.duration - 18, 16, ease.in);
    return (
      <AbsoluteFill>
        <AbsoluteFill style={{ transform: `scale(${1 - 0.9 * exit})`, opacity: 1 - exit }}>
          <EmptyFolder x={FOLDER.x} y={FOLDER.y} from={ctx.w('empty') - 6} />
          <Beam from={[FOLDER.x + 185, FOLDER.y]} to={[LIVE.x - LIVE.width / 2 - 20, LIVE.y]} at={ctx.w('into') - 2} color={alpha(C.accent2, 0.8)} dashed />
          {live ? (
            <AppWindow shot={PREVIEW_BAR} x={LIVE.x} y={LIVE.y} width={LIVE.width} opacity={live.opacity} scale={live.scale * (1 + 0.03 * glow)} style={{ boxShadow: `${C.shadow.window}, ${C.glow(alpha(C.ok, 0.5 * glow), 60, 6)}` }}>
              <Spotlight {...PX.previewLive} radius={10} dim={0.3} opacity={ramp(frame, ctx.w('Fabric') - 2, 6) * (1 - ramp(frame, ctx.w('One'), 8))} />
            </AppWindow>
          ) : null}
          {JOURNEY.map((j) => (
            <CommandPill key={j.word} cmd={j.cmd} label={j.label} x={j.x} y={690} from={ctx.w(j.word) - 2} />
          ))}
          <Arrow x={735} y={715} from={ctx.w('runs') - 6} />
          <Arrow x={1185} y={715} from={ctx.w('ships') - 6} />
          <Burst kind="sparkles" at={watch} x={LIVE.x} y={LIVE.y} count={16} seed={21} spread={2.2} />
        </AbsoluteFill>
        <AbsoluteFill style={{ background: C.fadeIn, opacity: 1 - ramp(frame, 0, 14) }} />
      </AbsoluteFill>
    );
  },
};

/* ------------------------------------------------------------------------------------------ */
/*                                  2. The bumper, 3. Welcome                                 */
/* ------------------------------------------------------------------------------------------ */

const bumper: LessonScene = {
  id: 'bumper',
  bed: 0,
  ray: (c) => ({
    keys: [
      { f: 0, x: 960, y: 930, s: 0.6 },
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
      { f: c.span.duration, ...SPOT.gear },
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
    { f: c.w('create'), id: 'pop', volume: 0.5 },
    { f: c.w('run'), id: 'pop', volume: 0.5 },
    { f: c.w('ship'), id: 'pop', volume: 0.5 },
    { f: c.w('dive'), id: 'swim-whoosh', volume: 0.4 },
  ],
  View: ({ ctx }) => (
    <AbsoluteFill>
      <Burst kind="bubbles" at={ctx.w('Hi')} x={1000} y={470} count={10} seed={22} />
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
          { text: 'Create a Rayfin app', at: ctx.w('create') },
          { text: 'Run it while you build', at: ctx.w('run') },
          { text: 'Ship it to Microsoft Fabric', at: ctx.w('ship') },
        ]}
      />
    </AbsoluteFill>
  ),
};

/* ------------------------------------------------------------------------------------------ */
/*                                     4. Before you start                                    */
/* ------------------------------------------------------------------------------------------ */

/** A card of things to have, each ticked off on its cue. */
function NeedList({ x, y, width, items, from, to }: { x: number; y: number; width: number; items: ReadonlyArray<{ icon: IconName; text: ReactNode; at: number }>; from: number; to: number }): JSX.Element | null {
  const { fps } = useVideoConfig();
  const C = useTheme();
  const show = useShow(from, to);
  if (!show) return null;
  const { frame, p, out } = show;
  return (
    <div style={{ position: 'absolute', left: x - width / 2, top: y, width, padding: '30px 40px 34px', borderRadius: 28, background: C.panel.bg, border: `2px solid ${C.panel.border}`, boxShadow: C.shadow.panel, opacity: Math.min(1, p * 1.5) * out, transform: `translateY(${(1 - p) * 40}px)` }}>
      <div style={{ fontFamily: FONT, fontWeight: 750, fontSize: 30, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.accent2 }}>What you need</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18, marginTop: 22 }}>
        {items.map((item, i) => {
          const q = frame < item.at ? 0 : pop(frame, fps, item.at, 12, 0.6);
          const tick = frame < item.at + 8 ? 0 : pop(frame, fps, item.at + 8, 10, 0.5);
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 26, opacity: 0.35 + 0.65 * Math.min(1, q), transform: `translateX(${(1 - Math.min(1, q)) * 16}px)` }}>
              <div style={{ width: 72, height: 72, flex: 'none', borderRadius: 18, display: 'grid', placeItems: 'center', background: alpha(C.accent, 0.14) }}>
                <Icon name={item.icon} color={C.accent} size={44} />
              </div>
              <div style={{ flex: 1, fontFamily: FONT, fontWeight: 650, fontSize: 46, color: C.ink }}>{item.text}</div>
              <div style={{ width: 56, height: 56, borderRadius: '50%', display: 'grid', placeItems: 'center', background: alpha(C.ok, 0.18), transform: `scale(${tick})` }}>
                <Icon name="check" color={C.ok} size={36} stroke={2.8} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The tenant setting a Fabric admin turns on, drawn after the admin portal's own words. */
function TenantSwitch({ x, y, width, from, flip, to }: { x: number; y: number; width: number; from: number; flip: number; to: number }): JSX.Element | null {
  const C = useTheme();
  const show = useShow(from, to);
  if (!show) return null;
  const { frame, p, out } = show;
  const on = ramp(frame, flip, 10, ease.inOut);
  const rail = on > 0.5 ? C.ok : C.inkFaint;
  return (
    <div style={{ position: 'absolute', left: x - width / 2, top: y, width, padding: '26px 40px', borderRadius: 28, background: C.panel.bg, border: `2px solid ${alpha(C.ok, 0.2 + 0.6 * on)}`, boxShadow: `${C.shadow.panel}, ${C.glow(alpha(C.ok, 0.35 * on), 30)}`, opacity: Math.min(1, p * 1.5) * out, transform: `translateY(${(1 - p) * 40}px)` }}>
      <div style={{ fontFamily: FONT, fontWeight: 700, fontSize: 24, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.inkDim }}>Fabric admin portal · Tenant settings</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 28, marginTop: 18 }}>
        <div style={{ flex: 1, fontFamily: FONT, fontWeight: 700, fontSize: 44, color: C.ink }}>Fabric Apps (preview)</div>
        <div style={{ position: 'relative', width: 104, height: 56, borderRadius: 28, background: alpha(rail, 0.35 + 0.4 * on), border: `2px solid ${rail}` }}>
          <div style={{ position: 'absolute', top: 6, left: 6 + 48 * on, width: 40, height: 40, borderRadius: '50%', background: on > 0.5 ? C.ok : C.inkDim, boxShadow: C.shadow.chip }} />
        </div>
        <div style={{ width: 170, fontFamily: FONT, fontWeight: 700, fontSize: 36, color: on > 0.5 ? C.ok : C.inkDim }}>{on > 0.5 ? 'Enabled' : 'Disabled'}</div>
      </div>
    </div>
  );
}

const prereqs: LessonScene = {
  id: 'prereqs',
  ray: (c) => ({
    keys: [{ f: 0, ...SPOT.gear }, swim(c.span.duration - 24, 'gear'), swim(c.span.duration, 'perchBL')],
    moods: [
      { f: 0, mood: 'happy' },
      { f: c.w('Node.js'), mood: 'idle' },
      { f: c.at('tenant', 'admin'), mood: 'idle' },
      { f: c.at('tenant', 'flips'), mood: 'happy' },
    ],
    hops: [c.at('tenant', 'flips') + 6],
    gaze: [
      [0, 0.8, -0.5],
      [c.w('Node.js'), 0.9, -0.6],
      [c.w('Microsoft'), 0.9, -0.4],
      [c.at('tenant', 'Fabric'), 0.9, 0.3],
      [c.at('tenant', 'ask'), 0, 0.1],
    ],
  }),
  sfx: (c) => [
    { f: c.w('Node.js') + 8, id: 'pop', volume: 0.45 },
    { f: c.w('Microsoft') + 8, id: 'pop', volume: 0.45 },
    { f: c.at('tenant', 'Fabric'), id: 'swim-whoosh', volume: 0.3 },
    { f: c.at('tenant', 'flips'), id: 'click', volume: 0.6 },
    { f: c.at('tenant', 'flips') + 6, id: 'chime', volume: 0.35 },
    { f: c.at('tenant', 'ask'), id: 'pop', volume: 0.45 },
  ],
  View: ({ ctx }) => {
    const end = ctx.span.duration - 14;
    return (
      <AbsoluteFill>
        <ChapterTag text="Before you start" from={ctx.lead} to={end} />
        <NeedList
          x={1130}
          y={190}
          width={960}
          from={ctx.lead + 4}
          to={end}
          items={[
            { icon: 'hexagon', text: 'Node.js 20 or later', at: ctx.w('Node.js') },
            { icon: 'user', text: 'A Microsoft Fabric account', at: ctx.w('Microsoft') },
          ]}
        />
        <TenantSwitch x={1130} y={560} width={960} from={ctx.at('tenant', 'Fabric') - 2} flip={ctx.at('tenant', 'flips')} to={end} />
        <Chip x={1130} y={840} from={ctx.at('tenant', 'ask')} to={end} accent="#ffb547" size={32}>
          Not an admin? Ask your Fabric admin to turn it on
        </Chip>
      </AbsoluteFill>
    );
  },
};

/* ------------------------------------------------------------------------------------------ */
/*                                     5. Create your app                                     */
/* ------------------------------------------------------------------------------------------ */

/** Where the create command's parts sit on its card (Cascadia Code is about 0.586 em wide). */
const CREATE_CARD = { x: 960, y: 380, width: 1400, font: 34 } as const;
function commandSpan(command: string, part: string): { x: number } {
  const ch = CREATE_CARD.font * 0.586;
  const start = CREATE_CARD.x - CREATE_CARD.width / 2 + 28 + 4 * ch + command.indexOf(part) * ch;
  return { x: start + (part.length * ch) / 2 };
}

/** The app's pieces, inside a dashed boundary with its name on it. */
function AppBox({ x, y, w, h, from, to, label }: { x: number; y: number; w: number; h: number; from: number; to: number; label: ReactNode }): JSX.Element | null {
  const { fps } = useVideoConfig();
  const C = useTheme();
  const show = useShow(from, to);
  if (!show) return null;
  const { frame, out } = show;
  const draw = ramp(frame, from, 22, ease.inOut);
  const tag = pop(frame, fps, from + 6, 12, 0.6);
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: out }}>
      <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0 }}>
        <rect x={x - w / 2} y={y - h / 2} width={w} height={h} rx={36} fill={alpha(C.accent2, 0.05 * draw)} stroke={C.accent2} strokeWidth={4} strokeDasharray="18 12" opacity={draw} />
      </svg>
      <div style={{ position: 'absolute', left: x - w / 2 + 40, top: y - h / 2 - 26, padding: '8px 22px', borderRadius: 999, background: C.chip.bg, border: `2px solid ${C.accent2}`, fontFamily: FONT, fontWeight: 650, fontSize: 28, color: C.chip.text, whiteSpace: 'nowrap', transform: `scale(${tag})`, transformOrigin: '0% 50%' }}>{label}</div>
    </div>
  );
}

const STARTS = [
  { word: 'website', icon: 'hosting', label: 'Website', sub: 'Your frontend', x: 620 },
  { word: 'sign-in', icon: 'signin', label: 'Sign-in', sub: 'Microsoft Entra ID', x: 960 },
  { word: 'database', icon: 'database', label: 'Database', sub: 'Off for now', x: 1300 },
] as const;
const GROWS = [
  { word: 'data', icon: 'database', label: 'Your data', sub: 'Entities you own', x: 495 },
  { word: 'connectors', icon: 'plug', label: 'Connectors', sub: 'Data already in Fabric', x: 830 },
  { word: 'functions', icon: 'functions', label: 'Functions', sub: 'Code on the server', x: 1165 },
  { word: 'storage', icon: 'storage', label: 'File storage', sub: 'Files and uploads', x: 1500 },
] as const;

const create: LessonScene = {
  id: 'create',
  ray: (c) => ({
    keys: [{ f: 0, ...SPOT.perchBL }, swim(c.span.duration, 'perchBL')],
    moods: [
      { f: 0, mood: 'idle' },
      { f: c.at('create-2', 'too'), mood: 'happy' },
      { f: c.at('create-3', 'small'), mood: 'idle' },
      { f: c.at('create-4', 'grows'), mood: 'happy' },
    ],
    hops: [c.at('create-2', 'too') + 4, c.at('create-4', 'storage') + 6],
    gaze: [
      [0, 0.8, -0.8],
      [c.at('create-3', 'small'), 0.8, -0.8],
      [c.at('create-4', 'grows'), 0.8, -0.3],
    ],
  }),
  sfx: (c) => {
    const typeFrom = c.at('create-1', 'npm');
    return [
      { f: typeFrom, id: 'typing', volume: 0.3, duration: c.atEnd('create-1', 'name') - typeFrom },
      { f: c.at('create-1', 'package'), id: 'pop', volume: 0.4 },
      { f: c.at('create-1', 'name'), id: 'pop', volume: 0.4 },
      { f: c.at('create-2', 'default'), id: 'click', volume: 0.5 },
      { f: c.at('create-2', 'too'), id: 'chime', volume: 0.35 },
      { f: c.beat('create-3').from - 6, id: 'swim-whoosh', volume: 0.3 },
      ...STARTS.map((s) => ({ f: c.at('create-3', s.word), id: 'pop' as const, volume: 0.45 })),
      ...GROWS.map((g) => ({ f: c.at('create-4', g.word), id: 'pop' as const, volume: 0.5 })),
      { f: c.at('create-4', 'storage') + 4, id: 'shimmer', volume: 0.3 },
    ];
  },
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const C = useTheme();
    const end = ctx.span.duration - 14;
    const three = ctx.beat('create-3').from;
    const t = TERMINALS.create;
    const pkg = commandSpan(t.command, '@microsoft/rayfin@latest');
    const name = commandSpan(t.command, 'my-app');
    const labelsTo = ctx.beat('create-2').from + 4;
    const dataOn = ramp(frame, ctx.at('create-4', 'data'), 10);
    return (
      <AbsoluteFill>
        <ChapterTag text="Create your app" from={ctx.lead} to={end} />
        <CommandCard
          command={t.command}
          output={[
            { text: t.output[0], at: ctx.at('create-2', 'default'), color: '#9cdcfe' },
            { text: t.output[1], at: ctx.at('create-2', 'installs'), color: '#7d7d7d' },
            { text: t.output[2], at: ctx.at('create-2', 'too'), color: C.ok },
          ]}
          from={ctx.lead + 2}
          to={three - 6}
          typeFrom={ctx.at('create-1', 'npm')}
          typeTo={ctx.atEnd('create-1', 'name') - 4}
          tagAt={ctx.atEnd('create-1', 'name') + 6}
          x={CREATE_CARD.x}
          y={CREATE_CARD.y}
          width={CREATE_CARD.width}
        />
        <Chip x={pkg.x} y={510} from={ctx.at('create-1', 'package')} to={labelsTo} size={30} accent={C.accent2}>
          Rayfin’s package
        </Chip>
        <Chip x={name.x} y={510} from={ctx.at('create-1', 'name')} to={labelsTo} size={30} accent={C.accent2}>
          Your app’s name
        </Chip>
        <Chip x={960} y={640} from={ctx.at('create-2', 'Universal')} to={three - 6} size={34}>
          The default template: the Universal App
        </Chip>
        <AppBox x={960} y={330} w={1100} h={300} from={three - 2} to={end} label={<span>my-app · starts small</span>} />
        {STARTS.map((s) => (
          <Tile key={s.word} x={s.x} y={340} w={300} h={210} icon={s.icon} label={s.label} sub={s.word === 'database' && dataOn > 0.5 ? 'Turned on' : s.sub} at={ctx.at('create-3', s.word)} until={end} off={s.word === 'database' ? 1 - dataOn : 0} glow={s.word === 'database' ? dataOn * (1 - ramp(frame, ctx.at('create-4', 'data') + 20, 20)) : 0} />
        ))}
        {frame >= ctx.at('create-4', 'grows') - 4 ? (
          <div style={{ position: 'absolute', left: 0, right: 0, top: 528, textAlign: 'center', fontFamily: FONT, fontWeight: 750, fontSize: 32, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.accent2, opacity: ramp(frame, ctx.at('create-4', 'grows') - 4, 10) * fadeOut(frame, end + 12, 12) }}>
            + Add what it needs
          </div>
        ) : null}
        {GROWS.map((g) => (
          <Beam key={`b${g.word}`} from={[g.x, 690]} to={[g.x < 960 ? 820 : 1100, 486]} at={ctx.at('create-4', g.word) - 2} color={alpha(C.accent2, 0.45)} width={3} dashed until={end} />
        ))}
        {GROWS.map((g) => (
          <Tile key={g.word} x={g.x} y={790} w={310} h={200} icon={g.icon} label={g.label} sub={g.sub} at={ctx.at('create-4', g.word)} until={end} color={C.accent2} />
        ))}
      </AbsoluteFill>
    );
  },
};

/* ------------------------------------------------------------------------------------------ */
/*                                    6. Sign in and run it                                   */
/* ------------------------------------------------------------------------------------------ */

/** The browser's part of rayfin login: sign in with Microsoft Entra ID, then a tick. */
function SignInCard({ x, y, from, done, to }: { x: number; y: number; from: number; done: number; to: number }): JSX.Element | null {
  const { fps } = useVideoConfig();
  const C = useTheme();
  const show = useShow(from, to);
  if (!show) return null;
  const { frame, p, out } = show;
  const b = C.browser;
  const tick = frame < done ? 0 : pop(frame, fps, done, 10, 0.5);
  return (
    <div style={{ position: 'absolute', left: x - 260, top: y - 190, width: 520, borderRadius: 16, overflow: 'hidden', background: b.page, boxShadow: C.shadow.browser, opacity: Math.min(1, p * 1.5) * out, transform: `scale(${0.85 + 0.15 * p})` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, height: 50, background: b.chrome, padding: '0 16px' }}>
        <span style={{ display: 'flex', gap: 8 }}>
          {[0, 1, 2].map((i) => (
            <span key={i} style={{ width: 12, height: 12, borderRadius: '50%', background: b.icons, opacity: 0.6 }} />
          ))}
        </span>
        <div style={{ flex: 1, height: 30, borderRadius: 15, background: b.field, display: 'flex', alignItems: 'center', padding: '0 14px', fontFamily: FONT, fontSize: 18, color: b.url }}>Sign in · your browser</div>
      </div>
      <div style={{ height: 330, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 20 }}>
        <div style={{ position: 'relative', width: 120, height: 120, borderRadius: '50%', display: 'grid', placeItems: 'center', background: alpha(C.accent, 0.14) }}>
          <Icon name="user" color={C.accent} size={70} />
          <div style={{ position: 'absolute', right: -6, bottom: -6, width: 52, height: 52, borderRadius: '50%', display: 'grid', placeItems: 'center', background: C.ok, transform: `scale(${tick})` }}>
            <Icon name="check" color="#fff" size={34} stroke={3} />
          </div>
        </div>
        <div style={{ fontFamily: FONT, fontWeight: 700, fontSize: 36, color: b.url }}>Microsoft Entra ID</div>
        <div style={{ fontFamily: FONT, fontSize: 28, color: tick > 0.5 ? C.ok : b.icons }}>{tick > 0.5 ? 'Signed in' : 'Signing in…'}</div>
      </div>
    </div>
  );
}

/** A browser on localhost, showing a stand-in page: the frontend running on your machine. */
function LocalApp({ x, y, width, from, to }: { x: number; y: number; width: number; from: number; to: number }): JSX.Element | null {
  const C = useTheme();
  const show = useShow(from, to);
  if (!show) return null;
  const { p, out } = show;
  const b = C.browser;
  const block = (w: number | string, h: number, o = 1) => <div style={{ width: w, height: h, borderRadius: 10, background: b.ring, opacity: o }} />;
  return (
    <div style={{ position: 'absolute', left: x - width / 2, top: y - 200, width, borderRadius: 16, overflow: 'hidden', background: b.page, boxShadow: `${C.shadow.browser}, ${C.glow(alpha(C.accent, 0.35), 40)}`, opacity: Math.min(1, p * 1.5) * out, transform: `translateY(${(1 - p) * 40}px) scale(${0.85 + 0.15 * p})` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, height: 50, background: b.chrome, padding: '0 16px' }}>
        <span style={{ color: b.icons, fontSize: 20 }}>←  →  ⟳</span>
        <div style={{ flex: 1, height: 30, borderRadius: 15, background: b.field, display: 'flex', alignItems: 'center', padding: '0 14px', fontFamily: MONO, fontSize: 20, color: b.url }}>localhost:5173</div>
      </div>
      <div style={{ padding: 28, display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ width: 56, height: 56, borderRadius: 14, background: C.brand }} />
          <div style={{ fontFamily: FONT, fontWeight: 750, fontSize: 36, color: b.url }}>Your app</div>
        </div>
        {block('85%', 22, 0.8)}
        {block('60%', 22, 0.6)}
        <div style={{ display: 'flex', gap: 16 }}>
          {block('48%', 110, 0.5)}
          {block('48%', 110, 0.5)}
        </div>
      </div>
    </div>
  );
}

const run: LessonScene = {
  id: 'run',
  ray: (c) => ({
    keys: [{ f: 0, ...SPOT.perchBL }, swim(c.span.duration, 'perchBL')],
    moods: [
      { f: 0, mood: 'idle' },
      { f: c.at('login', 'Entra') + 10, mood: 'happy' },
      { f: c.beat('dev-1').from, mood: 'idle' },
      { f: c.at('dev-2', "there's"), mood: 'happy' },
    ],
    hops: [c.at('dev-2', "there's")],
    gaze: [
      [0, 0.8, -0.8],
      [c.at('login', 'browser'), 1, -0.6],
      [c.beat('dev-1').from, 0.7, -0.8],
      [c.at('dev-2', 'Open'), 1, -0.4],
    ],
  }),
  sfx: (c) => [
    { f: c.at('login', 'rayfin'), id: 'typing', volume: 0.3, duration: 16 },
    { f: c.at('login', 'browser'), id: 'swim-whoosh', volume: 0.3 },
    { f: c.at('login', 'Entra') + 10, id: 'chime', volume: 0.35 },
    { f: c.at('dev-1', 'npm'), id: 'typing', volume: 0.3, duration: 14 },
    { f: c.at('dev-1', 'rayfin', 2), id: 'pop', volume: 0.45 },
    { f: c.at('dev-2', 'address'), id: 'pop', volume: 0.45 },
    { f: c.at('dev-2', 'Open'), id: 'click', volume: 0.5 },
    { f: c.at('dev-2', "there's"), id: 'shimmer', volume: 0.35 },
  ],
  View: ({ ctx }) => {
    const C = useTheme();
    const end = ctx.span.duration - 14;
    const dev = ctx.beat('dev-1').from;
    const d = TERMINALS.dev;
    return (
      <AbsoluteFill>
        <ChapterTag text="Sign in and run it" from={ctx.lead} to={end} />
        <CommandCard command={TERMINALS.login.command} from={ctx.lead + 2} to={dev - 6} typeFrom={ctx.at('login', 'rayfin')} typeTo={ctx.at('login', 'rayfin') + 16} tagAt={ctx.at('login', 'opens')} x={600} y={420} width={900} scale={1.2} />
        <SignInCard x={1450} y={430} from={ctx.at('login', 'browser') - 2} done={ctx.at('login', 'Entra') + 10} to={dev - 6} />
        <CommandCard
          command={d.command}
          output={[
            { text: d.output[0], at: ctx.at('dev-1', 'runs'), color: '#7d7d7d' },
            { text: d.output[1], at: ctx.at('dev-1', 'rayfin', 2), color: '#f9f1a5' },
            { text: d.output[2], at: ctx.at('dev-2', 'prints'), color: '#7d7d7d' },
            { text: d.output[3], at: ctx.at('dev-2', 'address'), color: '#9cdcfe' },
          ]}
          from={dev - 2}
          to={end}
          typeFrom={ctx.at('dev-1', 'npm')}
          typeTo={ctx.at('dev-1', 'npm') + 14}
          tag="Fabricator’s preview runs your frontend too"
          tagAt={ctx.at('dev-2', 'frontend')}
          x={680}
          y={460}
          width={960}
          scale={1.1}
        />
        <LocalApp x={1490} y={470} width={560} from={ctx.at('dev-2', 'Open')} to={end} />
        <Chip x={680} y={760} from={ctx.at('dev-1', 'rayfin', 2) + 4} to={end} size={30} accent={C.accent2}>
          <span>
            In a Rayfin app, <Mono>npm run dev</Mono> runs <Mono>rayfin dev</Mono>
          </span>
        </Chip>
      </AbsoluteFill>
    );
  },
};

/* ------------------------------------------------------------------------------------------ */
/*                                        7. Deep Dive                                        */
/* ------------------------------------------------------------------------------------------ */

/** A region of the diagram, such as "Your machine": a dashed outline with its name on a tab. */
function Zone({ x, y, w, h, icon, title, at: from, glow = 0, color }: { x: number; y: number; w: number; h: number; icon: IconName; title: string; at: number; glow?: number; color: string }): JSX.Element | null {
  const C = useTheme();
  const show = useShow(from);
  if (!show) return null;
  const { frame, p } = show;
  const draw = ramp(frame, from, 20, ease.inOut);
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <div style={{ position: 'absolute', left: x - w / 2, top: y - h / 2, width: w, height: h, borderRadius: 36, border: `3px dashed ${alpha(color, 0.45 + 0.5 * glow)}`, background: alpha(color, 0.04 + 0.08 * glow), boxShadow: C.glow(alpha(color, 0.45 * glow), 50, 4), opacity: draw }} />
      <div style={{ position: 'absolute', left: x - w / 2 + 34, top: y - h / 2 - 30, display: 'flex', alignItems: 'center', gap: 14, padding: '10px 26px 10px 18px', borderRadius: 999, background: C.chip.bg, border: `2px solid ${color}`, boxShadow: C.shadow.chip, fontFamily: FONT, fontWeight: 750, fontSize: 32, color: C.chip.text, whiteSpace: 'nowrap', transform: `scale(${Math.min(1, p)})`, transformOrigin: '0% 50%' }}>
        <Icon name={icon} color={color} size={38} />
        {title}
      </div>
    </div>
  );
}

/** A pill with a line struck through it on its cue. */
function Struck({ children, x, y, from, strike, to }: { children: ReactNode; x: number; y: number; from: number; strike: number; to: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  if (frame < from || frame > to + 12) return null;
  const p = pop(frame, fps, from, 12, 0.6);
  const s = ramp(frame, strike, 8, ease.out);
  const out = 1 - ramp(frame, to, 12, ease.in);
  const red = '#ff6b81';
  return (
    <div style={{ position: 'absolute', left: x, top: y, transform: `translate(-50%, -50%) scale(${(0.7 + 0.3 * p) * (1 - 0.06 * s)}) rotate(${-3 * s}deg)`, opacity: Math.min(1, p * 1.5) * out, display: 'flex', alignItems: 'center', gap: 12, padding: '14px 30px', borderRadius: 999, background: C.chip.bg, border: `3px solid ${s > 0 ? alpha(red, 0.4 + 0.6 * s) : C.panel.border}`, boxShadow: C.shadow.chip, fontFamily: FONT, fontWeight: 650, fontSize: 32, color: C.ink, whiteSpace: 'nowrap' }}>
      {children}
      <div style={{ position: 'absolute', left: 20, top: '50%', height: 6, width: `calc(${s} * (100% - 40px))`, borderRadius: 3, background: red, transform: 'rotate(-5deg)' }} />
    </div>
  );
}

/** The diagram's two sides: your machine on the left, Fabric on the right. Clear of the depth gauge. */
const MACHINE = { x: 590, y: 575, w: 580, h: 590 } as const;
const FABRIC = { x: 1330, y: 575, w: 580, h: 590 } as const;
const FRONTEND = { x: 590, y: 458 } as const;
const SLOT2 = { x: 590, y: 628 } as const;
const BACKEND = { x: 1330, y: 458 } as const;
const WEBSITE = { x: 1330, y: 740 } as const;

const deepDive: LessonScene = {
  id: 'deep-dive',
  depth: 1,
  ray: (c) => ({
    keys: [{ f: 0, ...SPOT.perchBL }, swim(36, 'deep'), swim(c.span.duration, 'deep')],
    moods: [
      { f: 0, mood: 'happy' },
      { f: c.at('dive', 'Your'), mood: 'idle' },
      { f: c.at('dive-1', 'finds'), mood: 'surprised' },
      { f: c.at('dive-1', 'creates'), mood: 'idle' },
      { f: c.at('dive-5', 'So'), mood: 'happy' },
      { f: c.at('dive-6', 'never'), mood: 'idle' },
      { f: c.at('dive-6', 'job'), mood: 'happy' },
    ],
    rolls: [8],
    hops: [c.at('dive-5', 'yourself'), c.at('dive-6', 'up')],
    gaze: [
      [0, -0.4, -0.4],
      [c.at('dive', 'Your'), -1, -0.6],
      [c.at('dive-1', 'Fabric'), -0.4, -0.8],
      [c.at('dive-2', 'settings'), -0.6, -0.7],
      [c.at('dive-3', 'address'), -0.9, -0.3],
      [c.at('dive-4', 'frontend'), -1, -0.6],
      [c.at('dive-5', 'So'), -0.4, -0.7],
      [c.at('dive-6', 'publish'), -0.5, -0.3],
    ],
  }),
  sfx: (c) => [
    { f: 0, id: 'dive', volume: 0.55 },
    { f: c.at('dive', "where's"), id: 'boing', volume: 0.35 },
    { f: c.at('dive-1', 'finds'), id: 'sonar', volume: 0.35 },
    { f: c.at('dive-1', 'creates'), id: 'pop', volume: 0.4 },
    { f: c.at('dive-2', 'settings'), id: 'swim-whoosh', volume: 0.3 },
    { f: c.at('dive-2', 'schema'), id: 'swim-whoosh', volume: 0.3 },
    { f: c.at('dive-2', 'matches'), id: 'chime', volume: 0.35 },
    { f: c.at('dive-3', 'address'), id: 'swim-whoosh', volume: 0.3 },
    { f: c.at('dive-3', 'environment'), id: 'pop', volume: 0.45 },
    { f: c.at('dive-3', 'call'), id: 'sonar', volume: 0.3 },
    { f: c.at('dive-4', 'frontend'), id: 'pop', volume: 0.45 },
    { f: c.at('dive-4', 'functions'), id: 'pop', volume: 0.45 },
    { f: c.at('dive-5', 'no'), id: 'stamp', volume: 0.45 },
    { f: c.at('dive-6', 'publish') + 4, id: 'stamp', volume: 0.45 },
    { f: c.at('dive-6', 'up'), id: 'chime', volume: 0.4 },
  ],
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const C = useTheme();
    const end = ctx.span.duration - 14;
    const finds = ctx.at('dive-1', 'finds');
    const call = ctx.at('dive-3', 'call');
    const machineGlow = ramp(frame, ctx.at('dive-4', 'machine'), 10) * (1 - ramp(frame, ctx.at('dive-5', 'So'), 14));
    const fabricGlow = ramp(frame, ctx.at('dive-5', 'Fabric'), 10) * (1 - ramp(frame, ctx.beat('dive-6').from, 14));
    const started = ramp(frame, ctx.at('dive-4', 'frontend'), 10);
    const matches = ramp(frame, ctx.at('dive-2', 'matches'), 8);
    return (
      <AbsoluteFill style={{ opacity: fadeOut(frame, ctx.span.duration, 12) }}>
        <DeepDiveTitle from={ctx.lead} to={end} subtitle="Where is the backend?" tuckAt={ctx.at('dive', 'Your')} />
        <DepthGauge from={0} to={ctx.span.duration - 20} />
        <Zone {...MACHINE} icon="laptop" title="Your machine" at={ctx.at('dive', 'Your') + 6} glow={machineGlow} color={C.accent} />
        <Zone {...FABRIC} icon="cloud" title="Microsoft Fabric" at={finds - 4} glow={fabricGlow} color={C.accent2} />
        <Chip x={MACHINE.x} y={MACHINE.y - MACHINE.h / 2 + 66} from={ctx.at('dive-1', 'rayfin')} to={end} size={28} accent={C.accent}>
          <Mono>rayfin dev</Mono>
        </Chip>
        <Tile x={FRONTEND.x} y={FRONTEND.y} w={480} h={140} horizontal icon="hosting" label="Your frontend" sub={<Mono>localhost:5173</Mono>} at={ctx.at('dive', 'running') - 4} glow={started * (1 - ramp(frame, ctx.at('dive-4', 'functions'), 14))} />
        <Tile x={SLOT2.x} y={SLOT2.y} w={480} h={140} horizontal icon="question" label="Your backend?" sub="Not on your machine" at={ctx.at('dive', "where's")} until={finds - 4} off={1} color={C.inkDim} />
        <Tile x={SLOT2.x} y={SLOT2.y} w={480} h={140} horizontal icon="functions" label="Any functions" sub="Only if your app has them" at={ctx.at('dive-4', 'functions') - 2} off={0.6} color={C.accent} />
        <Tile x={BACKEND.x} y={BACKEND.y} w={500} h={160} horizontal icon="database" label="Your app’s backend" sub="The AppBackend" at={ctx.at('dive-1', 'Fabric') - 2} glow={matches * (1 - ramp(frame, ctx.at('dive-2', 'matches') + 24, 20))} color={C.accent2} />
        <Sonar x={BACKEND.x} y={BACKEND.y} at={finds} size={520} rings={2} color={alpha(C.accent2, 0.7)} />
        <Chip x={BACKEND.x} y={BACKEND.y + 120} from={ctx.at('dive-1', 'creates')} to={ctx.beat('dive-2').from + 8} size={26} accent={C.accent2}>
          Created on the first run
        </Chip>
        <Flyer from={[FRONTEND.x + 120, FRONTEND.y + 170]} to={[BACKEND.x - 60, BACKEND.y + 120]} at={ctx.at('dive-2', 'settings') - 2} stay={false} accent={C.accent}>
          <Icon name="cog" color={C.accent} size={30} /> Settings
        </Flyer>
        <Flyer from={[FRONTEND.x + 120, FRONTEND.y + 170]} to={[BACKEND.x + 80, BACKEND.y + 120]} at={ctx.at('dive-2', 'schema') - 2} stay={false} accent={C.accent}>
          <Icon name="table" color={C.accent} size={30} /> Data schema
        </Flyer>
        <Chip x={BACKEND.x} y={BACKEND.y + 120} from={ctx.at('dive-2', 'matches')} to={ctx.beat('dive-3').from + 4} size={26} accent={C.ok}>
          ✓ Matches your code
        </Chip>
        <Flyer from={[BACKEND.x - 40, BACKEND.y + 110]} to={[MACHINE.x - 130, MACHINE.y + 225]} at={ctx.at('dive-3', 'address') - 4} accent={C.accent2} until={end}>
          <Mono>rayfin/.env</Mono>
        </Flyer>
        <Flyer from={[BACKEND.x - 40, BACKEND.y + 110]} to={[MACHINE.x + 150, MACHINE.y + 225]} at={ctx.at('dive-3', 'environment')} accent={C.accent2} until={end}>
          <Mono>.env.local</Mono>
        </Flyer>
        <Chip x={MACHINE.x} y={MACHINE.y + 160} from={ctx.at('dive-3', 'address')} to={ctx.beat('dive-4').from} size={26} accent={C.accent2}>
          The backend’s address
        </Chip>
        <Beam from={[FRONTEND.x + 245, FRONTEND.y]} to={[BACKEND.x - 255, BACKEND.y]} at={call - 4} color={alpha(C.accent, 0.8)} width={4} dashed />
        <Flow from={[FRONTEND.x + 250, FRONTEND.y]} to={[BACKEND.x - 260, BACKEND.y]} at={call + 10} color={C.accent} />
        <Chip x={MACHINE.x} y={MACHINE.y + 160} from={ctx.at('dive-5', 'no')} to={end} size={28} accent={C.ok}>
          ✓ No backend to run yourself
        </Chip>
        <Tile x={WEBSITE.x} y={WEBSITE.y} w={500} h={140} horizontal icon="hosting" label="Your live website" sub="Published by rayfin up" at={ctx.beat('dive-6').from - 2} off={1 - ramp(frame, ctx.at('dive-6', 'up'), 10)} color={C.accent2} />
        <Struck x={960} y={WEBSITE.y} from={ctx.at('dive-6', 'never') - 2} strike={ctx.at('dive-6', 'publish') + 2} to={end}>
          <Icon name="upload" color={C.inkDim} size={30} /> Publish
        </Struck>
        <Chip x={WEBSITE.x} y={WEBSITE.y + 115} from={ctx.at('dive-6', 'up') - 2} to={end} size={30} accent={C.accent2}>
          <span>
            That’s <Mono>rayfin up</Mono>
          </span>
        </Chip>
      </AbsoluteFill>
    );
  },
};

/* ------------------------------------------------------------------------------------------ */
/*                                   8. Ship it with rayfin up                                */
/* ------------------------------------------------------------------------------------------ */

/** What rayfin up does, one row each, ticked off on its cue. */
function StepRows({ x, y, width, items, from, to }: { x: number; y: number; width: number; items: ReadonlyArray<{ icon: IconName; text: ReactNode; at: number }>; from: number; to: number }): JSX.Element | null {
  const { fps } = useVideoConfig();
  const C = useTheme();
  const show = useShow(from, to);
  if (!show) return null;
  const { frame, out } = show;
  return (
    <div style={{ position: 'absolute', left: x - width / 2, top: y, width, display: 'flex', flexDirection: 'column', gap: 16, opacity: out }}>
      {items.map((item, i) => {
        const q = frame < item.at ? 0 : pop(frame, fps, item.at, 12, 0.6);
        const tick = frame < item.at + 8 ? 0 : pop(frame, fps, item.at + 8, 10, 0.5);
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 24, padding: '14px 26px', borderRadius: 22, background: C.panel.bg, border: `2px solid ${alpha(C.accent, 0.25 + 0.4 * Math.min(1, q))}`, boxShadow: C.shadow.tile, opacity: Math.min(1, q * 1.5), transform: `translateX(${(1 - Math.min(1, q)) * -50}px)` }}>
            <div style={{ width: 64, height: 64, flex: 'none', borderRadius: 16, display: 'grid', placeItems: 'center', background: alpha(C.accent, 0.14) }}>
              <Icon name={item.icon} color={C.accent} size={40} />
            </div>
            <div style={{ flex: 1, fontFamily: FONT, fontWeight: 650, fontSize: 42, color: C.ink }}>{item.text}</div>
            <div style={{ width: 52, height: 52, borderRadius: '50%', display: 'grid', placeItems: 'center', background: alpha(C.ok, 0.18), transform: `scale(${tick})` }}>
              <Icon name="check" color={C.ok} size={34} stroke={2.8} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

const FIRST_TIME = [
  { word: 'picks', icon: 'workspace', label: 'A workspace', sub: 'Picks one', x: 600 },
  { word: 'checks', icon: 'gauge', label: 'Its capacity', sub: 'Checks it’s ready', x: 960 },
  { word: 'creates', icon: 'cloud', label: 'Your Fabric app', sub: 'Creates it there', x: 1320 },
] as const;

const ship: LessonScene = {
  id: 'ship',
  ray: (c) => ({
    keys: [{ f: 0, ...SPOT.deep }, swim(c.span.duration, 'ship')],
    moods: [
      { f: 0, mood: 'happy' },
      { f: c.beat('up-2').from, mood: 'idle' },
      { f: c.at('up-2', 'publishes'), mood: 'happy' },
      { f: c.beat('up-3').from, mood: 'idle' },
      { f: c.at('up-4', 'live'), mood: 'happy' },
    ],
    hops: [c.at('up-1', 'up') + 4, c.at('up-4', 'live') + 4],
    gaze: [
      [0, -0.8, -0.8],
      [c.beat('up-2').from, -0.8, -0.2],
      [c.beat('up-3').from, -0.8, -0.3],
      [c.beat('up-4').from, -0.8, -0.6],
      [c.at('up-4', 'status'), -0.8, -0.1],
    ],
  }),
  sfx: (c) => [
    { f: 0, id: 'surface', volume: 0.5 },
    { f: c.at('up-1', 'rayfin'), id: 'typing', volume: 0.3, duration: 14 },
    { f: c.at('up-1', 'up') + 6, id: 'stamp', volume: 0.4 },
    ...['builds', 'applies', 'deploys', 'publishes'].map((w) => ({ f: c.at('up-2', w) + 8, id: 'pop' as const, volume: 0.45 })),
    ...FIRST_TIME.map((s) => ({ f: c.at('up-3', s.word), id: 'pop' as const, volume: 0.45 })),
    { f: c.at('up-4', 'tells'), id: 'chime', volume: 0.35 },
    { f: c.at('up-4', 'live'), id: 'shimmer', volume: 0.35 },
    { f: c.at('up-4', 'rayfin'), id: 'typing', volume: 0.3, duration: 18 },
  ],
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const C = useTheme();
    const end = ctx.span.duration - 14;
    const two = ctx.beat('up-2').from;
    const three = ctx.beat('up-3').from;
    const four = ctx.beat('up-4').from;
    const u = TERMINALS.up;
    const cardY = track(frame, [
      [four - 12, 230],
      [four + 8, 400],
    ]);
    return (
      <AbsoluteFill>
        <ChapterTag text="Ship it with rayfin up" from={ctx.lead} to={end} />
        <CommandCard
          command={u.command}
          output={[
            { text: u.output[0], at: four, color: '#7d7d7d' },
            { text: u.output[1], at: ctx.at('up-4', 'tells'), color: C.ok },
            { text: u.output[2], at: ctx.at('up-4', 'tells') + 6, color: '#cccccc' },
            { text: u.output[3], at: ctx.at('up-4', 'live'), color: '#9cdcfe' },
          ]}
          from={ctx.lead + 2}
          to={end}
          typeFrom={ctx.at('up-1', 'rayfin')}
          typeTo={ctx.at('up-1', 'rayfin') + 14}
          tagAt={ctx.at('up-1', 'up') + 6}
          x={960}
          y={cardY}
          width={1460}
        />
        <StepRows
          x={960}
          y={410}
          width={1060}
          from={two - 4}
          to={three - 6}
          items={[
            { icon: 'package', text: 'Builds your frontend for production', at: ctx.at('up-2', 'builds') },
            { icon: 'cog', text: 'Applies your settings and schema', at: ctx.at('up-2', 'applies') },
            { icon: 'functions', text: 'Deploys any functions', at: ctx.at('up-2', 'deploys') },
            { icon: 'upload', text: 'Publishes it all to Fabric', at: ctx.at('up-2', 'publishes') },
          ]}
        />
        {frame >= three - 2 && frame < four + 4 ? (
          <div style={{ position: 'absolute', left: 0, right: 0, top: 440, textAlign: 'center', fontFamily: FONT, fontWeight: 750, fontSize: 34, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.accent2, opacity: ramp(frame, three - 2, 10) * fadeOut(frame, four + 4, 10) }}>
            The first time, it…
          </div>
        ) : null}
        {FIRST_TIME.map((s) => (
          <Tile key={s.word} x={s.x} y={640} w={320} h={220} icon={s.icon} label={s.label} sub={s.sub} at={ctx.at('up-3', s.word)} until={four - 8} color={C.accent2} />
        ))}
        <Arrow x={780} y={640} from={ctx.at('up-3', 'checks') - 6} until={four - 8} />
        <Arrow x={1140} y={640} from={ctx.at('up-3', 'creates') - 6} until={four - 8} />
        <Burst kind="sparkles" at={ctx.at('up-4', 'live')} x={1130} y={548} count={12} seed={81} spread={1.6} />
        <CommandCard command={TERMINALS.status.command} from={ctx.at('up-4', 'rayfin') - 4} to={end} typeFrom={ctx.at('up-4', 'rayfin')} typeTo={ctx.at('up-4', 'status') + 6} tagAt={ctx.at('up-4', 'status') + 8} x={860} y={790} width={760} />
        <Chip x={860} y={915} from={ctx.at('up-4', 'address')} to={end} size={30} accent={C.accent2}>
          Shows where your app is live, any time
        </Chip>
      </AbsoluteFill>
    );
  },
};

/* ------------------------------------------------------------------------------------------ */
/*                                  9. See it in Fabricator                                   */
/* ------------------------------------------------------------------------------------------ */

/** The commands behind Fabricator's buttons, listed as Ray names them. */
function UnderTheHood({ x, y, items, from, to }: { x: number; y: number; items: ReadonlyArray<{ cmd: string; at: number }>; from: number; to: number }): JSX.Element | null {
  const { fps } = useVideoConfig();
  const C = useTheme();
  const show = useShow(from, to);
  if (!show) return null;
  const { frame, p, out } = show;
  return (
    <div style={{ position: 'absolute', left: x - 190, top: y, width: 380, padding: '22px 26px 26px', borderRadius: 22, background: '#0c0c0c', boxShadow: C.shadow.terminal, opacity: Math.min(1, p * 1.5) * out, transform: `scale(${0.85 + 0.15 * p})` }}>
      <div style={{ fontFamily: FONT, fontWeight: 700, fontSize: 24, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#9a9a9a' }}>Under the hood</div>
      {items.map((item) => {
        const q = frame < item.at ? 0 : pop(frame, fps, item.at, 12, 0.6);
        return (
          <div key={item.cmd} style={{ marginTop: 16, fontFamily: MONO, fontSize: 36, color: '#f9f1a5', opacity: Math.min(1, q * 1.5), transform: `translateX(${(1 - Math.min(1, q)) * -24}px)` }}>
            <span style={{ color: '#7d7d7d' }}>&gt; </span>
            {item.cmd}
          </div>
        );
      })}
    </div>
  );
}

function fabricatorBeats(c: LessonCtx) {
  return {
    project: c.lead,
    deploy: c.beat('fab-2').from,
    progress: c.beat('fab-3').from,
    live: c.beat('fab-4').from,
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
      { f: c.at('fab-3', 'talk') - 4, mood: 'happy' },
      { f: c.beat('fab-4').from, mood: 'idle' },
      { f: c.at('fab-4', 'building'), mood: 'happy' },
    ],
    waves: [c.at('fab-3', 'talk') - 4],
    hops: [c.at('fab-4', 'live'), c.at('fab-4', 'building')],
    gaze: [
      [0, -0.6, -0.4],
      [30, -0.9, 0.5],
      [c.at('fab-2', 'sign'), -0.6, 0.1],
      [c.at('fab-2', 'pick'), -0.9, 0.5],
      [c.at('fab-3', 'talk'), -0.9, 0.3],
      [c.at('fab-4', 'live'), -0.6, 0.2],
      [c.at('fab-4', 'chat'), -1, 0.8],
    ],
  }),
  sfx: (c) => {
    const b = fabricatorBeats(c);
    return [
      { f: c.at('fab-1', 'New'), id: 'click', volume: 0.5 },
      { f: c.at('fab-1', 'runs'), id: 'click', volume: 0.5 },
      { f: b.deploy, id: 'swim-whoosh', volume: 0.3 },
      { f: c.at('fab-2', 'pick'), id: 'click', volume: 0.45 },
      { f: c.at('fab-2', 'Deploy', 2), id: 'click', volume: 0.55 },
      { f: b.progress, id: 'swim-whoosh', volume: 0.3 },
      { f: c.at('fab-3', 'login'), id: 'pop', volume: 0.45 },
      { f: c.at('fab-3', 'up'), id: 'pop', volume: 0.45 },
      { f: b.live, id: 'swim-whoosh', volume: 0.3 },
      { f: c.at('fab-4', 'live'), id: 'chime', volume: 0.35 },
      { f: c.at('fab-4', 'chat'), id: 'pop', volume: 0.45 },
    ];
  },
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const b = fabricatorBeats(ctx);
    const end = ctx.span.duration - 14;
    const project = windowLife(frame, fps, b.project, b.deploy);
    const deploy = windowLife(frame, fps, b.deploy, b.progress);
    const progress = windowLife(frame, fps, b.progress, b.live);
    const bench = windowLife(frame, fps, b.live, end);
    const name = ctx.at('fab-1', 'name');
    const runs = ctx.at('fab-1', 'runs');
    const projectZoom = track(frame, [
      [name - 10, 1],
      [name + 12, 1.3],
    ]);
    const pick = ctx.at('fab-2', 'pick');
    const deployCam = {
      zoom: track(frame, [
        [pick - 8, 1],
        [pick + 12, 1.4],
      ]),
      fx: 800,
      fy: track(frame, [
        [pick - 8, 411],
        [pick + 12, 560],
      ]),
    };
    const benchCam = {
      zoom: track(frame, [
        [b.live + 4, 1],
        [ctx.at('fab-4', 'live') + 4, 1.7],
        [ctx.at('fab-4', 'chat') - 6, 1.7],
        [ctx.at('fab-4', 'chat') + 10, 1.5],
      ]),
      fx: track(frame, [
        [ctx.at('fab-4', 'live') - 4, 1150],
        [ctx.at('fab-4', 'chat') - 6, 1150],
        [ctx.at('fab-4', 'chat') + 10, 420],
      ]),
      fy: track(frame, [
        [ctx.at('fab-4', 'live') - 4, 300],
        [ctx.at('fab-4', 'chat') - 6, 300],
        [ctx.at('fab-4', 'chat') + 10, 760],
      ]),
    };
    const on = (from: number, to?: number) => ramp(frame, from - 2, 6) * (to === undefined ? 1 : 1 - ramp(frame, to - 2, 6));
    return (
      <AbsoluteFill>
        <ChapterTag text="See it in Fabricator" from={ctx.lead} to={end} />
        {project ? (
          <AppWindow shot={SHOTS.newProject} x={960} y={500} width={1500} zoom={projectZoom} fx={800} fy={265} opacity={project.opacity} scale={project.scale}>
            <Spotlight {...PX.projectTitle} radius={8} dim={0.45} opacity={on(ctx.at('fab-1', 'New'), name)} />
            <Spotlight {...PX.projectName} radius={10} dim={0.45} opacity={on(name, runs)} />
            <Spotlight {...PX.createButton} radius={10} dim={0.45} opacity={on(runs)} />
          </AppWindow>
        ) : null}
        <Chip x={960} y={850} from={runs + 2} to={b.deploy - 4} size={34}>
          <span>
            Runs <Mono>npm create</Mono> for you, with the Universal App
          </span>
        </Chip>
        {deploy ? (
          <AppWindow shot={FIRST_DEPLOY} x={960} y={555} width={1340} {...deployCam} opacity={deploy.opacity} scale={deploy.scale}>
            <Spotlight {...PX.account} radius={18} dim={0.45} opacity={on(ctx.at('fab-2', 'sign'), ctx.at('fab-2', 'pick'))} />
            <Spotlight {...PX.workspaces} radius={12} dim={0.45} opacity={on(ctx.at('fab-2', 'pick'), ctx.at('fab-2', 'Deploy', 2))} />
            <Spotlight {...PX.deployButton} radius={10} dim={0.45} opacity={on(ctx.at('fab-2', 'Deploy', 2))} />
          </AppWindow>
        ) : null}
        <Chip x={1480} y={300} from={ctx.at('fab-2', 'sign')} to={ctx.at('fab-2', 'pick') - 4} size={28}>
          Sign in to Fabric
        </Chip>
        {progress ? (
          <AppWindow shot={SHOTS.deployProgress} x={1080} y={540} width={880} opacity={progress.opacity} scale={progress.scale}>
            <Spotlight {...PX.rayBubble} radius={16} dim={0.4} opacity={on(ctx.at('fab-3', 'talk'), ctx.at('fab-3', 'deploys'))} />
            <Spotlight {...PX.deploySteps} radius={14} dim={0.4} opacity={on(ctx.at('fab-3', 'deploys'))} />
          </AppWindow>
        ) : null}
        <UnderTheHood
          x={360}
          y={330}
          from={b.progress}
          to={b.live - 6}
          items={[
            { cmd: 'rayfin login', at: ctx.at('fab-3', 'login') },
            { cmd: 'rayfin up', at: ctx.at('fab-3', 'up') },
          ]}
        />
        {bench ? (
          <AppWindow shot={SHOTS.workbench} x={960} y={555} width={1440} {...benchCam} opacity={bench.opacity} scale={bench.scale}>
            <Spotlight {...PX.benchLive} radius={10} dim={0.45} opacity={on(ctx.at('fab-4', 'live'), ctx.at('fab-4', 'chat'))} />
            <Spotlight {...PX.composer} radius={14} dim={0.45} opacity={on(ctx.at('fab-4', 'chat'))} />
          </AppWindow>
        ) : null}
      </AbsoluteFill>
    );
  },
};

/* ------------------------------------------------------------------------------------------ */
/*                                    10. Pop quiz                                            */
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
        [reveal, -0.9, 0.5],
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
      question="Which command publishes your app’s frontend to Fabric?"
      options={[
        { text: 'rayfin dev', code: true, at: ctx.at('quiz-options', 'A') },
        { text: 'rayfin up', code: true, at: ctx.at('quiz-options', 'B') },
        { text: 'rayfin login', code: true, at: ctx.at('quiz-options', 'C') },
      ]}
      answer={1}
      countdown={{ from: ctx.beat('countdown').from, step: 30 }}
      revealAt={ctx.beat('quiz-answer').from + 3}
      from={ctx.lead}
      to={ctx.span.duration - 14}
      x={880}
    />
  ),
};

/* ------------------------------------------------------------------------------------------ */
/*                                11. Recap, 12. Challenge                                    */
/* ------------------------------------------------------------------------------------------ */

const recap: LessonScene = {
  id: 'recap',
  ray: (c) => ({
    keys: [{ f: 0, ...SPOT.quiz }, swim(26, 'recap'), swim(c.span.duration, 'recap')],
    moods: [{ f: 0, mood: 'happy' }],
    hops: [c.w('starts'), c.w('runs'), c.w('ships')],
    gaze: [
      [0, -0.6, 0.6],
      [30, -0.9, -0.7],
    ],
  }),
  sfx: (c) => ['starts', 'runs', 'ships'].map((w) => ({ f: c.w(w) + 6, id: 'stamp' as const, volume: 0.4 })),
  View: ({ ctx }) => (
    <Recap
      from={ctx.lead}
      to={ctx.span.duration - 14}
      items={[
        {
          text: (
            <span>
              <Mono>npm create</Mono> starts your app from the Universal App
            </span>
          ),
          at: ctx.w('starts'),
        },
        {
          text: (
            <span>
              <Mono>npm run dev</Mono> runs it, with the backend in Fabric
            </span>
          ),
          at: ctx.w('runs'),
        },
        {
          text: (
            <span>
              <Mono>rayfin up</Mono> ships it to Fabric
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
    { f: c.w('send'), id: 'typing', volume: 0.28, duration: c.beat('challenge-2').from - c.w('send') },
    { f: c.beat('challenge-2').from, id: 'pop', volume: 0.5 },
  ],
  View: ({ ctx }) => <Challenge prompt={YOUTUBE.challenge.prompt} from={ctx.lead} to={ctx.span.duration - 14} typeFrom={ctx.w('send')} typeTo={ctx.beat('challenge-2').from + 10} cta={YOUTUBE.challenge.question} ctaAt={ctx.beat('challenge-2').from} />,
};

/* ------------------------------------------------------------------------------------------ */
/*                                13. Next up, 14. Ray fact                                   */
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
    const back = c.wEnd('eat') + 8;
    return {
      keys: [{ f: 0, ...SPOT.end }, swim(20, 'fact', ease.out), swim(back, 'fact'), swim(back + 22, 'end'), swim(c.span.duration, 'end')],
      moods: [
        { f: 0, mood: 'idle' },
        { f: c.w('eyes'), mood: 'surprised' },
        { f: c.w('mouth'), mood: 'idle' },
        { f: c.w('So'), mood: 'happy' },
      ],
      rolls: [c.w('underneath') - 2],
      squishes: [c.w('eat') - 2, c.w('eat') + 10],
      waves: [back + 24],
      gaze: [
        [0, 0, 0.1],
        [c.w('eyes'), 0, -0.9],
        [c.w('mouth'), 0, 0.9],
        [c.w('So'), 0, 0.1],
      ],
    };
  },
  sfx: (c) => [
    { f: 2, id: 'swim-whoosh', volume: 0.3 },
    { f: c.w('underneath') - 2, id: 'swim-whoosh', volume: 0.25 },
    { f: c.w('eat'), id: 'boing', volume: 0.35 },
    { f: c.wEnd('eat') + 8, id: 'swim-whoosh', volume: 0.3 },
  ],
  View: ({ ctx }) => (
    <AbsoluteFill>
      <TheEnd from={-400} to={ctx.span.duration + 400} />
      <Chip x={SPOT.fact.x} y={430} from={10} to={ctx.wEnd('eat') + 6} accent="#ffb547" size={26}>
        RAY FACT
      </Chip>
      <Burst kind="bubbles" at={ctx.w('eat')} x={SPOT.fact.x} y={SPOT.fact.y} count={10} seed={92} />
    </AbsoluteFill>
  ),
};

/** Lesson 2's scenes, in the script's order. */
export const SCENES: readonly LessonScene[] = [coldOpen, bumper, welcome, prereqs, create, run, deepDive, ship, fabricator, quiz, recap, challenge, next, stinger];
