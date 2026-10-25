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
  CommandCard,
  DeepDiveTitle,
  DepthGauge,
  EndScreen,
  Icon,
  Objectives,
  Quiz,
  Recap,
  SeriesBumper,
  Sonar,
  TableBody,
  ValidationBody,
  at,
  locate,
  tokenize,
} from '../../src/lesson-kit';
import { colorOf, type Token } from '../../src/lesson-kit/code';
import type { RayKey } from '../../src/ray/RayActor';
import type { LessonCtx, LessonScene } from '../../src/show/types';
import type { Shot } from '../../src/shots';
import { FONT, MONO, alpha, useTheme } from '../../src/theme';
import { AppWindow, ShotRegion, Spotlight } from '../../src/ui/AppWindow';
import { Chip } from '../../src/ui/Kit';
import { SERIES } from '../series';
import { SCRIPT } from './script';
import { CATEGORIES, SNIPPETS, lineWith, lines } from './snippets';
import { YOUTUBE } from './youtube';

/** Where Ray is when one scene hands him to the next. */
const SPOT = {
  hook: { x: 960, y: 975, s: 0.48 },
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

const EXPENSE = SNIPPETS.expense.code;
const EXPENSE_FILE = SNIPPETS.expense.file;
/** The entity from `@entity()` down: the import line is too long for the card, and says nothing new. */
const ENTITY_FROM = locate(EXPENSE, '@entity()').line;
const ENTITY_CODE = lines('expense', ENTITY_FROM, EXPENSE.split('\n').length);
/** The class body the options chapter shows: `export class Expense {` to its `}`. */
const CLASS_FROM = locate(EXPENSE, 'export class Expense {').line;
const CLASS = lines('expense', CLASS_FROM, EXPENSE.split('\n').length);
/** Teammate's two lines with the options Expense doesn't use. */
const TEAM_FROM = locate(SNIPPETS.teammate.code, '@email(').line;
const TEAM = lines('teammate', TEAM_FROM, TEAM_FROM + 1);

const RED = '#ff6b81';
const AMBER = '#ffb547';
const GRAPHQL = '#e535ab';

/** The Data model screenshot: the Contoso Expenses sample's Expense card (see Fabricator's docs). */
const MODEL: Shot = { id: 'model', w: 1600, h: 778 };
/** Pixels in it, the same in both themes. Rows are 37.3 px apart. */
const PX = {
  card: { x: 594, y: 333, w: 412, h: 444 },
  types: { x: 904, y: 394, w: 94, h: 252 },
  idRow: { x: 606, y: 393, w: 394, h: 34 },
  categoryRow: { x: 606, y: 504, w: 394, h: 36 },
  marks: { x: 634, y: 395, w: 32, h: 252 },
  noteRow: { x: 606, y: 541, w: 394, h: 36 },
  open: { x: 604, y: 719, w: 84, h: 50 },
  /** createdAt's "date" label, with the card behind it. */
  dateLabel: { x: 938, y: 583, w: 58, h: 26 },
} as const;
/**
 * The sample's agent typed spentOn as text; the lesson's entity uses the date decorator. Moving
 * createdAt's own "date" label up onto spentOn's row shows what Fabricator draws for
 * `@date() spentOn` (ModelView.tsx labels a date field "date"), pixel for pixel in both themes.
 */
const SPENT_ON_SHIFT = -149;

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

/** Code in running text. */
const Mono = ({ children }: { children: ReactNode }) => <span style={{ fontFamily: MONO, fontWeight: 500 }}>{children}</span>;

/** A line from one point to another that draws itself on. */
function Beam({ from, to, at: start, color, width = 4, until, bend = 0 }: { from: readonly [number, number]; to: readonly [number, number]; at: number; color: string; width?: number; until?: number; bend?: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const p = ramp(frame, start, 14, ease.out);
  if (p <= 0 || (until !== undefined && frame > until + 12)) return null;
  const out = until === undefined ? 1 : 1 - ramp(frame, until, 12, ease.in);
  const [x1, y1] = from;
  const [x2, y2] = to;
  const d = `M ${x1} ${y1} Q ${(x1 + x2) / 2} ${(y1 + y2) / 2 - bend} ${x2} ${y2}`;
  return (
    <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0, overflow: 'visible', opacity: out }}>
      <path d={d} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" pathLength={1} strokeDasharray={`${p} 1`} />
    </svg>
  );
}

/** Splits a line's tokens at character `n`. */
function splitTokens(tokens: readonly Token[], n: number): [Token[], Token[]] {
  const head: Token[] = [];
  const tail: Token[] = [];
  let seen = 0;
  for (const t of tokens) {
    if (seen + t.text.length <= n) head.push(t);
    else if (seen >= n) tail.push(t);
    else {
      head.push({ ...t, text: t.text.slice(0, n - seen) });
      tail.push({ ...t, text: t.text.slice(n - seen) });
    }
    seen += t.text.length;
  }
  return [head, tail];
}

/**
 * One line of code in the editor's colors, in a glowing pill. With `opens`, its first `opens`
 * characters (a decorator) slide open in front of the rest at `openAt`. It turns green at `ok`
 * and red, with a shake, at `bad`.
 */
function CodeLine({ code, x, y, size = 40, from, until, opens = 0, openAt, ok, bad, label, labelColor }: { code: string; x: number; y: number; size?: number; from: number; until?: number; opens?: number; openAt?: number; ok?: number; bad?: number; label?: ReactNode; labelColor?: string }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  const P = CODE_PALETTES[C.name];
  if (frame < from || (until !== undefined && frame > until + 12)) return null;
  const p = pop(frame, fps, from, 12, 0.6);
  const out = until === undefined ? 1 : 1 - ramp(frame, until, 12, ease.in);
  const open = opens && openAt !== undefined ? ramp(frame, openAt, 10, ease.out) : 1;
  const [head, tail] = splitTokens(tokenize(code)[0] ?? [], opens);
  // Whichever cue came last decides the color: a line can go red, then green once it's fixed.
  const badOn = bad !== undefined && frame >= bad;
  const okOn = ok !== undefined && frame >= ok;
  const isBad = badOn && !(okOn && ok! > bad!);
  const isOk = okOn && !isBad;
  const ring = isBad ? RED : isOk ? C.ok : C.accent2;
  const shake = isBad && frame < bad! + 14 ? Math.sin((frame - bad!) * 2.4) * 8 * (1 - (frame - bad!) / 14) : 0;
  const snap = opens && openAt !== undefined && frame >= openAt + 8 ? 1 + 0.05 * (1 - ramp(frame, openAt + 8, 8, ease.out)) : 1;
  const span = (t: Token, i: number) => (
    <span key={i} style={{ color: colorOf(t, P) }}>
      {t.text}
    </span>
  );
  return (
    <div style={{ position: 'absolute', left: x, top: y, transform: `translate(calc(-50% + ${shake}px), -50%) scale(${(0.7 + 0.3 * p) * snap})`, opacity: Math.min(1, p * 1.5) * out }}>
      <div style={{ display: 'flex', alignItems: 'baseline', padding: `${size * 0.4}px ${size * 0.66}px`, borderRadius: size * 0.42, background: P.bg, border: `3px solid ${alpha(ring, 0.85)}`, boxShadow: `${C.shadow.panel}, ${C.glow(alpha(ring, isBad || isOk ? 0.5 : 0.28), 36, 3)}`, fontFamily: MONO, fontSize: size, whiteSpace: 'pre' }}>
        {opens ? <span style={{ display: 'inline-block', overflow: 'hidden', width: `${open * opens}ch`, opacity: open }}>{head.map(span)}</span> : null}
        <span>{(opens ? tail : tokenize(code)[0] ?? []).map(span)}</span>
      </div>
      {label ? (
        <div style={{ position: 'absolute', left: '50%', top: '100%', transform: 'translateX(-50%)', marginTop: 12, fontFamily: FONT, fontWeight: 650, fontSize: size * 0.62, color: labelColor ?? ring, whiteSpace: 'nowrap' }}>{label}</div>
      ) : null}
    </div>
  );
}

