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
import { AppWindow, Spotlight } from '../../src/ui/AppWindow';
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
const TEAL = '#46ccb0';

/* ------------------------------------------------------------------------------------------ */
/*                                    Code and sample data                                    */
/* ------------------------------------------------------------------------------------------ */

/** Part of a snippet, as a scene shows it: it must be in the snippet, word for word. */
function fragment(key: keyof typeof SNIPPETS, text: string): string {
  if (!SNIPPETS[key].code.includes(text)) throw new Error(`"${text}" isn't in snippet ${key}.`);
  return text;
}

const EXPENSE = SNIPPETS.expense.code;
const EXPENSE_FROM = locate(EXPENSE, 'export class Expense {').line;
/** Expense's class, from `export class Expense {` to its `}`. */
const EXPENSE_CLASS = lines('expense', EXPENSE_FROM, EXPENSE.split('\n').length);
const REPORT = SNIPPETS.report.code;
const REPORT_FROM = locate(REPORT, 'export class Report {').line;
const REPORT_CLASS = lines('report', REPORT_FROM, REPORT.split('\n').length);
const JOIN = SNIPPETS.expenseTag.code;
const JOIN_FROM = locate(JOIN, 'export class ExpenseTag {').line;
const JOIN_CLASS = lines('expenseTag', JOIN_FROM, JOIN.split('\n').length);

const ONE = fragment('expense', '@one(() => Report, { optional: true })');
const MANY = fragment('report', '@many(() => Expense)');
const ONE_EXPENSE = fragment('expenseTag', '@one(() => Expense)');
const ONE_TAG = fragment('expenseTag', '@one(() => Tag)');
const IMPORT_REPORT = lineWith('expense', "from './Report.js'");
const IMPORT_EXPENSE = lineWith('report', "from './Expense.js'");
const FILE = fragment('client', 'client.data.Expense.update({ id: expense.id }, { report: { id: report.id } })');
const WITH_REPORTS = fragment('client', "client.data.Expense.select(['amount', 'spentOn', 'report.title']).execute()");
const WITH_AMOUNTS = fragment('client', "client.data.Report.select(['title', 'expenses.amount']).execute()");
const TAGS_OF = fragment('client', "client.data.ExpenseTag.select(['tag.name']).where({ expense_id: { eq: expense.id } }).execute()");
const REMOVE = fragment('client', 'client.data.Report.delete({ id: report.id })');

/** Columns `from` to `to` of the first `text` in `code`, for a mark on a one-line pill. */
function span(code: string, text: string): { from: number; to: number } {
  const from = code.indexOf(text);
  if (from < 0) throw new Error(`"${text}" isn't in "${code}".`);
  return { from, to: from + text.length };
}

/**
 * What the client gets back when a delete would leave records pointing at nothing, or a write
 * points at a record that isn't there: checked on Rayfin 1.36.2's own backend, on SQL Server and
 * on PostgreSQL alike (see script.ts).
 */
const DEPENDS = 'Cannot complete this operation because other items depend on this record. Remove the dependent items first.';

/** The sample records the lesson files, moves, reads and deletes. */
const TAXI = { note: 'Taxi', amount: '18.20' };
const HOTEL = { note: 'Hotel', amount: '240.00' };
const LUNCH = { note: 'Team lunch', amount: '42.50' };
const BERLIN = 'Berlin trip';
const OFFSITE = 'Team offsite';
const TAGS = ['Client visit', 'Billable'] as const;
/** IDs as a table shows them, shortened. */
const IDS = { berlin: '7c1e…', offsite: '9b2d…', missing: '0000…', owner: 'a3f9…' } as const;
/** The categories lesson 4's set decorator lists. */
const CATEGORIES = ['Travel', 'Meals', 'Software', 'Office'] as const;
if (!EXPENSE.includes(CATEGORIES.map((c) => `'${c}'`).join(', '))) throw new Error('The categories changed in snippets.expense.');

