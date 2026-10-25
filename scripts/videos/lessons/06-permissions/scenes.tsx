import type { ReactNode } from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { ease, fadeOut, pop, ramp, track } from '../../src/anim';
import { Burst } from '../../src/fx/Burst';
import {
  ArtifactCard,
  CODE_PALETTES,
  Challenge,
  ChapterTag,
  CodeCard,
  DeepDiveTitle,
  DepthGauge,
  EndScreen,
  Icon,
  Objectives,
  Quiz,
  Recap,
  SeriesBumper,
  Sonar,
  at,
  locate,
  tokenize,
  type IconName,
} from '../../src/lesson-kit';
import { colorOf, type Token } from '../../src/lesson-kit/code';
import type { RayKey } from '../../src/ray/RayActor';
import type { LessonCtx, LessonScene } from '../../src/show/types';
import type { Shot } from '../../src/shots';
import { FONT, MONO, alpha, useTheme } from '../../src/theme';
import { AppWindow, Spotlight, onScreen } from '../../src/ui/AppWindow';
import { Chip } from '../../src/ui/Kit';
import { SERIES } from '../series';
import { SCRIPT } from './script';
import { SNIPPETS, lineWith, lines } from './snippets';
import { YOUTUBE } from './youtube';

/** Where Ray is when one scene hands him to the next. */
const SPOT = {
  hook: { x: 960, y: 990, s: 0.44 },
  welcome: { x: 960, y: 560, s: 1 },
  today: { x: 330, y: 600, s: 0.85 },
  perchBL: { x: 150, y: 965, s: 0.4 },
  perchBR: { x: 1835, y: 985, s: 0.36 },
  deep: { x: 1835, y: 1000, s: 0.36 },
  fabricator: { x: 1815, y: 175, s: 0.4 },
  quiz: { x: 1700, y: 260, s: 0.5 },
  recap: { x: 1785, y: 945, s: 0.42 },
  challenge: { x: 1620, y: 560, s: 0.8 },
  end: { x: 1500, y: 250, s: 0.5 },
  fact: { x: 1155, y: 600, s: 0.6 },
} as const;

const swim = (f: number, spot: keyof typeof SPOT, e = ease.inOut): RayKey => at(f, SPOT[spot], e);

const RED = '#ff6b81';
const AMBER = '#ffb547';

/* ------------------------------------------------------------------------------------------ */
/*                                   Code and sample data                                     */
/* ------------------------------------------------------------------------------------------ */

/** Part of a snippet, as a scene shows it: it must be in the snippet, word for word. */
function fragment(key: keyof typeof SNIPPETS, text: string): string {
  if (!SNIPPETS[key].code.includes(text)) throw new Error(`"${text}" isn't in snippet ${key}.`);
  return text;
}

/** Columns `from` to `to` of the first `text` in `code`, for a mark on a one-line pill. */
function span(code: string, text: string): { from: number; to: number } {
  const from = code.indexOf(text);
  if (from < 0) throw new Error(`"${text}" isn't in "${code}".`);
  return { from, to: from + text.length };
}

const EXPENSE = SNIPPETS.expense.code;
/** Expense from `@entity()` to `export class Expense {`: the decorators. */
const HEAD_FROM = locate(EXPENSE, '@entity()').line;
const HEAD_TO = locate(EXPENSE, 'export class Expense {').line;
const HEAD = lines('expense', HEAD_FROM, HEAD_TO);
const BARE = SNIPPETS.bare.code;
const BARE_FROM = locate(BARE, '@entity()').line;
const BARE_CLASS = lines('bare', BARE_FROM, BARE.split('\n').length);
const CREATE = SNIPPETS.create.code;
const CREATE_FROM = locate(CREATE, 'export async function addExpense').line;
const CREATE_FN = lines('create', CREATE_FROM, CREATE.split('\n').length);

const SHORTHAND = lineWith('expense', "@authenticated('*', {");
const ROLE_SRC = SNIPPETS.roleForm.code;
/** roleForm from `@entity()` to `export class Expense {`, as lessons 4 and 5 wrote it. */
const ROLE_HEAD = lines('roleForm', locate(ROLE_SRC, '@entity()').line, locate(ROLE_SRC, 'export class Expense {').line);
const STAR = fragment('grants', "@authenticated('*')");
const SOME = fragment('grants', "@authenticated(['create', 'read'])");
const ANON = fragment('grants', "@anonymous('read')");
const POLICY = lineWith('expense', 'policy:');
const TYPO = lineWith('claims', 'eq(item.ownr_id)');
const MINE = fragment('filter', "client.data.Expense.select(['note', 'amount']).where({ owner_id: { eq: me } }).execute()");
const EVERYONE = fragment('filter', "client.data.Expense.select(['note', 'amount', 'owner_id']).execute()");

/** The two people in the lesson, and their IDs as a table shows them (shortened). */
const AVERY = { name: 'Avery', color: '#46ccb0', id: 'd7d5…' } as const;
const BLAKE = { name: 'Blake', color: '#f78fb3', id: 'c554…' } as const;
type Who = typeof AVERY | typeof BLAKE;

/** Their expenses. */
const ROWS: ReadonlyArray<{ note: string; amount: string; owner: Who }> = [
  { note: 'Taxi', amount: '18.20', owner: AVERY },
  { note: 'Team lunch', amount: '42.50', owner: BLAKE },
  { note: 'Hotel', amount: '240.00', owner: AVERY },
  { note: 'Parking', amount: '9.00', owner: BLAKE },
];

/** What the claims proxy offers, and Expense's fields: the completions ro-4 shows. */
const CLAIMS = ['sub', 'email', 'role'] as const;
const FIELDS = ['id', 'spentOn', 'amount', 'category', 'note', 'createdAt', 'owner_id'] as const;
for (const f of FIELDS) if (!new RegExp(`\\b${f}[!?]:`).test(EXPENSE)) throw new Error(`${f} isn't a field of snippets.expense.`);

/** The four actions, in the order Ray names them, with an icon each. */
const ACTIONS: ReadonlyArray<{ name: string; icon: IconName }> = [
  { name: 'create', icon: 'plus' },
  { name: 'read', icon: 'eye' },
  { name: 'update', icon: 'pencil' },
  { name: 'delete', icon: 'trash' },
];

/**
 * What Fabricator's Harden sends to the chat: ModelView.tsx's `onSendToChat(\`Harden access on
 * ${entity.name}\`, prompt)`. The prompt asks for a row-level policy and leaves deploying to
 * Fabricator.
 */
const HARDEN_TITLE = 'Harden access on Report';
/** The tenant setting the permissions page names. */
const ANON_SWITCH = 'Enable anonymous data access for Fabric Apps';

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

/** 0→1 over a few frames from `from`, and back to 0 from `to`: how lit something is. */
function lit(frame: number, from: number, to?: number): number {
  return ramp(frame, from - 2, 8) * (to === undefined ? 1 : 1 - ramp(frame, to - 2, 8));
}

/** How something pops in at `from` and leaves at `until`: null while it's away. */
function life(frame: number, fps: number, from: number, until?: number): { p: number; out: number } | null {
  if (frame < from || (until !== undefined && frame > until + 12)) return null;
  return { p: pop(frame, fps, from, 12, 0.6), out: until === undefined ? 1 : 1 - ramp(frame, until, 12, ease.in) };
}

/** A small shake after `at`, in pixels. */
function shake(frame: number, at: number | undefined, size = 8): number {
  return at !== undefined && frame >= at && frame < at + 14 ? Math.sin((frame - at) * 2.4) * size * (1 - (frame - at) / 14) : 0;
}

/** Code in running text. */
const Mono = ({ children }: { children: ReactNode }) => <span style={{ fontFamily: MONO, fontWeight: 500 }}>{children}</span>;

/** A line from one point to another that draws itself on. */
function Beam({ from, to, at: start, color, width = 4, until, bend = 0, dashed }: { from: readonly [number, number]; to: readonly [number, number]; at: number; color: string; width?: number; until?: number; bend?: number; dashed?: boolean }): JSX.Element | null {
  const frame = useCurrentFrame();
  const p = ramp(frame, start, 14, ease.out);
  if (p <= 0 || (until !== undefined && frame > until + 12)) return null;
  const out = until === undefined ? 1 : 1 - ramp(frame, until, 12, ease.in);
  const [x1, y1] = from;
  const [x2, y2] = to;
  const d = `M ${x1} ${y1} Q ${(x1 + x2) / 2} ${(y1 + y2) / 2 - bend} ${x2} ${y2}`;
  const id = `m-${Math.round(x1)}-${Math.round(y1)}-${Math.round(x2)}-${Math.round(y2)}`;
  return (
    <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0, overflow: 'visible', opacity: out }}>
      {dashed ? (
        <>
          <mask id={id}>
            <path d={d} fill="none" stroke="#fff" strokeWidth={width + 4} pathLength={1} strokeDasharray={`${p} 1`} />
          </mask>
          <path d={d} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeDasharray="10 12" mask={`url(#${id})`} />
        </>
      ) : (
        <path d={d} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" pathLength={1} strokeDasharray={`${p} 1`} />
      )}
    </svg>
  );
}

