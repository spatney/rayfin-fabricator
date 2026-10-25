import type { ReactNode } from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { ease, fadeOut, pop, ramp, track } from '../../src/anim';
import { Burst } from '../../src/fx/Burst';
import { CODE_PALETTES, Challenge, ChapterTag, CodeCard, DeepDiveTitle, DepthGauge, EndScreen, Icon, Objectives, Quiz, Recap, SeriesBumper, Sonar, at, locate, tokenize, type IconName } from '../../src/lesson-kit';
import type { RayKey } from '../../src/ray/RayActor';
import type { LessonScene } from '../../src/show/types';
import type { Shot } from '../../src/shots';
import { FONT, MONO, alpha, useTheme } from '../../src/theme';
import { AppWindow, Patch, SHOTS, Spotlight } from '../../src/ui/AppWindow';
import { Chip } from '../../src/ui/Kit';
import { SERIES } from '../series';
import { SCRIPT } from './script';
import { DEPLOYMENTS_JSON, ENV_VARS, FLURRY, GITIGNORE, GROWN, PACKAGE_NAMES, RAYFIN_FOLDER, RAYFIN_YML, SNIPPETS, TREE } from './snippets';
import { YOUTUBE } from './youtube';

/** Where Ray is when one scene hands him to the next. */
const SPOT = {
  hook: { x: 960, y: 960, s: 0.56 },
  welcome: { x: 960, y: 560, s: 1 },
  today: { x: 330, y: 600, s: 0.85 },
  perchBL: { x: 160, y: 940, s: 0.44 },
  deep: { x: 1830, y: 1000, s: 0.36 },
  fabricator: { x: 1800, y: 175, s: 0.4 },
  quiz: { x: 1700, y: 260, s: 0.5 },
  recap: { x: 1785, y: 945, s: 0.42 },
  challenge: { x: 1620, y: 560, s: 0.8 },
  end: { x: 1500, y: 250, s: 0.5 },
  fact: { x: 1155, y: 600, s: 0.6 },
} as const;

const swim = (f: number, spot: keyof typeof SPOT, e = ease.inOut): RayKey => at(f, SPOT[spot], e);

/** The Fabricator screenshots this lesson shows that src/shots.ts doesn't list. */
const CODE_VIEW: Shot = { id: 'code', w: 1600, h: 1000 };
const SKILLS_VIEW: Shot = { id: 'skills', w: 1600, h: 1000 };
/** Where the Fabricator chapter's windows sit: 850 px tall, between the chapter tag and a caption under them. */
const FAB_WINDOW = { y: 535, width: 1360 } as const;

/** Pixels in the screenshots that scenes point at. */
const PX = {
  tree: { x: 4, y: 150, w: 284, h: 810 },
  treeAgents: { x: 8, y: 157, w: 124, h: 28 },
  treePackages: { x: 8, y: 214, w: 176, h: 86 },
  skillsHeader: { x: 12, y: 8, w: 376, h: 40 },
  skillsFile: { x: 1238, y: 944, w: 356, h: 54 },
  skillsAlways: { x: 16, y: 68, w: 1190, h: 146 },
  bpWebsite: { x: 591, y: 261, w: 266, h: 98 },
  bpSignin: { x: 591, y: 363, w: 266, h: 66 },
  bpDatabase: { x: 591, y: 431, w: 266, h: 68 },
  bpStorage: { x: 591, y: 501, w: 266, h: 52 },
  bpConnectors: { x: 591, y: 555, w: 266, h: 106 },
  bpFunctions: { x: 591, y: 663, w: 266, h: 104 },
  bpSecrets: { x: 591, y: 770, w: 266, h: 66 },
  /** "· experimental" after File storage's "Files people upload": the lessons treat Storage as released. */
  bpExperimental: { x: 720, y: 529, w: 67, h: 16 },
  bpIdentities: { x: 627, y: 605, w: 232, h: 50 },
  bpSources: { x: 985, y: 150, w: 264, h: 690 },
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

/** 0→1 over a few frames from `from`, and back to 0 from `to`: how lit something is. */
function useLit(from: number, to?: number): number {
  const frame = useCurrentFrame();
  return ramp(frame, from - 2, 8) * (to === undefined ? 1 : 1 - ramp(frame, to - 2, 8));
}

/** Code in running text. */
const Mono = ({ children }: { children: ReactNode }) => <span style={{ fontFamily: MONO, fontWeight: 500 }}>{children}</span>;

/** A small chip inside a card that pops on its cue. It keeps its space before then, so nothing jumps. */
function Pill({ at: from, children, accent, mono = false, size = 26 }: { at: number; children: ReactNode; accent?: string; mono?: boolean; size?: number }): JSX.Element {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  const p = frame < from ? 0 : Math.min(1, pop(frame, fps, from, 12, 0.6));
  const ring = accent ?? C.accent;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: `${size * 0.22}px ${size * 0.6}px`, borderRadius: 999, background: C.chip.bg, border: `2px solid ${alpha(ring, 0.8)}`, fontFamily: mono ? MONO : FONT, fontWeight: mono ? 500 : 650, fontSize: size, color: C.chip.text, whiteSpace: 'nowrap', opacity: Math.min(1, p * 1.5), transform: `scale(${0.6 + 0.4 * p})` }}>
      {children}
    </span>
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
  const id = `m${start}-${Math.round(x1)}-${Math.round(y1)}-${Math.round(x2)}`;
  return (
    <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0, overflow: 'visible', opacity: out }}>
      <defs>
        <mask id={id} maskUnits="userSpaceOnUse" x={0} y={0} width={1920} height={1080}>
          <path d={d} fill="none" stroke="#fff" strokeWidth={width + 4} strokeLinecap="round" pathLength={1} strokeDasharray={`${p} 1`} />
        </mask>
      </defs>
      <path d={d} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeDasharray={dashed ? '14 14' : undefined} mask={`url(#${id})`} />
    </svg>
  );
}

/** Dots that travel along a straight line, over and over, to show something flowing. */
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

/** A command on its own, as a terminal pill. */
function CommandPill({ cmd, x, y, from, until, scale = 1 }: { cmd: string; x: number; y: number; from: number; until?: number; scale?: number }): JSX.Element | null {
  const C = useTheme();
  const show = useShow(from, until);
  if (!show) return null;
  const { p, out } = show;
  return (
    <div style={{ position: 'absolute', left: x, top: y, transform: `translate(-50%, -50%) scale(${(0.6 + 0.4 * p) * scale})`, opacity: Math.min(1, p * 1.5) * out, display: 'flex', alignItems: 'center', gap: 14, padding: '14px 26px', borderRadius: 18, background: '#0c0c0c', boxShadow: `${C.shadow.terminal}, ${C.glow(alpha(C.accent, 0.35), 24)}`, fontFamily: MONO, fontSize: 34, color: '#f9f1a5', whiteSpace: 'nowrap' }}>
      <span style={{ color: '#7d7d7d' }}>&gt;</span>
      {cmd}
    </div>
  );
}