/** Rows that pop in on their cues: a check for a rule that holds, a cross for a value it turns away. */
function RuleList({ items, size = 28 }: { items: ReadonlyArray<{ text: ReactNode; at: number; bad?: boolean }>; size?: number }): JSX.Element {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {items.map((item, i) => {
        const p = frame < item.at ? 0 : pop(frame, fps, item.at, 11, 0.6);
        const color = item.bad ? RED : C.ok;
        const shake = item.bad && frame >= item.at && frame < item.at + 14 ? Math.sin((frame - item.at) * 2.4) * 7 * (1 - (frame - item.at) / 14) : 0;
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 14, opacity: Math.min(1, p * 1.5), transform: `translateX(${(1 - p) * 30 + shake}px)`, padding: '8px 14px', borderRadius: 12, background: alpha(color, 0.1), border: `1.5px solid ${alpha(color, 0.45)}` }}>
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

/** A file tree like Fabricator's Code view: folders, then the entity's file, lit on its cue. */
const TREE: ReadonlyArray<{ name: string; depth: number; folder?: boolean; key?: 'data' | 'file' }> = [
  { name: 'packages', depth: 0, folder: true },
  { name: 'data', depth: 1, folder: true, key: 'data' },
  { name: 'src', depth: 2, folder: true },
  { name: 'Expense.ts', depth: 3, key: 'file' },
  { name: 'index.ts', depth: 3 },
  { name: 'frontend', depth: 1, folder: true },
  { name: 'shared', depth: 1, folder: true },
];

function FileTree({ x, y, from, until, litAt }: { x: number; y: number; from: number; until: number; litAt: Record<'data' | 'file', number> }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  if (frame < from || frame > until + 12) return null;
  const p = pop(frame, fps, from, 12, 0.7);
  const out = 1 - ramp(frame, until, 12, ease.in);
  return (
    <div style={{ position: 'absolute', left: x, top: y, width: 380, transform: `translate(-50%, -50%) translateX(${(1 - p) * -40}px)`, opacity: Math.min(1, p * 1.5) * out, padding: '18px 14px', borderRadius: 22, background: C.panel.bg, border: `2px solid ${C.panel.border}`, boxShadow: C.shadow.panel }}>
      {TREE.map((row) => {
        const l = row.key ? lit(frame, litAt[row.key]) : 0;
        return (
          <div key={`${row.depth}-${row.name}`} style={{ display: 'flex', alignItems: 'center', gap: 12, height: 52, paddingLeft: 12 + row.depth * 30, borderRadius: 10, background: alpha(C.accent, 0.2 * l), boxShadow: l > 0 ? `inset 0 0 0 2px ${alpha(C.accent, 0.8 * l)}` : undefined }}>
            <Icon name={row.folder ? 'folder' : 'file'} color={row.folder ? AMBER : C.accent} size={28} />
            <span style={{ fontFamily: row.folder ? FONT : MONO, fontWeight: row.folder ? 650 : 500, fontSize: 27, color: C.ink }}>{row.name}</span>
          </div>
        );
      })}
    </div>
  );
}

/** One field decorator: the decorator, a value it holds, and what it's for. */
function TypeTile({ deco, sample, desc, x, y, from, litFrom, litTo, children }: { deco: string; sample?: ReactNode; desc: string; x: number; y: number; from: number; litFrom: number; litTo: number; children?: ReactNode }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  const P = CODE_PALETTES[C.name];
  if (frame < from) return null;
  const p = pop(frame, fps, from, 12, 0.6);
  const l = lit(frame, litFrom, litTo);
  return (
    <div style={{ position: 'absolute', left: x - 200, top: y - 130, width: 400, height: 260, borderRadius: 24, background: C.panel.bg, border: `3px solid ${alpha(C.accent, 0.25 + 0.75 * l)}`, boxShadow: `${C.shadow.panel}, ${C.glow(alpha(C.accent, 0.12 + 0.4 * l), 34, 2 + 4 * l)}`, opacity: Math.min(1, p * 1.5), transform: `scale(${(0.75 + 0.25 * p) * (1 + 0.04 * l)})`, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: '0 20px' }}>
      <div style={{ fontFamily: MONO, fontSize: 36, color: P.kinds.decorator, whiteSpace: 'nowrap' }}>{deco}</div>
      <div style={{ fontFamily: MONO, fontSize: 30, color: C.ink, whiteSpace: 'nowrap', minHeight: 40, display: 'flex', alignItems: 'center' }}>{children ?? sample}</div>
      <div style={{ fontFamily: FONT, fontWeight: 650, fontSize: 26, color: C.inkSoft, textAlign: 'center', lineHeight: 1.2 }}>{desc}</div>
    </div>
  );
}

/** A database column with a ruler for its length: full for a max, running off the edge with none. */
function ColumnCard({ x, y, width, at: from, until, limit, fillFrom, fillTo, dim = 0 }: { x: number; y: number; width: number; at: number; until?: number; limit: number | null; fillFrom: number; fillTo: number; dim?: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const C = useTheme();
  const fill = ramp(frame, fillFrom, Math.max(1, fillTo - fillFrom), ease.inOut);
  const color = limit === null ? AMBER : C.ok;
  return (
    <ArtifactCard x={x} y={y} width={width} icon="database" title={<Mono>title</Mono>} subtitle={limit === null ? 'As long as the database allows' : `Up to ${limit} characters`} at={from} until={until}>
      <div style={{ position: 'relative', height: 44, marginTop: 6, opacity: 1 - 0.7 * dim }}>
        <div style={{ position: 'absolute', left: 0, right: limit === null ? -60 : 0, top: 16, height: 14, borderRadius: 7, background: alpha(C.ink, 0.1) }} />
        <div style={{ position: 'absolute', left: 0, top: 16, height: 14, borderRadius: 7, width: limit === null ? `calc(${fill} * (100% + 60px))` : `${fill * 100}%`, background: `linear-gradient(90deg, ${alpha(color, 0.5)}, ${color})`, boxShadow: `0 0 16px ${alpha(color, 0.6)}` }} />
        {limit !== null ? (
          <div style={{ position: 'absolute', right: -4, top: 6, width: 4, height: 34, borderRadius: 2, background: color, opacity: fill }} />
        ) : null}
      </div>
    </ArtifactCard>
  );
}

/** The GraphQL schema Rayfin builds from the columns: it cracks and turns red at `failAt`. */
function SchemaNode({ x, y, from, until, failAt }: { x: number; y: number; from: number; until?: number; failAt: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  if (frame < from || (until !== undefined && frame > until + 12)) return null;
  const p = pop(frame, fps, from, 12, 0.6);
  const out = until === undefined ? 1 : 1 - ramp(frame, until, 12, ease.in);
  const f = ramp(frame, failAt, 8);
  const shake = frame >= failAt && frame < failAt + 16 ? Math.sin((frame - failAt) * 2.4) * 9 * (1 - (frame - failAt) / 16) : 0;
  const color = f > 0.5 ? RED : GRAPHQL;
  return (
    <div style={{ position: 'absolute', left: x, top: y, transform: `translate(calc(-50% + ${shake}px), -50%) scale(${0.7 + 0.3 * p})`, opacity: Math.min(1, p * 1.5) * out, width: 300, padding: '22px 20px', borderRadius: 24, background: C.panel.bg, border: `3px solid ${alpha(color, 0.85)}`, boxShadow: `${C.shadow.panel}, ${C.glow(alpha(color, 0.35), 34, 3)}`, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
      <div style={{ position: 'relative' }}>
        <Icon name="hexagon" color={color} size={74} />
        {f > 0 ? (
          <svg width={74} height={74} viewBox="0 0 24 24" style={{ position: 'absolute', inset: 0 }}>
            <path d="M12 3 L10.5 9 L13.5 12 L11 16.5 L12.5 21" fill="none" stroke={RED} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray={`${f} 1`} />
          </svg>
        ) : null}
      </div>
      <div style={{ fontFamily: FONT, fontWeight: 750, fontSize: 32, color: C.ink }}>GraphQL schema</div>
      <div style={{ fontFamily: FONT, fontWeight: 650, fontSize: 24, color: f > 0.5 ? RED : C.inkDim, whiteSpace: 'nowrap' }}>{f > 0.5 ? 'Fails to build' : 'Built from your columns'}</div>
    </div>
  );
}

/** A query from the app, which comes back with an error at `failAt`. */
function QueryCard({ x, y, from, until, failAt }: { x: number; y: number; from: number; until?: number; failAt: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const C = useTheme();
  const f = ramp(frame, failAt, 8);
  const shake = frame >= failAt && frame < failAt + 16 ? Math.sin((frame - failAt) * 2.4) * 8 * (1 - (frame - failAt) / 16) : 0;
  return (
    <ArtifactCard x={x} y={y} width={760} icon="client" title="Your app asks for its expenses" at={from} until={until}>
      <div style={{ transform: `translateX(${shake}px)`, display: 'flex', alignItems: 'center', gap: 16, padding: '14px 18px', borderRadius: 14, background: alpha(f > 0 ? RED : C.accent, 0.12), border: `2px solid ${alpha(f > 0 ? RED : C.accent, 0.5)}` }}>
        <Icon name={f > 0 ? 'x' : 'api'} color={f > 0 ? RED : C.accent} size={34} stroke={2.6} />
        <span style={{ fontFamily: MONO, fontWeight: 600, fontSize: 30, color: f > 0 ? RED : C.inkDim, whiteSpace: 'nowrap' }}>{f > 0 ? 'Internal server error' : 'Waiting for GraphQL…'}</span>
      </div>
    </ArtifactCard>
  );
}

/** An entity name GraphQL already uses: it gets a red cross on its cue. */
function NameTag({ name, x, y, from, until, rejectAt, ok }: { name: string; x: number; y: number; from: number; until: number; rejectAt?: number; ok?: boolean }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  if (frame < from || frame > until + 12) return null;
  const p = pop(frame, fps, from, 12, 0.6);
  const out = 1 - ramp(frame, until, 12, ease.in);
  const r = rejectAt === undefined ? 0 : ramp(frame, rejectAt, 8, ease.out);
  const color = ok ? C.ok : r > 0 ? RED : C.accent;
  return (
    <div style={{ position: 'absolute', left: x, top: y, transform: `translate(-50%, -50%) scale(${(0.7 + 0.3 * p) * (1 - 0.05 * r)}) rotate(${-3 * r}deg)`, opacity: Math.min(1, p * 1.5) * out, display: 'flex', alignItems: 'center', gap: 22, padding: '20px 34px', borderRadius: 22, background: C.panel.bg, border: `3px solid ${alpha(color, 0.85)}`, boxShadow: `${C.shadow.panel}, ${C.glow(alpha(color, 0.35), 32, 3)}` }}>
      <span style={{ fontFamily: FONT, fontWeight: 650, fontSize: 26, color: C.inkDim }}>entity</span>
      <span style={{ fontFamily: MONO, fontWeight: 600, fontSize: 52, color: C.ink }}>{name}</span>
      {ok || r > 0 ? (
        <div style={{ width: 56, height: 56, borderRadius: '50%', display: 'grid', placeItems: 'center', background: color, transform: `scale(${ok ? pop(frame, fps, from + 6, 10, 0.5) : r})` }}>
          <Icon name={ok ? 'check' : 'x'} color="#fff" size={36} stroke={3.2} />
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */
/*                                     1. The cold open                                       */
/* ------------------------------------------------------------------------------------------ */

const AMOUNT = lineWith('expense', 'amount!');
const AMOUNT_DECO = AMOUNT.indexOf('amount');
/** "each one": the other field decorators, each a question, in an arc under the line. */
const ASKING = [
  { deco: '@text()', x: 470, y: 560 },
  { deco: '@date()', x: 715, y: 640 },
  { deco: '@set(…)', x: 960, y: 670 },
  { deco: '@email()', x: 1205, y: 640 },
  { deco: '@int()', x: 1450, y: 560 },
] as const;

/** A decorator with a question mark: what does it do? */
function Asking({ deco, x, y, from, until }: { deco: string; x: number; y: number; from: number; until: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  const P = CODE_PALETTES[C.name];
  if (frame < from || frame > until + 12) return null;
  const p = pop(frame, fps, from, 12, 0.55);
  const out = 1 - ramp(frame, until, 12, ease.in);
  const bob = Math.sin((frame - from) / 9 + x) * 6;
  return (
    <div style={{ position: 'absolute', left: x, top: y + bob, transform: `translate(-50%, -50%) scale(${0.6 + 0.4 * p})`, opacity: Math.min(1, p * 1.5) * out, display: 'flex', alignItems: 'center', gap: 14, padding: '14px 22px', borderRadius: 18, background: P.bg, border: `2px solid ${alpha(C.accent, 0.5)}`, boxShadow: C.shadow.panel, fontFamily: MONO, fontSize: 32, color: P.kinds.decorator, whiteSpace: 'nowrap' }}>
      {deco}
      <span style={{ width: 38, height: 38, borderRadius: '50%', display: 'grid', placeItems: 'center', background: C.star, color: '#1b1200', fontFamily: FONT, fontWeight: 800, fontSize: 26 }}>?</span>
    </div>
  );
}

const coldOpen: LessonScene = {
  id: 'cold-open',
  ray: (c) => ({
    keys: [{ f: 0, x: 960, y: 1250, s: 0.6 }, swim(c.lead + 6, 'hook', ease.out), swim(c.span.duration, 'hook')],
    moods: [
      { f: 0, mood: 'idle' },
      { f: c.w('decorator') + 6, mood: 'surprised' },
      { f: c.w('Watch'), mood: 'happy' },
    ],
    rolls: [6],
    hops: [c.w('Watch'), c.w('rules')],
    gaze: [
      [0, 0, -0.9],
      [c.w('each'), 0, -0.4],
      [c.w('Watch'), 0, -0.9],
      [c.w('column'), -0.7, -0.6],
      [c.w('rules'), 0.7, -0.6],
    ],
  }),
  sfx: (c) => [
    { f: 4, id: 'swim-whoosh', volume: 0.4 },
    { f: c.w('field') - 2, id: 'pop', volume: 0.45 },
    { f: c.w('decorator') + 8, id: 'stamp', volume: 0.5 },
    { f: c.w('decorator') + 10, id: 'shimmer', volume: 0.35 },
    ...ASKING.map((_, i) => ({ f: c.w('each') + i * 4, id: 'pop' as const, volume: 0.28 })),
    { f: c.w('column'), id: 'pop', volume: 0.5 },
    { f: c.w('rules'), id: 'pop', volume: 0.5 },
    { f: c.w('follow') + 4, id: 'thud', volume: 0.4 },
    { f: c.span.duration - 16, id: 'sweep', volume: 0.45 },
  ],
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const C = useTheme();
    const exit = ramp(frame, ctx.span.duration - 18, 16, ease.in);
    const column = ctx.w('column');
    const rules = ctx.w('rules');
    return (
      <AbsoluteFill>
        <AbsoluteFill style={{ transform: `scale(${1 - 0.9 * exit})`, opacity: 1 - exit }}>
          <Beam from={[860, 360]} to={[620, 520]} at={column - 6} color={alpha(C.accent2, 0.7)} />
          <Beam from={[1060, 360]} to={[1300, 520]} at={rules - 6} color={alpha(C.accent2, 0.7)} />
          <CodeLine code={AMOUNT} x={960} y={300} size={52} from={ctx.w('field') - 2} opens={AMOUNT_DECO} openAt={ctx.w('decorator') - 2} />
          {ASKING.map((a, i) => (
            <Asking key={a.deco} {...a} from={ctx.w('each') + i * 4} until={ctx.w('Watch') - 6} />
          ))}
          <ArtifactCard x={620} y={690} width={460} icon="database" title="A database column" subtitle="Decimal, two places by default" at={column} lit={0.5}>
            <TableBody columns={['amount']} rows={[['42.50'], ['18.20'], ['6.75']]} rowsFrom={column + 8} />
          </ArtifactCard>
          <ArtifactCard x={1300} y={690} width={520} icon="shield" title="Rules it follows" at={rules} lit={0.5}>
            <RuleList
              items={[
                { text: 'Required: never empty', at: rules + 6 },
                { text: 'At least 0', at: rules + 14 },
                { text: <Mono>-5.00</Mono>, at: ctx.w('follow') + 2, bad: true },
              ]}
            />
          </ArtifactCard>
          <Burst kind="sparkles" at={ctx.w('decorator') + 8} x={960} y={300} count={14} seed={11} spread={2.2} />
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
      swim(c.span.duration, 'perchBL'),
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
    { f: c.w('write'), id: 'pop', volume: 0.5 },
    { f: c.w('what'), id: 'pop', volume: 0.5 },
    { f: c.w('register'), id: 'pop', volume: 0.5 },
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
          { text: 'How to write an entity', at: ctx.w('write') },
          { text: 'What each field decorator stores', at: ctx.w('what') },
          { text: 'How to register it', at: ctx.w('register') },
        ]}
      />
    </AbsoluteFill>
  ),
};

/* ------------------------------------------------------------------------------------------ */
/*                                   4. Write an entity                                       */
/* ------------------------------------------------------------------------------------------ */

const E = {
  entity: locate(ENTITY_CODE, '@entity()'),
  cls: locate(ENTITY_CODE, 'export class Expense {'),
  id: locate(ENTITY_CODE, '@uuid() id!: string;'),
  fields: ['@date() spentOn', '@decimal({ min: 0 })', "@set('Travel'", "@text({ optional: true, max: 500 })", '@date() createdAt', '@text({ max: 200 })'].map((t) => {
    const l = locate(ENTITY_CODE, t);
    // Ring just the decorator, up to its closing parenthesis.
    const text = ENTITY_CODE.split('\n')[l.line - 1];
    const close = text.indexOf(')', l.from);
    return { line: l.line, from: l.from, to: close + 1 };
  }),
} as const;
const FIELD_LINES = Array.from({ length: E.fields[E.fields.length - 1].line - E.id.line + 1 }, (_, i) => E.id.line + i);

const entity: LessonScene = {
  id: 'entity',
  dim: 0.3,
  ray: (c) => ({
    keys: [{ f: 0, ...SPOT.perchBL }, swim(c.span.duration, 'perchBL')],
    moods: [
      { f: 0, mood: 'idle' },
      { f: c.w('Leave'), mood: 'surprised' },
      { f: c.w('adds'), mood: 'happy' },
      { f: c.beat('en-3').from, mood: 'idle' },
    ],
    hops: [c.w('adds')],
    gaze: [
      [0, 0.4, -0.8],
      [c.w('file'), 0.2, -0.9],
      [c.w('ID'), 0.9, -0.7],
      [c.beat('en-3').from, 0.9, -0.5],
    ],
  }),
  sfx: (c) => [
    { f: 4, id: 'swim-whoosh', volume: 0.3 },
    { f: c.at('en-1', 'entity', 2), id: 'pop', volume: 0.45 },
    { f: c.w('file'), id: 'click', volume: 0.45 },
    { f: c.w('ID'), id: 'pop', volume: 0.45 },
    { f: c.w('adds'), id: 'shimmer', volume: 0.35 },
    ...E.fields.map((_, i) => ({ f: c.w('exactly') + i * 4, id: 'pop' as const, volume: 0.32 })),
  ],
  View: ({ ctx }) => {
    const end = ctx.span.duration - 14;
    const deco = ctx.at('en-1', 'entity', 2);
    const two = ctx.beat('en-2').from;
    const three = ctx.beat('en-3').from;
    const leave = ctx.w('Leave');
    return (
      <AbsoluteFill>
        <ChapterTag text="Write an entity" from={ctx.lead} to={end} />
        <FileTree x={300} y={520} from={ctx.lead + 2} until={end} litAt={{ data: ctx.w('data'), file: ctx.w('file') }} />
        <CodeCard
          code={ENTITY_CODE}
          file={EXPENSE_FILE}
          firstLine={ENTITY_FROM}
          x={1170}
          y={520}
          width={1260}
          fontSize={29}
          from={ctx.lead + 6}
          to={end}
          focus={[
            { lines: [E.entity.line, E.cls.line], from: deco - 4, to: two },
            { lines: [E.id.line], from: two, to: three },
            { lines: FIELD_LINES.filter((n) => n !== E.id.line), from: three, to: end + 20 },
          ]}
          marks={[
            { line: E.entity.line, from: E.entity.from, to: E.entity.to, at: deco, until: two - 2, label: 'Marks the class as an entity' },
            { line: E.id.line, from: E.id.from, to: E.id.to, at: ctx.w('ID'), until: leave - 2, label: 'A UUID primary key' },
            { line: E.id.line, from: E.id.from, to: E.id.to, at: leave, until: three - 2, label: 'Optional: Rayfin adds it for you', color: '#46ccb0' },
            ...E.fields.map((m, i) => ({ line: m.line, from: m.from, to: m.to, at: ctx.w('exactly') + i * 4, until: end })),
          ]}
        />
        <Chip x={1170} y={975} from={ctx.at('en-3', 'one') + 4} to={end} size={30}>
          One field decorator for each field you store
        </Chip>
      </AbsoluteFill>
    );
  },
};

/* ------------------------------------------------------------------------------------------ */
/*                                5. Eight field decorators                                   */
/* ------------------------------------------------------------------------------------------ */

const TILE_X = [315, 745, 1175, 1605] as const;
const TILE_Y = [400, 700] as const;

const TYPES: ReadonlyArray<{ deco: string; sample: string; desc: string; line: string; word: string }> = [
  { deco: '@text()', sample: 'Team lunch', desc: 'Strings', line: 'ty-1', word: 'Text' },
  { deco: '@int()', sample: '3', desc: 'Whole numbers', line: 'ty-1', word: 'Int' },
  { deco: '@decimal()', sample: '42.50', desc: 'Exact numbers, like money', line: 'ty-1', word: 'Decimal' },
  { deco: '@boolean()', sample: 'true', desc: 'True or false', line: 'ty-2', word: 'Boolean' },
  { deco: '@date()', sample: 'Oct 13, 9:30', desc: 'A date and time', line: 'ty-2', word: 'date' },
  { deco: '@uuid()', sample: '3f2a…c91e', desc: 'IDs', line: 'ty-2', word: 'uuid' },
  { deco: '@email()', sample: 'avery@contoso.com', desc: 'Text that looks like an email', line: 'ty-3', word: 'Email' },
  { deco: '@set(…)', sample: '', desc: 'Only the values you list', line: 'ty-3', word: 'set' },
];

const types: LessonScene = {
  id: 'types',
  dim: 0.3,
  ray: (c) => ({
    keys: [{ f: 0, ...SPOT.perchBL }, swim(26, 'perchBR'), swim(c.span.duration, 'perchBR')],
    moods: [
      { f: 0, mood: 'happy' },
      { f: 30, mood: 'idle' },
      { f: c.w('list'), mood: 'happy' },
    ],
    hops: [c.w('money'), c.w('list')],
    gaze: TYPES.map((t, i) => [c.at(t.line, t.word), (TILE_X[i % 4] - 1835) / 1000, (TILE_Y[Math.floor(i / 4)] - 985) / 500] as const),
  }),
  sfx: (c) => [{ f: 4, id: 'swim-whoosh', volume: 0.3 }, ...TYPES.map((t) => ({ f: c.at(t.line, t.word), id: 'pop' as const, volume: 0.45 })), { f: c.w('two'), id: 'chime', volume: 0.3 }],
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const C = useTheme();
    const end = ctx.span.duration - 14;
    const cues = TYPES.map((t) => ctx.at(t.line, t.word));
    const places = lit(frame, ctx.w('two'));
    return (
      <AbsoluteFill style={{ opacity: fadeOut(frame, ctx.span.duration, 12) }}>
        <ChapterTag text="Eight field decorators" from={ctx.lead} to={end} />
        {TYPES.map((t, i) => (
          <TypeTile key={t.deco} deco={t.deco} sample={t.sample} desc={t.desc} x={TILE_X[i % 4]} y={TILE_Y[Math.floor(i / 4)]} from={cues[i]} litFrom={cues[i]} litTo={i + 1 < cues.length ? cues[i + 1] : end}>
            {t.deco === '@decimal()' ? (
              <span>
                42<span style={{ color: C.ok, textShadow: places > 0 ? `0 0 14px ${alpha(C.ok, places)}` : undefined, borderBottom: `3px solid ${alpha(C.ok, places)}` }}>.50</span>
              </span>
            ) : t.deco === '@set(…)' ? (
              <span style={{ display: 'flex', gap: 8 }}>
                {CATEGORIES.map((v) => (
                  <span key={v} style={{ fontFamily: FONT, fontWeight: 650, fontSize: 21, padding: '4px 10px', borderRadius: 999, background: alpha(C.accent, 0.16), color: C.ink }}>
                    {v}
                  </span>
                ))}
              </span>
            ) : undefined}
          </TypeTile>
        ))}
        {TYPES.map((t, i) => (
          <Sonar key={t.deco} x={TILE_X[i % 4]} y={TILE_Y[Math.floor(i / 4)]} at={cues[i]} size={360} rings={1} color={alpha(i % 2 ? C.accent : C.accent2, 0.6)} />
        ))}
      </AbsoluteFill>
    );
  },
};

/* ------------------------------------------------------------------------------------------ */
/*                                6. Options shape each field                                 */
/* ------------------------------------------------------------------------------------------ */

const O = {
  optional: locate(CLASS, 'optional: true'),
  note: locate(CLASS, 'note?'),
  min: locate(CLASS, 'min: 0'),
  max500: locate(CLASS, 'max: 500'),
  max200: locate(CLASS, 'max: 200'),
  setValues: locate(CLASS, CATEGORIES.map((v) => `'${v}'`).join(', ')),
  union: locate(CLASS, CATEGORIES.map((v) => `'${v}'`).join(' | ')),
  unique: locate(TEAM, 'unique: true'),
  dflt: locate(TEAM, 'default: false'),
} as const;
/** The `?` after `note`. */
const QUESTION = { line: O.note.line, from: O.note.from + 4, to: O.note.from + 5 };
const CLASS_LINES = CLASS.split('\n').length;

const options: LessonScene = {
  id: 'options',
  dim: 0.3,
  ray: (c) => ({
    keys: [{ f: 0, ...SPOT.perchBR }, swim(28, 'perchBL'), swim(c.span.duration, 'perchBL')],
    moods: [
      { f: 0, mood: 'idle' },
      { f: c.w('both'), mood: 'happy' },
      { f: c.beat('op-2').from, mood: 'idle' },
      { f: c.w('enforces'), mood: 'happy' },
    ],
    hops: [c.w('both'), c.w('form')],
    gaze: [
      [0, 0.4, -0.6],
      [30, 0.9, -0.8],
      [c.beat('op-2').from, 0.9, -0.1],
      [c.beat('op-3').from, 0.9, -0.8],
      [c.w('form'), 1, -0.4],
    ],
  }),
  sfx: (c) => [
    { f: c.w('required'), id: 'pop', volume: 0.4 },
    { f: c.w('optional', 2), id: 'pop', volume: 0.45 },
    { f: c.w('question'), id: 'pop', volume: 0.45 },
    { f: c.w('both'), id: 'chime', volume: 0.3 },
    { f: c.beat('op-2').from, id: 'swim-whoosh', volume: 0.3 },
    { f: c.at('op-2', 'Default'), id: 'pop', volume: 0.45 },
    { f: c.w('Unique'), id: 'pop', volume: 0.45 },
    { f: c.w('Min'), id: 'pop', volume: 0.4 },
    { f: c.w('max'), id: 'pop', volume: 0.4 },
    { f: c.w("set's"), id: 'pop', volume: 0.4 },
    { f: c.w('again'), id: 'pop', volume: 0.4 },
    { f: c.w('enforces'), id: 'stamp', volume: 0.45 },
    { f: c.w('form'), id: 'pop', volume: 0.5 },
    { f: c.w('validator') + 8, id: 'thud', volume: 0.35 },
  ],
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const end = ctx.span.duration - 14;
    const one = ctx.beat('op-1').from;
    const two = ctx.beat('op-2').from;
    const three = ctx.beat('op-3').from;
    const four = ctx.beat('op-4').from;
    const five = ctx.beat('op-5').from;
    const enforces = ctx.w('enforces');
    const shift = ramp(frame, enforces - 4, 16, ease.inOut);
    const required = Array.from({ length: CLASS_LINES - 2 }, (_, i) => i + 2).filter((n) => n !== O.note.line);
    return (
      <AbsoluteFill>
        <ChapterTag text="Options shape each field" from={ctx.lead} to={end} />
        <AbsoluteFill style={{ transform: `translateX(${-330 * shift}px) scale(${1 - 0.24 * shift})`, transformOrigin: '50% 50%' }}>
          <CodeCard
            code={CLASS}
            file={EXPENSE_FILE}
            firstLine={CLASS_FROM}
            x={960}
            y={395}
            width={1240}
            fontSize={28}
            from={ctx.lead + 4}
            to={end}
            focus={[
              { lines: required, from: ctx.w('required') - 2, to: ctx.w('optional') },
              { lines: [O.note.line], from: ctx.w('optional'), to: two },
              { lines: [O.min.line, O.max500.line, O.max200.line], from: three, to: four },
              { lines: [O.setValues.line, O.union.line], from: four, to: five },
            ]}
            marks={[
              ...required.map((line) => ({ line, at: ctx.w('required'), until: ctx.w('optional') - 2, color: '#46ccb0' })),
              { line: O.optional.line, from: O.optional.from, to: O.optional.to, at: ctx.w('optional', 2), until: two - 2, label: '1. optional: true', labelSide: 'above' as const },
              { line: QUESTION.line, from: QUESTION.from, to: QUESTION.to, at: ctx.w('question'), until: two - 2, label: '2. and a ?', labelGap: 2 },
              { line: O.min.line, from: O.min.from, to: O.min.to, at: ctx.w('Min'), until: four - 2, label: 'A number’s range', labelGap: 3 },
              { line: O.max500.line, from: O.max500.from, to: O.max500.to, at: ctx.w('max'), until: four - 2, label: 'A text’s length', labelSide: 'above' as const },
              { line: O.max200.line, from: O.max200.from, to: O.max200.to, at: ctx.w('max'), until: four - 2 },
              { line: O.setValues.line, from: O.setValues.from, to: O.setValues.to, at: ctx.w("set's"), until: five - 2, label: 'In the decorator…', labelGap: 2 },
              { line: O.union.line, from: O.union.from, to: O.union.to, at: ctx.w('again'), until: five - 2, label: '…and as its type', labelSide: 'below' as const },
            ]}
          />
          <CodeCard
            code={TEAM}
            file={SNIPPETS.teammate.file}
            firstLine={TEAM_FROM}
            x={960}
            y={838}
            width={1240}
            fontSize={28}
            from={two}
            to={end}
            marks={[
              { line: O.dflt.line, from: O.dflt.from, to: O.dflt.to, at: ctx.at('op-2', 'Default'), until: three - 2, label: 'Filled in when you leave it out', labelGap: 2 },
              { line: O.unique.line, from: O.unique.from, to: O.unique.to, at: ctx.w('Unique'), until: three - 2, label: 'No two records share one', labelGap: 2 },
            ]}
          />
        </AbsoluteFill>
        <Chip x={960} y={70} from={ctx.w('required')} to={ctx.w('optional') - 2} size={30} accent="#46ccb0">
          Every field is required by default
        </Chip>
        <Chip x={960} y={70} from={ctx.w('both')} to={two - 2} size={30} accent="#46ccb0">
          Optional takes both: <Mono>optional: true</Mono> and a <Mono>?</Mono>
        </Chip>
        <ArtifactCard x={1480} y={330} width={700} icon="shield" title="Rayfin enforces them" at={enforces} until={end}>
          <RuleList
            size={25}
            items={[
              { text: 'spentOn, amount, category: required', at: enforces + 6 },
              { text: 'amount: at least 0', at: enforces + 12 },
              { text: 'category: one of the four', at: enforces + 18 },
              { text: 'note: up to 500 characters', at: enforces + 24 },
            ]}
          />
        </ArtifactCard>
        <ArtifactCard x={1480} y={790} width={700} icon="form" title="A form validator" subtitle={<Mono>toStandardSchema(Expense, …)</Mono>} at={ctx.w('form')} until={end}>
          <ValidationBody
            fields={[
              { label: 'amount', value: '-5', error: "Field 'amount' must be >= 0" },
              { label: 'category', value: 'Travel' },
            ]}
            failAt={ctx.w('validator') + 8}
          />
        </ArtifactCard>
      </AbsoluteFill>
    );
  },
};

/* ------------------------------------------------------------------------------------------ */
/*                                     7. Register it                                         */
/* ------------------------------------------------------------------------------------------ */

const REGISTER = SNIPPETS.register.code;
const SHARED = SNIPPETS.shared.code;
const R = {
  exportLine: locate(REGISTER, 'export { Expense };'),
  list: locate(REGISTER, '[Expense]'),
  record: locate(SHARED, 'export interface ExpenseRecord {'),
  entry: locate(SHARED, 'Expense: ExpenseRecord;'),
} as const;
/** How the client reaches the entity: a fragment of the typed check in snippets.ts. */
const CLIENT_LINE = 'client.data.Expense';
if (!SNIPPETS.typed.code.includes(CLIENT_LINE)) throw new Error(`"${CLIENT_LINE}" isn't in snippets.typed.`);
/** The CLI's message for an entity named Date: rayfin-core 1.36.2's dist/analysis/reserved-entity-names.js. */
const RESERVED = "Entity name 'Date' is a built-in GraphQL scalar type reserved by the platform";

const register: LessonScene = {
  id: 'register',
  dim: 0.3,
  ray: (c) => ({
    keys: [{ f: 0, ...SPOT.perchBL }, swim(28, 'perchBR'), swim(c.span.duration, 'perchBR')],
    moods: [
      { f: 0, mood: 'idle' },
      { f: c.w("doesn't"), mood: 'worried' },
      { f: c.beat('rg-2').from, mood: 'idle' },
      { f: c.w('checked'), mood: 'happy' },
      { f: c.w('rejects'), mood: 'surprised' },
      { f: c.w('EventDate'), mood: 'happy' },
    ],
    hops: [c.w('checked'), c.w('EventDate')],
    gaze: [
      [0, 0.4, -0.6],
      [30, -0.8, -0.6],
      [c.beat('rg-2').from, -1, -0.5],
      [c.beat('rg-3').from, -0.6, -0.6],
      [c.w('checked'), -0.9, -0.1],
      [c.beat('rg-4').from, -0.8, -0.6],
    ],
  }),
  sfx: (c) => [
    { f: 4, id: 'swim-whoosh', volume: 0.3 },
    { f: c.w("doesn't"), id: 'thud', volume: 0.4 },
    { f: c.w('export'), id: 'pop', volume: 0.45 },
    { f: c.w('schema'), id: 'pop', volume: 0.45 },
    { f: c.w('record'), id: 'pop', volume: 0.45 },
    { f: c.w('UniversalAppSchema'), id: 'pop', volume: 0.45 },
    { f: c.w('checked'), id: 'chime', volume: 0.4 },
    { f: c.w('Date'), id: 'pop', volume: 0.45 },
    { f: c.w('Query'), id: 'pop', volume: 0.45 },
    { f: c.w('rejects'), id: 'stamp', volume: 0.5 },
    { f: c.w('EventDate'), id: 'shimmer', volume: 0.4 },
  ],
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const end = ctx.span.duration - 14;
    const two = ctx.beat('rg-2').from;
    const three = ctx.beat('rg-3').from;
    const four = ctx.beat('rg-4').from;
    const checked = ctx.w('checked');
    const move = ramp(frame, two - 4, 18, ease.inOut);
    const down = ramp(frame, two - 4, 18, ease.inOut);
    return (
      <AbsoluteFill>
        <ChapterTag text="Register it" from={ctx.lead} to={end} />
        <div style={{ position: 'absolute', inset: 0, opacity: 1 - ramp(frame, four - 6, 12) }}>
          <CodeLine code={lineWith('expense', 'export class Expense')} x={960 - 470 * move} y={330 - 160 * move} size={44 - 10 * move} from={ctx.lead + 2} until={four} />
          <CodeLine
            code={CLIENT_LINE}
            x={960}
            y={600 + 330 * down}
            size={44 - 6 * down}
            from={ctx.w('register') + 4}
            until={four}
            bad={ctx.w("doesn't")}
            ok={checked}
            label={frame >= checked ? 'Typed, and visible to your client' : 'Not registered: your client can’t see it'}
          />
          <CodeCard
            code={REGISTER}
            file={SNIPPETS.register.file}
            x={520}
            y={480}
            width={840}
            fontSize={30}
            from={two}
            to={four}
            marks={[
              { line: R.exportLine.line, from: R.exportLine.from, to: R.exportLine.to, at: ctx.w('export'), until: four, label: 'Export the class', labelGap: 2 },
              { line: R.list.line, from: R.list.from, to: R.list.to, at: ctx.w('schema'), until: four, label: 'Add it to the schema list', labelSide: 'below' as const, labelFrom: 0 },
            ]}
          />
          <CodeCard
            code={SHARED}
            file={SNIPPETS.shared.file}
            x={1395}
            y={500}
            width={840}
            fontSize={25}
            from={three}
            to={four}
            marks={[
              { line: R.record.line, from: R.record.from, to: R.record.to, at: ctx.w('record'), until: four, label: 'Its record', labelGap: 1 },
              { line: R.entry.line, from: R.entry.from, to: R.entry.to, at: ctx.w('UniversalAppSchema'), until: four, label: 'What types your client', labelGap: 2 },
            ]}
          />
        </div>
        <NameTag name="Date" x={620} y={360} from={ctx.w('Date')} until={end} rejectAt={ctx.w('rejects')} />
        <NameTag name="Query" x={1300} y={360} from={ctx.w('Query')} until={end} rejectAt={ctx.w('rejects')} />
        <ArtifactCard x={960} y={600} width={1400} icon="terminal" title="The CLI says" at={ctx.w('CLI')} until={end}>
          <div style={{ fontFamily: MONO, fontSize: 26, color: RED, whiteSpace: 'nowrap' }}>{RESERVED}</div>
        </ArtifactCard>
        <NameTag name="EventDate" x={960} y={850} from={ctx.w('EventDate')} until={end} ok />
      </AbsoluteFill>
    );
  },
};

/* ------------------------------------------------------------------------------------------ */
/*                                     8. Deep Dive                                           */
/* ------------------------------------------------------------------------------------------ */

const TITLE_MAX = lineWith('taskFixed', 'title!');
const TITLE_BARE = lineWith('task', 'title!');
const NAME_50 = lineWith('project', 'name!');
const DESCRIPTION_2000 = lineWith('project', 'description!');
const EMAIL_LINE = lineWith('teammate', 'email!');
/** What rayfin up prints when it succeeds (renderSuccess in the CLI's dist/commands/up/render.js), as in lesson 2. */
const UP_DONE = '🎉 Project "my-app" is now deployed to Fabric!';

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
        { f: c.w('fail'), mood: 'worried' },
        { f: c.w('Worse'), mood: 'surprised' },
        { f: c.w('internal'), mood: 'worried' },
        { f: b.five, mood: 'happy' },
      ],
      rolls: [6],
      hops: [c.w('give'), c.w('same')],
      squishes: [c.w('error')],
      gaze: [
        [0, 0, 0.4],
        [c.w('What'), -0.8, -0.5],
        [b.one, -1, -0.6],
        [b.two, -1, -0.2],
        [b.three, -0.4, -0.3],
        [b.four, -0.8, -0.5],
        [c.w('queries'), -0.8, -0.1],
        [b.five, -0.8, -0.5],
      ],
    };
  },
  sfx: (c) => {
    const b = deepBeats(c);
    return [
      { f: 0, id: 'dive', volume: 0.55 },
      { f: c.at('dd-1', 'Text'), id: 'pop', volume: 0.45 },
      { f: c.w('characters'), id: 'sonar', volume: 0.3 },
      { f: c.w('Leave'), id: 'pop', volume: 0.45 },
      { f: c.w('maximum'), id: 'sonar', volume: 0.3 },
      { f: c.w('GraphQL'), id: 'pop', volume: 0.4 },
      { f: c.w('fail'), id: 'thud', volume: 0.5 },
      { f: c.w('rayfin') - 2, id: 'typing', volume: 0.28, duration: 16 },
      { f: c.w('success'), id: 'chime', volume: 0.35 },
      { f: c.w('queries'), id: 'pop', volume: 0.4 },
      { f: c.w('internal'), id: 'thud', volume: 0.55 },
      { f: b.five, id: 'sweep', volume: 0.4 },
      { f: c.w('fifty'), id: 'pop', volume: 0.45 },
      { f: c.at('dd-5', 'two'), id: 'pop', volume: 0.45 },
      { f: c.w('Email'), id: 'pop', volume: 0.45 },
    ];
  },
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const C = useTheme();
    const b = deepBeats(ctx);
    const end = ctx.span.duration - 14;
    const rowsDim = ramp(frame, b.four - 4, 10);
    return (
      <AbsoluteFill style={{ opacity: fadeOut(frame, ctx.span.duration, 12) }}>
        <DeepDiveTitle from={ctx.lead} to={end} subtitle="Why every text needs a max" tuckAt={ctx.w('What')} />
        <DepthGauge from={0} to={ctx.span.duration - 20} />
        <Chip x={1060} y={250} from={ctx.w('What')} to={b.one - 2} size={38}>
          What happens to a text field with no max?
        </Chip>
        <div style={{ position: 'absolute', inset: 0, opacity: 1 - 0.75 * rowsDim * (1 - ramp(frame, b.five - 6, 8)) }}>
          <Beam from={[930, 390]} to={[1080, 390]} at={ctx.w('column') - 4} until={b.five - 6} color={alpha(C.ok, 0.7)} />
          <CodeLine code={TITLE_MAX} x={640} y={390} size={34} from={ctx.at('dd-1', 'Text') - 2} until={b.five - 6} ok={ctx.w('characters')} />
          <ColumnCard x={1330} y={390} width={500} at={ctx.w('column')} until={b.five - 6} limit={200} fillFrom={ctx.at('dd-1', 'two')} fillTo={ctx.wEnd('characters')} />
          <Beam from={[860, 680]} to={[960, 680]} at={ctx.w('Leave') + 6} until={b.five - 6} color={alpha(AMBER, 0.7)} />
          <CodeLine code={TITLE_BARE} x={590} y={680} size={34} from={ctx.w('Leave') - 2} until={b.five - 6} bad={ctx.w('fail')} />
          <ColumnCard x={1200} y={680} width={460} at={ctx.w('Leave') + 8} until={b.five - 6} limit={null} fillFrom={ctx.w('maximum')} fillTo={ctx.w('maximum') + 24} />
          <Beam from={[1436, 680]} to={[1506, 680]} at={ctx.w('some') - 4} until={b.five - 6} color={alpha(RED, 0.7)} />
          <SchemaNode x={1660} y={680} from={ctx.w('some') - 4} until={b.five - 6} failAt={ctx.w('fail')} />
          <Chip x={1660} y={860} from={ctx.w('some') + 2} to={b.four - 4} size={24} accent={AMBER}>
            On some databases
          </Chip>
        </div>
        <CommandCard
          command="npx rayfin up"
          output={[
            { text: '…', at: ctx.w('rayfin') + 16, color: '#7d7d7d' },
            { text: UP_DONE, at: ctx.w('success'), color: C.ok },
          ]}
          from={b.four}
          to={b.five - 6}
          typeFrom={ctx.w('rayfin') - 2}
          typeTo={ctx.w('rayfin') + 14}
          tagAt={ctx.w('success') + 4}
          x={1080}
          y={420}
          width={1100}
        />
        <QueryCard x={1080} y={790} from={ctx.w('queries') - 2} until={b.five - 6} failAt={ctx.w('internal')} />
        <CodeLine code={TITLE_MAX} x={1080} y={380} size={36} from={b.five} until={end} ok={b.five + 6} />
        <CodeLine code={NAME_50} x={1080} y={560} size={36} from={ctx.w('fifty')} until={end} ok={ctx.w('fifty') + 6} label="A short name" labelColor={C.inkSoft} />
        <CodeLine code={DESCRIPTION_2000} x={1080} y={740} size={36} from={ctx.at('dd-5', 'two')} until={end} ok={ctx.at('dd-5', 'two') + 6} label="A description" labelColor={C.inkSoft} />
        <CodeLine code={EMAIL_LINE} x={1080} y={925} size={32} from={ctx.w('Email')} until={end} ok={ctx.w('same')} />
        <Sonar x={1330} y={390} at={ctx.w('column')} size={420} rings={2} color={alpha(C.ok, 0.6)} />
        <Sonar x={1200} y={680} at={ctx.w('Leave') + 8} size={420} rings={2} color={alpha(AMBER, 0.6)} />
        <Burst kind="sparkles" at={b.five + 6} x={1080} y={380} count={12} seed={51} spread={2} />
      </AbsoluteFill>
    );
  },
};

/* ------------------------------------------------------------------------------------------ */
/*                                 9. See it in Fabricator                                    */
/* ------------------------------------------------------------------------------------------ */

const FAB = { x: 960, y: 565, width: 1500 } as const;

const fabricator: LessonScene = {
  id: 'fabricator',
  dim: 0.35,
  ray: (c) => ({
    keys: [{ f: 0, ...SPOT.deep }, swim(28, 'fabricator'), swim(c.span.duration, 'fabricator')],
    moods: [
      { f: 0, mood: 'happy' },
      { f: 30, mood: 'idle' },
      { f: c.w('enum'), mood: 'happy' },
      { f: c.w('filled'), mood: 'idle' },
    ],
    hops: [c.w('enum'), c.w('Open')],
    gaze: [
      [0, -0.6, -0.4],
      [30, -0.9, 0.4],
      [c.w('key'), -1, 0.3],
      [c.w('Open'), -1, 0.7],
    ],
  }),
  sfx: (c) => [
    { f: 0, id: 'surface', volume: 0.5 },
    { f: c.w('card'), id: 'swim-whoosh', volume: 0.3 },
    { f: c.w('type'), id: 'pop', volume: 0.4 },
    { f: c.w('key'), id: 'pop', volume: 0.4 },
    { f: c.w('enum'), id: 'pop', volume: 0.4 },
    { f: c.w('filled'), id: 'pop', volume: 0.4 },
    { f: c.w('hollow'), id: 'pop', volume: 0.4 },
    { f: c.w('Open'), id: 'click', volume: 0.5 },
  ],
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const end = ctx.span.duration - 14;
    const win = windowLife(frame, fps, ctx.lead, end);
    const zoom = track(frame, [
      [ctx.w('card') - 6, 1],
      [ctx.w('card') + 22, 1.62],
    ]);
    const two = ctx.beat('fab-2').from;
    const three = ctx.beat('fab-3').from;
    const four = ctx.beat('fab-4').from;
    return (
      <AbsoluteFill>
        <ChapterTag text="See it in Fabricator" from={ctx.lead} to={end} />
        {win ? (
          <AppWindow shot={MODEL} x={FAB.x} y={FAB.y} width={FAB.width} zoom={zoom} fx={800} fy={555} opacity={win.opacity} scale={win.scale}>
            <div style={{ position: 'absolute', left: 0, top: 0, transform: `translateY(${SPENT_ON_SHIFT}px)` }}>
              <ShotRegion shot={MODEL} {...PX.dateLabel} />
            </div>
            <Spotlight {...PX.card} radius={18} dim={0.45} opacity={lit(frame, ctx.w('card'), ctx.w('type'))} />
            <Spotlight {...PX.types} radius={12} dim={0.45} opacity={lit(frame, ctx.w('type'), two)} />
            <Spotlight {...PX.idRow} radius={10} dim={0.45} opacity={lit(frame, ctx.w('key'), ctx.w('set'))} />
            <Spotlight {...PX.categoryRow} radius={10} dim={0.45} opacity={lit(frame, ctx.w('set'), three)} />
            <Spotlight {...PX.marks} radius={10} dim={0.45} opacity={lit(frame, ctx.w('filled'), ctx.w('hollow'))} />
            <Spotlight {...PX.noteRow} radius={10} dim={0.45} opacity={lit(frame, ctx.w('hollow'), four)} />
            <Spotlight {...PX.open} radius={12} dim={0.45} opacity={lit(frame, ctx.w('Open'))} />
          </AppWindow>
        ) : null}
        <Chip x={960} y={985} from={ctx.w('type') + 2} to={two - 2} size={30}>
          Every field, with its type
        </Chip>
        <Chip x={960} y={985} from={ctx.w('key')} to={three - 2} size={30}>
          <span>
            Key: the primary key · <Mono>enum</Mono>: a set
          </span>
        </Chip>
        <Chip x={960} y={985} from={ctx.w('filled')} to={four - 2} size={30}>
          ◆ required · ◇ optional
        </Chip>
        <Chip x={960} y={985} from={ctx.w('Open')} to={end} size={30}>
          Open: the entity’s file, in Code
        </Chip>
      </AbsoluteFill>
    );
  },
};

/* ------------------------------------------------------------------------------------------ */
/*                                     10. Pop quiz                                           */
/* ------------------------------------------------------------------------------------------ */

const QUIZ_FIELD = TITLE_BARE;

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
        [reveal, -0.9, 0.4],
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
  View: ({ ctx }) => {
    const C = useTheme();
    return (
      <Quiz
        question={
          <span>
            What’s wrong with this field?
            <br />
            <span style={{ fontFamily: MONO, fontWeight: 500, fontSize: 48, color: C.accent }}>{QUIZ_FIELD}</span>
          </span>
        }
        options={[
          { text: 'It needs a question mark', at: ctx.at('quiz-options', 'A') },
          { text: 'It has no max', at: ctx.at('quiz-options', 'B') },
          { text: 'Text can’t be required', at: ctx.at('quiz-options', 'C') },
        ]}
        answer={1}
        countdown={{ from: ctx.beat('countdown').from, step: 30 }}
        revealAt={ctx.beat('quiz-answer').from + 3}
        from={ctx.lead}
        to={ctx.span.duration - 14}
        x={880}
      />
    );
  },
};