/** A box around columns of a one-line pill, with an optional label under it. */
interface PillMark {
  from: number;
  to: number;
  at: number;
  until?: number;
  color?: string;
  label?: ReactNode;
  /** A wavy underline instead of a box: a compile error. */
  squiggle?: boolean;
}

/**
 * One line of code in the editor's colors, in a glowing pill. It turns green at `ok` and red,
 * with a shake, at `bad`. `marks` ring parts of it, in columns.
 */
function CodeLine({ code, x, y, size = 40, from, until, ok, bad, label, labelColor, marks = [], dim = 0 }: { code: string; x: number; y: number; size?: number; from: number; until?: number; ok?: number; bad?: number; label?: ReactNode; labelColor?: string; marks?: readonly PillMark[]; dim?: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  const P = CODE_PALETTES[C.name];
  const l = life(frame, fps, from, until);
  if (!l) return null;
  // Whichever cue came last decides the color: a line can go red, then green once it's fixed.
  const badOn = bad !== undefined && frame >= bad;
  const okOn = ok !== undefined && frame >= ok;
  const isBad = badOn && !(okOn && ok! > bad!);
  const isOk = okOn && !isBad;
  const ring = isBad ? RED : isOk ? C.ok : C.accent2;
  const tokens: readonly Token[] = tokenize(code)[0] ?? [];
  return (
    <div style={{ position: 'absolute', left: x, top: y, transform: `translate(calc(-50% + ${shake(frame, isBad ? bad : undefined)}px), -50%) scale(${0.7 + 0.3 * l.p})`, opacity: Math.min(1, l.p * 1.5) * l.out * (1 - 0.6 * dim) }}>
      <div style={{ display: 'flex', alignItems: 'baseline', padding: `${size * 0.4}px ${size * 0.66}px`, borderRadius: size * 0.42, background: P.bg, border: `3px solid ${alpha(ring, 0.85)}`, boxShadow: `${C.shadow.panel}, ${C.glow(alpha(ring, isBad || isOk ? 0.5 : 0.28), 36, 3)}`, fontFamily: MONO, fontSize: size, whiteSpace: 'pre' }}>
        <span style={{ position: 'relative' }}>
          {tokens.map((t, i) => (
            <span key={i} style={{ color: colorOf(t, P) }}>
              {t.text}
            </span>
          ))}
          {marks.map((m, i) => {
            const o = m.squiggle ? ramp(frame, m.at, 10) * (m.until === undefined ? 1 : 1 - ramp(frame, m.until, 8)) : lit(frame, m.at, m.until);
            if (o <= 0) return null;
            const color = m.color ?? C.accent;
            const box = m.squiggle
              ? { top: '1.05em', height: '0.32em', border: 'none', background: `repeating-linear-gradient(135deg, ${color} 0 3px, transparent 3px 7px)`, boxShadow: 'none', borderRadius: 2 }
              : { top: '-0.18em', height: '1.36em', border: `3px solid ${color}`, background: alpha(color, 0.14), boxShadow: C.glow(alpha(color, 0.45), 18, 2), borderRadius: 10 };
            return (
              <span key={i} style={{ position: 'absolute', left: `calc(${m.from}ch - 6px)`, width: `calc(${m.to - m.from}ch + 12px)`, opacity: o, ...box }}>
                {m.label ? (
                  <span style={{ position: 'absolute', left: '50%', top: m.squiggle ? '0.6em' : '100%', transform: 'translateX(-50%)', marginTop: size * 0.5, fontFamily: FONT, fontWeight: 650, fontSize: Math.max(24, size * 0.8), color, whiteSpace: 'nowrap' }}>{m.label}</span>
                ) : null}
              </span>
            );
          })}
        </span>
      </div>
      {label ? (
        <div style={{ position: 'absolute', left: '50%', top: '100%', transform: 'translateX(-50%)', marginTop: 12, fontFamily: FONT, fontWeight: 650, fontSize: Math.max(24, size * 0.72), color: labelColor ?? ring, whiteSpace: 'nowrap' }}>{label}</div>
      ) : null}
    </div>
  );
}

/** Rows that pop in on their cues: a check for what holds, a cross for what's turned away. */
function RuleList({ items, size = 28 }: { items: ReadonlyArray<{ text: ReactNode; at: number; bad?: boolean }>; size?: number }): JSX.Element {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {items.map((item, i) => {
        const p = frame < item.at ? 0 : pop(frame, fps, item.at, 11, 0.6);
        const color = item.bad ? RED : C.ok;
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 14, opacity: Math.min(1, p * 1.5), transform: `translateX(${(1 - p) * 30 + (item.bad ? shake(frame, item.at, 7) : 0)}px)`, padding: '8px 14px', borderRadius: 12, background: alpha(color, 0.1), border: `1.5px solid ${alpha(color, 0.45)}` }}>
            <div style={{ width: size * 1.25, height: size * 1.25, flex: 'none', borderRadius: '50%', display: 'grid', placeItems: 'center', background: alpha(color, 0.2) }}>
              <Icon name={item.bad ? 'x' : 'check'} color={color} size={size * 0.9} stroke={3} />
            </div>
            <span style={{ fontFamily: FONT, fontWeight: 650, fontSize: size, color: C.ink, whiteSpace: 'nowrap' }}>{item.text}</span>
          </div>
        );
      })}
    </div>
  );
}