/** An on/off switch, as rayfin.yml's `enabled` reads. */
function Switch({ on, size = 1 }: { on: number; size?: number }): JSX.Element {
  const C = useTheme();
  const rail = on > 0.5 ? C.ok : C.inkFaint;
  return (
    <div style={{ position: 'relative', flex: 'none', width: 84 * size, height: 44 * size, borderRadius: 22 * size, background: alpha(rail, 0.3 + 0.4 * on), border: `2px solid ${rail}` }}>
      <div style={{ position: 'absolute', top: 5 * size, left: (5 + 40 * on) * size, width: 30 * size, height: 30 * size, borderRadius: '50%', background: on > 0.5 ? C.ok : C.inkDim, boxShadow: C.shadow.chip }} />
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */
/*                                     1. The cold open                                       */
/* ------------------------------------------------------------------------------------------ */

const FOLDER = { x: 960, y: 300 } as const;
const FOLDER_TUCKED = { x: 250, y: 190 } as const;
const BOXES = {
  frontend: { x: 450, y: 650, icon: 'browser' },
  data: { x: 790, y: 650, icon: 'database' },
  shared: { x: 1130, y: 650, icon: 'link' },
} as const satisfies Record<string, { x: number; y: number; icon: IconName }>;
const YML_CARD = { x: 1570, y: 650 } as const;
const CLOUD = { x: 1570, y: 262 } as const;

/**
 * Where each file in the flurry settles around the folder: a 5×5 grid with a little jitter, minus
 * the two cells behind the folder, so no name hides another. The same every render.
 */
const SLOTS = Array.from({ length: 25 }, (_, n) => ({ col: n % 5, row: Math.floor(n / 5) })).filter(({ col, row }) => !(col === 2 && (row === 1 || row === 2)));
const SCATTER = FLURRY.map((_, i) => {
  const rand = (n: number) => {
    const s = Math.sin(i * 12.9898 + n * 78.233) * 43758.5453;
    return s - Math.floor(s);
  };
  const { col, row } = SLOTS[i % SLOTS.length];
  return { x: 200 + col * 380 + (rand(1) - 0.5) * 36, y: 105 + row * 140 + (rand(2) - 0.5) * 30, r: (rand(3) - 0.5) * 10 };
});

/** The new app's folder, counting its files as they spill out. */
function FolderCard({ from, count, tuck }: { from: number; count: number; tuck: number }): JSX.Element | null {
  const C = useTheme();
  const show = useShow(from);
  if (!show) return null;
  const { p } = show;
  const x = FOLDER.x + (FOLDER_TUCKED.x - FOLDER.x) * tuck;
  const y = FOLDER.y + (FOLDER_TUCKED.y - FOLDER.y) * tuck;
  return (
    <div style={{ position: 'absolute', left: x, top: y, transform: `translate(-50%, -50%) scale(${(0.7 + 0.3 * p) * (1 - 0.45 * tuck)})`, opacity: Math.min(1, p * 1.5), width: 330, padding: '26px 0 24px', borderRadius: 30, border: `3px solid ${alpha(C.accent2, 0.75)}`, background: C.panel.bg, boxShadow: `${C.shadow.panel}, ${C.glow(alpha(C.accent2, 0.3), 36)}`, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
      <Icon name="folder" color={C.accent2} size={110} stroke={1.6} />
      <div style={{ fontFamily: MONO, fontSize: 40, color: C.ink }}>{TREE.root}</div>
      <div style={{ fontFamily: FONT, fontWeight: 700, fontSize: 32, color: count > 0 ? C.star : C.inkDim, opacity: count > 0 ? 1 : 0 }}>
        {count} files
      </div>
    </div>
  );
}

/** A file's name on a chip, as it flies around. */
function FileChip({ name, x, y, r, scale, opacity }: { name: string; x: number; y: number; r: number; scale: number; opacity: number }): JSX.Element | null {
  const C = useTheme();
  if (opacity <= 0.01) return null;
  return (
    <div style={{ position: 'absolute', left: x, top: y, transform: `translate(-50%, -50%) rotate(${r}deg) scale(${scale})`, opacity, display: 'flex', alignItems: 'center', gap: 10, padding: '8px 18px 8px 12px', borderRadius: 14, background: C.panel.tile, border: `2px solid ${C.panel.border}`, boxShadow: C.shadow.chip, fontFamily: MONO, fontSize: 28, color: C.ink, whiteSpace: 'nowrap' }}>
      <Icon name="file" color={C.inkDim} size={28} />
      {name}
    </div>
  );
}

/** One of the three packages: where the code lives. */
function PackageBox({ name, icon, x, y, from, glow }: { name: string; icon: IconName; x: number; y: number; from: number; glow: number }): JSX.Element | null {
  const C = useTheme();
  const show = useShow(from);
  if (!show) return null;
  const { p } = show;
  return (
    <div style={{ position: 'absolute', left: x - 150, top: y - 82, width: 300, height: 164, borderRadius: 26, background: C.panel.tile, border: `2px solid ${alpha(C.accent, 0.35 + 0.55 * glow)}`, boxShadow: `${C.shadow.tile}, ${C.glow(alpha(C.accent, 0.4 * glow), 30)}`, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, opacity: Math.min(1, p * 1.5), transform: `translateY(${(1 - p) * 40}px) scale(${(0.8 + 0.2 * p) * (1 + 0.04 * glow)})` }}>
      <Icon name={icon} color={C.accent} size={58} />
      <div style={{ fontFamily: MONO, fontSize: 32, color: C.ink }}>{name}</div>
    </div>
  );
}

/** rayfin.yml as a panel of switches: what the new app turns on, and what it leaves off. */
function SwitchCard({ x, y, from, rows }: { x: number; y: number; from: number; rows: ReadonlyArray<{ key: string; on: number }> }): JSX.Element | null {
  const C = useTheme();
  const show = useShow(from);
  if (!show) return null;
  const { p } = show;
  return (
    <div style={{ position: 'absolute', left: x - 225, top: y - 135, width: 450, borderRadius: 24, overflow: 'hidden', background: C.panel.bg, border: `2px solid ${alpha(C.accent2, 0.7)}`, boxShadow: `${C.shadow.panel}, ${C.glow(alpha(C.accent2, 0.3), 30)}`, opacity: Math.min(1, p * 1.5), transform: `scale(${0.75 + 0.25 * p})` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 22px', background: C.bgElev, borderBottom: `2px solid ${C.panel.border}`, fontFamily: MONO, fontSize: 28, color: C.inkDim }}>
        <Icon name="file" color={C.accent2} size={30} />
        rayfin/<span style={{ color: C.ink, fontWeight: 600 }}>rayfin.yml</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '20px 26px 24px' }}>
        {rows.map((r) => (
          <div key={r.key} style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
            <div style={{ flex: 1, fontFamily: MONO, fontSize: 30, color: '#4ec9b0' }}>{r.key}</div>
            <Switch on={r.on} size={0.9} />
            <div style={{ width: 56, fontFamily: FONT, fontWeight: 700, fontSize: 26, color: r.on > 0.5 ? C.ok : C.inkDim }}>{r.on > 0.5 ? 'on' : 'off'}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Microsoft Fabric, running what rayfin.yml turned on. */
function FabricCloud({ x, y, from, signIn, website }: { x: number; y: number; from: number; signIn: number; website: number }): JSX.Element | null {
  const C = useTheme();
  const show = useShow(from);
  if (!show) return null;
  const { p } = show;
  const lit = Math.max(signIn, website);
  const piece = (icon: IconName, label: string, on: number) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 16px', borderRadius: 999, background: alpha(C.ok, 0.08 + 0.14 * on), border: `2px solid ${alpha(C.ok, 0.25 + 0.7 * on)}`, opacity: 0.4 + 0.6 * on, fontFamily: FONT, fontWeight: 650, fontSize: 26, color: C.ink }}>
      <Icon name={icon} color={on > 0.5 ? C.ok : C.inkDim} size={28} />
      {label}
    </div>
  );
  return (
    <div style={{ position: 'absolute', left: x - 225, top: y - 90, width: 450, height: 180, borderRadius: 28, background: C.panel.bg, border: `2px solid ${alpha(C.accent2, 0.4 + 0.5 * lit)}`, boxShadow: `${C.shadow.panel}, ${C.glow(alpha(C.ok, 0.35 * lit), 40)}`, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, opacity: Math.min(1, p * 1.5), transform: `scale(${0.75 + 0.25 * p})` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontFamily: FONT, fontWeight: 750, fontSize: 34, color: C.ink }}>
        <Icon name="cloud" color={C.accent2} size={40} /> Microsoft Fabric
      </div>
      <div style={{ display: 'flex', gap: 12 }}>
        {piece('shield', 'Sign-in', signIn)}
        {piece('browser', 'Website', website)}
      </div>
    </div>
  );
}

const coldOpen: LessonScene = {
  id: 'cold-open',
  ray: (c) => ({
    keys: [{ f: 0, x: 960, y: 1250, s: 0.6 }, swim(c.lead + 6, 'hook', ease.out), swim(c.span.duration, 'hook')],
    moods: [
      { f: 0, mood: 'idle' },
      { f: c.w('hundred'), mood: 'surprised' },
      { f: c.w('What'), mood: 'idle' },
      { f: c.w('Fabric'), mood: 'happy' },
    ],
    rolls: [6],
    hops: [c.w('run') + 2],
    gaze: [
      [0, 0, -0.7],
      [c.w('hundred'), -0.6, -0.8],
      [c.w('What') + 6, 0.7, -0.7],
      [c.w('all') + 6, -0.7, -0.5],
      [c.w('packages'), -0.6, -0.4],
      [c.w('small'), 0.8, -0.4],
      [c.w('Fabric'), 0.8, -0.8],
    ],
  }),
  sfx: (c) => [
    { f: 4, id: 'swim-whoosh', volume: 0.4 },
    { f: c.w('new') - 4, id: 'pop', volume: 0.5 },
    { f: c.w('comes'), id: 'bubbles', volume: 0.4 },
    { f: c.w('hundred'), id: 'shimmer', volume: 0.35 },
    { f: c.w('code'), id: 'swim-whoosh', volume: 0.3 },
    ...(['three', 'packages'] as const).map((w) => ({ f: c.w(w), id: 'pop' as const, volume: 0.45 })),
    { f: c.w('small') - 2, id: 'pop', volume: 0.5 },
    { f: c.w('tells'), id: 'click', volume: 0.55 },
    { f: c.w('tells') + 6, id: 'click', volume: 0.5 },
    { f: c.w('run'), id: 'chime', volume: 0.4 },
    { f: c.span.duration - 16, id: 'sweep', volume: 0.45 },
  ],
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const C = useTheme();
    const counted = Math.round(142 * ramp(frame, ctx.w('more'), ctx.wEnd('files') + 6 - ctx.w('more'), ease.out));
    const tuck = ramp(frame, ctx.w('code') - 4, 20, ease.inOut);
    const homing = ctx.w('packages') - 8;
    const tells = ctx.w('tells');
    const run = ctx.w('run');
    const exit = ramp(frame, ctx.span.duration - 18, 16, ease.in);
    const absorbed = (k: 'frontend' | 'data' | 'shared') => {
      const landed = FLURRY.map((f, i) => ({ f, i })).filter(({ f }) => f.home === k);
      const last = Math.max(...landed.map(({ i }) => homing + (i % 6) * 2 + 16));
      return ramp(frame, homing + 10, last - homing - 6) * (1 - ramp(frame, last + 6, 14));
    };
    return (
      <AbsoluteFill>
        <AbsoluteFill style={{ transform: `scale(${1 - 0.9 * exit})`, opacity: 1 - exit }}>
          <FolderCard from={ctx.w('new') - 4} count={counted} tuck={tuck} />
          {(Object.keys(BOXES) as Array<keyof typeof BOXES>).map((k, n) => (
            <PackageBox key={k} name={k} icon={BOXES[k].icon} x={BOXES[k].x} y={BOXES[k].y} from={ctx.w('three') + n * 5} glow={absorbed(k)} />
          ))}
          <Beam from={[YML_CARD.x, YML_CARD.y - 140]} to={[CLOUD.x, CLOUD.y + 95]} at={tells + 4} color={alpha(C.ok, 0.85)} width={5} />
          <Flow from={[YML_CARD.x, YML_CARD.y - 140]} to={[CLOUD.x, CLOUD.y + 95]} at={tells + 16} color={C.ok} every={30} />
          <FabricCloud x={CLOUD.x} y={CLOUD.y} from={ctx.w('Fabric') - 4} signIn={ramp(frame, run - 8, 8)} website={ramp(frame, run - 2, 8)} />
          <SwitchCard
            x={YML_CARD.x}
            y={YML_CARD.y}
            from={ctx.w('small') - 2}
            rows={[
              { key: 'auth', on: ramp(frame, tells, 8) },
              { key: 'staticHosting', on: ramp(frame, tells + 6, 8) },
              { key: 'data', on: 0 },
            ]}
          />
          {FLURRY.map((file, i) => {
            const start = ctx.w('comes') + i * 2;
            if (frame < start) return null;
            const s = SCATTER[i];
            const fly = ramp(frame, start, 18, ease.out);
            let x = FOLDER.x + (s.x - FOLDER.x) * fly + Math.sin((frame + i * 13) / 22) * 6;
            let y = FOLDER.y + (s.y - FOLDER.y) * fly + Math.cos((frame + i * 7) / 26) * 5;
            const homeAt = file.home === 'rayfin' ? ctx.w('small') - 6 : homing + (i % 6) * 2;
            const h = ramp(frame, homeAt, 16, ease.inOut);
            const dest = file.home === 'other' ? { x: s.x, y: s.y + 140 } : file.home === 'rayfin' ? YML_CARD : BOXES[file.home];
            x += (dest.x - x) * h;
            y += (dest.y - y) * h;
            const gone = file.home === 'other' ? h : ramp(frame, homeAt + 12, 6);
            return <FileChip key={i} name={file.name} x={x} y={y} r={s.r * (1 - h)} scale={(0.55 + 0.45 * fly) * (file.home === 'other' ? 1 : 1 - 0.5 * h)} opacity={Math.min(1, fly * 2) * (1 - gone)} />;
          })}
          <Burst kind="sparkles" at={run} x={CLOUD.x} y={CLOUD.y} count={16} seed={31} spread={2.2} />
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
      { f: 0, ...SPOT.hook },
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
      { f: c.span.duration, ...SPOT.perchBL },
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
    { f: c.w('package'), id: 'pop', volume: 0.5 },
    { f: c.w('rayfin.yml'), id: 'pop', volume: 0.5 },
    { f: c.w('building'), id: 'pop', volume: 0.5 },
    { f: c.w('dive'), id: 'swim-whoosh', volume: 0.4 },
  ],
  View: ({ ctx }) => (
    <AbsoluteFill>
      <Burst kind="bubbles" at={ctx.w('Hi')} x={1000} y={470} count={10} seed={32} />
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
          { text: 'What each package does', at: ctx.w('package') },
          {
            text: (
              <span>
                What <Mono>rayfin.yml</Mono> turns on
              </span>
            ),
            at: ctx.w('rayfin.yml'),
          },
          { text: 'The building blocks your app can grow', at: ctx.w('building') },
        ]}
      />
    </AbsoluteFill>
  ),
};

/* ------------------------------------------------------------------------------------------ */
/*                                 4. Three packages, one app                                 */
/* ------------------------------------------------------------------------------------------ */

interface TreeRow {
  key: string;
  depth: number;
  name: string;
  folder?: boolean;
  /** Frame it appears; it keeps its slot before then. */
  at: number;
  /** 0…1: picked out. */
  lit?: number;
  dim?: boolean;
  /** Drawn dashed: there later, not yet. */
  ghost?: boolean;
  note?: ReactNode;
}

/** A project's files as a tree, rows appearing on their cues and lighting up as Ray names them. */
function TreeCard({ x, y, width, rows, from, to, heading }: { x: number; y: number; width: number; rows: readonly TreeRow[]; from: number; to: number; heading?: ReactNode }): JSX.Element | null {
  const { fps } = useVideoConfig();
  const C = useTheme();
  const show = useShow(from, to);
  if (!show) return null;
  const { frame, p, out } = show;
  return (
    <div style={{ position: 'absolute', left: x - width / 2, top: y, width, padding: '20px 22px 24px', borderRadius: 28, background: C.panel.bg, border: `2px solid ${C.panel.border}`, boxShadow: C.shadow.panel, opacity: Math.min(1, p * 1.5) * out, transform: `translateY(${(1 - p) * 30}px)` }}>
      {heading ? <div style={{ height: 40, display: 'flex', alignItems: 'center', gap: 12, padding: '0 10px 14px', fontFamily: FONT, fontWeight: 750, fontSize: 26, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.accent2 }}>{heading}</div> : null}
      {rows.map((r) => {
        const q = frame < r.at ? 0 : Math.min(1, pop(frame, fps, r.at, 12, 0.6));
        const lit = r.lit ?? 0;
        return (
          <div key={r.key} style={{ position: 'relative', height: 60, display: 'flex', alignItems: 'center', gap: 14, paddingLeft: 12 + r.depth * 46, borderRadius: 14, background: alpha(C.accent, 0.18 * lit), boxShadow: lit > 0.02 ? `inset 0 0 0 2px ${alpha(C.accent, 0.7 * lit)}` : undefined, opacity: Math.min(1, q * 1.5) * (r.dim ? 0.45 : 1) * (r.ghost ? 0.7 : 1), transform: `translateX(${(1 - q) * -24}px)` }}>
            <Icon name={r.folder ? 'folder' : 'file'} color={r.folder ? C.accent2 : C.inkDim} size={34} />
            <span style={{ fontFamily: MONO, fontSize: 32, color: C.ink, textDecoration: r.ghost ? `underline dashed ${alpha(C.accent2, 0.8)}` : undefined, textUnderlineOffset: 8 }}>{r.name}</span>
            {r.note}
          </div>
        );
      })}
    </div>
  );
}

/** One package, with what it owns as chips that pop on their cues. */
function PackageCard({ y, icon, path, name, from, until, lit, ghost = 0, children }: { y: number; icon: IconName; path: string; name: string; from: number; until: number; lit: number; ghost?: number; children?: ReactNode }): JSX.Element | null {
  const C = useTheme();
  const show = useShow(from, until);
  if (!show) return null;
  const { p, out } = show;
  const ring = C.accent2;
  const x = 1290;
  const w = 960;
  return (
    <div style={{ position: 'absolute', left: x - w / 2, top: y - 78, width: w, height: 156, borderRadius: 26, background: ghost > 0.5 ? alpha(C.name === 'dark' ? '#0c1320' : '#ffffff', 0.55) : C.panel.tile, border: `2px ${ghost > 0.5 ? 'dashed' : 'solid'} ${alpha(ring, 0.3 + 0.6 * lit)}`, boxShadow: `${C.shadow.tile}, ${C.glow(alpha(ring, 0.35 * lit), 30)}`, display: 'flex', alignItems: 'center', gap: 24, padding: '0 28px', opacity: Math.min(1, p * 1.5) * out * (1 - 0.3 * ghost) * (0.6 + 0.4 * Math.max(lit, 0.5)), transform: `translateX(${(1 - p) * 60}px) scale(${0.94 + 0.06 * p})` }}>
      <div style={{ width: 88, height: 88, flex: 'none', borderRadius: 22, display: 'grid', placeItems: 'center', background: alpha(ring, 0.14) }}>
        <Icon name={icon} color={ring} size={52} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 'none', width: 350 }}>
        <div style={{ fontFamily: MONO, fontWeight: 600, fontSize: 32, color: C.ink }}>{path}</div>
        <div style={{ fontFamily: MONO, fontSize: 24, color: C.inkDim }}>{name}</div>
      </div>
      <div style={{ flex: 1, display: 'flex', flexWrap: 'wrap', alignContent: 'center', gap: 10, justifyContent: 'flex-end' }}>{children}</div>
    </div>
  );
}

/** Where the package cards sit, top to bottom. */
const CARD_Y = { frontend: 262, data: 442, shared: 622, functions: 802 } as const;
const TREE_X = 420;
const TREE_TOP = 190;

const packages: LessonScene = {
  id: 'packages',
  ray: (c) => ({
    keys: [{ f: 0, ...SPOT.perchBL }, swim(c.span.duration, 'perchBL')],
    moods: [
      { f: 0, mood: 'happy' },
      { f: c.at('pk-1', 'Your'), mood: 'idle' },
      { f: c.at('pk-3', 'lesson'), mood: 'happy' },
      { f: c.beat('pk-4').from, mood: 'idle' },
      { f: c.at('pk-5', 'joins'), mood: 'happy' },
    ],
    hops: [c.at('pk-3', 'lesson'), c.at('pk-5', 'joins') + 4],
    gaze: [
      [0, 0.3, -0.9],
      [c.at('pk-1', 'packages'), 0.4, -0.7],
      [c.beat('pk-2').from, 1, -0.8],
      [c.beat('pk-3').from, 1, -0.6],
      [c.beat('pk-4').from, 1, -0.4],
      [c.beat('pk-5').from, 1, -0.2],
    ],
  }),
  sfx: (c) => [
    { f: c.at('pk-1', 'npm'), id: 'pop', volume: 0.45 },
    { f: c.at('pk-1', 'workspace'), id: 'pop', volume: 0.4 },
    { f: c.at('pk-1', 'packages'), id: 'swim-whoosh', volume: 0.3 },
    { f: c.at('pk-2', 'frontend'), id: 'pop', volume: 0.5 },
    ...(['React', 'sign-in', 'pages'] as const).map((w) => ({ f: c.at('pk-2', w), id: 'pop' as const, volume: 0.35 })),
    { f: c.at('pk-3', 'data'), id: 'pop', volume: 0.5 },
    { f: c.at('pk-3', 'registers'), id: 'typing', volume: 0.28, duration: c.atEnd('pk-3', 'schema') - c.at('pk-3', 'registers') },
    { f: c.at('pk-4', 'shared'), id: 'pop', volume: 0.5 },
    ...(['frontend', 'data', 'functions'] as const).map((w) => ({ f: c.at('pk-4', w), id: 'pop' as const, volume: 0.35 })),
    { f: c.at('pk-5', 'functions'), id: 'swim-whoosh', volume: 0.3 },
    { f: c.at('pk-5', 'joins'), id: 'chime', volume: 0.4 },
  ],
  View: ({ ctx }) => {
    const end = ctx.span.duration - 14;
    const pk = (id: string) => ctx.beat(id).from;
    const litFrontend = useLit(pk('pk-2'), pk('pk-3'));
    const litData = useLit(pk('pk-3'), pk('pk-4'));
    const litShared = useLit(pk('pk-4'), pk('pk-5'));
    const litFunctions = useLit(ctx.at('pk-5', 'joins'));
    const C = useTheme();
    const folders = ctx.at('pk-1', 'packages');
    const rows: TreeRow[] = [
      { key: 'root', depth: 0, folder: true, name: TREE.root, at: ctx.lead + 4 },
      { key: 'manifest', depth: 1, name: TREE.manifest, at: ctx.at('pk-1', 'npm') },
      { key: 'rayfin', depth: 1, folder: true, name: 'rayfin/', at: ctx.at('pk-1', 'project'), dim: true },
      { key: 'packages', depth: 1, folder: true, name: 'packages/', at: folders, lit: useLit(folders, pk('pk-2')) },
      { key: 'frontend', depth: 2, folder: true, name: 'frontend/', at: folders + 6, lit: litFrontend },
      { key: 'data', depth: 2, folder: true, name: 'data/', at: folders + 10, lit: litData },
      { key: 'shared', depth: 2, folder: true, name: 'shared/', at: folders + 14, lit: litShared },
      { key: 'functions', depth: 2, folder: true, name: `${TREE.later}/`, at: ctx.at('pk-5', 'functions'), ghost: litFunctions < 0.5, lit: litFunctions },
    ];
    const register = SNIPPETS.register.code;
    const registerAt = ctx.at('pk-3', 'registers');
    const schemaMark = locate(register, 'schema');
    return (
      <AbsoluteFill>
        <ChapterTag text="Three packages, one app" from={ctx.lead} to={end} />
        <TreeCard x={TREE_X} y={TREE_TOP} width={560} rows={rows} from={ctx.lead} to={end} heading={<>npm workspace</>} />
        <Chip x={1290} y={300} from={ctx.at('pk-1', 'workspace')} to={pk('pk-2') - 6} size={30} accent={C.accent2}>
          <span>
            <Mono>package.json</Mono> · <Mono>{TREE.workspaces}</Mono>
          </span>
        </Chip>
        <Chip x={1290} y={420} from={ctx.at('pk-1', 'job')} to={pk('pk-2') - 6} size={30}>
          One project, a few packages, a job each
        </Chip>
        <PackageCard y={CARD_Y.frontend} icon="browser" path="packages/frontend" name={PACKAGE_NAMES.frontend} from={ctx.at('pk-2', 'frontend') - 4} until={end} lit={litFrontend}>
          <Pill at={ctx.at('pk-2', 'React')}>React + Vite</Pill>
          <Pill at={ctx.at('pk-2', 'sign-in')}>Sign-in</Pill>
          <Pill at={ctx.at('pk-2', 'pages')}>The pages people see</Pill>
        </PackageCard>
        <PackageCard y={CARD_Y.data} icon="database" path="packages/data" name={PACKAGE_NAMES.data} from={ctx.at('pk-3', 'data') - 4} until={end} lit={litData}>
          <Pill at={ctx.at('pk-3', 'entities')}>Your entities</Pill>
          <Pill at={ctx.at('pk-3', 'lesson')} mono accent={C.star}>
            Expense.ts
          </Pill>
        </PackageCard>
        <CodeCard
          code={register.split('\n').slice(2).join('\n')}
          firstLine={3}
          file="packages/data/src/index.ts"
          x={1290}
          y={CARD_Y.shared + 10}
          width={760}
          fontSize={30}
          from={registerAt - 4}
          to={pk('pk-4') - 8}
          typeFrom={registerAt}
          typeTo={ctx.atEnd('pk-3', 'schema')}
          marks={[{ line: 1, from: schemaMark.from, to: schemaMark.to, at: ctx.at('pk-3', 'schema'), until: pk('pk-4') - 8, color: C.accent2 }]}
        />
        <PackageCard y={CARD_Y.shared} icon="link" path="packages/shared" name={PACKAGE_NAMES.shared} from={ctx.at('pk-4', 'shared') - 4} until={end} lit={litShared}>
          <Pill at={ctx.at('pk-4', 'types')}>Shared types, for</Pill>
          <Pill at={ctx.at('pk-4', 'frontend')} accent={C.accent2}>
            frontend
          </Pill>
          <Pill at={ctx.at('pk-4', 'data')} accent={C.accent2}>
            data
          </Pill>
          <Pill at={ctx.at('pk-4', 'functions')} accent={C.accent2}>
            functions
          </Pill>
        </PackageCard>
        <PackageCard y={CARD_Y.functions} icon="functions" path={`packages/${TREE.later}`} name={PACKAGE_NAMES.functions} from={ctx.at('pk-5', 'functions') - 4} until={end} lit={litFunctions} ghost={1 - litFunctions}>
          <Pill at={ctx.at('pk-5', 'needs')} accent={C.star}>
            When your app needs it
          </Pill>
        </PackageCard>
      </AbsoluteFill>
    );
  },
};

/* ------------------------------------------------------------------------------------------ */
/*                               5. rayfin.yml: your app's services                           */
/* ------------------------------------------------------------------------------------------ */

/** A labeled block: an icon beside a name and a line under it. `glow` lights it up. */
function Tile({ x, y, w, h, icon, label, sub, at: from, until, glow = 0, color, mono = false }: { x: number; y: number; w: number; h: number; icon: IconName; label: ReactNode; sub?: ReactNode; at: number; until?: number; glow?: number; color?: string; mono?: boolean }): JSX.Element | null {
  const C = useTheme();
  const show = useShow(from, until);
  if (!show) return null;
  const { p, out } = show;
  const ring = color ?? C.accent;
  return (
    <div style={{ position: 'absolute', left: x - w / 2, top: y - h / 2, width: w, height: h, borderRadius: 22, background: C.panel.tile, border: `2px solid ${alpha(ring, 0.4 + 0.5 * Math.max(glow, Math.min(1, p) * 0.4))}`, boxShadow: `${C.shadow.tile}, ${C.glow(alpha(ring, 0.18 + 0.4 * glow), 26 + 20 * glow, 3 * glow)}`, display: 'flex', alignItems: 'center', gap: 18, padding: '0 22px', opacity: Math.min(1, p * 1.5) * out, transform: `translateY(${(1 - p) * 30}px) scale(${(0.85 + 0.15 * p) * (1 + 0.03 * glow)})` }}>
      <div style={{ width: 64, height: 64, flex: 'none', borderRadius: 18, display: 'grid', placeItems: 'center', background: alpha(ring, 0.14) }}>
        <Icon name={icon} color={ring} size={40} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        <div style={{ fontFamily: mono ? MONO : FONT, fontWeight: mono ? 600 : 750, fontSize: 30, color: C.ink, whiteSpace: 'nowrap' }}>{label}</div>
        {sub ? <div style={{ fontFamily: FONT, fontSize: 24, color: C.inkDim, lineHeight: 1.25 }}>{sub}</div> : null}
      </div>
    </div>
  );
}

/** The two values of `assetAccess`, side by side with what each means for the pages. */
function AccessCard({ x, y, from, to }: { x: number; y: number; from: number; to: number }): JSX.Element | null {
  const C = useTheme();
  const show = useShow(from, to);
  if (!show) return null;
  const { p, out } = show;
  const row = (value: string, meaning: string, lit: boolean) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '12px 16px', borderRadius: 14, background: lit ? alpha(C.accent2, 0.14) : 'transparent', border: `2px solid ${lit ? alpha(C.accent2, 0.7) : 'transparent'}` }}>
      <Icon name={lit ? 'lock' : 'hosting'} color={lit ? C.accent2 : C.inkDim} size={32} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontFamily: MONO, fontSize: 28, color: '#ce9178' }}>{value}</span>
        <span style={{ fontFamily: FONT, fontSize: 26, color: lit ? C.ink : C.inkDim }}>{meaning}</span>
      </div>
    </div>
  );
  return (
    <div style={{ position: 'absolute', left: x - 285, top: y, width: 570, padding: '20px 20px 18px', borderRadius: 24, background: C.panel.bg, border: `2px solid ${C.panel.border}`, boxShadow: C.shadow.panel, opacity: Math.min(1, p * 1.5) * out, transform: `translateX(${(1 - p) * 40}px)`, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontFamily: MONO, fontSize: 26, color: '#4ec9b0', padding: '0 6px 6px' }}>assetAccess</div>
      {row('protected', 'Pages load after sign-in', true)}
      {row('public', 'Pages load for anyone with the link', false)}
      <div style={{ fontFamily: FONT, fontSize: 24, color: C.inkDim, padding: '6px 6px 0' }}>Your data keeps its permissions either way.</div>
    </div>
  );
}