/** A field as a Data model card shows it: its type is the target entity for a relationship. */
interface Field {
  name: string;
  type: string;
  kind?: 'key' | 'link';
}
/** Lesson 4's Expense: no relationships. */
const ISLAND: readonly Field[] = [
  { name: 'id', type: 'uuid', kind: 'key' },
  { name: 'spentOn', type: 'date' },
  { name: 'amount', type: 'decimal' },
  { name: 'category', type: 'enum' },
  { name: 'note', type: 'text' },
  { name: 'createdAt', type: 'date' },
  { name: 'owner_id', type: 'text' },
];
const LINKED: readonly Field[] = [...ISLAND.slice(0, 6), { name: 'report', type: 'Report', kind: 'link' }, ISLAND[6]];
const REPORT_FIELDS: readonly Field[] = [
  { name: 'id', type: 'uuid', kind: 'key' },
  { name: 'title', type: 'text' },
  { name: 'expenses', type: 'Expense[]', kind: 'link' },
  { name: 'owner_id', type: 'text' },
];
for (const [code, fields] of [
  [EXPENSE, LINKED],
  [REPORT, REPORT_FIELDS],
] as const) {
  for (const f of fields) if (f.name !== 'id' && !code.includes(` ${f.name}`)) throw new Error(`${f.name} isn't a field in its snippet.`);
}

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
  return (
    <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0, overflow: 'visible', opacity: out }}>
      {dashed ? (
        <>
          <mask id={`m-${x1}-${y1}-${x2}-${y2}`}>
            <path d={d} fill="none" stroke="#fff" strokeWidth={width + 4} pathLength={1} strokeDasharray={`${p} 1`} />
          </mask>
          <path d={d} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeDasharray="10 12" mask={`url(#m-${x1}-${y1}-${x2}-${y2})`} />
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
            const o = lit(frame, m.at, m.until);
            if (o <= 0) return null;
            const color = m.color ?? C.accent;
            return (
              <span key={i} style={{ position: 'absolute', left: `calc(${m.from}ch - 6px)`, width: `calc(${m.to - m.from}ch + 12px)`, top: '-0.18em', height: '1.36em', borderRadius: 10, border: `3px solid ${color}`, background: alpha(color, 0.14), boxShadow: C.glow(alpha(color, 0.45), 18, 2), opacity: o }}>
                {m.label ? (
                  <span style={{ position: 'absolute', left: '50%', top: '100%', transform: 'translateX(-50%)', marginTop: size * 0.55, fontFamily: FONT, fontWeight: 650, fontSize: Math.max(24, size * 0.8), color, whiteSpace: 'nowrap' }}>{m.label}</span>
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

/** A Data model card's header and row heights. */
const HEAD = 62;
const ROW = 46;
/** The middle of a card's `i`th row, from the card's top. */
const rowY = (top: number, i: number): number => top + HEAD + 8 + i * ROW + ROW / 2;
const cardHeight = (rows: number): number => HEAD + 16 + rows * ROW;

/** An entity drawn as a Data model card: its name, then each field with its type. Rows light up on cues. */
function EntityCard({ name, fields, x, top, width = 520, from, until, lights = [] }: { name: string; fields: readonly Field[]; x: number; top: number; width?: number; from: number; until?: number; lights?: ReadonlyArray<{ row: string; from: number; to?: number; color?: string }> }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  const l = life(frame, fps, from, until);
  if (!l) return null;
  return (
    <div style={{ position: 'absolute', left: x - width / 2, top, width, height: cardHeight(fields.length), borderRadius: 18, background: C.panel.bg, border: `2px solid ${alpha(C.accent, 0.55)}`, boxShadow: `${C.shadow.panel}, ${C.glow(alpha(C.accent, 0.18), 30, 2)}`, overflow: 'hidden', opacity: Math.min(1, l.p * 1.5) * l.out, transform: `scale(${0.82 + 0.18 * l.p})` }}>
      <div style={{ height: HEAD, display: 'flex', alignItems: 'center', justifyContent: 'center', background: alpha(C.accent, 0.24), borderBottom: `2px solid ${alpha(C.accent, 0.4)}`, fontFamily: FONT, fontWeight: 750, fontSize: 32, color: C.ink }}>{name}</div>
      <div style={{ padding: '8px 10px' }}>
        {fields.map((f) => {
          const mine = lights.filter((li) => li.row === f.name);
          const light = mine.reduce((m, li) => Math.max(m, lit(frame, li.from, li.to)), 0);
          const color = mine[0]?.color ?? C.accent2;
          return (
            <div key={f.name} style={{ height: ROW, display: 'flex', alignItems: 'center', gap: 12, padding: '0 12px', borderRadius: 10, background: alpha(color, 0.2 * light), boxShadow: light > 0 ? `inset 0 0 0 2px ${alpha(color, 0.85 * light)}` : undefined }}>
              <span style={{ width: 28, display: 'grid', placeItems: 'center' }}>
                {f.kind === 'key' ? <Icon name="key" color={AMBER} size={24} stroke={2.2} /> : f.kind === 'link' ? <Icon name="link" color={C.accent} size={24} stroke={2.2} /> : <span style={{ color: C.inkDim, fontSize: 16 }}>◆</span>}
              </span>
              <span style={{ fontFamily: MONO, fontSize: 26, fontWeight: 500, color: f.kind === 'link' ? C.accent : C.ink }}>{f.name}</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontFamily: MONO, fontSize: 22, color: C.inkDim }}>{f.type}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Where the `i`th expense sits inside a report box. */
const slotY = (boxY: number, boxH: number, i: number): number => boxY - boxH / 2 + 118 + i * 74;

/** A report: a folder with its title, which can be renamed, and room for the expenses filed in it. */
function ReportBox({ title, renamed, renameAt, x, y, width = 480, height = 330, from, until, ring, gone }: { title: string; renamed?: string; renameAt?: number; x: number; y: number; width?: number; height?: number; from: number; until?: number; ring?: string; gone?: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  const l = life(frame, fps, from, until);
  if (!l) return null;
  const color = ring ?? AMBER;
  const renaming = renamed !== undefined && renameAt !== undefined && frame >= renameAt;
  const shown = renaming ? renamed.slice(0, Math.round(ramp(frame, renameAt, 18, ease.linear) * renamed.length)) : title;
  const typing = renaming && shown.length < renamed.length;
  const g = gone === undefined ? 0 : ramp(frame, gone, 14, ease.in);
  return (
    <div style={{ position: 'absolute', left: x - width / 2, top: y - height / 2, width, height, borderRadius: 24, background: C.panel.bg, border: `2.5px dashed ${alpha(color, 0.75)}`, boxShadow: `${C.shadow.panel}, ${C.glow(alpha(color, 0.18), 30, 2)}`, opacity: Math.min(1, l.p * 1.5) * l.out * (1 - g), transform: `scale(${(0.8 + 0.2 * l.p) * (1 - 0.3 * g)})` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '20px 24px' }}>
        <Icon name="folder" color={color} size={40} stroke={2} />
        <span style={{ fontFamily: FONT, fontWeight: 750, fontSize: 34, color: C.ink, whiteSpace: 'nowrap' }}>
          {shown}
          {typing ? <span style={{ color: C.accent }}>▍</span> : null}
        </span>
      </div>
    </div>
  );
}

/** An expense as a receipt: what it was, and how much. The caller moves it. */
function Receipt({ note, amount, x, y, from, until, width = 330, ring, bad, ok, dim = 0, glow = 0 }: { note: string; amount: string; x: number; y: number; from: number; until?: number; width?: number; ring?: string; bad?: number; ok?: number; dim?: number; glow?: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  const l = life(frame, fps, from, until);
  if (!l) return null;
  const color = bad !== undefined && frame >= bad ? RED : ok !== undefined && frame >= ok ? C.ok : ring ?? C.accent;
  return (
    <div style={{ position: 'absolute', left: x, top: y, width, transform: `translate(calc(-50% + ${shake(frame, bad)}px), -50%) scale(${(0.7 + 0.3 * l.p) * (1 + 0.06 * glow)})`, opacity: Math.min(1, l.p * 1.5) * l.out * (1 - 0.65 * dim), display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px', borderRadius: 16, background: C.panel.bg, border: `2px solid ${alpha(color, 0.7 + 0.3 * glow)}`, boxShadow: `${C.shadow.chip}, ${C.glow(alpha(color, 0.22 + 0.4 * glow), 22, 2)}` }}>
      <Icon name="receipt" color={color} size={30} stroke={2} />
      <span style={{ fontFamily: FONT, fontWeight: 650, fontSize: 28, color: C.ink, whiteSpace: 'nowrap' }}>{note}</span>
      <span style={{ flex: 1 }} />
      <span style={{ fontFamily: MONO, fontSize: 26, color: C.inkSoft }}>{amount}</span>
    </div>
  );
}

/** A pill: an icon and a few words, centered on a point. Tags and ExpenseTag links use it. */
function Pill({ icon, color, children, x, y, from, until, glow = 0, dim = 0, bad }: { icon: IconName; color: string; children: ReactNode; x: number; y: number; from: number; until?: number; glow?: number; dim?: number; bad?: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  const l = life(frame, fps, from, until);
  if (!l) return null;
  const ring = bad !== undefined && frame >= bad ? RED : color;
  return (
    <div style={{ position: 'absolute', left: x, top: y, transform: `translate(calc(-50% + ${shake(frame, bad)}px), -50%) scale(${(0.7 + 0.3 * l.p) * (1 + 0.06 * glow)})`, opacity: Math.min(1, l.p * 1.5) * l.out * (1 - 0.65 * dim), display: 'flex', alignItems: 'center', gap: 12, padding: '12px 22px', borderRadius: 999, background: C.panel.bg, border: `2px solid ${alpha(ring, 0.7 + 0.3 * glow)}`, boxShadow: `${C.shadow.chip}, ${C.glow(alpha(ring, 0.2 + 0.45 * glow), 22, 2)}`, fontFamily: FONT, fontWeight: 650, fontSize: 28, color: C.ink, whiteSpace: 'nowrap' }}>
      <Icon name={icon} color={ring} size={28} stroke={2.2} />
      {children}
    </div>
  );
}

/** A database table whose cells can change on cue: rows fill in from `rowsFrom`, and a column can light up. */
function DataTable({ columns, rows, rowsFrom, every = 6, widths, hi }: { columns: readonly string[]; rows: ReadonlyArray<{ cells: readonly ReactNode[]; at?: number; color?: string; bad?: number; gone?: number }>; rowsFrom: number; every?: number; widths?: readonly number[]; hi?: { col: number; from: number; to?: number; color?: string } }): JSX.Element {
  const frame = useCurrentFrame();
  const C = useTheme();
  const w = widths ?? columns.map(() => 1);
  const sum = w.reduce((a, b) => a + b, 0);
  const grid = w.map((n) => `minmax(0, ${n}fr)`).join(' ');
  const h = hi ? lit(frame, hi.from, hi.to) : 0;
  const hc = hi?.color ?? C.accent2;
  const left = hi ? (w.slice(0, hi.col).reduce((a, b) => a + b, 0) / sum) * 100 : 0;
  const width = hi ? (w[hi.col] / sum) * 100 : 0;
  return (
    <div style={{ position: 'relative', borderRadius: 12, overflow: 'hidden', border: `1.5px solid ${C.panel.border}`, fontFamily: MONO, fontSize: 24 }}>
      <div style={{ display: 'grid', gridTemplateColumns: grid, background: alpha(C.accent, 0.16), color: C.accent, fontWeight: 600 }}>
        {columns.map((c) => (
          <div key={c} style={{ padding: '10px 14px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c}</div>
        ))}
      </div>
      {rows.map((row, i) => {
        const start = row.at ?? rowsFrom + i * every;
        const p = ramp(frame, start, 8, ease.out);
        const g = row.gone === undefined ? 0 : ramp(frame, row.gone, 10, ease.in);
        const color = row.bad !== undefined && frame >= row.bad ? RED : row.color;
        return (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: grid, color: color ?? C.text, borderTop: `1px solid ${C.panel.border}`, opacity: p * (1 - g), transform: `translate(${shake(frame, row.bad, 7)}px, ${(1 - p) * 10}px)`, background: color ? alpha(color, 0.1) : 'transparent', height: 48, overflow: 'hidden' }}>
            {row.cells.map((cell, k) => (
              <div key={k} style={{ padding: '9px 14px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{cell}</div>
            ))}
          </div>
        );
      })}
      {h > 0 ? <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${left}%`, width: `${width}%`, borderRadius: 10, border: `3px solid ${alpha(hc, h)}`, background: alpha(hc, 0.12 * h), boxShadow: C.glow(alpha(hc, 0.4 * h), 18, 2) }} /> : null}
    </div>
  );
}

/** A low island of sand under an entity that links to nothing, ringed by water. */
function Island({ x, y, width, height, from, until }: { x: number; y: number; width: number; height: number; from: number; until?: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  const l = life(frame, fps, from, until);
  if (!l) return null;
  const ripple = 1 + 0.025 * Math.sin(frame / 9);
  return (
    <div style={{ position: 'absolute', left: x - width / 2, top: y - height / 2, width, height, opacity: Math.min(1, l.p * 1.3) * l.out, transform: `scale(${(0.6 + 0.4 * l.p) * ripple})` }}>
      <div style={{ position: 'absolute', inset: -34, borderRadius: '50%', border: `3px dashed ${alpha(TEAL, 0.55)}` }} />
      <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: `radial-gradient(ellipse at 50% 45%, ${alpha(AMBER, 0.42)}, ${alpha(AMBER, 0.16)} 60%, ${alpha(C.accent, 0.05)} 100%)` }} />
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */
/*                                     1. Cold open                                           */
/* ------------------------------------------------------------------------------------------ */

/** The cold open's report box, and where its three expenses float before they're filed. */
const OPEN_BOX = { x: 560, y: 560, w: 480, h: 330 } as const;
const OPEN_FLOAT = [
  [1380, 400],
  [1450, 560],
  [1360, 720],
] as const;
const OPEN_ITEMS = [TAXI, HOTEL, LUNCH] as const;

const coldOpen: LessonScene = {
  id: 'cold-open',
  ray: (c) => ({
    keys: [{ f: 0, x: 960, y: 1250, s: 0.6 }, swim(c.lead + 6, 'hook', ease.out), swim(c.span.duration, 'hook')],
    moods: [
      { f: 0, mood: 'idle' },
      { f: c.w('Two'), mood: 'surprised' },
      { f: c.w('link'), mood: 'happy' },
    ],
    rolls: [6],
    hops: [c.w('link'), c.w('you') + 10],
    gaze: [
      [0, 0, -0.9],
      [c.w('report'), -0.8, -0.6],
      [c.w('expenses'), 0.8, -0.6],
      [c.w('Two'), 0, -0.9],
      [c.w('link'), -0.6, -0.6],
    ],
  }),
  sfx: (c) => [
    { f: 4, id: 'swim-whoosh', volume: 0.4 },
    { f: c.w('customer'), id: 'pop', volume: 0.35 },
    { f: c.w('report'), id: 'pop', volume: 0.45 },
    ...OPEN_ITEMS.map((_, i) => ({ f: c.w('expenses') + i * 4, id: 'pop' as const, volume: 0.32 })),
    { f: c.w('How'), id: 'boing', volume: 0.3 },
    { f: c.w('Two'), id: 'stamp', volume: 0.45 },
    { f: c.w('each'), id: 'shimmer', volume: 0.35 },
    { f: c.w('link'), id: 'chime', volume: 0.4 },
    { f: c.w('you'), id: 'swim-whoosh', volume: 0.3 },
    { f: c.span.duration - 16, id: 'sweep', volume: 0.45 },
  ],
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const C = useTheme();
    const exit = ramp(frame, ctx.span.duration - 18, 16, ease.in);
    const together = ctx.w('together');
    const link = ctx.w('link');
    const fly = ctx.w('you') - 4;
    return (
      <AbsoluteFill>
        <AbsoluteFill style={{ transform: `scale(${1 - 0.9 * exit})`, opacity: 1 - exit }}>
          <Chip x={960} y={130} from={ctx.w('customer')} to={ctx.w('How') - 4} size={30} accent={C.inkDim}>
            1 customer → many orders · 1 report → many expenses
          </Chip>
          <ReportBox title={BERLIN} x={OPEN_BOX.x} y={OPEN_BOX.y} width={OPEN_BOX.w} height={OPEN_BOX.h} from={ctx.w('report')} />
          {OPEN_ITEMS.map((item, i) => {
            const [fx, fy] = OPEN_FLOAT[i];
            const bob = Math.sin((frame + i * 17) / 14) * 6;
            const tx = track(frame, [
              [fly + i * 3, fx],
              [fly + i * 3 + 16, OPEN_BOX.x, ease.inOut],
            ]);
            const ty = track(frame, [
              [fly + i * 3, fy + bob],
              [fly + i * 3 + 16, slotY(OPEN_BOX.y, OPEN_BOX.h, i), ease.inOut],
            ]);
            return (
              <div key={item.note}>
                <Beam from={[fx - 175, fy]} to={[OPEN_BOX.x + OPEN_BOX.w / 2 + 6, OPEN_BOX.y - 60 + i * 60]} at={together + i * 3} until={link} color={alpha(AMBER, 0.65)} dashed />
                <Beam from={[fx - 175, fy]} to={[OPEN_BOX.x + OPEN_BOX.w / 2 + 6, OPEN_BOX.y - 60 + i * 60]} at={link + i * 3} until={fly + i * 3} color={alpha(C.accent, 0.9)} width={5} />
                <Receipt note={item.note} amount={item.amount} x={tx} y={ty} from={ctx.w('expenses') + i * 4} ring={frame >= link ? C.accent : AMBER} />
              </div>
            );
          })}
          <Pill icon="question" color={AMBER} x={960} y={900} from={ctx.w('How')} until={ctx.beat('hook-2').from - 2}>
            Which ones go together?
          </Pill>
          <CodeLine code={MANY} x={OPEN_BOX.x} y={250} size={34} from={ctx.w('Two')} ok={ctx.w('each')} />
          <CodeLine code={ONE} x={1380} y={250} size={34} from={ctx.w('Two') + 6} ok={ctx.w('each') + 4} />
          <Burst kind="sparkles" at={fly + 16} x={OPEN_BOX.x} y={OPEN_BOX.y} count={14} seed={11} spread={2.2} />
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
    { f: c.w('link'), id: 'pop', volume: 0.5 },
    { f: c.w('one'), id: 'pop', volume: 0.5 },
    { f: c.w('delete'), id: 'pop', volume: 0.5 },
    { f: c.w('dive'), id: 'swim-whoosh', volume: 0.4 },
  ],
  View: ({ ctx }) => (
    <AbsoluteFill>
      <Burst kind="bubbles" at={ctx.w('Hi')} x={1000} y={470} count={10} seed={21} />
      <Chip x={960} y={790} from={ctx.w("I'm")} to={ctx.beat('today').from} accent={TEAL} size={36}>
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
          { text: 'When your data needs a link', at: ctx.w('link') },
          { text: 'The one and many decorators', at: ctx.w('one') },
          { text: 'What happens when you delete', at: ctx.w('delete') },
        ]}
      />
    </AbsoluteFill>
  ),
};

/* ------------------------------------------------------------------------------------------ */
/*                                   4. Islands or links?                                     */
/* ------------------------------------------------------------------------------------------ */

const ISLE = { x: 620, top: 330 } as const;
/** The report box reports are created in, renamed and filled. */
const BOX = { x: 960, y: 520, w: 560, h: 360 } as const;
/** is-5's two linked cards. */
const LINK_CARDS = { expense: { x: 560, top: 300 }, report: { x: 1360, top: 400 } } as const;

function islandBeats(c: LessonCtx) {
  return { two: c.beat('is-2').from, three: c.beat('is-3').from, four: c.beat('is-4').from, five: c.beat('is-5').from };
}

const islands: LessonScene = {
  id: 'islands',
  dim: 0.3,
  ray: (c) => {
    const b = islandBeats(c);
    return {
      keys: [{ f: 0, ...SPOT.perchBR }, swim(c.span.duration, 'perchBR')],
      moods: [
        { f: 0, mood: 'idle' },
        { f: c.w('need'), mood: 'happy' },
        { f: b.two, mood: 'idle' },
        { f: c.w('different'), mood: 'idle' },
        { f: c.w('typo'), mood: 'worried' },
        { f: b.five, mood: 'happy' },
      ],
      hops: [c.w('need'), c.at('is-5', 'link')],
      squishes: [c.w('two')],
      gaze: [
        [0, -0.9, -0.5],
        [c.w('category'), -0.6, -0.8],
        [c.w('owner_id'), -0.6, -0.5],
        [b.three, -0.9, -0.6],
        [b.four, -0.9, -0.5],
        [c.w('two'), -0.9, -0.2],
        [b.five, -0.9, -0.6],
      ],
    };
  },
  sfx: (c) => {
    const b = islandBeats(c);
    const rename = c.at('is-4', 'rename');
    return [
      { f: 4, id: 'swim-whoosh', volume: 0.3 },
      { f: c.w('island'), id: 'shimmer', volume: 0.35 },
      { f: c.w('need'), id: 'chime', volume: 0.35 },
      { f: c.w('fixed'), id: 'pop', volume: 0.45 },
      { f: c.w('owner_id'), id: 'pop', volume: 0.45 },
      { f: b.three, id: 'sweep', volume: 0.3 },
      { f: c.w('create'), id: 'pop', volume: 0.45 },
      { f: c.w('rename'), id: 'typing', volume: 0.28, duration: 18 },
      { f: c.w('file'), id: 'swim-whoosh', volume: 0.35 },
      { f: b.four, id: 'pop', volume: 0.4 },
      ...[0, 1, 2].map((i) => ({ f: rename + i * 8, id: 'click' as const, volume: 0.4 })),
      { f: c.w('typo'), id: 'thud', volume: 0.45 },
      { f: c.w('two'), id: 'boing', volume: 0.3 },
      { f: b.five, id: 'sweep', volume: 0.3 },
      { f: c.at('is-5', 'link'), id: 'chime', volume: 0.4 },
    ];
  },
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const C = useTheme();
    const b = islandBeats(ctx);
    const end = ctx.span.duration - 14;
    const leaveA = b.three - 4;
    const fileAt = ctx.w('file');
    const rename = ctx.at('is-4', 'rename');
    const typo = ctx.w('typo');
    const link = ctx.at('is-5', 'link');
    const islandH = cardHeight(ISLAND.length);
    /** The report cell is-4 shows on each expense: a copy of the title, edited one by one. */
    const copy = (i: number): ReactNode => {
      const edit = rename + i * 8;
      if (i === 2 && frame >= typo) return 'Berlin tirp';
      if (frame < edit) return 'Q3 travel';
      return <span style={{ color: frame < edit + 10 ? AMBER : undefined }}>{BERLIN}</span>;
    };
    return (
      <AbsoluteFill>
        <ChapterTag text="Islands or links?" from={ctx.lead} to={end} />
        {/* is-1, is-2: lesson 4's Expense, on its own. */}
        <Island x={ISLE.x} y={ISLE.top + islandH - 10} width={780} height={150} from={ctx.w('island')} until={leaveA} />
        <EntityCard
          name="Expense"
          fields={ISLAND}
          x={ISLE.x}
          top={ISLE.top}
          from={ctx.lead + 2}
          until={leaveA}
          lights={[
            { row: 'category', from: ctx.w('category'), to: ctx.w('owner_id'), color: TEAL },
            { row: 'owner_id', from: ctx.w('owner_id'), color: AMBER },
          ]}
        />
        <Chip x={ISLE.x} y={240} from={ctx.w('island')} to={ctx.w('need') - 2} size={30} accent={TEAL}>
          An island: no links
        </Chip>
        <Chip x={ISLE.x} y={240} from={ctx.w('need')} to={leaveA} size={30} accent={C.ok}>
          For a lot of data, that’s all you need
        </Chip>
        <Beam from={[ISLE.x + 262, rowY(ISLE.top, 3)]} to={[1075, 430]} at={ctx.w('fixed') - 4} until={leaveA} color={alpha(TEAL, 0.7)} />
        <ArtifactCard x={1360} y={430} width={560} icon="table" title="A fixed list" subtitle="The set decorator: nothing to link to" at={ctx.w('fixed')} until={leaveA}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {CATEGORIES.map((v, i) => (
              <span key={v} style={{ fontFamily: FONT, fontWeight: 650, fontSize: 26, padding: '6px 16px', borderRadius: 999, background: alpha(TEAL, 0.16), border: `1.5px solid ${alpha(TEAL, 0.5)}`, color: C.ink, opacity: ramp(frame, ctx.w('set') + i * 3, 6) }}>
                {v}
              </span>
            ))}
          </div>
        </ArtifactCard>
        <Beam from={[ISLE.x + 262, rowY(ISLE.top, 6)]} to={[1075, 740]} at={ctx.w('owner_id') - 4} until={leaveA} color={alpha(AMBER, 0.7)} />
        <ArtifactCard x={1360} y={740} width={560} icon="signin" title="Who signed in" subtitle="Plain text, from sign-in" at={ctx.w('owner_id')} until={leaveA}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, opacity: ramp(frame, ctx.w('link'), 8), fontFamily: FONT, fontWeight: 650, fontSize: 26, color: C.inkSoft }}>
            <Icon name="x" color={C.inkDim} size={28} stroke={2.6} />
            Not a link to another entity
          </div>
        </ArtifactCard>
        {/* is-3: a report people create, rename and file expenses in. */}
        <ReportBox title="Q3 travel" renamed={BERLIN} renameAt={ctx.w('rename')} x={BOX.x} y={BOX.y} width={BOX.w} height={BOX.h} from={ctx.w('create')} until={b.four - 4} />
        {[TAXI, HOTEL, LUNCH].map((item, i) => (
          <Receipt key={item.note} note={item.note} amount={item.amount} width={420} x={track(frame, [[fileAt + i * 4, 2100], [fileAt + i * 4 + 16, BOX.x, ease.out]])} y={slotY(BOX.y, BOX.h, i)} from={fileAt + i * 4} until={b.four - 4} />
        ))}
        {/* is-4: the title copied onto each expense. */}
        <ArtifactCard x={960} y={540} width={1000} icon="database" title="Your expenses" subtitle="With the report’s title typed onto each one" at={b.four} until={b.five - 4}>
          <DataTable
            columns={['note', 'amount', 'report']}
            widths={[1.2, 1, 1.5]}
            rowsFrom={b.four + 6}
            rows={[TAXI, HOTEL, LUNCH].map((item, i) => ({ cells: [item.note, item.amount, copy(i)], bad: i === 2 ? typo : undefined }))}
            hi={{ col: 2, from: ctx.at('is-4', 'title'), to: b.five - 4, color: AMBER }}
          />
        </ArtifactCard>
        <Chip x={960} y={250} from={rename} to={typo - 2} size={30} accent={AMBER}>
          A rename: edit every copy
        </Chip>
        <Chip x={960} y={250} from={typo} to={b.five - 4} size={30} accent={RED}>
          <span>
            Two reports now: <b>{BERLIN}</b> and <b>Berlin tirp</b>
          </span>
        </Chip>
        {/* is-5: its own entity, and a link. */}
        <EntityCard name="Expense" fields={LINKED} x={LINK_CARDS.expense.x} top={LINK_CARDS.expense.top} from={b.five} until={end} lights={[{ row: 'report', from: link }]} />
        <EntityCard name="Report" fields={REPORT_FIELDS} x={LINK_CARDS.report.x} top={LINK_CARDS.report.top} from={ctx.w('own')} until={end} lights={[{ row: 'expenses', from: link }]} />
        <Beam from={[LINK_CARDS.expense.x + 262, rowY(LINK_CARDS.expense.top, 6)]} to={[LINK_CARDS.report.x - 262, rowY(LINK_CARDS.report.top, 2)]} at={link} until={end} color={C.accent} width={5} />
        <Chip x={960} y={200} from={ctx.w('share')} to={end} size={30}>
          Created and shared? Its own entity, and a link
        </Chip>
        <Burst kind="sparkles" at={link + 10} x={(LINK_CARDS.expense.x + LINK_CARDS.report.x) / 2} y={(rowY(LINK_CARDS.expense.top, 6) + rowY(LINK_CARDS.report.top, 2)) / 2} count={12} seed={41} spread={1.6} />
      </AbsoluteFill>
    );
  },
};

/* ------------------------------------------------------------------------------------------ */
/*                                     5. One and many                                        */
/* ------------------------------------------------------------------------------------------ */

const OM = {
  one: locate(EXPENSE_CLASS, ONE),
  question: locate(EXPENSE_CLASS, 'report?'),
  optional: locate(EXPENSE_CLASS, 'optional: true }) report'),
  many: locate(REPORT_CLASS, MANY),
} as const;
/** The right-hand panel, beside the code. */
const SIDE = { x: 1580, w: 600 } as const;

function oneManyBeats(c: LessonCtx) {
  return { two: c.beat('om-2').from, three: c.beat('om-3').from, four: c.beat('om-4').from };
}

const oneMany: LessonScene = {
  id: 'one-many',
  dim: 0.3,
  ray: (c) => {
    const b = oneManyBeats(c);
    return {
      keys: [{ f: 0, ...SPOT.perchBR }, swim(c.span.duration, 'perchBR')],
      moods: [
        { f: 0, mood: 'idle' },
        { f: c.w('foreign'), mood: 'happy' },
        { f: b.three, mood: 'idle' },
        { f: c.w('back'), mood: 'happy' },
        { f: b.four, mood: 'idle' },
        { f: c.w('type'), mood: 'worried' },
        { f: c.w('type') + 30, mood: 'idle' },
      ],
      hops: [c.w('foreign'), c.w('back'), c.w('plain')],
      gaze: [
        [0, -0.9, -0.6],
        [c.w('single'), -0.3, -0.8],
        [b.two, -0.4, -0.6],
        [b.three, -0.9, -0.7],
        [c.w('back'), -0.3, -0.8],
        [b.four, -0.9, -0.6],
      ],
    };
  },
  sfx: (c) => {
    const b = oneManyBeats(c);
    return [
      { f: 4, id: 'swim-whoosh', volume: 0.3 },
      { f: c.w('one'), id: 'pop', volume: 0.45 },
      { f: c.w('single'), id: 'pop', volume: 0.4 },
      { f: c.w('question'), id: 'pop', volume: 0.45 },
      { f: c.w('wait'), id: 'pop', volume: 0.4 },
      { f: b.two, id: 'sweep', volume: 0.3 },
      { f: c.w('foreign'), id: 'stamp', volume: 0.45 },
      { f: c.w("don't"), id: 'pop', volume: 0.4 },
      { f: b.three, id: 'sweep', volume: 0.3 },
      { f: c.w('many'), id: 'pop', volume: 0.45 },
      { f: c.w('back'), id: 'swim-whoosh', volume: 0.3 },
      { f: c.at('om-3', 'column'), id: 'pop', volume: 0.4 },
      { f: b.four, id: 'sweep', volume: 0.3 },
      { f: c.w('arrow'), id: 'pop', volume: 0.45 },
      { f: c.at('om-4', 'import'), id: 'swim-whoosh', volume: 0.35 },
      { f: c.w('plain'), id: 'chime', volume: 0.35 },
      { f: c.w('type'), id: 'thud', volume: 0.4 },
    ];
  },
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const C = useTheme();
    const b = oneManyBeats(ctx);
    const end = ctx.span.duration - 14;
    const single = ctx.w('single');
    const back = ctx.w('back');
    const imports = ctx.at('om-4', 'import');
    const sink = (i: number) => track(frame, [[back + i * 4, 1180], [back + i * 4 + 14, 400 - 165 + 118 + i * 74, ease.out]]);
    return (
      <AbsoluteFill>
        <ChapterTag text="One and many" from={ctx.lead} to={end} />
        {/* om-1, om-2: Expense's side. */}
        <CodeCard
          code={EXPENSE_CLASS}
          file={SNIPPETS.expense.file}
          firstLine={EXPENSE_FROM}
          x={680}
          y={520}
          width={1120}
          fontSize={28}
          from={ctx.lead + 4}
          to={b.three - 2}
          focus={[{ lines: [OM.one.line], from: ctx.w('one') - 2, to: b.three }]}
          marks={[
            { line: OM.one.line, from: OM.one.from, to: OM.one.to, at: ctx.w('one'), until: b.two - 2 },
            { line: OM.question.line, from: OM.question.from + 6, to: OM.question.from + 7, at: ctx.w('question'), until: b.two - 2, color: TEAL },
            { line: OM.optional.line, from: OM.optional.from, to: OM.optional.from + 14, at: ctx.w('optional'), until: b.two - 2, color: TEAL },
          ]}
        />
        <Receipt note={TAXI.note} amount={TAXI.amount} x={SIDE.x} y={300} from={single - 6} until={b.two - 2} width={380} />
        <Beam from={[SIDE.x, 334]} to={[SIDE.x, 430]} at={single} until={b.two - 2} color={alpha(C.accent, 0.85)} width={5} />
        <ReportBox title={BERLIN} x={SIDE.x} y={500} width={440} height={130} from={single + 4} until={b.two - 2} />
        <Chip x={SIDE.x} y={600} from={single + 8} to={ctx.w('question') - 2} size={26}>
          Exactly one report
        </Chip>
        <Receipt note={LUNCH.note} amount={LUNCH.amount} x={SIDE.x} y={720} from={ctx.w('wait')} until={b.two - 2} width={380} ring={TEAL} />
        <Chip x={SIDE.x} y={810} from={ctx.w('wait') + 4} to={b.two - 2} size={26} accent={TEAL}>
          Optional: not filed yet
        </Chip>
        <ArtifactCard x={SIDE.x} y={500} width={SIDE.w} icon="database" title="Your expenses" subtitle="In your database" at={b.two} until={b.three - 2}>
          <DataTable
            columns={['note', 'amount', 'report_id']}
            widths={[1.25, 1, 1.15]}
            rowsFrom={b.two + 6}
            rows={[
              { cells: [TAXI.note, TAXI.amount, IDS.berlin] },
              { cells: [LUNCH.note, LUNCH.amount, '—'] },
            ]}
            hi={{ col: 2, from: ctx.w('column') }}
          />
        </ArtifactCard>
        <Chip x={SIDE.x} y={700} from={ctx.w('foreign')} to={b.three - 2} size={28} accent={C.accent2}>
          report_id: a foreign key
        </Chip>
        <Chip x={680} y={940} from={ctx.w("don't")} to={b.three - 2} size={28} accent={TEAL}>
          Rayfin adds it: there’s no report_id in your class
        </Chip>
        {/* om-3: Report's side. */}
        <CodeCard
          code={REPORT_CLASS}
          file={SNIPPETS.report.file}
          firstLine={REPORT_FROM}
          x={680}
          y={460}
          width={1120}
          fontSize={30}
          from={b.three}
          to={b.four - 2}
          marks={[{ line: OM.many.line, from: OM.many.from, to: OM.many.to, at: ctx.w('many'), until: b.four - 2 }]}
        />
        <ReportBox title={BERLIN} x={SIDE.x} y={400} width={460} height={330} from={b.three + 4} until={b.four - 2} />
        {[TAXI, HOTEL].map((item, i) => (
          <Receipt key={item.note} note={item.note} amount={item.amount} x={SIDE.x} y={sink(i)} from={back + i * 4} until={b.four - 2} width={380} />
        ))}
        <Chip x={SIDE.x} y={630} from={back + 8} to={b.four - 2} size={26}>
          The way back: all its expenses
        </Chip>
        <ArtifactCard x={SIDE.x} y={800} width={SIDE.w} icon="database" title="Your reports" subtitle="No column for its expenses" at={ctx.at('om-3', 'column')} until={b.four - 2}>
          <DataTable columns={['id', 'title', 'owner_id']} widths={[0.9, 1.4, 1]} rowsFrom={ctx.at('om-3', 'column') + 6} rows={[{ cells: [IDS.berlin, BERLIN, IDS.owner] }]} />
        </ArtifactCard>
        {/* om-4: the arrows, and the imports they make possible. */}
        <Pill icon="file" color={C.accent} x={500} y={250} from={b.four}>
          Expense.ts
        </Pill>
        <Pill icon="file" color={C.accent} x={1420} y={250} from={b.four + 4}>
          Report.ts
        </Pill>
        <CodeLine code={IMPORT_REPORT} x={500} y={400} size={30} from={b.four + 6} ok={ctx.w('plain')} />
        <CodeLine code={IMPORT_EXPENSE} x={1420} y={400} size={30} from={b.four + 10} ok={ctx.w('plain') + 4} />
        <Beam from={[860, 382]} to={[1048, 382]} at={imports} color={alpha(C.accent, 0.85)} bend={70} />
        <Beam from={[1048, 418]} to={[860, 418]} at={imports + 6} color={alpha(C.accent, 0.85)} bend={-70} />
        <CodeLine code={ONE} x={500} y={600} size={30} from={b.four + 6} marks={[{ ...span(ONE, '() => Report'), at: ctx.w('arrow'), label: 'An arrow to the class' }]} />
        <CodeLine code={MANY} x={1420} y={600} size={30} from={b.four + 10} marks={[{ ...span(MANY, '() => Expense'), at: ctx.w('arrow') + 4, label: 'An arrow to the class' }]} />
        <Pill icon="x" color={RED} x={960} y={850} from={ctx.w('type')}>
          <span>
            Not <s style={{ fontFamily: MONO, fontWeight: 500 }}>import type</s>: it’s erased when your code compiles
          </span>
        </Pill>
      </AbsoluteFill>
    );
  },
};

/* ------------------------------------------------------------------------------------------ */
/*                                6. Write and read across it                                 */
/* ------------------------------------------------------------------------------------------ */

const MOVE = { from: { x: 620, y: 640 }, to: { x: 1300, y: 640 }, w: 520, h: 330 } as const;

/** A report's amounts, as `expenses.amount` brings them, adding up on cue. */
function Amounts({ amounts, total, addAt }: { amounts: readonly string[]; total: string; addAt: number }): JSX.Element {
  const frame = useCurrentFrame();
  const C = useTheme();
  const t = ramp(frame, addAt, 10, ease.out);
  return (
    <div style={{ fontFamily: MONO, fontSize: 30, color: C.text, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, paddingRight: 10 }}>
      {amounts.map((a) => (
        <div key={a}>{a}</div>
      ))}
      <div style={{ marginTop: 6, paddingTop: 8, borderTop: `2px solid ${alpha(C.ok, t)}`, color: C.ok, fontWeight: 700, opacity: t, transform: `translateY(${(1 - t) * 10}px)` }}>= {total}</div>
    </div>
  );
}

function clientBeats(c: LessonCtx) {
  return { two: c.beat('cl-2').from, three: c.beat('cl-3').from, four: c.beat('cl-4').from };
}

const client: LessonScene = {
  id: 'client',
  dim: 0.3,
  ray: (c) => {
    const b = clientBeats(c);
    return {
      keys: [{ f: 0, ...SPOT.perchBR }, swim(28, 'perchBL'), swim(c.span.duration, 'perchBL')],
      moods: [
        { f: 0, mood: 'idle' },
        { f: c.w('fills'), mood: 'happy' },
        { f: b.two, mood: 'idle' },
        { f: c.w('move'), mood: 'happy' },
        { f: b.three, mood: 'idle' },
        { f: c.w('add'), mood: 'happy' },
      ],
      hops: [c.w('fills'), c.w('move') + 10, c.w('add')],
      gaze: [
        [0, 0.6, -0.6],
        [30, 0.9, -0.8],
        [c.w('fills'), 0.9, -0.4],
        [b.two, 0.9, -0.8],
        [c.w('move'), 0.6, -0.4],
        [b.three, 0.9, -0.8],
        [c.at('cl-3', 'brings'), 0.9, -0.4],
        [c.at('cl-4', 'brings'), 0.8, -0.4],
      ],
    };
  },
  sfx: (c) => {
    const b = clientBeats(c);
    return [
      { f: 4, id: 'swim-whoosh', volume: 0.3 },
      { f: c.w('file'), id: 'pop', volume: 0.4 },
      { f: c.w('object'), id: 'pop', volume: 0.45 },
      { f: c.w('fills'), id: 'chime', volume: 0.35 },
      { f: b.two, id: 'pop', volume: 0.4 },
      { f: c.w('move'), id: 'swim-whoosh', volume: 0.4 },
      { f: c.at('cl-2', 'update'), id: 'pop', volume: 0.4 },
      { f: b.three, id: 'pop', volume: 0.4 },
      { f: c.w('report.title'), id: 'pop', volume: 0.45 },
      { f: c.at('cl-3', 'brings'), id: 'shimmer', volume: 0.3 },
      { f: b.four, id: 'pop', volume: 0.4 },
      { f: c.w('expenses.amount'), id: 'pop', volume: 0.45 },
      { f: c.at('cl-4', 'brings'), id: 'shimmer', volume: 0.3 },
      { f: c.w('add'), id: 'chime', volume: 0.4 },
    ];
  },
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const C = useTheme();
    const b = clientBeats(ctx);
    const end = ctx.span.duration - 14;
    const fills = ctx.w('fills');
    const move = ctx.w('move');
    const update = ctx.at('cl-2', 'update');
    const brings3 = ctx.at('cl-3', 'brings');
    const brings4 = ctx.at('cl-4', 'brings');
    const lunchX = track(frame, [[move, MOVE.from.x], [move + 22, MOVE.to.x, ease.inOut]]);
    const lunchY = track(frame, [[move, slotY(MOVE.from.y, MOVE.h, 2)], [move + 22, slotY(MOVE.to.y, MOVE.h, 0), ease.inOut]]);
    return (
      <AbsoluteFill>
        <ChapterTag text="Write and read across it" from={ctx.lead} to={end} />
        {/* cl-1: file an expense. */}
        <CodeLine code={FILE} x={960} y={250} size={28} from={ctx.lead + 4} until={b.two - 2} marks={[{ ...span(FILE, '{ report: { id: report.id } }'), at: ctx.w('object'), label: 'The report, as an object with its ID' }]} />
        <ArtifactCard x={960} y={640} width={900} icon="database" title="Your expenses" at={ctx.w('file') + 4} until={b.two - 2}>
          <DataTable columns={['note', 'amount', 'report_id']} rowsFrom={ctx.w('file') + 10} rows={[{ cells: [LUNCH.note, LUNCH.amount, frame >= fills ? <span style={{ color: C.ok }}>{IDS.berlin}</span> : '—'] }]} hi={{ col: 2, from: fills, color: C.ok }} />
        </ArtifactCard>
        <Chip x={960} y={830} from={ctx.at('cl-1', 'foreign')} to={b.two - 2} size={28} accent={C.ok}>
          The client fills in report_id for you
        </Chip>
        {/* cl-2: the many side is read-only, so moving updates the expense. */}
        <CodeLine code={MANY} x={960} y={250} size={34} from={b.two} until={update - 2} label="Read-only: writes ignore it" labelColor={C.inkSoft} />
        <ReportBox title={BERLIN} x={MOVE.from.x} y={MOVE.from.y} width={MOVE.w} height={MOVE.h} from={b.two + 4} until={b.three - 2} />
        <ReportBox title={OFFSITE} x={MOVE.to.x} y={MOVE.to.y} width={MOVE.w} height={MOVE.h} from={b.two + 8} until={b.three - 2} />
        {[TAXI, HOTEL].map((item, i) => (
          <Receipt key={item.note} note={item.note} amount={item.amount} x={MOVE.from.x} y={slotY(MOVE.from.y, MOVE.h, i)} from={b.two + 8 + i * 3} until={b.three - 2} width={420} />
        ))}
        <Receipt note={LUNCH.note} amount={LUNCH.amount} x={lunchX} y={lunchY} from={b.two + 14} until={b.three - 2} width={420} ring={frame >= move ? C.accent2 : undefined} glow={lit(frame, move, move + 30)} />
        <CodeLine code={FILE} x={960} y={250} size={28} from={update} until={b.three - 2} marks={[{ ...span(FILE, 'client.data.Expense.update'), at: update + 2, label: 'Update the expense' }]} />
        <Pill icon="x" color={C.inkDim} x={MOVE.from.x} y={880} from={ctx.w('not')} until={b.three - 2}>
          Not the report
        </Pill>
        {/* cl-3: read across it with a dot path. */}
        <CodeLine code={WITH_REPORTS} x={960} y={250} size={28} from={b.three} until={b.four - 2} marks={[{ ...span(WITH_REPORTS, "'report.title'"), at: ctx.w('report.title'), label: 'A dot path' }]} />
        <ArtifactCard x={960} y={650} width={900} icon="client" title="Each expense, with its report’s title" at={brings3 - 4} until={b.four - 2}>
          <DataTable
            columns={['amount', 'spentOn', 'report.title']}
            widths={[1, 1, 1.4]}
            rowsFrom={brings3}
            rows={[
              { cells: [TAXI.amount, 'Oct 2', BERLIN] },
              { cells: [HOTEL.amount, 'Oct 2', BERLIN] },
              { cells: [LUNCH.amount, 'Oct 9', OFFSITE] },
            ]}
            hi={{ col: 2, from: brings3 + 14 }}
          />
        </ArtifactCard>
        {/* cl-4: and back the other way, through the many side. */}
        <CodeLine code={WITH_AMOUNTS} x={960} y={250} size={30} from={b.four} until={end} marks={[{ ...span(WITH_AMOUNTS, "'expenses.amount'"), at: ctx.w('expenses.amount'), label: 'Through the many side' }]} />
        <ArtifactCard x={680} y={640} width={500} icon="folder" title={BERLIN} at={brings4} until={end}>
          <Amounts amounts={[TAXI.amount, HOTEL.amount]} total="258.20" addAt={ctx.w('add')} />
        </ArtifactCard>
        <ArtifactCard x={1240} y={619} width={500} icon="folder" title={OFFSITE} at={brings4 + 6} until={end}>
          <Amounts amounts={[LUNCH.amount]} total={LUNCH.amount} addAt={ctx.w('add') + 4} />
        </ArtifactCard>
      </AbsoluteFill>
    );
  },
};

/* ------------------------------------------------------------------------------------------ */
/*                                  7. Many on both sides                                     */
/* ------------------------------------------------------------------------------------------ */

const MM = {
  receipts: [
    { ...TAXI, y: 400 },
    { ...HOTEL, y: 560 },
    { ...LUNCH, y: 720 },
  ],
  tags: [
    { name: TAGS[0], y: 460 },
    { name: TAGS[1], y: 660 },
  ],
  /** Each ExpenseTag: which expense, which tag, and where its pill sits. */
  links: [
    { e: 0, t: 0, y: 360 },
    { e: 0, t: 1, y: 480 },
    { e: 1, t: 1, y: 600 },
    { e: 2, t: 1, y: 720 },
  ],
  rx: 380,
  lx: 960,
  tx: 1540,
} as const;
const RECEIPT_W = 300;
const LINK_W = 400;
const TAG_HALF = 130;

const J = {
  expenseId: locate(JOIN_CLASS, 'expense_id'),
  expense: locate(JOIN_CLASS, 'expense!'),
  tagId: locate(JOIN_CLASS, 'tag_id'),
  tag: locate(JOIN_CLASS, 'tag!'),
  uuid1: locate(JOIN_CLASS, '@uuid() expense_id'),
  uuid2: locate(JOIN_CLASS, '@uuid() tag_id'),
} as const;

function manyBeats(c: LessonCtx) {
  return { two: c.beat('mm-2').from, three: c.beat('mm-3').from, four: c.beat('mm-4').from, five: c.beat('mm-5').from };
}

const manyMany: LessonScene = {
  id: 'many-many',
  dim: 0.3,
  ray: (c) => {
    const b = manyBeats(c);
    return {
      keys: [{ f: 0, ...SPOT.perchBL }, swim(c.span.duration, 'perchBL')],
      moods: [
        { f: 0, mood: 'idle' },
        { f: c.w("doesn't"), mood: 'worried' },
        { f: c.w('join'), mood: 'happy' },
        { f: b.three, mood: 'idle' },
        { f: c.w('that'), mood: 'happy' },
        { f: b.four, mood: 'idle' },
      ],
      hops: [c.w('join'), c.w('that')],
      gaze: [
        [0, 0.9, -0.6],
        [c.w('tags'), 1, -0.6],
        [c.w('join'), 0.9, -0.7],
        [b.four, 0.9, -0.6],
        [b.five, 0.9, -0.8],
      ],
    };
  },
  sfx: (c) => {
    const b = manyBeats(c);
    return [
      { f: 4, id: 'swim-whoosh', volume: 0.3 },
      ...MM.tags.map((_, i) => ({ f: c.w('tags') + i * 4, id: 'pop' as const, volume: 0.4 })),
      { f: c.at('mm-1', 'tags', 2), id: 'sweep', volume: 0.3 },
      { f: c.w('expenses'), id: 'sweep', volume: 0.3 },
      { f: c.w("doesn't"), id: 'thud', volume: 0.45 },
      ...MM.links.map((_, i) => ({ f: c.w('join') + i * 4, id: 'pop' as const, volume: 0.32 })),
      { f: c.w('two'), id: 'stamp', volume: 0.4 },
      { f: c.w('this'), id: 'pop', volume: 0.4 },
      { f: c.w('that'), id: 'chime', volume: 0.35 },
      { f: b.four, id: 'sweep', volume: 0.3 },
      { f: c.w('keys'), id: 'pop', volume: 0.45 },
      { f: c.w('name'), id: 'pop', volume: 0.4 },
      { f: c.w('UUID'), id: 'pop', volume: 0.4 },
      { f: b.five, id: 'pop', volume: 0.4 },
      { f: c.w('expense_id'), id: 'pop', volume: 0.45 },
      { f: c.w('tag.name'), id: 'pop', volume: 0.45 },
      { f: c.w('tag.name') + 8, id: 'shimmer', volume: 0.35 },
    ];
  },
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const C = useTheme();
    const b = manyBeats(ctx);
    const end = ctx.span.duration - 14;
    const leave = b.four - 4;
    const many = ctx.at('mm-1', 'tags', 2);
    const no = ctx.w("doesn't");
    const join = ctx.w('join');
    const one = ctx.w('ExpenseTag');
    const found = ctx.w('tag.name') + 8;
    /** Every expense–tag pair, joined straight across: what many-to-many would be. */
    const web = MM.links.map((l) => ({ ...l, at: l.e === 0 ? many : ctx.w('expenses') }));
    const dimOthers = (i: number) => (i === 0 ? 0 : lit(frame, one, leave));
    return (
      <AbsoluteFill>
        <ChapterTag text="Many on both sides" from={ctx.lead} to={end} />
        {web.map((l, i) => (
          <div key={`w${i}`}>
            <Beam from={[MM.rx + RECEIPT_W / 2, MM.receipts[l.e].y]} to={[MM.tx - TAG_HALF, MM.tags[l.t].y]} at={l.at + i * 2} until={no} color={alpha(C.accent, 0.7)} />
            <Beam from={[MM.rx + RECEIPT_W / 2, MM.receipts[l.e].y]} to={[MM.tx - TAG_HALF, MM.tags[l.t].y]} at={no} until={join - 6} color={alpha(RED, 0.75)} dashed />
          </div>
        ))}
        <Chip x={960} y={250} from={no} to={join - 4} size={30} accent={RED}>
          No direct many-to-many in Rayfin
        </Chip>
        {MM.links.map((l, i) => {
          const hot = i === 0 ? lit(frame, ctx.w('this'), leave) : 0;
          const color = hot > 0 ? C.accent2 : C.accent;
          return (
            <div key={`l${i}`} style={{ opacity: 1 - 0.65 * dimOthers(i) }}>
              <Beam from={[MM.rx + RECEIPT_W / 2, MM.receipts[l.e].y]} to={[MM.lx - LINK_W / 2, l.y]} at={join + i * 4} until={leave} color={alpha(color, 0.85)} width={4 + 2 * hot} />
              <Beam from={[MM.lx + LINK_W / 2, l.y]} to={[MM.tx - TAG_HALF, MM.tags[l.t].y]} at={join + i * 4 + 6} until={leave} color={alpha(i === 0 ? (frame >= ctx.w('that') ? C.accent2 : C.accent) : C.accent, 0.85)} width={4 + 2 * (i === 0 ? lit(frame, ctx.w('that'), leave) : 0)} />
              <Pill icon="link" color={C.accent2} x={MM.lx} y={l.y} from={join + i * 4} until={leave} glow={i === 0 ? lit(frame, one, leave) : 0}>
                <span style={{ fontSize: 24 }}>
                  {MM.receipts[l.e].note} · {MM.tags[l.t].name}
                </span>
              </Pill>
            </div>
          );
        })}
        <Pill icon="link" color={C.accent2} x={MM.lx} y={250} from={join} until={leave}>
          <span>
            <b>ExpenseTag</b>: one row for each link
          </span>
        </Pill>
        {MM.receipts.map((r, i) => (
          <Receipt key={r.note} note={r.note} amount={r.amount} x={MM.rx} y={r.y} width={RECEIPT_W} from={ctx.lead + 4 + i * 3} until={leave} dim={dimOthers(i === 0 ? 0 : 1)} glow={i === 0 ? lit(frame, ctx.w('this'), leave) : 0} />
        ))}
        {MM.tags.map((t, i) => (
          <Pill key={t.name} icon="tag" color={TEAL} x={MM.tx} y={t.y} from={ctx.w('tags') + i * 4} until={leave} dim={dimOthers(i === 0 ? 0 : 1)} glow={i === 0 ? lit(frame, ctx.w('that'), leave) : 0}>
            {t.name}
          </Pill>
        ))}
        <CodeLine code={ONE_EXPENSE} x={720} y={880} size={30} from={ctx.w('two')} until={leave} />
        <CodeLine code={ONE_TAG} x={1200} y={880} size={30} from={ctx.w('two') + 6} until={leave} />
        {/* mm-4: the join entity declares its keys. */}
        <CodeCard
          code={JOIN_CLASS}
          file={SNIPPETS.expenseTag.file}
          firstLine={JOIN_FROM}
          x={900}
          y={500}
          width={1200}
          fontSize={32}
          from={b.four}
          to={b.five - 2}
          focus={[{ lines: [J.expenseId.line, J.expense.line, J.tagId.line, J.tag.line], from: ctx.w('keys') - 2, to: b.five }]}
          marks={[
            { line: J.expenseId.line, at: ctx.w('keys'), until: ctx.w('name') - 2 },
            { line: J.tagId.line, at: ctx.w('keys') + 3, until: ctx.w('name') - 2 },
            { line: J.expense.line, from: J.expense.from, to: J.expense.from + 7, at: ctx.w('name'), until: ctx.w('UUID') - 2, color: TEAL },
            { line: J.expenseId.line, from: J.expenseId.from, to: J.expenseId.to, at: ctx.w('name') + 3, until: ctx.w('UUID') - 2, color: TEAL, label: <span>expense + <Mono>_id</Mono></span>, labelGap: 2 },
            { line: J.tag.line, from: J.tag.from, to: J.tag.from + 3, at: ctx.w('name') + 6, until: ctx.w('UUID') - 2, color: TEAL },
            { line: J.tagId.line, from: J.tagId.from, to: J.tagId.to, at: ctx.w('name') + 9, until: ctx.w('UUID') - 2, color: TEAL, label: <span>tag + <Mono>_id</Mono></span>, labelGap: 6 },
            { line: J.uuid1.line, from: J.uuid1.from, to: J.uuid1.from + 7, at: ctx.w('UUID'), until: b.five - 2, label: 'A UUID, like the ID it points at', labelGap: 2 },
            { line: J.uuid2.line, from: J.uuid2.from, to: J.uuid2.from + 7, at: ctx.w('UUID') + 3, until: b.five - 2 },
          ]}
        />
        <Chip x={900} y={900} from={ctx.w('filter')} to={b.five - 2} size={28}>
          Declared, so the app can filter by them
        </Chip>
        {/* mm-5: an expense's tags, through the join entity. */}
        <CodeLine
          code={TAGS_OF}
          x={960}
          y={280}
          size={25}
          from={b.five}
          until={end}
          marks={[
            { ...span(TAGS_OF, 'expense_id'), at: ctx.w('expense_id'), label: 'Filter by the key' },
            { ...span(TAGS_OF, "'tag.name'"), at: ctx.w('tag.name'), label: 'Select across the link' },
          ]}
        />
        <Receipt note={TAXI.note} amount={TAXI.amount} x={700} y={660} from={ctx.w('find')} until={end} width={RECEIPT_W} />
        {MM.tags.map((t, i) => (
          <div key={t.name}>
            <Beam from={[700 + RECEIPT_W / 2, 660]} to={[1200 - TAG_HALF, 600 + i * 120]} at={found + 4 + i * 4} until={end} color={alpha(C.accent2, 0.85)} />
            <Pill icon="tag" color={TEAL} x={1200} y={600 + i * 120} from={found + 8 + i * 4} until={end}>
              {t.name}
            </Pill>
          </div>
        ))}
      </AbsoluteFill>
    );
  },
};

/* ------------------------------------------------------------------------------------------ */
/*                                8. Deep Dive: when you delete                               */
/* ------------------------------------------------------------------------------------------ */

const TABLES = { reports: { x: 700, y: 560, w: 520 }, expenses: { x: 1380, y: 560, w: 680 } } as const;

/** A trash can that wobbles over what's about to be deleted. */
function TrashBadge({ x, y, from, until }: { x: number; y: number; from: number; until?: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const l = life(frame, fps, from, until);
  if (!l) return null;
  return (
    <div style={{ position: 'absolute', left: x, top: y, width: 96, height: 96, borderRadius: '50%', display: 'grid', placeItems: 'center', background: alpha(RED, 0.18), border: `3px solid ${alpha(RED, 0.8)}`, boxShadow: `0 0 28px ${alpha(RED, 0.45)}`, opacity: Math.min(1, l.p * 1.5) * l.out, transform: `translate(-50%, -50%) scale(${0.6 + 0.4 * l.p}) rotate(${Math.sin(frame / 4) * 8}deg)` }}>
      <Icon name="trash" color={RED} size={52} stroke={2.2} />
    </div>
  );
}

function deepBeats(c: LessonCtx) {
  return { one: c.beat('dd-1').from, two: c.beat('dd-2').from, three: c.beat('dd-3').from, four: c.beat('dd-4').from, five: c.beat('dd-5').from, six: c.beat('dd-6').from };
}

const deepDive: LessonScene = {
  id: 'deep-dive',
  depth: 1,
  ray: (c) => {
    const b = deepBeats(c);
    return {
      keys: [{ f: 0, ...SPOT.perchBL }, swim(30, 'deep'), swim(c.span.duration, 'deep')],
      moods: [
        { f: 0, mood: 'happy' },
        { f: c.w('What'), mood: 'idle' },
        { f: c.w('exist'), mood: 'surprised' },
        { f: c.w('fails'), mood: 'worried' },
        { f: c.w('cascade'), mood: 'idle' },
        { f: c.w('want'), mood: 'happy' },
        { f: b.four, mood: 'idle' },
        { f: b.five, mood: 'happy' },
      ],
      rolls: [6],
      hops: [c.w('want'), c.w('deletes'), c.w('first')],
      squishes: [c.w('fails')],
      gaze: [
        [0, 0, 0.4],
        [c.w('What'), -0.8, -0.5],
        [b.one, -1, -0.5],
        [c.w('exist'), -0.6, -0.3],
        [b.two, -0.8, -0.7],
        [c.w('why'), -0.8, -0.1],
        [b.four, -0.8, -0.4],
        [b.five, -0.8, -0.4],
      ],
    };
  },
  sfx: (c) => {
    const b = deepBeats(c);
    return [
      { f: 0, id: 'dive', volume: 0.55 },
      { f: c.w('delete'), id: 'pop', volume: 0.4 },
      { f: b.one, id: 'pop', volume: 0.4 },
      { f: c.w('foreign'), id: 'sonar', volume: 0.3 },
      { f: c.w("can't"), id: 'pop', volume: 0.4 },
      { f: c.w('exist'), id: 'thud', volume: 0.45 },
      { f: b.two, id: 'typing', volume: 0.28, duration: 16 },
      { f: c.w('fails'), id: 'thud', volume: 0.5 },
      { f: c.w('why'), id: 'pop', volume: 0.45 },
      { f: c.w('cascade'), id: 'sonar', volume: 0.3 },
      { f: c.w('option'), id: 'pop', volume: 0.4 },
      { f: c.w('want'), id: 'chime', volume: 0.4 },
      { f: c.w('money'), id: 'pop', volume: 0.4 },
      { f: c.w('quietly'), id: 'stamp', volume: 0.4 },
      { f: c.w('move'), id: 'pop', volume: 0.45 },
      { f: c.at('dd-5', 'delete'), id: 'pop', volume: 0.45 },
      { f: c.w('deletes'), id: 'sweep', volume: 0.35 },
      { f: c.w('deletes') + 10, id: 'chime', volume: 0.35 },
      { f: c.w('links'), id: 'pop', volume: 0.45 },
      { f: c.w('first') + 6, id: 'pop', volume: 0.45 },
    ];
  },
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const C = useTheme();
    const b = deepBeats(ctx);
    const end = ctx.span.duration - 14;
    const cant = ctx.w("can't");
    const exist = ctx.w('exist');
    const fails = ctx.w('fails');
    const want = ctx.w('want');
    const option = ctx.w('option');
    const tablesOut = b.four - 4;
    const safe = (i: number) => (frame >= want ? C.ok : undefined) ?? (i < 0 ? RED : undefined);
    return (
      <AbsoluteFill style={{ opacity: fadeOut(frame, ctx.span.duration, 12) }}>
        <DeepDiveTitle from={ctx.lead} to={end} subtitle="What a delete does to linked records" tuckAt={ctx.w('What')} />
        <DepthGauge from={0} to={ctx.span.duration - 20} />
        {/* dive: the question. */}
        <Chip x={1080} y={250} from={ctx.w('What')} to={b.one - 2} size={36}>
          Delete a report that still has expenses?
        </Chip>
        <ReportBox title={BERLIN} x={1080} y={600} width={560} height={300} from={ctx.w('delete') - 6} until={b.one - 2} />
        {[TAXI, HOTEL].map((item, i) => (
          <Receipt key={item.note} note={item.note} amount={item.amount} x={1080} y={slotY(600, 300, i)} from={ctx.w('delete') - 2 + i * 3} until={b.one - 2} width={440} />
        ))}
        <TrashBadge x={1390} y={460} from={ctx.w('delete')} until={b.one - 2} />
        {/* dd-1, dd-2, dd-3: the two tables and the foreign key between them. */}
        <ArtifactCard x={TABLES.reports.x} y={TABLES.reports.y} width={TABLES.reports.w} icon="database" title="Reports" at={b.one} until={tablesOut}>
          <DataTable
            columns={['id', 'title']}
            widths={[0.8, 1.4]}
            rowsFrom={b.one + 6}
            rows={[{ cells: [IDS.berlin, BERLIN], bad: fails }, { cells: [IDS.offsite, OFFSITE] }, { cells: ['', ''], at: 1e6 }]}
            hi={{ col: 0, from: ctx.w('foreign'), to: b.two }}
          />
        </ArtifactCard>
        <ArtifactCard x={TABLES.expenses.x} y={TABLES.expenses.y} width={TABLES.expenses.w} icon="database" title="Expenses" at={b.one + 4} until={tablesOut}>
          <DataTable
            columns={['note', 'amount', 'report_id']}
            widths={[1.1, 0.9, 1]}
            rowsFrom={b.one + 10}
            rows={[
              { cells: [TAXI.note, TAXI.amount, IDS.berlin], color: safe(0) },
              { cells: [HOTEL.note, HOTEL.amount, IDS.berlin], color: safe(1) },
              { cells: ['Parking', '9.00', IDS.missing], at: cant, bad: exist, gone: b.two },
            ]}
            hi={{ col: 2, from: ctx.w('foreign'), to: b.two }}
          />
        </ArtifactCard>
        <Beam from={[1590, 395]} to={[555, 405]} at={ctx.w('foreign')} until={tablesOut} color={alpha(C.accent2, 0.9)} width={5} bend={110} />
        <Chip x={1080} y={250} from={ctx.w('foreign')} to={b.two - 2} size={30} accent={C.accent2}>
          A real foreign key, in your database
        </Chip>
        <Chip x={TABLES.expenses.x} y={790} from={exist} to={b.two - 2} size={28} accent={RED}>
          No such report: refused
        </Chip>
        <CodeLine code={REMOVE} x={1080} y={250} size={34} from={b.two} until={ctx.w('cascade') - 2} bad={fails} />
        <TrashBadge x={TABLES.reports.x - 300} y={TABLES.reports.y + 10} from={ctx.at('dd-2', 'deleted')} until={ctx.w('cascade') - 2} />
        <ArtifactCard x={1080} y={870} width={1300} icon="x" title="The delete fails" at={ctx.w('why')} until={option - 4}>
          <div style={{ fontFamily: MONO, fontSize: 24, color: C.inkDim, marginBottom: 6 }}>GraphQL errors:</div>
          <div style={{ fontFamily: FONT, fontWeight: 650, fontSize: 30, lineHeight: 1.3, color: RED }}>{DEPENDS}</div>
        </ArtifactCard>
        <Chip x={1080} y={250} from={ctx.w('cascade')} to={tablesOut} size={32} accent={TEAL}>
          No cascade: the expenses stay
        </Chip>
        <CodeLine code={ONE} x={1080} y={860} size={32} from={option} until={tablesOut} label="Its only options: optional and unique" labelColor={C.inkSoft} />
        <Burst kind="sparkles" at={want} x={TABLES.expenses.x} y={TABLES.expenses.y} count={12} seed={61} spread={2} />
        {/* dd-4: they're money someone spent. */}
        <ArtifactCard x={1080} y={520} width={720} icon="shield" title="Money someone spent" at={ctx.w('money')} until={b.five - 4}>
          <RuleList
            items={[
              { text: <span>{TAXI.note} · <Mono>{TAXI.amount}</Mono></span>, at: ctx.w('money') + 6 },
              { text: <span>{HOTEL.note} · <Mono>{HOTEL.amount}</Mono></span>, at: ctx.w('spent') },
            ]}
          />
        </ArtifactCard>
        <Chip x={1080} y={790} from={ctx.w('quietly')} to={b.five - 4} size={32} accent={C.ok}>
          A report can’t take them with it
        </Chip>
        {/* dd-5: so you decide. */}
        <ArtifactCard x={780} y={480} width={580} icon="migrate" title="Move them" subtitle="Update each expense’s report" at={ctx.w('move')} until={b.six - 4}>
          <div style={{ fontFamily: FONT, fontWeight: 650, fontSize: 28, color: C.inkSoft }}>
            {TAXI.note}, {HOTEL.note} → {OFFSITE}
          </div>
        </ArtifactCard>
        <ArtifactCard x={1440} y={480} width={580} icon="trash" title="Or delete them" subtitle="If they should go too" at={ctx.at('dd-5', 'delete')} until={b.six - 4}>
          <div style={{ fontFamily: FONT, fontWeight: 650, fontSize: 28, color: C.inkSoft }}>Then nothing points at {BERLIN}</div>
        </ArtifactCard>
        <ReportBox title={BERLIN} x={1110} y={790} width={520} height={110} from={ctx.w('Then') - 4} until={b.six - 4} gone={ctx.w('deletes') + 4} />
        <Chip x={1110} y={790} from={ctx.w('deletes') + 12} to={b.six - 4} size={32} accent={C.ok}>
          ✓ Then the report deletes
        </Chip>
        {/* dd-6: tags the same way. */}
        <ArtifactCard x={1080} y={540} width={760} icon="tag" title="For tags" at={b.six} until={end}>
          <RuleList
            items={[
              { text: 'First, delete its ExpenseTag links', at: ctx.w('links') },
              { text: 'Then the tag, or the expense', at: ctx.w('first') + 6 },
            ]}
          />
        </ArtifactCard>
      </AbsoluteFill>
    );
  },
};

/* ------------------------------------------------------------------------------------------ */
/*                                 9. See it in Fabricator                                    */
/* ------------------------------------------------------------------------------------------ */

/** Blueprint's Data model view with the lesson's four entities (scripts/docs-screenshots' `model-relations` shot). */
const MODEL_REL: Shot = { id: 'model-relations', w: 1600, h: 856 };
/** Pixels in it, the same in both themes. */
const MR = {
  header: { x: 1110, y: 11, w: 164, h: 34 },
  expensesRow: { x: 628, y: 664, w: 318, h: 32 },
  join: { x: 616, y: 171, w: 341, h: 338 },
  /** The three dashed lines, traced. */
  edges: [
    'M 505 235 H 552 Q 561 235 561 244 V 287 Q 561 296 570 296 H 617',
    'M 505 419 H 552 Q 561 419 561 428 V 670 Q 561 679 570 679 H 617',
    'M 955 358 H 1002 Q 1011 358 1011 349 V 245 Q 1011 236 1020 236 H 1067',
  ],
} as const;
const FAB = { x: 960, y: 560, width: 1500 } as const;

/** The screenshot's relationship lines, drawn over in the accent color from `at`. In image pixels. */
function EdgeTrace({ at: start, until }: { at: number; until?: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const C = useTheme();
  if (frame < start) return null;
  const out = until === undefined ? 1 : 1 - ramp(frame, until, 10, ease.in);
  return (
    <svg width={MODEL_REL.w} height={MODEL_REL.h} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', opacity: out }}>
      {MR.edges.map((d, i) => (
        <path key={i} d={d} fill="none" stroke={C.accent2} strokeWidth={4} strokeLinecap="round" pathLength={1} strokeDasharray={`${ramp(frame, start + i * 6, 16, ease.out)} 1`} style={{ filter: `drop-shadow(0 0 6px ${alpha(C.accent2, 0.8)})` }} />
      ))}
    </svg>
  );
}

const fabricator: LessonScene = {
  id: 'fabricator',
  dim: 0.35,
  ray: (c) => ({
    keys: [{ f: 0, ...SPOT.deep }, swim(28, 'fabricator'), swim(c.span.duration, 'fabricator')],
    moods: [
      { f: 0, mood: 'happy' },
      { f: 30, mood: 'idle' },
      { f: c.w('line'), mood: 'happy' },
      { f: c.w('brackets'), mood: 'idle' },
      { f: c.w('middle'), mood: 'happy' },
    ],
    hops: [c.w('line'), c.w('middle')],
    gaze: [
      [0, -0.6, -0.4],
      [30, -0.9, 0.3],
      [c.w('relationship'), -0.4, -0.2],
      [c.w('brackets'), -0.9, 0.6],
      [c.w('middle'), -0.9, 0.1],
    ],
  }),
  sfx: (c) => [
    { f: 0, id: 'surface', volume: 0.5 },
    { f: c.w('line'), id: 'sweep', volume: 0.35 },
    { f: c.w('relationship'), id: 'pop', volume: 0.4 },
    { f: c.w('brackets'), id: 'pop', volume: 0.45 },
    { f: c.w('middle'), id: 'pop', volume: 0.45 },
  ],
  View: ({ ctx }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const end = ctx.span.duration - 14;
    const win = windowLife(frame, fps, ctx.lead, end);
    const two = ctx.beat('fab-2').from;
    const brackets = ctx.w('brackets');
    const middle = ctx.w('middle');
    const zoom = track(frame, [
      [two - 4, 1],
      [two + 20, 1.22],
    ]);
    return (
      <AbsoluteFill>
        <ChapterTag text="See it in Fabricator" from={ctx.lead} to={end} />
        {win ? (
          <AppWindow shot={MODEL_REL} x={FAB.x} y={FAB.y} width={FAB.width} zoom={zoom} fx={790} fy={500} opacity={win.opacity} scale={win.scale}>
            <EdgeTrace at={ctx.w('line')} until={brackets - 2} />
            <Spotlight {...MR.header} radius={10} dim={0.3} opacity={lit(frame, ctx.w('relationship'), brackets)} />
            <Spotlight {...MR.expensesRow} radius={10} dim={0.45} opacity={lit(frame, brackets, ctx.w('ExpenseTag'))} />
            <Spotlight {...MR.join} radius={18} dim={0.45} opacity={lit(frame, ctx.w('ExpenseTag'))} />
          </AppWindow>
        ) : null}
        <Chip x={960} y={1010} from={ctx.w('line')} to={brackets - 2} size={30}>
          A line for each relationship
        </Chip>
        <Chip x={960} y={1010} from={brackets} to={ctx.w('ExpenseTag') - 2} size={30}>
          <span>
            <Mono>Expense[]</Mono>: many
          </span>
        </Chip>
        <Chip x={960} y={1010} from={ctx.w('ExpenseTag')} to={end} size={30}>
          The join entity, linked to both
        </Chip>
      </AbsoluteFill>
    );
  },
};

/* ------------------------------------------------------------------------------------------ */
/*                                     10. Pop quiz                                           */
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
          A report still has expenses in it.
          <br />
          You delete it. What happens?
        </span>
      }
      options={[
        { text: 'Its expenses are deleted too', at: ctx.at('quiz-options', 'A') },
        { text: 'They stay, but unfiled', at: ctx.at('quiz-options', 'B') },
        { text: 'The delete fails until you move or delete them', at: ctx.at('quiz-options', 'C') },
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
/*                                11. Recap, 12. Challenge                                    */
/* ------------------------------------------------------------------------------------------ */

const recap: LessonScene = {
  id: 'recap',
  ray: (c) => ({
    keys: [{ f: 0, ...SPOT.quiz }, swim(26, 'recap'), swim(c.span.duration, 'recap')],
    moods: [{ f: 0, mood: 'happy' }],
    hops: [c.w('create'), c.w('Deletes'), c.w('join')],
    gaze: [
      [0, -0.6, 0.6],
      [30, -0.9, -0.7],
    ],
  }),
  sfx: (c) => ['create', 'Deletes', 'join'].map((w) => ({ f: c.w(w) + 6, id: 'stamp' as const, volume: 0.4 })),
  View: ({ ctx }) => (
    <Recap
      from={ctx.lead}
      to={ctx.span.duration - 14}
      items={[
        {
          text: (
            <span>
              Created and shared? Its own entity, linked with <Mono>@one</Mono> and <Mono>@many</Mono>
            </span>
          ),
          at: ctx.w('create'),
        },
        { text: 'Deletes don’t cascade: move or delete what’s linked first', at: ctx.w('Deletes') },
        { text: 'Many-to-many takes a join entity', at: ctx.w('join') },
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
    { f: c.w('send'), id: 'typing', volume: 0.28, duration: c.w('follow') + 24 - c.w('send') },
    { f: c.beat('challenge-2').from, id: 'pop', volume: 0.5 },
  ],
  View: ({ ctx }) => <Challenge prompt={YOUTUBE.challenge.prompt} from={ctx.lead} to={ctx.span.duration - 14} typeFrom={ctx.w('send')} typeTo={ctx.w('follow') + 24} cta={YOUTUBE.challenge.question} ctaAt={ctx.beat('challenge-2').from} />,
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
    const back = c.wEnd('relationships') + 8;
    return {
      keys: [{ f: 0, ...SPOT.end }, swim(20, 'fact', ease.out), swim(back, 'fact'), swim(back + 22, 'end'), swim(c.span.duration, 'end')],
      moods: [
        { f: 0, mood: 'idle' },
        { f: c.w('biggest'), mood: 'surprised' },
        { f: c.w('Plenty') - 2, mood: 'happy' },
      ],
      squishes: [c.w('Plenty') - 2, c.w('Plenty') + 10],
      waves: [back + 24],
      gaze: [
        [0, 0, 0.1],
        [c.w('biggest'), -0.4, 0],
        [c.w('Plenty'), 0, 0.1],
      ],
    };
  },
  sfx: (c) => [
    { f: 2, id: 'swim-whoosh', volume: 0.3 },
    { f: c.w('Plenty'), id: 'boing', volume: 0.35 },
    { f: c.wEnd('relationships') + 8, id: 'swim-whoosh', volume: 0.3 },
  ],
  View: ({ ctx }) => (
    <AbsoluteFill>
      <TheEnd from={-400} to={ctx.span.duration + 400} />
      <Chip x={SPOT.fact.x} y={430} from={10} to={ctx.wEnd('relationships') + 6} accent={AMBER} size={26}>
        RAY FACT
      </Chip>
      <Burst kind="bubbles" at={ctx.w('Plenty')} x={SPOT.fact.x} y={SPOT.fact.y} count={10} seed={91} />
    </AbsoluteFill>
  ),
};

/** Lesson 5's scenes, in the script's order. */
export const SCENES: readonly LessonScene[] = [coldOpen, bumper, welcome, islands, oneMany, client, manyMany, deepDive, fabricator, quiz, recap, challenge, next, stinger];