/** A pill: an icon and a few words, centered on a point. */
function Pill({ icon, color, children, x, y, from, until, glow = 0, size = 28 }: { icon: IconName; color: string; children: ReactNode; x: number; y: number; from: number; until?: number; glow?: number; size?: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  const l = life(frame, fps, from, until);
  if (!l) return null;
  return (
    <div style={{ position: 'absolute', left: x, top: y, transform: `translate(-50%, -50%) scale(${(0.7 + 0.3 * l.p) * (1 + 0.05 * glow)})`, opacity: Math.min(1, l.p * 1.5) * l.out, display: 'flex', alignItems: 'center', gap: 12, padding: `${size * 0.42}px ${size * 0.8}px`, borderRadius: 999, background: C.panel.bg, border: `2px solid ${alpha(color, 0.7 + 0.3 * glow)}`, boxShadow: `${C.shadow.chip}, ${C.glow(alpha(color, 0.2 + 0.45 * glow), 22, 2)}`, fontFamily: FONT, fontWeight: 650, fontSize: size, color: C.ink, whiteSpace: 'nowrap' }}>
      <Icon name={icon} color={color} size={size} stroke={2.2} />
      {children}
    </div>
  );
}

/** A person: their initial in a circle of their color, and their name. */
function Person({ who, x, y, from, until, size = 96, glow = 0, label }: { who: Who; x: number; y: number; from: number; until?: number; size?: number; glow?: number; label?: ReactNode }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  const l = life(frame, fps, from, until);
  if (!l) return null;
  return (
    <div style={{ position: 'absolute', left: x, top: y, transform: `translate(-50%, -50%) scale(${(0.6 + 0.4 * l.p) * (1 + 0.06 * glow)})`, opacity: Math.min(1, l.p * 1.5) * l.out, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
      <div style={{ width: size, height: size, borderRadius: '50%', display: 'grid', placeItems: 'center', background: `linear-gradient(140deg, ${who.color}, ${alpha(who.color, 0.65)})`, border: `3px solid ${alpha('#ffffff', 0.85)}`, boxShadow: `${C.shadow.chip}, ${C.glow(alpha(who.color, 0.35 + 0.4 * glow), 30, 3)}`, color: '#0b1220', fontFamily: FONT, fontWeight: 800, fontSize: size * 0.48 }}>{who.name.slice(0, 1)}</div>
      <div style={{ fontFamily: FONT, fontWeight: 750, fontSize: 30, color: C.ink, whiteSpace: 'nowrap' }}>{who.name}</div>
      {label ? <div style={{ fontFamily: FONT, fontWeight: 600, fontSize: 24, color: C.inkSoft, whiteSpace: 'nowrap' }}>{label}</div> : null}
    </div>
  );
}

/** One expense, as a row: its owner's dot, what it was, how much, and whose it is. */
function ExpenseRow({ row, x, y, from, until, width = 460, glow = 0, dim = 0, bad, ok, gone, note }: { row: (typeof ROWS)[number]; x: number; y: number; from: number; until?: number; width?: number; glow?: number; dim?: number; bad?: number; ok?: number; gone?: number; note?: ReactNode }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  const l = life(frame, fps, from, until);
  if (!l) return null;
  const isBad = bad !== undefined && frame >= bad;
  const isOk = ok !== undefined && frame >= ok && !isBad;
  const ring = isBad ? RED : isOk ? C.ok : row.owner.color;
  const g = gone === undefined ? 0 : ramp(frame, gone, 12, ease.in);
  const badge = isBad || isOk ? pop(frame, fps, isBad ? bad! : ok!, 10, 0.5) : 0;
  return (
    <div style={{ position: 'absolute', left: x, top: y, width, transform: `translate(calc(-50% + ${shake(frame, bad, 8)}px), -50%) scale(${(0.7 + 0.3 * l.p) * (1 + 0.05 * glow) * (1 - 0.15 * g)})`, opacity: Math.min(1, l.p * 1.5) * l.out * (1 - 0.7 * dim) * (1 - g), display: 'flex', alignItems: 'center', gap: 14, padding: '12px 18px', borderRadius: 16, background: C.panel.bg, border: `2px solid ${alpha(ring, 0.6 + 0.4 * glow)}`, boxShadow: `${C.shadow.chip}, ${C.glow(alpha(ring, 0.18 + 0.4 * glow), 22, 2)}` }}>
      <span style={{ width: 14, height: 14, borderRadius: '50%', background: row.owner.color, flex: 'none' }} />
      <span style={{ fontFamily: FONT, fontWeight: 650, fontSize: 28, color: C.ink, whiteSpace: 'nowrap' }}>{note ?? row.note}</span>
      <span style={{ flex: 1 }} />
      <span style={{ fontFamily: MONO, fontSize: 25, color: C.inkSoft }}>{row.amount}</span>
      <span style={{ fontFamily: FONT, fontWeight: 600, fontSize: 21, color: row.owner.color, minWidth: 64, textAlign: 'right' }}>{row.owner.name}</span>
      {badge > 0 ? (
        <span style={{ position: 'absolute', right: -18, top: -18, width: 40, height: 40, borderRadius: '50%', display: 'grid', placeItems: 'center', background: ring, transform: `scale(${badge})` }}>
          <Icon name={isBad ? 'x' : 'check'} color="#0b1220" size={26} stroke={3.2} />
        </span>
      ) : null}
    </div>
  );
}

/** An editor's completion list under `prefix.`: what the type offers, item by item. */
function Completion({ prefix, items, x, y, from, until, width = 380 }: { prefix: string; items: ReadonlyArray<{ text: string; at: number }>; x: number; y: number; from: number; until?: number; width?: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  const P = CODE_PALETTES[C.name];
  const l = life(frame, fps, from, until);
  if (!l) return null;
  return (
    <div style={{ position: 'absolute', left: x - width / 2, top: y, width, opacity: Math.min(1, l.p * 1.5) * l.out, transform: `scale(${0.85 + 0.15 * l.p})`, transformOrigin: '50% 0', fontFamily: MONO, fontSize: 30 }}>
      <div style={{ padding: '14px 20px', borderRadius: 14, background: P.bg, border: `2px solid ${alpha(C.accent2, 0.7)}`, whiteSpace: 'pre', boxShadow: C.shadow.panel }}>
        <span style={{ color: P.kinds.plain }}>{prefix}</span>
        <span style={{ color: P.kinds.punct }}>.</span>
        <span style={{ color: C.accent, opacity: Math.floor(frame / 8) % 2 === 0 ? 1 : 0.25 }}>▍</span>
      </div>
      <div style={{ marginTop: 8, borderRadius: 12, background: C.name === 'dark' ? '#1c2230' : '#ffffff', border: `1.5px solid ${P.border}`, boxShadow: C.shadow.chip, overflow: 'hidden' }}>
        {items.map((item) => {
          const p = ramp(frame, item.at, 8, ease.out);
          return (
            <div key={item.text} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '7px 18px', color: C.text, opacity: p, height: 46 * p, overflow: 'hidden', background: alpha(C.accent, 0.12 * lit(frame, item.at, item.at + 24)) }}>
              <span style={{ width: 24, height: 24, borderRadius: 6, display: 'grid', placeItems: 'center', background: alpha('#5ab0f7', 0.22), color: '#5ab0f7', fontSize: 16, fontFamily: FONT, fontWeight: 700 }}>◆</span>
              {item.text}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** An action a permission can grant, as a tile that lights up on its cue. */
function ActionTile({ name, icon, x, y, from, until, glow = 0 }: { name: string; icon: IconName; x: number; y: number; from: number; until?: number; glow?: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  const l = life(frame, fps, from, until);
  if (!l) return null;
  return (
    <div style={{ position: 'absolute', left: x - 120, top: y - 105, width: 240, height: 210, borderRadius: 24, background: C.panel.bg, border: `3px solid ${alpha(C.accent, 0.3 + 0.7 * glow)}`, boxShadow: `${C.shadow.panel}, ${C.glow(alpha(C.accent, 0.12 + 0.4 * glow), 34, 2 + 4 * glow)}`, opacity: Math.min(1, l.p * 1.5) * l.out, transform: `scale(${(0.75 + 0.25 * l.p) * (1 + 0.04 * glow)})`, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
      <div style={{ width: 84, height: 84, borderRadius: 22, display: 'grid', placeItems: 'center', background: alpha(C.accent, 0.14 + 0.14 * glow) }}>
        <Icon name={icon} color={C.accent} size={50} stroke={2} />
      </div>
      <div style={{ fontFamily: MONO, fontSize: 34, color: C.ink }}>{name}</div>
    </div>
  );
}

/** A tenant setting with its switch, which turns on at `onAt`. */
function SettingSwitch({ title, label, x, y, from, until, onAt }: { title: string; label: string; x: number; y: number; from: number; until?: number; onAt: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const C = useTheme();
  const on = ramp(frame, onAt, 10, ease.out);
  const track = on > 0.5 ? C.ok : alpha(C.ink, 0.25);
  return (
    <ArtifactCard x={x} y={y} width={980} icon="cog" title={title} subtitle="Set by a tenant admin" at={from} until={until}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 24, padding: '14px 18px', borderRadius: 14, background: alpha(C.ink, 0.05), border: `1.5px solid ${C.panel.border}` }}>
        <span style={{ fontFamily: FONT, fontWeight: 650, fontSize: 30, color: C.ink, flex: 1 }}>{label}</span>
        <span style={{ position: 'relative', width: 84, height: 44, borderRadius: 22, background: track, transition: 'none', flex: 'none' }}>
          <span style={{ position: 'absolute', top: 5, left: 5 + 40 * on, width: 34, height: 34, borderRadius: '50%', background: '#ffffff', boxShadow: '0 2px 6px rgba(0,0,0,0.35)' }} />
        </span>
      </div>
    </ArtifactCard>
  );
}

/* ------------------------------------------------------------------------------------------ */
/*                                     1. Cold open                                           */
/* ------------------------------------------------------------------------------------------ */

const OPEN = {
  avery: [420, 300] as const,
  blake: [1500, 300] as const,
  rowY: (i: number) => 430 + i * 92,
  /** Where each row lands after the split, under its owner. */
  landY: (k: number) => 470 + k * 92,
};

const coldOpen: LessonScene = {
  id: 'cold-open',
  ray: (c) => ({
    keys: [{ f: 0, x: 960, y: 1250, s: 0.6 }, swim(c.lead + 6, 'hook', ease.out), swim(c.span.duration, 'hook')],
    moods: [
      { f: 0, mood: 'idle' },
      { f: c.w('How'), mood: 'surprised' },
      { f: c.w('One'), mood: 'happy' },
    ],
    rolls: [6],
    hops: [c.w('rule'), c.w('row', 2)],
    gaze: [
      [0, 0, -0.9],
      [c.w('Avery'), -0.8, -0.8],
      [c.w('Blake'), 0.8, -0.8],
      [c.w('expense'), 0, -0.8],
      [c.w('rule'), 0, -1],
      [c.w('row'), 0, -0.6],
    ],
  }),
  sfx: (c) => [
    { f: 4, id: 'swim-whoosh', volume: 0.4 },
    { f: c.w('Avery'), id: 'pop', volume: 0.45 },
    { f: c.w('Blake'), id: 'pop', volume: 0.45 },
    ...ROWS.map((_, i) => ({ f: c.w('expense') + i * 4, id: 'pop' as const, volume: 0.3 })),
    { f: c.w('How'), id: 'boing', volume: 0.3 },
    { f: c.w('rule'), id: 'stamp', volume: 0.45 },
    { f: c.w('server'), id: 'pop', volume: 0.4 },
    { f: c.w('row'), id: 'swim-whoosh', volume: 0.4 },
    { f: c.w('row') + 18, id: 'chime', volume: 0.4 },
    { f: c.span.duration - 16, id: 'sweep', volume: 0.45 },
  ],
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const C = useTheme();
    const exit = ramp(frame, ctx.span.duration - 18, 16, ease.in);
    const how = ctx.w('How');
    const split = ctx.w('row');
    let a = 0;
    let b = 0;
    const land = ROWS.map((r) => (r.owner === AVERY ? { x: OPEN.avery[0], y: OPEN.landY(a++) } : { x: OPEN.blake[0], y: OPEN.landY(b++) }));
    return (
      <AbsoluteFill>
        <AbsoluteFill style={{ transform: `scale(${1 - 0.9 * exit})`, opacity: 1 - exit }}>
          {ROWS.map((r, i) =>
            [AVERY, BLAKE].map((who) => {
              const p = who === AVERY ? OPEN.avery : OPEN.blake;
              return <Beam key={`${who.name}${i}`} from={[p[0], p[1] + 40]} to={[960 + (who === AVERY ? -240 : 240), OPEN.rowY(i)]} at={how + i * 3} until={split - 4} color={alpha(AMBER, 0.6)} dashed />;
            }),
          )}
          <Person who={AVERY} x={OPEN.avery[0]} y={OPEN.avery[1]} from={ctx.w('Avery')} glow={lit(frame, split + 16)} />
          <Person who={BLAKE} x={OPEN.blake[0]} y={OPEN.blake[1]} from={ctx.w('Blake')} glow={lit(frame, split + 16)} />
          {ROWS.map((r, i) => (
            <ExpenseRow
              key={r.note}
              row={r}
              x={track(frame, [[split + i * 2, 960], [split + i * 2 + 18, land[i].x, ease.inOut]])}
              y={track(frame, [[split + i * 2, OPEN.rowY(i)], [split + i * 2 + 18, land[i].y, ease.inOut]])}
              from={ctx.w('expense') + i * 4}
              ok={split + 20 + i * 2}
            />
          ))}
          <Pill icon="question" color={AMBER} x={960} y={860} from={how} until={ctx.beat('hook-2').from - 2}>
            Only their own?
          </Pill>
          <CodeLine code={POLICY} x={960} y={170} size={32} from={ctx.w('rule')} ok={split + 20} />
          <Pill icon="shield" color={C.ok} x={960} y={860} from={ctx.w('server')}>
            Checked on the server, on every request
          </Pill>
          <Burst kind="sparkles" at={split + 20} x={960} y={500} count={14} seed={11} spread={2.4} />
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
      swim(c.span.duration, 'perchBR'),
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
    { f: c.w('who'), id: 'pop', volume: 0.5 },
    { f: c.w('policy'), id: 'pop', volume: 0.5 },
    { f: c.w('filter'), id: 'pop', volume: 0.5 },
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
          { text: 'Who can do what', at: ctx.w('who') },
          { text: 'A policy that keeps rows their own', at: ctx.w('policy') },
          { text: 'Why a filter in your app isn’t security', at: ctx.w('filter') },
        ]}
      />
    </AbsoluteFill>
  ),
};

/* ------------------------------------------------------------------------------------------ */
/*                                   4. Who can do what                                       */
/* ------------------------------------------------------------------------------------------ */

const H = {
  decorator: locate(HEAD, SHORTHAND).line,
  policy: locate(HEAD, POLICY).line,
  close: locate(HEAD, '})').line,
} as const;
const ROLE_LINE = locate(ROLE_HEAD, "@role('authenticated', '*', {");
const TILE_X = [390, 770, 1150, 1530] as const;

function whoBeats(c: LessonCtx) {
  return { two: c.beat('wd-2').from, three: c.beat('wd-3').from, four: c.beat('wd-4').from };
}

const who: LessonScene = {
  id: 'who',
  dim: 0.3,
  ray: (c) => {
    const b = whoBeats(c);
    return {
      keys: [{ f: 0, ...SPOT.perchBR }, swim(c.span.duration, 'perchBR')],
      moods: [
        { f: 0, mood: 'idle' },
        { f: c.w('two'), mood: 'happy' },
        { f: b.two, mood: 'idle' },
        { f: c.w('star'), mood: 'happy' },
        { f: b.four, mood: 'idle' },
        { f: c.w('tenant'), mood: 'surprised' },
        { f: c.w('allow') + 10, mood: 'happy' },
      ],
      hops: [c.w('two'), c.w('star'), c.w('same')],
      gaze: [
        [0, -0.9, -0.7],
        [c.w('two'), -0.6, -0.3],
        [b.two, -0.9, -0.7],
        [c.at('wd-2', 'create'), -1, -0.4],
        [b.three, -0.9, -0.7],
        [b.four, -0.9, -0.7],
        [c.w('tenant'), -0.6, -0.3],
      ],
    };
  },
  sfx: (c) => {
    const b = whoBeats(c);
    return [
      { f: 4, id: 'swim-whoosh', volume: 0.3 },
      { f: c.w('permission'), id: 'pop', volume: 0.45 },
      { f: c.at('wd-1', 'authenticated'), id: 'pop', volume: 0.45 },
      { f: c.at('wd-1', 'anonymous'), id: 'pop', volume: 0.45 },
      { f: b.two, id: 'sweep', volume: 0.3 },
      ...ACTIONS.map((a) => ({ f: c.at('wd-2', a.name), id: 'pop' as const, volume: 0.42 })),
      { f: c.w('star'), id: 'shimmer', volume: 0.4 },
      { f: c.w('shorthand'), id: 'swim-whoosh', volume: 0.3 },
      { f: c.w('same'), id: 'chime', volume: 0.35 },
      { f: b.four, id: 'sweep', volume: 0.3 },
      { f: c.w('tenant'), id: 'pop', volume: 0.45 },
      { f: c.w('allow'), id: 'click', volume: 0.5 },
    ];
  },
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const C = useTheme();
    const b = whoBeats(ctx);
    const end = ctx.span.duration - 14;
    const star = ctx.w('star');
    const shorthand = ctx.w('shorthand');
    return (
      <AbsoluteFill>
        <ChapterTag text="Who can do what" from={ctx.lead} to={end} />
        {/* wd-1: the permission decorator, and the two roles. */}
        <CodeCard
          code={HEAD}
          file={SNIPPETS.expense.file}
          firstLine={HEAD_FROM}
          x={960}
          y={330}
          width={1180}
          fontSize={30}
          from={ctx.lead + 4}
          to={b.two - 2}
          focus={[{ lines: [H.decorator, H.policy, H.close], from: ctx.w('permission') - 2, to: b.two }]}
          marks={[{ line: H.decorator, from: 0, to: SHORTHAND.length, at: ctx.w('permission'), until: b.two - 2, label: 'Who can use it', labelGap: 2 }]}
        />
        <ArtifactCard x={640} y={760} width={520} icon="signin" title={<Mono>authenticated</Mono>} subtitle="People who are signed in" at={ctx.at('wd-1', 'authenticated')} until={b.two - 2} lit={lit(frame, ctx.at('wd-1', 'authenticated'), ctx.at('wd-1', 'anonymous'))} />
        <ArtifactCard x={1280} y={760} width={520} icon="users" title={<Mono>anonymous</Mono>} subtitle="People who aren’t" at={ctx.at('wd-1', 'anonymous')} until={b.two - 2} lit={lit(frame, ctx.at('wd-1', 'anonymous'))} />
        <Chip x={960} y={600} from={ctx.w('two')} to={b.two - 2} size={30}>
          Two built-in roles
        </Chip>
        {/* wd-2, wd-3: the actions, and the star. */}
        <CodeLine code={SOME} x={960} y={260} size={40} from={b.two} until={star - 14} marks={[{ ...span(SOME, "['create', 'read']"), at: ctx.w('actions'), label: 'The actions they get' }]} />
        <CodeLine code={STAR} x={960} y={260} size={40} from={star} until={shorthand - 2} marks={[{ ...span(STAR, "'*'"), at: star + 4, label: 'All four' }]} />
        {ACTIONS.map((a, i) => (
          <ActionTile key={a.name} name={a.name} icon={a.icon} x={TILE_X[i]} y={640} from={ctx.at('wd-2', a.name)} until={shorthand - 2} glow={Math.max(lit(frame, ctx.at('wd-2', a.name), ctx.at('wd-2', a.name) + 20), lit(frame, ctx.w('all') + i * 3))} />
        ))}
        <CodeCard code={ROLE_HEAD} file={SNIPPETS.roleForm.file} firstLine={HEAD_FROM} badge="LESSONS 4 AND 5" x={960} y={330} width={1180} fontSize={27} from={shorthand} to={b.four - 2} marks={[{ line: ROLE_LINE.line, from: ROLE_LINE.from, to: ROLE_LINE.to, at: ctx.w('role'), until: b.four - 2 }]} />
        <CodeCard code={HEAD} file={SNIPPETS.expense.file} firstLine={HEAD_FROM} badge="SHORTHAND" x={960} y={750} width={1180} fontSize={27} from={shorthand + 6} to={b.four - 2} marks={[{ line: H.decorator, from: 0, to: SHORTHAND.length, at: ctx.w('shorthand') + 6, until: b.four - 2 }]} />
        <Chip x={960} y={540} from={ctx.w('same')} to={b.four - 2} size={30} accent={C.ok}>
          Same rule, easier to read
        </Chip>
        {/* wd-4: the anonymous role, and the tenant switch. */}
        <CodeLine code={ANON} x={960} y={260} size={44} from={b.four} until={end} />
        <Chip x={960} y={390} from={ctx.at('wd-4', 'signed')} to={end} size={30} accent={AMBER}>
          For people who aren’t signed in
        </Chip>
        <SettingSwitch title="Tenant settings" label={ANON_SWITCH} x={960} y={680} from={ctx.w('tenant')} until={end} onAt={ctx.w('allow')} />
      </AbsoluteFill>
    );
  },
};

/* ------------------------------------------------------------------------------------------ */
/*                              5. Your rows, nobody else's                                   */
/* ------------------------------------------------------------------------------------------ */

const R = {
  avery: [330, 560] as const,
  blake: [1590, 560] as const,
  rowX: 960,
  rowY: (i: number) => 420 + i * 92,
  rowHalf: 230,
} as const;
const POLICY_CLAIM = span(POLICY, 'claims.sub');
const POLICY_OWNER = span(POLICY, 'item.owner_id');
const CREATE_SESSION = locate(CREATE_FN, 'client.auth.getSession()');
const CREATE_OWNER = locate(CREATE_FN, 'owner_id: session.user.id');

function rowsBeats(c: LessonCtx) {
  return { two: c.beat('ro-2').from, three: c.beat('ro-3').from, four: c.beat('ro-4').from, five: c.beat('ro-5').from };
}

const rows: LessonScene = {
  id: 'rows',
  dim: 0.3,
  ray: (c) => {
    const b = rowsBeats(c);
    return {
      keys: [{ f: 0, ...SPOT.perchBR }, swim(c.span.duration, 'perchBR')],
      moods: [
        { f: 0, mood: 'idle' },
        { f: c.w("shouldn't"), mood: 'worried' },
        { f: b.two, mood: 'idle' },
        { f: c.w('equal'), mood: 'happy' },
        { f: c.w('typo'), mood: 'surprised' },
        { f: b.five, mood: 'idle' },
        { f: c.w('session'), mood: 'happy' },
      ],
      hops: [c.w('equal'), c.w('compile') + 8, c.w('session')],
      squishes: [c.w("shouldn't")],
      gaze: [
        [0, -0.9, -0.6],
        [c.at('ro-1', 'every'), -0.9, -0.3],
        [b.two, -0.9, -0.8],
        [b.three, -0.9, -0.8],
        [c.w('equal'), -0.9, -0.3],
        [b.four, -0.9, -0.6],
        [c.w('typo'), -0.9, -0.1],
        [b.five, -0.9, -0.4],
      ],
    };
  },
  sfx: (c) => {
    const b = rowsBeats(c);
    return [
      { f: 4, id: 'swim-whoosh', volume: 0.3 },
      { f: c.at('ro-1', 'every'), id: 'sweep', volume: 0.3 },
      { f: c.w("shouldn't"), id: 'thud', volume: 0.45 },
      { f: b.two, id: 'pop', volume: 0.4 },
      { f: c.w('policy'), id: 'stamp', volume: 0.4 },
      { f: c.w('compares'), id: 'sonar', volume: 0.3 },
      { f: c.w('claims.sub'), id: 'pop', volume: 0.45 },
      { f: c.w('owner_id'), id: 'pop', volume: 0.45 },
      { f: c.w('equal'), id: 'chime', volume: 0.4 },
      { f: c.at('ro-3', 'reach'), id: 'thud', volume: 0.35 },
      ...CLAIMS.map((w) => ({ f: c.at('ro-4', w), id: 'pop' as const, volume: 0.36 })),
      { f: c.w('fields'), id: 'pop', volume: 0.36 },
      { f: c.w('compile'), id: 'thud', volume: 0.45 },
      { f: b.five, id: 'sweep', volume: 0.3 },
      { f: c.w('session'), id: 'pop', volume: 0.45 },
      { f: c.w('sets'), id: 'pop', volume: 0.45 },
    ];
  },
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const C = useTheme();
    const b = rowsBeats(ctx);
    const end = ctx.span.duration - 14;
    const every = ctx.at('ro-1', 'every');
    const shouldnt = ctx.w("shouldn't");
    const compares = ctx.w('compares');
    const equal = ctx.w('equal');
    const reach = ctx.at('ro-3', 'reach');
    const rowsOut = b.four - 4;
    return (
      <AbsoluteFill>
        <ChapterTag text="Your rows, nobody else’s" from={ctx.lead} to={end} />
        {/* ro-1: a star alone reaches every row. */}
        <CodeLine code={STAR} x={960} y={200} size={40} from={ctx.lead + 2} until={b.two - 2} marks={[{ ...span(STAR, "'*'"), at: ctx.w('star'), label: 'Every signed-in person', color: AMBER }]} />
        {[AVERY, BLAKE].map((who) =>
          ROWS.map((r, i) => {
            const p = who === AVERY ? R.avery : R.blake;
            const toX = R.rowX + (who === AVERY ? -R.rowHalf : R.rowHalf);
            const intrusion = who === BLAKE && r.owner === AVERY;
            return (
              <div key={`${who.name}${i}`}>
                <Beam from={[p[0] + (who === AVERY ? 60 : -60), p[1]]} to={[toX, R.rowY(i)]} at={every + i * 3} until={b.two - 2} color={alpha(intrusion && frame >= shouldnt ? RED : AMBER, 0.6)} width={intrusion && frame >= shouldnt ? 5 : 3} dashed={!(intrusion && frame >= shouldnt)} />
              </div>
            );
          }),
        )}
        <Person who={AVERY} x={R.avery[0]} y={R.avery[1]} from={ctx.lead + 6} until={b.two - 2} />
        <Person who={BLAKE} x={R.blake[0]} y={R.blake[1]} from={ctx.lead + 8} until={rowsOut} glow={lit(frame, b.two, rowsOut)} label={frame >= b.three ? <span>claims.sub = <Mono>{BLAKE.id}</Mono></span> : undefined} />
        {ROWS.map((r, i) => (
          <ExpenseRow
            key={r.note}
            row={r}
            x={R.rowX}
            y={R.rowY(i)}
            from={ctx.lead + 4 + i * 3}
            until={rowsOut}
            bad={r.owner === AVERY && i === 0 ? ctx.w('taxi') : undefined}
            ok={r.owner === BLAKE ? equal + i * 3 : undefined}
            dim={r.owner === AVERY ? ramp(frame, reach - 4, 10) : 0}
            glow={lit(frame, compares + i * 6, compares + i * 6 + 14)}
          />
        ))}
        <Chip x={960} y={830} from={every} to={ctx.w('Expenses') - 2} size={30} accent={AMBER}>
          Every signed-in person, every row
        </Chip>
        <Chip x={960} y={830} from={shouldnt} to={b.two - 2} size={30} accent={RED}>
          Avery’s taxi rides aren’t Blake’s to see
        </Chip>
        {/* ro-2: the policy compares the person asking with each row. */}
        <CodeCard code={HEAD} file={SNIPPETS.expense.file} firstLine={HEAD_FROM} x={960} y={225} width={1000} fontSize={24} from={b.two} to={b.three - 2} focus={[{ lines: [H.policy], from: ctx.w('policy') - 2, to: b.three }]} marks={[{ line: H.policy, at: ctx.w('policy'), until: b.three - 2 }]} />
        {ROWS.map((r, i) => (
          <Beam key={`c${i}`} from={[R.blake[0] - 60, R.blake[1]]} to={[R.rowX + R.rowHalf, R.rowY(i)]} at={compares + i * 6} until={rowsOut} color={alpha(r.owner === BLAKE ? C.ok : C.accent2, frame >= reach && r.owner === AVERY ? 0.15 : 0.75)} />
        ))}
        {/* ro-3: claims.sub has to equal the row's owner_id. */}
        <CodeLine
          code={POLICY}
          x={960}
          y={200}
          size={32}
          from={b.three}
          until={rowsOut}
          marks={[
            { ...POLICY_CLAIM, at: ctx.w('claims.sub'), label: 'Who’s asking' },
            { ...POLICY_OWNER, at: ctx.w('owner_id'), label: 'Whose row it is', color: C.accent2 },
          ]}
        />
        <Chip x={960} y={830} from={reach} to={rowsOut} size={30} accent={C.inkDim}>
          Not equal: out of reach
        </Chip>
        {/* ro-4: both sides are typed. */}
        <Completion prefix="claims" x={560} y={240} from={b.four} until={b.five - 2} items={CLAIMS.map((w) => ({ text: w, at: ctx.at('ro-4', w) }))} />
        <Completion prefix="item" x={1300} y={240} from={b.four + 6} until={b.five - 2} items={FIELDS.map((f, i) => ({ text: f, at: ctx.w('fields') + i * 3 }))} />
        <CodeLine code={TYPO} x={960} y={880} size={30} from={ctx.w('typo')} until={b.five - 2} bad={ctx.w('compile')} marks={[{ ...span(TYPO, 'ownr_id'), at: ctx.w('typo') + 6, squiggle: true, color: RED, label: 'Won’t compile' }]} />
        {/* ro-5: the policy checks owner_id; the app fills it in. */}
        <CodeCard
          code={CREATE_FN}
          file={SNIPPETS.create.file}
          firstLine={CREATE_FROM}
          x={900}
          y={580}
          width={1500}
          fontSize={26}
          from={ctx.w('creates') - 6}
          to={end}
          focus={[{ lines: [CREATE_SESSION.line, CREATE_OWNER.line], from: ctx.w('session') - 2, to: end + 20 }]}
          marks={[
            { line: CREATE_SESSION.line, from: CREATE_SESSION.from, to: CREATE_SESSION.to, at: ctx.w('session'), until: end, label: 'The signed-in person', labelGap: 2 },
            { line: CREATE_OWNER.line, from: CREATE_OWNER.from, to: CREATE_OWNER.to, at: ctx.w('sets'), until: end, label: 'Your app sets owner_id', labelGap: 2 },
          ]}
        />
        <Chip x={900} y={190} from={b.five} to={end} size={32} accent={C.accent2}>
          <span>
            The policy checks <Mono>owner_id</Mono>. It doesn’t fill it in.
          </span>
        </Chip>
      </AbsoluteFill>
    );
  },
};

/* ------------------------------------------------------------------------------------------ */
/*                           6. Deep Dive: what a filter can't protect                        */
/* ------------------------------------------------------------------------------------------ */

/** A query's results, row by row. A row can be flagged, edited, deleted or left out, each on its cue. */
function Results({ items }: { items: ReadonlyArray<{ row: (typeof ROWS)[number]; at: number; flag?: number; editAt?: number; editText?: string; deleteAt?: number; hideAt?: number }> }): JSX.Element {
  const frame = useCurrentFrame();
  const C = useTheme();
  return (
    <div style={{ borderRadius: 12, overflow: 'hidden', border: `1.5px solid ${C.panel.border}` }}>
      {items.map((it, i) => {
        const p = ramp(frame, it.at, 8, ease.out);
        const hide = it.hideAt === undefined ? 0 : ramp(frame, it.hideAt, 12, ease.inOut);
        const del = it.deleteAt === undefined ? 0 : ramp(frame, it.deleteAt, 10, ease.out);
        const edited = it.editAt !== undefined && frame >= it.editAt;
        const flagged = it.flag !== undefined && frame >= it.flag;
        const color = flagged ? RED : undefined;
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 14, height: 52 * p * (1 - hide), opacity: p * (1 - hide), overflow: 'hidden', padding: '0 16px', borderTop: i ? `1px solid ${C.panel.border}` : 'none', background: color ? alpha(color, 0.12) : 'transparent', transform: `translateX(${shake(frame, it.flag, 6)}px)` }}>
            <span style={{ width: 12, height: 12, borderRadius: '50%', background: it.row.owner.color, flex: 'none' }} />
            <span style={{ position: 'relative', fontFamily: FONT, fontWeight: 650, fontSize: 27, color: edited ? AMBER : C.ink, whiteSpace: 'nowrap' }}>
              {edited ? it.editText : it.row.note}
              {del > 0 ? <span style={{ position: 'absolute', left: -4, right: `${(1 - del) * 100}%`, top: '52%', height: 3, background: RED }} /> : null}
            </span>
            <span style={{ flex: 1 }} />
            <span style={{ fontFamily: MONO, fontSize: 24, color: C.inkSoft, opacity: 1 - 0.6 * del }}>{it.row.amount}</span>
            <span style={{ fontFamily: FONT, fontWeight: 600, fontSize: 21, color: it.row.owner.color, minWidth: 64, textAlign: 'right' }}>{it.row.owner.name}</span>
          </div>
        );
      })}
    </div>
  );
}

const BARE_ENTITY = locate(BARE_CLASS, '@entity()');
const MINE_WHERE = span(MINE, 'where({ owner_id: { eq: me } })');

function deepBeats(c: LessonCtx) {
  return { one: c.beat('dd-1').from, two: c.beat('dd-2').from, three: c.beat('dd-3').from, four: c.beat('dd-4').from, five: c.beat('dd-5').from, six: c.beat('dd-6').from };
}

const deepDive: LessonScene = {
  id: 'deep-dive',
  depth: 1,
  ray: (c) => {
    const b = deepBeats(c);
    return {
      keys: [{ f: 0, ...SPOT.perchBR }, swim(30, 'deep'), swim(c.span.duration, 'deep')],
      moods: [
        { f: 0, mood: 'happy' },
        { f: c.w('What'), mood: 'idle' },
        { f: c.w('locked'), mood: 'surprised' },
        { f: b.two, mood: 'idle' },
        { f: c.w('without'), mood: 'worried' },
        { f: c.w('yes'), mood: 'worried' },
        { f: b.five, mood: 'happy' },
        { f: b.six, mood: 'idle' },
      ],
      rolls: [6],
      hops: [c.w('own'), c.w('name')],
      squishes: [c.w('delete', 2)],
      gaze: [
        [0, 0, 0.4],
        [c.w('What'), -0.8, -0.5],
        [b.one, -0.9, -0.6],
        [b.two, -0.9, -0.6],
        [b.three, -0.9, -0.5],
        [b.four, -0.9, -0.4],
        [b.five, -0.9, -0.5],
        [b.six, -0.8, -0.4],
      ],
    };
  },
  sfx: (c) => {
    const b = deepBeats(c);
    return [
      { f: 0, id: 'dive', volume: 0.55 },
      { f: c.w('decorator'), id: 'thud', volume: 0.4 },
      { f: c.w('locked'), id: 'sonar', volume: 0.3 },
      ...ACTIONS.map((a) => ({ f: c.at('dd-1', a.name), id: 'pop' as const, volume: 0.4 })),
      { f: b.two, id: 'pop', volume: 0.4 },
      { f: c.w('Avery'), id: 'pop', volume: 0.4 },
      { f: c.w('looks'), id: 'shimmer', volume: 0.3 },
      { f: c.at('dd-3', 'filter'), id: 'pop', volume: 0.4 },
      { f: c.w('without'), id: 'swim-whoosh', volume: 0.35 },
      { f: c.w("everyone's"), id: 'thud', volume: 0.45 },
      { f: c.w('edit'), id: 'typing', volume: 0.28, duration: 14 },
      { f: c.at('dd-4', 'delete'), id: 'thud', volume: 0.45 },
      { f: c.w('yes'), id: 'stamp', volume: 0.45 },
      { f: b.five, id: 'sweep', volume: 0.4 },
      { f: c.w('policy') + 4, id: 'stamp', volume: 0.4 },
      { f: c.w('own'), id: 'chime', volume: 0.4 },
      { f: c.w('Editing'), id: 'pop', volume: 0.4 },
      { f: c.w('deleting'), id: 'pop', volume: 0.4 },
      { f: c.w('creating'), id: 'pop', volume: 0.4 },
      { f: c.w('name'), id: 'chime', volume: 0.35 },
      { f: c.at('dd-6', 'filter'), id: 'pop', volume: 0.45 },
      { f: c.at('dd-6', 'policy'), id: 'pop', volume: 0.45 },
    ];
  },
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const C = useTheme();
    const b = deepBeats(ctx);
    const end = ctx.span.duration - 14;
    const without = ctx.w('without');
    const everyone = ctx.w("everyone's");
    const edit = ctx.w('edit');
    const del = ctx.at('dd-4', 'delete');
    const own = ctx.w('own');
    return (
      <AbsoluteFill style={{ opacity: fadeOut(frame, ctx.span.duration, 12) }}>
        <DeepDiveTitle from={ctx.lead} to={end} subtitle="What a filter can’t protect" tuckAt={ctx.w('What')} />
        <DepthGauge from={0} to={ctx.span.duration - 20} />
        {/* dive, dd-1: no permission decorator, and Rayfin's default. */}
        <Chip x={1080} y={230} from={ctx.w('What')} to={b.one - 2} size={36}>
          An entity with no permission decorator?
        </Chip>
        <CodeCard code={BARE_CLASS} file={SNIPPETS.bare.file} firstLine={BARE_FROM} x={1080} y={600} width={1100} fontSize={26} from={ctx.w('What') + 4} to={b.one - 2} marks={[{ line: BARE_ENTITY.line, at: ctx.w('decorator'), until: b.one - 2, color: AMBER, label: 'No permission decorator', labelGap: 2 }]} />
        <Pill icon="unlock" color={AMBER} x={1080} y={230} from={ctx.w('locked')} until={b.two - 2} size={34}>
          It isn’t locked
        </Pill>
        <Chip x={1080} y={370} from={ctx.w('default')} to={b.two - 2} size={30} accent={AMBER}>
          <span>
            Rayfin’s default: <Mono>authenticated: *</Mono>
          </span>
        </Chip>
        {ACTIONS.map((a, i) => (
          <ActionTile key={a.name} name={a.name} icon={a.icon} x={600 + i * 320} y={610} from={ctx.w('default') + i * 3} until={b.two - 2} glow={Math.max(lit(frame, ctx.at('dd-1', a.name), ctx.at('dd-1', a.name) + 18), lit(frame, ctx.w('every', 1) + 6))} />
        ))}
        <Chip x={1080} y={850} from={ctx.w('anyone')} to={b.two - 2} size={32} accent={AMBER}>
          Anyone signed in · every row
        </Chip>
        {/* dd-2, dd-3, dd-4: the app's filter, and Blake without it. */}
        <CodeLine
          code={MINE}
          x={1090}
          y={210}
          size={24}
          from={b.two}
          until={without - 2}
          marks={[
            { ...MINE_WHERE, at: ctx.w('only'), until: ctx.at('dd-3', 'filter') - 2, label: 'Your app’s filter' },
            { ...MINE_WHERE, at: ctx.at('dd-3', 'filter'), color: AMBER, label: 'It lives in your app' },
          ]}
        />
        <CodeLine code={EVERYONE} x={1090} y={210} size={24} from={without} until={b.five - 2} label="The same question, no filter" labelColor={AMBER} />
        <Person who={AVERY} x={520} y={560} from={ctx.w('Avery')} until={ctx.w('Blake') - 2} />
        <ArtifactCard x={1180} y={560} width={760} icon="browser" title="Avery’s expenses" subtitle="What her app shows" at={ctx.w('Avery') + 4} until={ctx.w('Blake') - 2}>
          <Results items={ROWS.filter((r) => r.owner === AVERY).map((row, i) => ({ row, at: ctx.w('Avery') + 10 + i * 5 }))} />
        </ArtifactCard>
        <Chip x={1180} y={850} from={ctx.w('looks')} to={ctx.w('Blake') - 2} size={30} accent={AMBER}>
          Looks private…
        </Chip>
        <Person who={BLAKE} x={520} y={560} from={ctx.w('Blake')} until={b.five - 2} />
        <ArtifactCard x={1180} y={580} width={760} icon="client" title="What Blake gets" subtitle="Everyone’s rows" at={without + 6} until={b.five - 2}>
          <Results
            items={ROWS.map((row, i) => ({
              row,
              at: everyone + i * 4,
              flag: row.owner === AVERY ? everyone + 14 : undefined,
              ...(i === 0 ? { editAt: edit, editText: 'Blake was here', deleteAt: del } : {}),
            }))}
          />
        </ArtifactCard>
        <Pill icon="server" color={RED} x={1180} y={880} from={ctx.w('yes')} until={b.five - 2} size={30}>
          The server says yes
        </Pill>
        {/* dd-5: with the policy. */}
        <CodeLine code={POLICY} x={1090} y={210} size={30} from={b.five} until={b.six - 2} ok={ctx.w('policy') + 4} label="Added to Expense" labelColor={C.ok} />
        <Person who={BLAKE} x={480} y={560} from={b.five + 4} until={b.six - 2} />
        <ArtifactCard x={900} y={560} width={560} icon="client" title="What Blake gets" subtitle="Only his own rows" at={b.five + 6} until={b.six - 2}>
          <Results items={ROWS.map((row, i) => ({ row, at: b.five + 10 + i * 3, hideAt: row.owner === AVERY ? own : undefined }))} />
        </ArtifactCard>
        <ArtifactCard x={1530} y={560} width={560} icon="shield" title="Refused" subtitle="By the server" at={ctx.w('Editing') - 4} until={b.six - 2}>
          <RuleList
            size={26}
            items={[
              { text: 'Edit Avery’s taxi ride', at: ctx.w('Editing'), bad: true },
              { text: 'Delete it', at: ctx.w('deleting'), bad: true },
              { text: 'Create one in her name', at: ctx.w('creating'), bad: true },
            ]}
          />
        </ArtifactCard>
        <Pill icon="shield" color={C.ok} x={1180} y={880} from={ctx.w('name')} until={b.six - 2} size={30}>
          Avery’s rows stay hers
        </Pill>
        {/* dd-6: the difference. */}
        <ArtifactCard x={760} y={540} width={620} icon="browser" title="A filter in your app" subtitle="Picks which rows to show" at={ctx.at('dd-6', 'filter')} until={end} lit={lit(frame, ctx.at('dd-6', 'filter'), ctx.at('dd-6', 'policy'))} />
        <ArtifactCard x={1440} y={540} width={620} icon="shield" title="A policy on the server" subtitle="Decides which rows anyone can reach" at={ctx.at('dd-6', 'policy')} until={end} lit={lit(frame, ctx.at('dd-6', 'policy'))} />
        <Sonar x={1440} y={540} at={ctx.at('dd-6', 'policy')} size={520} rings={2} color={alpha(C.ok, 0.55)} />
      </AbsoluteFill>
    );
  },
};

/* ------------------------------------------------------------------------------------------ */
/*                                 7. See it in Fabricator                                    */
/* ------------------------------------------------------------------------------------------ */

/** Blueprint's Data model view with Report left without a permission decorator (scripts/docs-screenshots' `model-access`). */
const MODEL_ACCESS: Shot = { id: 'model-access', w: 1600, h: 856 };
/** Pixels in it, the same in both themes (measured with sharp: the dots' centers, the words' extents). */
const MA = {
  legend: { x: 1274, y: 12, w: 318, h: 30 },
  rowScoped: { x: 1331, y: 14, w: 95, h: 26 },
  anySignedIn: { x: 1427, y: 14, w: 102, h: 26 },
  public: { x: 1530, y: 14, w: 60, h: 26 },
  greenDots: [
    [483, 194],
    [932, 194],
    [1381, 194],
  ] as const,
  reportDot: [932, 574] as const,
  report: { x: 616, y: 554, w: 337, h: 271 },
  noRoles: { x: 631, y: 738, w: 102, h: 26 },
  harden: { x: 689, y: 781, w: 77, h: 37 },
} as const;
const FAB = { x: 960, y: 560, width: 1500 } as const;

/** A glowing ring around a point of a screenshot, in image pixels. */
function Ring({ x, y, r = 13, color, opacity }: { x: number; y: number; r?: number; color: string; opacity: number }): JSX.Element | null {
  if (opacity <= 0.001) return null;
  return <div style={{ position: 'absolute', left: x - r, top: y - r, width: r * 2, height: r * 2, borderRadius: '50%', border: `3px solid ${color}`, boxShadow: `0 0 14px ${color}`, opacity }} />;
}

function fabBeats(c: LessonCtx) {
  return { two: c.beat('fab-2').from, three: c.beat('fab-3').from };
}

const fabricator: LessonScene = {
  id: 'fabricator',
  dim: 0.35,
  ray: (c) => {
    const b = fabBeats(c);
    return {
      keys: [{ f: 0, ...SPOT.deep }, swim(28, 'fabricator'), swim(c.span.duration, 'fabricator')],
      moods: [
        { f: 0, mood: 'happy' },
        { f: 30, mood: 'idle' },
        { f: c.w('dot'), mood: 'happy' },
        { f: b.two, mood: 'idle' },
        { f: c.at('fab-2', 'Harden'), mood: 'happy' },
      ],
      hops: [c.w('dot'), c.at('fab-2', 'Harden'), c.w('redeploys')],
      gaze: [
        [0, -0.6, -0.4],
        [30, -0.9, 0.2],
        [c.w('dot'), -0.4, -0.3],
        [b.two, -0.9, 0.6],
        [b.three, -0.9, 0.7],
      ],
    };
  },
  sfx: (c) => [
    { f: 0, id: 'surface', volume: 0.5 },
    { f: c.w('dot'), id: 'pop', volume: 0.4 },
    { f: c.w('row-scoped'), id: 'pop', volume: 0.4 },
    { f: c.at('fab-1', 'any'), id: 'pop', volume: 0.4 },
    { f: c.w('public'), id: 'pop', volume: 0.4 },
    { f: c.w('Report'), id: 'swim-whoosh', volume: 0.3 },
    { f: c.w('explicit'), id: 'pop', volume: 0.4 },
    { f: c.at('fab-2', 'dot'), id: 'pop', volume: 0.4 },
    { f: c.at('fab-2', 'Harden'), id: 'pop', volume: 0.45 },
    { f: c.at('fab-3', 'Harden'), id: 'click', volume: 0.5 },
    { f: c.w('Copilot'), id: 'pop', volume: 0.45 },
    { f: c.w('redeploys'), id: 'chime', volume: 0.35 },
  ],
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const C = useTheme();
    const b = fabBeats(ctx);
    const end = ctx.span.duration - 14;
    const win = windowLife(frame, fps, ctx.lead, end);
    const dot = ctx.w('dot');
    const scoped = ctx.w('row-scoped');
    const any = ctx.at('fab-1', 'any');
    const pub = ctx.w('public');
    const click = ctx.at('fab-3', 'Harden');
    const zoom = track(frame, [
      [b.two - 4, 1],
      [b.two + 22, 1.75],
    ]);
    const press = 1 - 0.5 * lit(frame, click, click + 8);
    const hardenAt = onScreen({ shot: MODEL_ACCESS, x: FAB.x, y: FAB.y, width: FAB.width, zoom: 1.75, fx: 790, fy: 690 }, MA.harden.x + MA.harden.w / 2, MA.harden.y + MA.harden.h / 2);
    return (
      <AbsoluteFill>
        <ChapterTag text="See it in Fabricator" from={ctx.lead} to={end} />
        {win ? (
          <AppWindow shot={MODEL_ACCESS} x={FAB.x} y={FAB.y} width={FAB.width} zoom={zoom} fx={790} fy={690} opacity={win.opacity} scale={win.scale}>
            <Spotlight {...MA.legend} radius={10} dim={0.35} opacity={lit(frame, dot, scoped)} />
            <Spotlight {...MA.rowScoped} radius={10} dim={0.35} opacity={lit(frame, scoped, any)} />
            <Spotlight {...MA.anySignedIn} radius={10} dim={0.35} opacity={lit(frame, any, pub)} />
            <Spotlight {...MA.public} radius={10} dim={0.35} opacity={lit(frame, pub, b.two)} />
            {MA.greenDots.map(([x, y], i) => (
              <Ring key={i} x={x} y={y} color={C.ok} opacity={Math.max(lit(frame, dot + i * 3, scoped), lit(frame, scoped, any))} />
            ))}
            <Ring x={MA.reportDot[0]} y={MA.reportDot[1]} color={AMBER} opacity={Math.max(lit(frame, dot + 9, scoped), lit(frame, any, pub), lit(frame, ctx.at('fab-2', 'dot'), ctx.at('fab-2', 'Harden')))} />
            <Spotlight {...MA.report} radius={18} dim={0.45} opacity={lit(frame, ctx.w('Report'), ctx.w('explicit'))} />
            <Spotlight {...MA.noRoles} radius={10} dim={0.45} opacity={lit(frame, ctx.w('explicit'), ctx.at('fab-2', 'dot'))} />
            <Spotlight {...MA.harden} radius={12} dim={0.45 * press} opacity={lit(frame, ctx.at('fab-2', 'Harden'), ctx.w('Copilot') + 10)} />
          </AppWindow>
        ) : null}
        <Burst kind="sparkles" at={click + 2} x={hardenAt.x} y={hardenAt.y} count={10} seed={71} spread={1.2} />
        <Chip x={960} y={1010} from={dot} to={b.two - 2} size={30}>
          Every entity gets an access dot
        </Chip>
        <Chip x={960} y={1010} from={ctx.w('explicit')} to={b.three - 2} size={30} accent={AMBER}>
          No permission decorator: Any signed-in, and Harden
        </Chip>
        <ArtifactCard x={1360} y={300} width={640} icon="comment" title={HARDEN_TITLE} subtitle="Sent to the Build chat" at={ctx.w('Copilot')} until={end} lit={lit(frame, ctx.w('Copilot'), ctx.w('Copilot') + 30)}>
          <div style={{ fontFamily: FONT, fontSize: 26, lineHeight: 1.35, color: C.inkSoft }}>Copilot adds a row-level policy. Then Fabricator redeploys.</div>
        </ArtifactCard>
        <Chip x={960} y={1010} from={ctx.w('redeploys')} to={end} size={30} accent={C.ok}>
          After the chat turn, Fabricator redeploys
        </Chip>
      </AbsoluteFill>
    );
  },
};

/* ------------------------------------------------------------------------------------------ */
/*                                     8. Pop quiz                                            */
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
      question={
        <span>
          Your app filters out other people’s expenses.
          <br />
          Are they private?
        </span>
      }
      options={[
        { text: 'Yes: the app never shows them', at: ctx.at('quiz-options', 'A') },
        { text: 'Yes, as long as everyone signs in', at: ctx.at('quiz-options', 'B') },
        { text: 'No: only a policy on the server does that', at: ctx.at('quiz-options', 'C') },
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
/*                                 9. Recap, 10. Challenge                                    */
/* ------------------------------------------------------------------------------------------ */

const recap: LessonScene = {
  id: 'recap',
  ray: (c) => ({
    keys: [{ f: 0, ...SPOT.quiz }, swim(26, 'recap'), swim(c.span.duration, 'recap')],
    moods: [{ f: 0, mood: 'happy' }],
    hops: [c.w('Give'), c.w('Keep'), c.w('filter')],
    gaze: [
      [0, -0.6, 0.6],
      [30, -0.9, -0.7],
    ],
  }),
  sfx: (c) => ['Give', 'Keep', 'filter'].map((w) => ({ f: c.w(w) + 6, id: 'stamp' as const, volume: 0.4 })),
  View: ({ ctx }) => (
    <Recap
      from={ctx.lead}
      to={ctx.span.duration - 14}
      items={[
        { text: 'Every entity gets a permission decorator: who, and which actions', at: ctx.w('Give') },
        {
          text: (
            <span>
              Personal rows: a policy on <Mono>claims.sub</Mono>
            </span>
          ),
          at: ctx.w('Keep'),
        },
        { text: 'Filter in your app to show rows, never to protect them', at: ctx.w('filter') },
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
    { f: c.w('send'), id: 'typing', volume: 0.28, duration: c.w('find') + 24 - c.w('send') },
    { f: c.beat('challenge-2').from, id: 'pop', volume: 0.5 },
  ],
  View: ({ ctx }) => <Challenge prompt={YOUTUBE.challenge.prompt} from={ctx.lead} to={ctx.span.duration - 14} typeFrom={ctx.w('send')} typeTo={ctx.w('find') + 24} cta={YOUTUBE.challenge.question} ctaAt={ctx.beat('challenge-2').from} />,
};

/* ------------------------------------------------------------------------------------------ */
/*                                11. Next up, 12. Ray fact                                   */
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
    const back = c.wEnd('rows') + 8;
    return {
      keys: [{ f: 0, ...SPOT.end }, swim(20, 'fact', ease.out), swim(back, 'fact'), swim(back + 22, 'end'), swim(c.span.duration, 'end')],
      moods: [
        { f: 0, mood: 'idle' },
        { f: c.w('sand'), mood: 'surprised' },
        { f: c.w('Out') - 2, mood: 'happy' },
      ],
      squishes: [c.w('Out') - 2, c.w('Out') + 10],
      waves: [back + 24],
      gaze: [
        [0, 0, 0.1],
        [c.w('sand'), 0, 0.6],
        [c.w('top'), 0, -0.6],
        [c.w('Out'), 0, 0.1],
      ],
    };
  },
  sfx: (c) => [
    { f: 2, id: 'swim-whoosh', volume: 0.3 },
    { f: c.w('Out'), id: 'boing', volume: 0.35 },
    { f: c.wEnd('rows') + 8, id: 'swim-whoosh', volume: 0.3 },
  ],
  View: ({ ctx }) => (
    <AbsoluteFill>
      <TheEnd from={-400} to={ctx.span.duration + 400} />
      <Chip x={SPOT.fact.x} y={430} from={10} to={ctx.wEnd('rows') + 6} accent={AMBER} size={26}>
        RAY FACT
      </Chip>
      <Burst kind="bubbles" at={ctx.w('Out')} x={SPOT.fact.x} y={SPOT.fact.y} count={10} seed={91} />
    </AbsoluteFill>
  ),
};

/** Lesson 6's scenes, in the script's order. */
export const SCENES: readonly LessonScene[] = [coldOpen, bumper, welcome, who, rows, deepDive, fabricator, quiz, recap, challenge, next, stinger];