/** A piece of rayfin.yml that a growing app adds, in the editor's colors. "…" stands for keys left out. */
function YamlTile({ y, icon, yaml, where, from, until }: { y: number; icon: IconName; yaml: string; where: string; from: number; until: number }): JSX.Element | null {
  const C = useTheme();
  const P = CODE_PALETTES[C.name];
  const show = useShow(from, until);
  if (!show) return null;
  const { p, out } = show;
  return (
    <div style={{ position: 'absolute', left: 1360, top: y - 72, width: 520, height: 144, borderRadius: 22, background: P.bg, border: `2px solid ${alpha(C.accent2, 0.6)}`, boxShadow: `${C.shadow.tile}, ${C.glow(alpha(C.accent2, 0.25), 24)}`, display: 'flex', alignItems: 'center', gap: 20, padding: '0 22px', opacity: Math.min(1, p * 1.5) * out, transform: `translateX(${(1 - p) * 50}px)` }}>
      <div style={{ width: 64, height: 64, flex: 'none', borderRadius: 18, display: 'grid', placeItems: 'center', background: alpha(C.accent2, 0.14) }}>
        <Icon name={icon} color={C.accent2} size={40} />
      </div>
      <div style={{ flex: 1, fontFamily: MONO, fontSize: 27, lineHeight: 1.45, whiteSpace: 'pre' }}>
        {tokenize(yaml, 'yaml').map((tokens, i) => (
          <div key={i}>
            {tokens.map((t, k) => (
              <span key={k} style={{ color: t.text.trim() === '…' ? P.gutter : t.kind === 'bracket' ? P.brackets[0] : P.kinds[t.kind] }}>
                {t.text}
              </span>
            ))}
          </div>
        ))}
      </div>
      <div style={{ position: 'absolute', right: 16, top: 12, padding: '3px 12px', borderRadius: 999, background: alpha(C.accent2, 0.16), fontFamily: FONT, fontWeight: 700, fontSize: 24, color: C.accent2 }}>{where}</div>
    </div>
  );
}