/* ------------------------------------------------------------------------------------------ */
/*                                11. Recap, 12. Challenge                                    */
/* ------------------------------------------------------------------------------------------ */

const recap: LessonScene = {
  id: 'recap',
  ray: (c) => ({
    keys: [{ f: 0, ...SPOT.quiz }, swim(26, 'recap'), swim(c.span.duration, 'recap')],
    moods: [{ f: 0, mood: 'happy' }],
    hops: [c.w('stored'), c.w('Register'), c.w('give')],
    gaze: [
      [0, -0.6, 0.6],
      [30, -0.9, -0.7],
    ],
  }),
  sfx: (c) => ['stored', 'Register', 'give'].map((w) => ({ f: c.w(w) + 6, id: 'stamp' as const, volume: 0.4 })),
  View: ({ ctx }) => (
    <Recap
      from={ctx.lead}
      to={ctx.span.duration - 14}
      items={[
        { text: 'Each stored field gets one decorator, and its options become rules', at: ctx.w('stored') },
        { text: 'Register every entity in the data and shared packages', at: ctx.w('Register') },
        {
          text: (
            <span>
              Give every <Mono>@text</Mono> a <Mono>max</Mono>
            </span>
          ),
          at: ctx.w('give'),
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
    { f: c.w('send'), id: 'typing', volume: 0.28, duration: c.w('find') + 24 - c.w('send') },
    { f: c.beat('challenge-2').from, id: 'pop', volume: 0.5 },
  ],
  View: ({ ctx }) => <Challenge prompt={YOUTUBE.challenge.prompt} from={ctx.lead} to={ctx.span.duration - 14} typeFrom={ctx.w('send')} typeTo={ctx.w('find') + 24} cta={YOUTUBE.challenge.question} ctaAt={ctx.beat('challenge-2').from} />,
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
    const back = c.wEnd('type') + 8;
    return {
      keys: [{ f: 0, ...SPOT.end }, swim(20, 'fact', ease.out), swim(back, 'fact'), swim(back + 22, 'end'), swim(c.span.duration, 'end')],
      moods: [
        { f: 0, mood: 'idle' },
        { f: c.w('despite'), mood: 'surprised' },
        { f: c.w('Talk') - 2, mood: 'happy' },
      ],
      squishes: [c.w('Talk') - 2, c.w('Talk') + 10],
      waves: [back + 24],
      gaze: [
        [0, 0, 0.1],
        [c.w('despite'), -0.4, 0],
        [c.w('Talk'), 0, 0.1],
      ],
    };
  },
  sfx: (c) => [
    { f: 2, id: 'swim-whoosh', volume: 0.3 },
    { f: c.w('Talk'), id: 'boing', volume: 0.35 },
    { f: c.wEnd('type') + 8, id: 'swim-whoosh', volume: 0.3 },
  ],
  View: ({ ctx }) => (
    <AbsoluteFill>
      <TheEnd from={-400} to={ctx.span.duration + 400} />
      <Chip x={SPOT.fact.x} y={430} from={10} to={ctx.wEnd('type') + 6} accent="#ffb547" size={26}>
        RAY FACT
      </Chip>
      <Burst kind="bubbles" at={ctx.w('Talk')} x={SPOT.fact.x} y={SPOT.fact.y} count={10} seed={91} />
    </AbsoluteFill>
  ),
};

/** Lesson 4's scenes, in the script's order. */
export const SCENES: readonly LessonScene[] = [coldOpen, bumper, welcome, entity, types, options, register, deepDive, fabricator, quiz, recap, challenge, next, stinger];