const YML = { x: 800, width: 1000, font: 26, rows: 19 } as const;

const config: LessonScene = {
  id: 'config',
  ray: (c) => ({
    keys: [{ f: 0, ...SPOT.perchBL }, swim(c.span.duration, 'perchBL')],
    moods: [
      { f: 0, mood: 'idle' },
      { f: c.at('yml-1', 'configuration'), mood: 'happy' },
      { f: c.beat('yml-2').from, mood: 'idle' },
      { f: c.at('yml-4', 'protected'), mood: 'happy' },
      { f: c.beat('yml-5').from, mood: 'idle' },
      { f: c.beat('yml-6').from, mood: 'happy' },
    ],
    hops: [c.at('yml-1', 'configuration'), c.at('yml-6', 'secrets')],
    gaze: [
      [0, 0.4, -0.8],
      [c.at('yml-1', 'configuration'), 0.8, -0.6],
      [c.at('yml-2', 'dev'), 1, -0.7],
      [c.beat('yml-3').from, 0.8, -0.8],
      [c.beat('yml-4').from, 0.8, -0.3],
      [c.beat('yml-5').from, 0.8, -0.5],
      [c.beat('yml-6').from, 1, -0.4],
    ],
  }),
  sfx: (c) => [
    { f: c.at('yml-1', 'rayfin'), id: 'pop', volume: 0.45 },
    { f: c.at('yml-1', 'rayfin.yml'), id: 'pop', volume: 0.45 },
    { f: c.at('yml-1', 'configuration') - 4, id: 'swim-whoosh', volume: 0.35 },
    { f: c.at('yml-2', 'dev'), id: 'pop', volume: 0.4 },
    { f: c.at('yml-2', 'up'), id: 'pop', volume: 0.4 },
    { f: c.at('yml-2', 'sync'), id: 'shimmer', volume: 0.3 },
    { f: c.at('yml-3', 'Auth'), id: 'pop', volume: 0.4 },
    { f: c.at('yml-3', 'Entra'), id: 'chime', volume: 0.3 },
    { f: c.at('yml-4', 'Static') - 6, id: 'sweep', volume: 0.3 },
    { f: c.at('yml-4', 'protected'), id: 'click', volume: 0.5 },
    { f: c.at('yml-5', 'off'), id: 'click', volume: 0.45 },
    ...(['Functions', 'storage', 'Connectors', 'secrets'] as const).map((w) => ({ f: c.at('yml-6', w), id: 'pop' as const, volume: 0.45 })),
  ],
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const C = useTheme();
    const end = ctx.span.duration - 14;
    const b = (id: string) => ctx.beat(id).from;
    const cardAt = ctx.at('yml-1', 'configuration') - 8;
    const staticAt = ctx.at('yml-4', 'Static');
    const scroll = track(frame, [
      [staticAt - 8, 0],
      [staticAt + 14, 7],
    ]);
    const L = (text: string, nth = 1) => locate(RAYFIN_YML, text, nth);
    const services = L('services:');
    const auth = L('auth:');
    const fabric = L('fabric:');
    const hosting = L('staticHosting:');
    const access = L('assetAccess: protected');
    const data = L('data:');
    const dataOff = L('enabled: false', 2);
    const turns = ctx.at('yml-5', 'turns');
    const range = (a: number, z: number) => Array.from({ length: z - a + 1 }, (_, i) => a + i);
    const rows: TreeRow[] = [
      { key: 'root', depth: 0, folder: true, name: TREE.root, at: -20 },
      { key: 'manifest', depth: 1, name: TREE.manifest, at: -20, dim: true },
      { key: 'packages', depth: 1, folder: true, name: 'packages/', at: -20, dim: true, note: <span style={{ fontFamily: FONT, fontSize: 24, color: C.inkDim, whiteSpace: 'nowrap' }}>frontend · data · shared</span> },
      { key: 'rayfin', depth: 1, folder: true, name: 'rayfin/', at: -20, lit: useLit(ctx.at('yml-1', 'rayfin'), ctx.at('yml-1', 'rayfin.yml')) },
      { key: 'yml', depth: 2, name: 'rayfin.yml', at: ctx.at('yml-1', 'rayfin.yml') - 2, lit: useLit(ctx.at('yml-1', 'rayfin.yml')) },
    ];
    return (
      <AbsoluteFill>
        <ChapterTag text="rayfin.yml: your app’s services" from={ctx.lead} to={end} />
        <TreeCard x={TREE_X + 20} y={TREE_TOP} width={600} rows={rows} from={10} to={cardAt + 6} heading={<>npm workspace</>} />
        <Flyer from={[TREE_X + 40, TREE_TOP + 330]} to={[YML.x, 160]} at={cardAt - 10} stay={false} frames={14}>
          <Icon name="file" color={C.accent2} size={28} /> <Mono>rayfin.yml</Mono>
        </Flyer>
        <CodeCard
          code={RAYFIN_YML}
          language="yaml"
          file="rayfin/rayfin.yml"
          x={YML.x}
          y={560}
          width={YML.width}
          fontSize={YML.font}
          rows={YML.rows}
          scroll={scroll}
          from={cardAt}
          to={end}
          opacity={1 - 0.45 * ramp(frame, b('yml-6'), 12)}
          focus={[
            { lines: [services.line], from: b('yml-2'), to: b('yml-3') },
            { lines: range(auth.line, data.line - 1), from: b('yml-3'), to: b('yml-4') },
            { lines: range(hosting.line, hosting.line + 8), from: b('yml-4'), to: b('yml-5') },
            { lines: range(data.line, hosting.line - 1), from: b('yml-5'), to: b('yml-6') },
          ]}
          marks={[
            { line: services.line, from: services.from, to: services.to - 1, at: ctx.at('yml-2', 'services'), until: b('yml-3') - 6, color: C.accent2 },
            { line: auth.line, from: auth.from, to: auth.to - 1, at: ctx.at('yml-3', 'Auth'), until: b('yml-4') - 6, color: C.accent2 },
            { line: fabric.line, from: fabric.from, to: fabric.to - 1, at: ctx.at('yml-3', 'Entra'), until: b('yml-4') - 6 },
            { line: hosting.line, from: hosting.from, to: hosting.to - 1, at: staticAt + 10, until: b('yml-5') - 6, color: C.accent2 },
            { line: access.line, from: access.from, to: access.to, at: ctx.at('yml-4', 'protected'), until: b('yml-5') - 6 },
            { line: data.line, from: data.from, to: data.to - 1, at: ctx.at('yml-5', 'Data'), until: b('yml-6') - 6, color: C.accent2 },
            { line: dataOff.line, from: dataOff.from + 9, to: dataOff.to, at: ctx.at('yml-5', 'off'), until: turns - 4, label: 'Off for now', color: C.inkDim },
            { line: dataOff.line, from: dataOff.from + 9, to: dataOff.to, at: turns, until: b('yml-6') - 6, label: 'On when it needs records of its own', color: C.ok },
          ]}
        />
        <CommandPill cmd="rayfin dev" x={1610} y={300} from={ctx.at('yml-2', 'dev') - 6} until={b('yml-3') + 4} />
        <CommandPill cmd="rayfin up" x={1610} y={400} from={ctx.at('yml-2', 'up') - 4} until={b('yml-3') + 4} />
        <Beam from={[1610, 448]} to={[1610, 588]} at={ctx.at('yml-2', 'sync') - 4} color={alpha(C.accent2, 0.85)} width={5} until={b('yml-3') + 4} />
        <Flow from={[1610, 448]} to={[1610, 588]} at={ctx.at('yml-2', 'sync') + 8} until={b('yml-3') + 4} color={C.accent2} every={28} />
        <Tile x={1610} y={660} w={440} h={130} icon="cloud" label="Microsoft Fabric" sub="Synced from rayfin.yml" at={ctx.at('yml-2', 'Fabric') - 4} until={b('yml-3') + 4} color={C.accent2} glow={ramp(frame, ctx.at('yml-2', 'Fabric'), 10)} />
        <Tile x={1610} y={330} w={440} h={130} icon="shield" label="Sign-in" sub="Microsoft Entra ID, brokered by Fabric" at={ctx.at('yml-3', 'sign-in') - 2} until={b('yml-4') - 4} color={C.ok} glow={0.6 * ramp(frame, ctx.at('yml-3', 'Entra'), 10)} />
        <AccessCard x={1615} y={300} from={ctx.at('yml-4', 'protected') + 6} to={b('yml-5') - 4} />
        <Tile x={1610} y={430} w={440} h={130} icon="database" label="Database" sub="For records your app owns" at={ctx.at('yml-5', 'Data') - 2} until={b('yml-6') - 4} color={C.inkDim} glow={0.6 * ramp(frame, turns, 10)} />
        <YamlTile y={250} icon="functions" yaml={GROWN.functions.yaml} where={GROWN.functions.where} from={ctx.at('yml-6', 'Functions')} until={end} />
        <YamlTile y={430} icon="storage" yaml={GROWN.storage.yaml} where={GROWN.storage.where} from={ctx.at('yml-6', 'storage')} until={end} />
        <YamlTile y={610} icon="plug" yaml={GROWN.connectors.yaml} where={GROWN.connectors.where} from={ctx.at('yml-6', 'Connectors')} until={end} />
        <YamlTile y={790} icon="key" yaml={GROWN.secrets.yaml} where={GROWN.secrets.where} from={ctx.at('yml-6', 'secrets')} until={end} />
      </AbsoluteFill>
    );
  },
};

/* ------------------------------------------------------------------------------------------ */
/*                               6. What to commit, and what not                              */
/* ------------------------------------------------------------------------------------------ */

/** The rayfin folder's files, with what git does with each. */
function FolderList({ width, from, to, rows }: { width: number; from: number; to: number; rows: ReadonlyArray<{ name: string; at: number; lit?: number; isNew?: boolean; badge?: { at: number; kind: 'commit' | 'ignored' } }> }): JSX.Element | null {
  const { fps } = useVideoConfig();
  const C = useTheme();
  const show = useShow(from, to);
  if (!show) return null;
  const { frame, p, out } = show;
  const red = '#ff6b81';
  return (
    <div style={{ position: 'absolute', left: 90, top: 190, width, padding: '18px 20px 22px', borderRadius: 28, background: C.panel.bg, border: `2px solid ${C.panel.border}`, boxShadow: C.shadow.panel, opacity: Math.min(1, p * 1.5) * out, transform: `translateY(${(1 - p) * 30}px)` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, height: 52, padding: '0 10px 10px', fontFamily: MONO, fontSize: 32, color: C.ink }}>
        <Icon name="folder" color={C.accent2} size={36} /> rayfin/
      </div>
      {rows.map((r) => {
        const q = frame < r.at ? 0 : Math.min(1, pop(frame, fps, r.at, 12, 0.6));
        const b = r.badge && frame >= r.badge.at ? Math.min(1, pop(frame, fps, r.badge.at, 12, 0.6)) : 0;
        const ignored = r.badge?.kind === 'ignored' ? b : 0;
        const lit = r.lit ?? 0;
        const fresh = r.isNew ? 1 - ramp(frame, r.at + 40, 20) : 0;
        return (
          <div key={r.name} style={{ position: 'relative', height: 60, display: 'flex', alignItems: 'center', gap: 14, paddingLeft: 52, borderRadius: 14, background: alpha(C.accent, 0.18 * lit), boxShadow: lit > 0.02 ? `inset 0 0 0 2px ${alpha(C.accent, 0.7 * lit)}` : undefined, opacity: Math.min(1, q * 1.5), transform: `translateX(${(1 - q) * 30}px)` }}>
            <Icon name="file" color={C.inkDim} size={30} />
            <span style={{ fontFamily: MONO, fontSize: 30, color: C.ink, opacity: 1 - 0.5 * ignored, textDecoration: ignored > 0.5 ? `line-through ${alpha(red, 0.8)} 3px` : undefined }}>{r.name}</span>
            {fresh > 0.01 ? <span style={{ fontFamily: FONT, fontWeight: 750, fontSize: 24, letterSpacing: '0.08em', color: C.star, opacity: fresh }}>NEW</span> : null}
            {r.badge ? (
              <span style={{ position: 'absolute', right: 10, display: 'flex', alignItems: 'center', gap: 6, padding: '4px 12px', borderRadius: 999, background: alpha(r.badge.kind === 'commit' ? C.ok : red, 0.16), fontFamily: FONT, fontWeight: 700, fontSize: 24, color: r.badge.kind === 'commit' ? C.ok : red, opacity: b, transform: `scale(${0.6 + 0.4 * b})` }}>
                <Icon name={r.badge.kind === 'commit' ? 'check' : 'eyeOff'} color={r.badge.kind === 'commit' ? C.ok : red} size={24} stroke={2.4} />
                {r.badge.kind === 'commit' ? 'commit' : 'ignored'}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** The first of the variables in rayfin/.env; "…" stands for the rest, such as the tenant and the local port. */
const ENV = [...ENV_VARS.map((v) => `${v}=…`), '…'].join('\n');
const DEPLOY = { x: 1270, width: 1220, font: 26 } as const;

const files: LessonScene = {
  id: 'files',
  ray: (c) => ({
    keys: [{ f: 0, ...SPOT.perchBL }, swim(c.span.duration, 'perchBL')],
    moods: [
      { f: 0, mood: 'idle' },
      { f: c.at('git-1', 'two'), mood: 'surprised' },
      { f: c.beat('git-2').from, mood: 'idle' },
      { f: c.at('git-4', 'commit'), mood: 'happy' },
    ],
    hops: [c.at('git-4', 'commit') + 4],
    gaze: [
      [0, 0.3, -0.9],
      [c.at('git-1', 'dev'), 1, -0.6],
      [c.at('git-1', 'two'), 0.3, -0.7],
      [c.beat('git-2').from, 1, -0.7],
      [c.beat('git-3').from, 1, -0.5],
      [c.at('git-4', 'git'), 0.3, -0.7],
      [c.at('git-4', 'commit'), 0.3, -0.9],
    ],
  }),
  sfx: (c) => [
    { f: c.at('git-1', 'dev'), id: 'pop', volume: 0.4 },
    { f: c.at('git-1', 'up'), id: 'pop', volume: 0.4 },
    { f: c.at('git-1', 'two'), id: 'swim-whoosh', volume: 0.3 },
    { f: c.at('git-1', 'files') + 4, id: 'pop', volume: 0.45 },
    { f: c.at('git-1', 'folder'), id: 'pop', volume: 0.45 },
    { f: c.at('git-2', 'address'), id: 'pop', volume: 0.45 },
    { f: c.beat('git-3').from, id: 'swim-whoosh', volume: 0.3 },
    ...(['workspace', 'app', 'address'] as const).map((w) => ({ f: c.at('git-3', w), id: 'pop' as const, volume: 0.4 })),
    { f: c.at('git-4', 'leaves'), id: 'stamp', volume: 0.45 },
    { f: c.at('git-4', 'commit'), id: 'chime', volume: 0.4 },
  ],
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const C = useTheme();
    const end = ctx.span.duration - 14;
    const b = (id: string) => ctx.beat(id).from;
    const ignoredAt = ctx.at('git-4', 'leaves');
    const commitAt = ctx.at('git-4', 'commit');
    const envAt = ctx.at('git-1', 'two');
    const deployAt = ctx.at('git-1', 'files');
    const L = (code: string, text: string) => locate(code, text);
    const workspace = L(DEPLOYMENTS_JSON, '"contoso-apps": {');
    const item = L(DEPLOYMENTS_JSON, '"itemName"');
    const hosting = L(DEPLOYMENTS_JSON, '"https://');
    const hostingEnd = L(DEPLOYMENTS_JSON, 'fabricapps.net"');
    const deepLink = L(DEPLOYMENTS_JSON, '"fabricDeepLink": "…",');
    const apiUrl = L(ENV, 'RAYFIN_PUBLIC_API_URL');
    const envLine = L(GITIGNORE, 'rayfin/.env');
    const deployLine = L(GITIGNORE, 'rayfin/.deployments.json');
    const rowAt = (i: number) => 190 + 18 + 62 + i * 60 + 30;
    const ymlLit = useLit(commitAt);
    // Narrow while the JSON card needs the room; wide enough for the git badges once it's gone.
    const listWidth = 500 + 130 * ramp(frame, b('git-4'), 14);
    return (
      <AbsoluteFill>
        <ChapterTag text="What to commit, and what not" from={ctx.lead} to={end} />
        <FolderList
          width={listWidth}
          from={ctx.lead}
          to={end}
          rows={[
            ...RAYFIN_FOLDER.scaffolded.map((name, i) => ({ name, at: ctx.lead + 4 + i * 3, lit: name === 'rayfin.yml' ? ymlLit : 0, badge: { at: commitAt + (name === 'rayfin.yml' ? 0 : 4 + i * 2), kind: 'commit' as const } })),
            { name: RAYFIN_FOLDER.written[0], at: envAt + 24, isNew: true, badge: { at: ignoredAt, kind: 'ignored' as const } },
            { name: RAYFIN_FOLDER.written[1], at: deployAt + 24, isNew: true, badge: { at: ignoredAt + 4, kind: 'ignored' as const } },
          ]}
        />
        <CommandPill cmd="rayfin dev" x={1180} y={380} from={ctx.at('git-1', 'dev') - 6} until={b('git-2') - 4} />
        <CommandPill cmd="rayfin up" x={1180} y={500} from={ctx.at('git-1', 'up') - 4} until={b('git-2') - 4} />
        <Flyer from={[1080, 400]} to={[260, rowAt(5)]} at={envAt} stay={false} frames={20}>
          <Mono>.env</Mono>
        </Flyer>
        <Flyer from={[1080, 500]} to={[330, rowAt(6)]} at={deployAt} stay={false} frames={20}>
          <Mono>.deployments.json</Mono>
        </Flyer>
        <CodeCard
          code={ENV}
          language="plaintext"
          file="rayfin/.env"
          x={1240}
          y={420}
          width={900}
          fontSize={28}
          from={b('git-2') - 2}
          to={b('git-3') - 6}
          marks={[{ line: apiUrl.line, from: apiUrl.from, to: apiUrl.to, at: ctx.at('git-2', 'address'), until: b('git-3') - 6, label: 'your backend’s address' }]}
        />
        <CodeCard
          code={DEPLOYMENTS_JSON}
          language="json"
          file="rayfin/.deployments.json"
          x={DEPLOY.x}
          y={545}
          width={DEPLOY.width}
          fontSize={DEPLOY.font}
          from={b('git-3') - 2}
          to={b('git-4') - 6}
          marks={[
            { line: workspace.line, from: workspace.from, to: workspace.from + 14, at: ctx.at('git-3', 'workspace'), until: b('git-4') - 6, label: 'its workspace' },
            { line: item.line, from: item.from, to: item.to + 10, at: ctx.at('git-3', 'app'), until: b('git-4') - 6, label: 'its Fabric app' },
            { line: hosting.line, from: hosting.from, to: hostingEnd.to, at: ctx.at('git-3', 'address'), until: b('git-4') - 6, label: 'its address', labelSide: 'below', labelFrom: deepLink.to + 3 },
          ]}
        />
        <CodeCard
          code={GITIGNORE}
          language="plaintext"
          file=".gitignore"
          x={1240}
          y={500}
          width={900}
          fontSize={28}
          from={b('git-4') - 2}
          to={end}
          marks={[
            { line: envLine.line, from: envLine.from, to: envLine.to, at: ignoredAt, until: end, color: '#ff6b81' },
            { line: deployLine.line, from: deployLine.from, to: deployLine.to, at: ignoredAt + 4, until: end, color: '#ff6b81', label: 'git leaves these out', labelGap: 3 },
          ]}
        />
        <Chip x={1240} y={820} from={commitAt} to={end} size={30} accent={C.ok}>
          <span>
            <Mono>rayfin.yml</Mono> is what you built: commit it
          </span>
        </Chip>
      </AbsoluteFill>
    );
  },
};

/* ------------------------------------------------------------------------------------------ */
/*                                        7. Deep Dive                                        */
/* ------------------------------------------------------------------------------------------ */

/** A region of the diagram: a dashed outline with its name on a tab. */
function Zone({ x, y, w, h, icon, title, at: from, glow = 0, color, children }: { x: number; y: number; w: number; h: number; icon: IconName; title: ReactNode; at: number; glow?: number; color: string; children?: ReactNode }): JSX.Element | null {
  const C = useTheme();
  const show = useShow(from);
  if (!show) return null;
  const { frame, p } = show;
  const draw = ramp(frame, from, 20, ease.inOut);
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <div style={{ position: 'absolute', left: x - w / 2, top: y - h / 2, width: w, height: h, borderRadius: 36, border: `3px dashed ${alpha(color, 0.45 + 0.5 * glow)}`, background: alpha(color, 0.04 + 0.06 * glow), boxShadow: C.glow(alpha(color, 0.4 * glow), 50, 4), opacity: draw }} />
      <div style={{ position: 'absolute', left: x - w / 2 + 34, top: y - h / 2 - 28, display: 'flex', alignItems: 'center', gap: 12, padding: '8px 22px 8px 16px', borderRadius: 999, background: C.chip.bg, border: `2px solid ${color}`, boxShadow: C.shadow.chip, fontFamily: FONT, fontWeight: 750, fontSize: 28, color: C.chip.text, whiteSpace: 'nowrap', transform: `scale(${Math.min(1, p)})`, transformOrigin: '0% 50%' }}>
        <Icon name={icon} color={color} size={34} />
        {title}
        {children}
      </div>
    </div>
  );
}

/** A small "on" switch that pops onto a piece of the diagram: rayfin.yml turned it on. */
function OnBadge({ x, y, at: from }: { x: number; y: number; at: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < from) return null;
  const p = Math.min(1, pop(frame, fps, from, 12, 0.6));
  return (
    <div style={{ position: 'absolute', left: x, top: y, transform: `translate(-50%, -50%) scale(${p})` }}>
      <Switch on={ramp(frame, from + 4, 8)} size={0.6} />
    </div>
  );
}

/**
 * Where the diagram's pieces sit: the Fabric app on the left, clear of the depth gauge, and what's
 * outside it on the right. The web service is the hub, as in rayfin.ai's diagram. Sign-in is one
 * of the app's own services, so it sits inside.
 */
const FAB = { x: 800, y: 565, w: 1020, h: 770 } as const;
const OUT = { x: 1615, y: 565, w: 550, h: 770 } as const;
const NODE = { w: 310, h: 100 } as const;
const N = {
  static: { x: 465, y: 310 },
  web: { x: 880, y: 310 },
  dab: { x: 465, y: 545 },
  blob: { x: 795, y: 545 },
  fn: { x: 1125, y: 545 },
  sql: { x: 465, y: 780 },
  signin: { x: 1125, y: 780 },
} as const;
/** The sources outside the app: a column of cards, each as tall as what it lists, level with what reaches it. */
const SRC_W = 490;
const SRC = {
  data: { y: 320, h: 160 },
  ms: { y: 560, h: 204 },
  api: { y: 775, h: 110 },
} as const;
/** A point on a node, from its center. */
const EDGE = (k: keyof typeof N, ax: number, ay: number): [number, number] => [N[k].x + ax, N[k].y + ay];
/** A point on a source card's left edge. */
const INTO = (k: keyof typeof SRC, ay = 0): [number, number] => [OUT.x - SRC_W / 2, SRC[k].y + ay];

/** A piece of the Fabric app in the Deep Dive's diagram. */
function Node({ k, icon, label, sub, at: from, glow = 0, color }: { k: keyof typeof N; icon: IconName; label: string; sub?: string; at: number; glow?: number; color?: string }): JSX.Element | null {
  const C = useTheme();
  const show = useShow(from);
  if (!show) return null;
  const { p } = show;
  const { x, y } = N[k];
  const ring = color ?? C.accent;
  return (
    <div style={{ position: 'absolute', left: x - NODE.w / 2, top: y - NODE.h / 2, width: NODE.w, height: NODE.h, borderRadius: 20, background: C.panel.tile, border: `2px solid ${alpha(ring, 0.45 + 0.5 * glow)}`, boxShadow: `${C.shadow.tile}, ${C.glow(alpha(ring, 0.18 + 0.4 * glow), 26 + 20 * glow, 3 * glow)}`, display: 'flex', alignItems: 'center', gap: 14, padding: '0 16px', opacity: Math.min(1, p * 1.5), transform: `translateY(${(1 - p) * 30}px) scale(${(0.85 + 0.15 * p) * (1 + 0.03 * glow)})` }}>
      <div style={{ width: 52, height: 52, flex: 'none', borderRadius: 14, display: 'grid', placeItems: 'center', background: alpha(ring, 0.14) }}>
        <Icon name={icon} color={ring} size={34} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{ fontFamily: FONT, fontWeight: 750, fontSize: 28, color: C.ink, whiteSpace: 'nowrap' }}>{label}</div>
        {sub ? <div style={{ fontFamily: FONT, fontSize: 24, color: C.inkDim, whiteSpace: 'nowrap' }}>{sub}</div> : null}
      </div>
    </div>
  );
}

/**
 * Sign-in, explained: a card over the app, its other pieces dimmed behind it, that ticks off what
 * Fabric brokered auth spares you, then settles into the Sign-in piece by `to`.
 */
function SignInCallout({ from, to, termAt, rows }: { from: number; to: number; termAt: number; rows: ReadonlyArray<{ text: string; at: number }> }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  if (frame < from || frame > to) return null;
  const p = Math.min(1, pop(frame, fps, from, 12, 0.7));
  const settle = ramp(frame, to - 16, 16, ease.inOut);
  const w = 720;
  const h = 330;
  const x = FAB.x + (N.signin.x - FAB.x) * settle;
  const y = FAB.y + (N.signin.y - FAB.y) * settle;
  const term = frame < termAt ? 0 : Math.min(1, pop(frame, fps, termAt, 12, 0.6));
  const dim = ramp(frame, from, 10) * (1 - settle);
  return (
    <>
      <div style={{ position: 'absolute', left: FAB.x - FAB.w / 2, top: FAB.y - FAB.h / 2, width: FAB.w, height: FAB.h, borderRadius: 36, background: C.scrim(0.6 * dim) }} />
      <div style={{ position: 'absolute', left: x - w / 2, top: y - h / 2, width: w, height: h, transform: `scale(${(0.85 + 0.15 * p) * (1 - (1 - NODE.w / w) * settle)})`, opacity: Math.min(1, p * 1.5) * (1 - settle), borderRadius: 28, background: C.panel.bg, border: `2px solid ${alpha(C.ok, 0.7)}`, boxShadow: `${C.shadow.panel}, ${C.glow(alpha(C.ok, 0.3), 36)}`, padding: '26px 34px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <div style={{ width: 72, height: 72, flex: 'none', borderRadius: 20, display: 'grid', placeItems: 'center', background: alpha(C.ok, 0.14) }}>
            <Icon name="shield" color={C.ok} size={44} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: 40, color: C.ink, whiteSpace: 'nowrap' }}>Sign-in, built in</div>
            <div style={{ fontFamily: FONT, fontWeight: 700, fontSize: 30, color: C.ok, whiteSpace: 'nowrap', opacity: term, transform: `translateX(${(1 - term) * -16}px)` }}>Fabric brokered auth</div>
          </div>
        </div>
        {rows.map((row) => {
          const q = frame < row.at ? 0 : Math.min(1, pop(frame, fps, row.at, 12, 0.6));
          return (
            <div key={row.text} style={{ display: 'flex', alignItems: 'center', gap: 16, opacity: 0.25 + 0.75 * q, transform: `translateX(${(1 - q) * 16}px)` }}>
              <div style={{ width: 40, height: 40, flex: 'none', borderRadius: '50%', display: 'grid', placeItems: 'center', background: alpha(C.ok, 0.18), transform: `scale(${0.5 + 0.5 * q})` }}>
                <Icon name="check" color={C.ok} size={26} stroke={2.8} />
              </div>
              <div style={{ fontFamily: FONT, fontWeight: 650, fontSize: 30, color: C.ink, whiteSpace: 'nowrap' }}>{row.text}</div>
            </div>
          );
        })}
      </div>
    </>
  );
}

const deepDive: LessonScene = {
  id: 'deep-dive',
  depth: 1,
  ray: (c) => ({
    keys: [{ f: 0, ...SPOT.perchBL }, swim(40, 'deep'), swim(c.span.duration, 'deep')],
    moods: [
      { f: 0, mood: 'happy' },
      { f: c.at('dive', 'What'), mood: 'idle' },
      { f: c.at('dive-1', 'tenant'), mood: 'happy' },
      { f: c.beat('dive-2').from, mood: 'idle' },
      { f: c.beat('dive-4b').from, mood: 'happy' },
      { f: c.at('dive-5', 'Connectors'), mood: 'idle' },
      { f: c.at('dive-7', 'decides'), mood: 'happy' },
    ],
    rolls: [10],
    hops: [c.at('dive-1', 'tenant'), c.at('dive-4b', 'approve'), c.at('dive-7', 'gets')],
    gaze: [
      [0, -0.4, -0.4],
      [c.at('dive', 'What'), -1, -0.6],
      [c.beat('dive-2').from, -1, -0.8],
      [c.at('dive-2', 'SQL'), -1, -0.3],
      [c.beat('dive-3').from, -0.6, -0.4],
      [c.beat('dive-4').from, -1, -0.5],
      [c.beat('dive-5').from, -0.2, -1],
      [c.beat('dive-6').from, -0.3, -0.3],
      [c.beat('dive-7').from, -1, -0.2],
    ],
  }),
  sfx: (c) => [
    { f: 0, id: 'dive', volume: 0.55 },
    { f: c.at('dive', 'What'), id: 'sonar', volume: 0.3 },
    { f: c.at('dive-1', 'rayfin'), id: 'pop', volume: 0.4 },
    { f: c.at('dive-1', 'sets'), id: 'swim-whoosh', volume: 0.35 },
    { f: c.at('dive-1', 'tenant'), id: 'chime', volume: 0.35 },
    ...(['static', 'web', 'Data', 'SQL'] as const).map((w) => ({ f: c.at('dive-2', w), id: 'pop' as const, volume: 0.45 })),
    { f: c.at('dive-3', 'Functions'), id: 'pop', volume: 0.45 },
    { f: c.at('dive-3', 'blob'), id: 'pop', volume: 0.45 },
    { f: c.beat('dive-4').from - 2, id: 'swim-whoosh', volume: 0.3 },
    { f: c.at('dive-4', 'brokers'), id: 'chime', volume: 0.3 },
    { f: c.at('dive-4', 'Entra'), id: 'pop', volume: 0.45 },
    { f: c.at('dive-4b', 'identity'), id: 'pop', volume: 0.45 },
    { f: c.at('dive-4b', 'Entra'), id: 'pop', volume: 0.45 },
    { f: c.beat('dive-5').from - 12, id: 'shimmer', volume: 0.3 },
    { f: c.at('dive-5', 'Connectors'), id: 'sonar', volume: 0.3 },
    { f: c.at('dive-5', 'outside'), id: 'sweep', volume: 0.3 },
    ...(['warehouse', 'database', 'Lakehouse', 'semantic'] as const).map((w) => ({ f: c.at('dive-5', w), id: 'pop' as const, volume: 0.35 })),
    { f: c.at('dive-6', 'Microsoft'), id: 'pop', volume: 0.45 },
    { f: c.at('dive-6', 'web'), id: 'pop', volume: 0.45 },
    { f: c.at('dive-6', 'secret'), id: 'click', volume: 0.45 },
    { f: c.at('dive-7', 'rayfin.yml'), id: 'pop', volume: 0.5 },
    { f: c.at('dive-7', 'decides'), id: 'click', volume: 0.45 },
    { f: c.at('dive-7', 'gets'), id: 'chime', volume: 0.4 },
  ],
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const C = useTheme();
    const end = ctx.span.duration - 14;
    const A = (line: string, word: string, nth?: number) => ctx.at(line, word, nth);
    const appAt = A('dive-1', 'Fabric') - 4;
    const unpack = ramp(frame, A('dive-1', 'sets'), 16, ease.inOut);
    const outside = A('dive-5', 'outside') - 2;
    const settled = ctx.beat('dive-5').from;
    const decides = A('dive-7', 'decides');
    const solid = alpha(C.accent, 0.75);
    const dashed = alpha(C.accent2, 0.85);
    const fnGlow = ramp(frame, A('dive-6', 'functions'), 8) * (1 - ramp(frame, A('dive-6', 'Microsoft') + 6, 12));
    const item = (text: string, f: number) => (
      <Pill at={f} size={24} accent={C.accent2}>
        {text}
      </Pill>
    );
    const source = (k: keyof typeof SRC, icon: IconName, title: string, from: number, body: ReactNode) => (
      <OutsideTile key={k} x={OUT.x} y={SRC[k].y} w={SRC_W} h={SRC[k].h} icon={icon} title={title} at={from - 2}>
        {body}
      </OutsideTile>
    );
    const resources = A('dive-6', 'resources');
    return (
      <AbsoluteFill style={{ opacity: fadeOut(frame, ctx.span.duration, 12) }}>
        <DeepDiveTitle from={ctx.lead} to={end} subtitle="How a Fabric app runs" tuckAt={A('dive', 'What')} />
        <DepthGauge from={0} to={ctx.span.duration - 20} />
        <Zone {...FAB} icon="cloud" title="Your Fabric app" at={appAt} color={C.accent} glow={ramp(frame, A('dive-1', 'tenant'), 10) * (1 - ramp(frame, ctx.beat('dive-2').from, 16))}>
          <span style={{ fontWeight: 600, color: C.inkDim, opacity: ramp(frame, A('dive-1', 'tenant'), 10) }}>· inside your tenant</span>
        </Zone>
        <div style={{ position: 'absolute', left: FAB.x, top: FAB.y, transform: `translate(-50%, -50%) scale(${(1 + 0.4 * unpack) * Math.min(1, ramp(frame, A('dive-1', 'packages') - 4, 10) * 1.2)})`, opacity: ramp(frame, A('dive-1', 'packages') - 4, 10) * (1 - unpack), display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
          <Icon name="folder" color={C.accent2} size={120} stroke={1.6} />
          <div style={{ fontFamily: MONO, fontSize: 40, color: C.ink }}>{TREE.root}</div>
        </div>
        <CommandPill cmd="rayfin up" x={FAB.x} y={FAB.y - 160} from={A('dive-1', 'rayfin') - 4} until={A('dive-1', 'sets') + 6} />
        <Beam from={EDGE('static', NODE.w / 2, 0)} to={EDGE('web', -NODE.w / 2, 0)} at={A('dive-2', 'web')} color={solid} />
        <Beam from={EDGE('web', -100, NODE.h / 2)} to={EDGE('dab', 100, -NODE.h / 2)} at={A('dive-2', 'Data')} color={solid} />
        <Beam from={EDGE('dab', 0, NODE.h / 2)} to={EDGE('sql', 0, -NODE.h / 2)} at={A('dive-2', 'SQL')} color={solid} />
        <Beam from={EDGE('web', 80, NODE.h / 2)} to={EDGE('fn', -60, -NODE.h / 2)} at={A('dive-3', 'Functions')} color={solid} />
        <Beam from={EDGE('fn', -120, NODE.h / 2)} to={EDGE('sql', NODE.w / 2, 0)} at={A('dive-3', 'server')} color={solid} />
        <Beam from={EDGE('web', -30, NODE.h / 2)} to={EDGE('blob', 20, -NODE.h / 2)} at={A('dive-3', 'blob')} color={solid} />
        <Node k="static" icon="browser" label="Static content" sub="Your frontend" at={A('dive-2', 'static') - 2} />
        <Node k="web" icon="server" label="Web service" at={A('dive-2', 'web') - 2} />
        <Node k="dab" icon="api" label="Data API Builder" at={A('dive-2', 'Data') - 2} />
        <Node k="sql" icon="database" label="SQL database" at={A('dive-2', 'SQL') - 2} />
        <Node k="fn" icon="functions" label="Functions" sub="On the server" at={A('dive-3', 'Functions') - 2} glow={fnGlow} />
        <Node k="blob" icon="storage" label="Blob storage" sub="Your app’s files" at={A('dive-3', 'blob') - 2} />
        <Node k="signin" icon="shield" label="Sign-in" sub="Brokered by Fabric" at={settled - 4} color={C.ok} glow={ramp(frame, settled - 4, 6) * (1 - ramp(frame, settled + 16, 20))} />
        <SignInCallout
          from={ctx.beat('dive-4').from - 2}
          to={settled}
          termAt={A('dive-4', 'brokers')}
          rows={[
            { text: 'The Entra account people use for Fabric', at: A('dive-4', 'Entra') },
            { text: 'No identity provider to run', at: A('dive-4b', 'identity') },
            { text: 'No Entra app to register or approve', at: A('dive-4b', 'Entra') },
          ]}
        />
        <Zone {...OUT} icon="link" title="Outside the app" at={outside} color={C.accent2} />
        <Beam from={EDGE('web', NODE.w / 2, 10)} to={INTO('data')} at={A('dive-5', 'Connectors') - 2} color={dashed} dashed />
        <Chip x={1200} y={318} from={A('dive-5', 'reach')} to={end} size={24} accent={C.accent2}>
          connectors
        </Chip>
        {source(
          'data',
          'layers',
          'Data already in Fabric',
          A('dive-5', 'Fabric'),
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {item('Warehouse', A('dive-5', 'warehouse'))}
            {item('SQL database', A('dive-5', 'database'))}
            {item('Lakehouse SQL', A('dive-5', 'Lakehouse'))}
            {item('Semantic model', A('dive-5', 'semantic'))}
          </div>,
        )}
        <Beam from={EDGE('fn', NODE.w / 2, -10)} to={INTO('ms', -20)} at={A('dive-6', 'Microsoft') - 2} color={dashed} dashed />
        {source(
          'ms',
          'cloud',
          'Microsoft resources',
          A('dive-6', 'Microsoft'),
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {item('OneLake', resources)}
              {item('Fabric REST', resources + 4)}
              {item('Azure AI Foundry', resources + 8)}
            </div>
            <Pill at={A('dive-6', 'identity')} size={24} accent={C.ok}>
              <Icon name="user" color={C.ok} size={22} /> with the app’s identity
            </Pill>
          </div>,
        )}
        <Beam from={EDGE('fn', NODE.w / 2, 15)} to={INTO('api')} at={A('dive-6', 'web') - 2} color={dashed} dashed />
        {source(
          'api',
          'hosting',
          'Any web API',
          A('dive-6', 'web'),
          <div style={{ display: 'flex' }}>
            <Pill at={A('dive-6', 'secret')} size={24} accent={C.star}>
              <Icon name="key" color={C.star} size={22} /> with a secret
            </Pill>
          </div>,
        )}
        <div style={{ position: 'absolute', left: 0, right: 0, top: 985, textAlign: 'center', fontFamily: FONT, fontSize: 24, color: C.inkDim, opacity: ramp(frame, A('dive-3', 'Functions') + 10, 12) * fadeOut(frame, end + 12, 12) }}>
          Functions aren’t available in every Fabric region or tenant.
        </div>
        <Chip x={FAB.x} y={905} from={A('dive-7', 'rayfin.yml') - 2} to={end} size={30} accent={C.ok}>
          <span>
            <Mono>rayfin/rayfin.yml</Mono> turns them on
          </span>
        </Chip>
        {(['static', 'dab', 'sql', 'fn', 'blob', 'signin'] as const).map((k, i) => (
          <OnBadge key={k} x={N[k].x + NODE.w / 2 - 34} y={N[k].y - NODE.h / 2} at={decides + i * 2} />
        ))}
        {(['data'] as const).map((k, i) => (
          <OnBadge key={k} x={OUT.x + SRC_W / 2 - 34} y={SRC[k].y - SRC[k].h / 2} at={decides + 12 + i * 2} />
        ))}
        <Sonar x={FAB.x} y={905} at={A('dive-7', 'rayfin.yml')} size={420} rings={2} color={alpha(C.ok, 0.6)} />
        <Burst kind="sparkles" at={A('dive-7', 'gets')} x={FAB.x} y={428} count={14} seed={71} spread={2.4} />
      </AbsoluteFill>
    );
  },
};

/** A source outside the app: a titled card with what's in it. */
function OutsideTile({ x, y, w, h, icon, title, at: from, children }: { x: number; y: number; w: number; h: number; icon: IconName; title: string; at: number; children?: ReactNode }): JSX.Element | null {
  const C = useTheme();
  const show = useShow(from);
  if (!show) return null;
  const { p } = show;
  return (
    <div style={{ position: 'absolute', left: x - w / 2, top: y - h / 2, width: w, height: h, borderRadius: 22, background: C.panel.tile, border: `2px solid ${alpha(C.accent2, 0.55)}`, boxShadow: `${C.shadow.tile}, ${C.glow(alpha(C.accent2, 0.2), 24)}`, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 10, padding: '0 20px', opacity: Math.min(1, p * 1.5), transform: `translateX(${(1 - p) * 40}px) scale(${0.9 + 0.1 * p})` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontFamily: FONT, fontWeight: 750, fontSize: 30, color: C.ink, whiteSpace: 'nowrap' }}>
        <Icon name={icon} color={C.accent2} size={36} />
        {title}
      </div>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */
/*                                  8. See it in Fabricator                                   */
/* ------------------------------------------------------------------------------------------ */

const fabricator: LessonScene = {
  id: 'fabricator',
  dim: 0.35,
  ray: (c) => ({
    keys: [{ f: 0, ...SPOT.deep }, swim(30, 'fabricator'), swim(c.span.duration, 'fabricator')],
    moods: [
      { f: 0, mood: 'happy' },
      { f: 30, mood: 'idle' },
      { f: c.at('fab-2', 'always'), mood: 'happy' },
      { f: c.beat('fab-3').from, mood: 'idle' },
      { f: c.at('fab-3', 'Secrets'), mood: 'happy' },
      { f: c.beat('fab-4').from, mood: 'idle' },
    ],
    hops: [c.at('fab-2', 'always'), c.at('fab-3', 'Secrets') + 4],
    gaze: [
      [0, -0.6, -0.4],
      [30, -1, 0.2],
      [c.at('fab-2', '.agents'), -0.4, 0.9],
      [c.at('fab-2', "Rayfin's"), -1, -0.2],
      [c.beat('fab-3').from, -1, 0.3],
      [c.beat('fab-4').from, -0.6, 0.2],
    ],
  }),
  sfx: (c) => [
    { f: 0, id: 'surface', volume: 0.5 },
    { f: c.at('fab-1', 'Code'), id: 'click', volume: 0.5 },
    { f: c.at('fab-1', 'packages'), id: 'pop', volume: 0.4 },
    { f: c.beat('fab-2').from, id: 'swim-whoosh', volume: 0.3 },
    { f: c.at('fab-2', 'Skills'), id: 'click', volume: 0.5 },
    { f: c.at('fab-2', '.agents'), id: 'pop', volume: 0.4 },
    { f: c.at('fab-2', 'always'), id: 'pop', volume: 0.4 },
    { f: c.beat('fab-3').from, id: 'swim-whoosh', volume: 0.3 },
    ...(['Website', 'Sign-in', 'Database', 'File', 'Connectors', 'Functions', 'Secrets'] as const).map((w) => ({ f: c.at('fab-3', w), id: 'pop' as const, volume: 0.32 })),
    { f: c.at('fab-4', 'Lines'), id: 'sweep', volume: 0.3 },
    { f: c.at('fab-4', 'identity'), id: 'pop', volume: 0.4 },
  ],
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const C = useTheme();
    const end = ctx.span.duration - 14;
    const b = (id: string) => ctx.beat(id).from;
    const A = (line: string, word: string) => ctx.at(line, word);
    const code = windowLife(frame, fps, ctx.lead, b('fab-2'));
    const skills = windowLife(frame, fps, b('fab-2'), b('fab-3'));
    const blueprint = windowLife(frame, fps, b('fab-3'), end);
    const on = (from: number, to?: number) => ramp(frame, from - 2, 6) * (to === undefined ? 1 : 1 - ramp(frame, to - 2, 6));
    const files = A('fab-1', 'files');
    const codeCam = {
      zoom: track(frame, [
        [files - 10, 1],
        [files + 8, 1.9],
      ]),
      fx: track(frame, [
        [files - 10, 800],
        [files + 8, 300],
      ]),
      fy: track(frame, [
        [files - 10, 500],
        [files + 8, 330],
      ]),
    };
    const agents = A('fab-2', '.agents');
    const own = A('fab-2', "Rayfin's");
    const skillsCam = {
      zoom: track(frame, [
        [agents - 10, 1],
        [agents + 8, 2.1],
        [own - 6, 2.1],
        [own + 14, 1.3],
      ]),
      fx: track(frame, [
        [agents - 10, 800],
        [agents + 8, 1415],
        [own - 6, 1415],
        [own + 14, 610],
      ]),
      fy: track(frame, [
        [agents - 10, 500],
        [agents + 8, 960],
        [own - 6, 960],
        [own + 14, 140],
      ]),
    };
    const website = A('fab-3', 'Website');
    const lines = A('fab-4', 'Lines');
    const bpCam = {
      zoom: track(frame, [
        [website - 10, 1],
        [website + 8, 1.55],
        [lines - 8, 1.55],
        [lines + 12, 1.25],
      ]),
      fx: track(frame, [
        [website - 10, 800],
        [website + 8, 724],
        [lines - 8, 724],
        [lines + 12, 900],
      ]),
      fy: track(frame, [
        [website - 10, 500],
        [website + 8, 548],
        [lines - 8, 548],
        [lines + 12, 495],
      ]),
    };
    const pieces = [
      ['Website', PX.bpWebsite],
      ['Sign-in', PX.bpSignin],
      ['Database', PX.bpDatabase],
      ['File', PX.bpStorage],
      ['Connectors', PX.bpConnectors],
      ['Functions', PX.bpFunctions],
      ['Secrets', PX.bpSecrets],
    ] as const;
    return (
      <AbsoluteFill>
        <ChapterTag text="See it in Fabricator" from={ctx.lead} to={end} />
        {code ? (
          <AppWindow shot={CODE_VIEW} x={960} y={FAB_WINDOW.y} width={FAB_WINDOW.width} {...codeCam} opacity={code.opacity} scale={code.scale}>
            <Spotlight {...PX.tree} radius={10} dim={0.45} opacity={on(files, A('fab-1', 'packages'))} />
            <Spotlight {...PX.treePackages} radius={10} dim={0.45} opacity={on(A('fab-1', 'packages'))} />
          </AppWindow>
        ) : null}
        {skills ? (
          <AppWindow shot={SKILLS_VIEW} x={960} y={FAB_WINDOW.y} width={FAB_WINDOW.width} {...skillsCam} opacity={skills.opacity} scale={skills.scale}>
            <Spotlight {...PX.skillsHeader} radius={10} dim={0.45} opacity={on(A('fab-2', 'Skills'), agents)} />
            <Spotlight {...PX.skillsFile} radius={10} dim={0.45} opacity={on(agents, own)} />
            <Spotlight {...PX.skillsAlways} radius={14} dim={0.45} opacity={on(A('fab-2', 'always'))} />
          </AppWindow>
        ) : null}
        {blueprint ? (
          <AppWindow shot={SHOTS.blueprint} x={960} y={FAB_WINDOW.y} width={FAB_WINDOW.width} {...bpCam} opacity={blueprint.opacity} scale={blueprint.scale}>
            <Patch {...PX.bpExperimental} color={C.name === 'dark' ? '#131620' : '#ffffff'} />
            {pieces.map(([word, px], i) => (
              <Spotlight key={word} {...px} radius={12} dim={0.45} opacity={on(A('fab-3', word), i + 1 < pieces.length ? A('fab-3', pieces[i + 1][0]) : lines)} />
            ))}
            <Spotlight {...PX.bpSources} radius={14} dim={0.4} opacity={on(lines + 4, A('fab-4', 'identity'))} />
            <Spotlight {...PX.bpIdentities} radius={10} dim={0.45} opacity={on(A('fab-4', 'identity'))} />
          </AppWindow>
        ) : null}
        <Chip x={960} y={1018} from={A('fab-2', "Rayfin's")} to={b('fab-3') - 4} size={28} accent={C.accent2}>
          Always on: Rayfin’s own skills, installed and updated by the Rayfin CLI
        </Chip>
      </AbsoluteFill>
    );
  },
};

/* ------------------------------------------------------------------------------------------ */
/*                                       9. Pop quiz                                          */
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
      question="Which file records where you deployed, and stays out of git?"
      options={[
        { text: '.deployments.json', code: true, at: ctx.at('quiz-options', 'A') },
        { text: 'rayfin.yml', code: true, at: ctx.at('quiz-options', 'B') },
        { text: 'package.json', code: true, at: ctx.at('quiz-options', 'C') },
      ]}
      answer={0}
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
    hops: [c.w('packages'), c.w('lists'), c.w('runs')],
    gaze: [
      [0, -0.6, 0.6],
      [30, -0.9, -0.7],
    ],
  }),
  sfx: (c) => ['packages', 'lists', 'runs'].map((w) => ({ f: c.w(w) + 6, id: 'stamp' as const, volume: 0.4 })),
  View: ({ ctx }) => (
    <Recap
      from={ctx.lead}
      to={ctx.span.duration - 14}
      items={[
        { text: 'Your code lives in packages: frontend, data and shared', at: ctx.w('packages') },
        {
          text: (
            <span>
              <Mono>rayfin.yml</Mono> lists your services
            </span>
          ),
          at: ctx.w('lists'),
        },
        { text: 'Fabric runs them all as one Fabric app', at: ctx.w('runs') },
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
    const back = c.wEnd('me') + 8;
    return {
      keys: [{ f: 0, ...SPOT.end }, swim(20, 'fact', ease.out), swim(back, 'fact'), swim(back + 22, 'end'), swim(c.span.duration, 'end')],
      moods: [
        { f: 0, mood: 'idle' },
        { f: c.w('sense'), mood: 'surprised' },
        { f: c.w('sand'), mood: 'idle' },
        { f: c.w('So'), mood: 'happy' },
      ],
      rolls: [c.w('hidden') - 2],
      squishes: [c.w('hide'), c.wEnd('me') + 2],
      waves: [back + 24],
      gaze: [
        [0, 0, 0.1],
        [c.w('sense'), 0.5, 0.4],
        [c.w('sand'), 0, 0.9],
        [c.w('So'), 0, 0.1],
      ],
    };
  },
  sfx: (c) => [
    { f: 2, id: 'swim-whoosh', volume: 0.3 },
    { f: c.w('electric'), id: 'sonar', volume: 0.3 },
    { f: c.w('sand'), id: 'bubbles', volume: 0.3 },
    { f: c.w('hidden') - 2, id: 'swim-whoosh', volume: 0.25 },
    { f: c.w('hide'), id: 'boing', volume: 0.35 },
    { f: c.wEnd('me') + 8, id: 'swim-whoosh', volume: 0.3 },
  ],
  View: ({ ctx }) => (
    <AbsoluteFill>
      <TheEnd from={-400} to={ctx.span.duration + 400} />
      <Chip x={SPOT.fact.x} y={430} from={10} to={ctx.wEnd('me') + 6} accent="#ffb547" size={26}>
        RAY FACT
      </Chip>
      <Sonar x={SPOT.fact.x} y={SPOT.fact.y + 70} at={ctx.w('electric')} size={340} rings={3} />
      <Burst kind="bubbles" at={ctx.w('sand')} x={SPOT.fact.x} y={SPOT.fact.y + 80} count={10} seed={93} />
    </AbsoluteFill>
  ),
};

/** Lesson 3's scenes, in the script's order. */
export const SCENES: readonly LessonScene[] = [coldOpen, bumper, welcome, packages, config, files, deepDive, fabricator, quiz, recap, challenge, next, stinger];
