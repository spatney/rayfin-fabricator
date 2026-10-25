import type { ReactNode } from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import { ease, pop, ramp } from '../anim';
import { FONT, MONO, alpha, useTheme } from '../theme';
import { CODE_PALETTES } from './code';
import { Icon, type IconName } from './icons';

/** A card for something Rayfin makes: an icon, a title, and what's inside. It pops in at `at`. */
export function ArtifactCard({ x, y, width, icon, title, subtitle, at, until, lit = 0, children }: { x: number; y: number; width: number; icon: IconName; title: ReactNode; subtitle?: ReactNode; at: number; until?: number; lit?: number; children?: ReactNode }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  if (frame < at || (until !== undefined && frame > until + 12)) return null;
  const p = pop(frame, fps, at, 12, 0.65);
  const out = until === undefined ? 1 : 1 - ramp(frame, until, 12, ease.in);
  const ring = C.accent2;
  return (
    <div
      style={{
        position: 'absolute',
        left: x - width / 2,
        top: y,
        width,
        transform: `translateY(-50%) scale(${(0.7 + 0.3 * p) * (1 + 0.03 * lit)})`,
        opacity: Math.min(1, p * 1.5) * out,
        borderRadius: 24,
        background: C.panel.bg,
        border: `2px solid ${lit > 0 ? alpha(ring, 0.4 + 0.6 * lit) : C.panel.border}`,
        boxShadow: `${C.shadow.panel}, ${C.glow(alpha(ring, 0.15 + 0.35 * lit), 34, 2)}`,
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '20px 24px 16px' }}>
        <div style={{ width: 58, height: 58, borderRadius: 16, display: 'grid', placeItems: 'center', background: alpha(ring, 0.14), flex: 'none' }}>
          <Icon name={icon} color={ring} size={36} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: FONT, fontWeight: 750, fontSize: 34, color: C.ink, lineHeight: 1.15 }}>{title}</div>
          {subtitle ? <div style={{ fontFamily: FONT, fontSize: 23, color: C.inkDim, marginTop: 2 }}>{subtitle}</div> : null}
        </div>
      </div>
      {children ? <div style={{ padding: '0 24px 22px' }}>{children}</div> : null}
    </div>
  );
}

/** A database table: column names, then rows that fill in one by one from `rowsFrom`. */
export function TableBody({ columns, rows, rowsFrom, every = 6, owners }: { columns: readonly string[]; rows: ReadonlyArray<readonly string[]>; rowsFrom: number; every?: number; owners?: readonly string[] }): JSX.Element {
  const frame = useCurrentFrame();
  const C = useTheme();
  const grid = `repeat(${columns.length}, minmax(0, 1fr))`;
  return (
    <div style={{ borderRadius: 12, overflow: 'hidden', border: `1.5px solid ${C.panel.border}`, fontFamily: MONO, fontSize: 21 }}>
      <div style={{ display: 'grid', gridTemplateColumns: grid, background: alpha(C.accent, 0.16), color: C.accent, fontWeight: 600 }}>
        {columns.map((c) => (
          <div key={c} style={{ padding: '9px 12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c}</div>
        ))}
      </div>
      {rows.map((row, i) => {
        const p = ramp(frame, rowsFrom + i * every, 8, ease.out);
        return (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: grid, color: C.text, borderTop: `1px solid ${C.panel.border}`, opacity: p, transform: `translateY(${(1 - p) * 10}px)`, background: owners ? alpha(owners[i], 0.08) : 'transparent' }}>
            {row.map((cell, k) => (
              <div key={k} style={{ padding: '8px 12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: owners && k === row.length - 1 ? owners[i] : undefined }}>{cell}</div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** The two APIs Rayfin serves for an entity. */
export function ApiBody({ rest, graphql }: { rest: ReactNode; graphql: ReactNode }): JSX.Element {
  const C = useTheme();
  const row = (label: string, text: ReactNode, color: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '12px 0' }}>
      <span style={{ flex: 'none', width: 128, textAlign: 'center', padding: '6px 0', borderRadius: 999, background: alpha(color, 0.16), color, fontFamily: MONO, fontWeight: 700, fontSize: 22 }}>{label}</span>
      <span style={{ fontFamily: FONT, fontSize: 26, color: C.text }}>{text}</span>
    </div>
  );
  return (
    <div>
      {row('REST', rest, C.accent)}
      {row('GraphQL', graphql, '#e535ab')}
    </div>
  );
}

/**
 * A line of client code with the editor's completion list open under it: the typed client
 * knows every method (and every field) of the entity. `items` must be real methods.
 */
export function AutocompleteBody({ prefix, items, from, pick }: { prefix: string; items: readonly string[]; from: number; pick?: number }): JSX.Element {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  const P = CODE_PALETTES[C.name];
  const open = frame < from ? 0 : pop(frame, fps, from, 13, 0.7);
  const parts = prefix.split('.');
  const selected = pick === undefined ? -1 : Math.min(items.length - 1, Math.max(0, Math.floor((frame - from - 8) / 7)));
  return (
    <div style={{ fontFamily: MONO, fontSize: 25 }}>
      <div style={{ padding: '12px 16px', borderRadius: 10, background: P.bg, border: `1.5px solid ${P.border}`, whiteSpace: 'pre' }}>
        <span style={{ color: P.kinds.keyword }}>await </span>
        {parts.map((part, i) => (
          <span key={i}>
            <span style={{ color: i === 0 ? P.kinds.plain : P.kinds.property }}>{part}</span>
            {i < parts.length - 1 ? <span style={{ color: P.kinds.punct }}>.</span> : null}
          </span>
        ))}
        <span style={{ color: P.kinds.punct }}>.</span>
        <span style={{ color: C.accent, opacity: Math.floor(frame / 8) % 2 === 0 ? 1 : 0.25 }}>▍</span>
      </div>
      <div style={{ marginLeft: `min(${Array.from(`await ${prefix}.`).length}ch, calc(100% - 340px))`, marginTop: 6, width: 330, borderRadius: 10, background: C.name === 'dark' ? '#1c2230' : '#ffffff', border: `1.5px solid ${P.border}`, boxShadow: C.shadow.chip, overflow: 'hidden', transformOrigin: '0 0', transform: `scaleY(${open})`, opacity: Math.min(1, open * 2) }}>
        {items.map((item, i) => (
          <div key={item} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '5px 14px', background: i === selected ? alpha(C.accent, 0.28) : 'transparent', color: C.text }}>
            <span style={{ width: 22, height: 22, borderRadius: 5, display: 'grid', placeItems: 'center', background: alpha('#b180d7', 0.25), color: '#b180d7', fontSize: 15, fontFamily: FONT, fontWeight: 700 }}>ƒ</span>
            {item}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Row-level security: one table of everyone's rows splits into what each person can see,
 * only their own, from `split`.
 */
export function RowSecurityBody({ people, rows, split }: { people: ReadonlyArray<{ name: string; color: string }>; rows: ReadonlyArray<{ text: string; owner: number }>; split: number }): JSX.Element {
  const frame = useCurrentFrame();
  const C = useTheme();
  const s = ramp(frame, split, 22, ease.inOut);
  return (
    <div style={{ display: 'flex', gap: 18 }}>
      {people.map((person, k) => (
        <div key={person.name} style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, opacity: s }}>
            <div style={{ width: 36, height: 36, borderRadius: '50%', display: 'grid', placeItems: 'center', background: person.color, color: '#fff', fontFamily: FONT, fontWeight: 750, fontSize: 17 }}>{person.name.slice(0, 1)}</div>
            <span style={{ fontFamily: FONT, fontWeight: 650, fontSize: 24, color: C.ink }}>{person.name}</span>
          </div>
          <div style={{ borderRadius: 10, border: `1.5px solid ${C.panel.border}`, overflow: 'hidden' }}>
            {rows.map((row, i) => {
              const mine = row.owner === k;
              const visible = mine ? 1 : 1 - s;
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, height: 42 * (mine ? 1 : 1 - s * 0.999), overflow: 'hidden', padding: '0 12px', borderTop: i ? `1px solid ${C.panel.border}` : 'none', background: alpha(people[row.owner].color, 0.12), opacity: visible, fontFamily: MONO, fontSize: 20, color: C.text, whiteSpace: 'nowrap' }}>
                  <span style={{ width: 9, height: 9, borderRadius: '50%', background: people[row.owner].color, flex: 'none' }} />
                  {row.text}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/** A form checked by the validator Rayfin generates from the entity: one field fails. */
export function ValidationBody({ fields, failAt }: { fields: ReadonlyArray<{ label: string; value: string; error?: string }>; failAt: number }): JSX.Element {
  const frame = useCurrentFrame();
  const C = useTheme();
  const bad = '#ff6b81';
  const fail = ramp(frame, failAt, 8);
  const shake = frame >= failAt && frame < failAt + 14 ? Math.sin((frame - failAt) * 2.4) * 7 * (1 - (frame - failAt) / 14) : 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {fields.map((f) => {
        const err = f.error !== undefined;
        return (
          <div key={f.label} style={{ transform: err ? `translateX(${shake}px)` : undefined }}>
            <div style={{ fontFamily: FONT, fontSize: 21, color: C.inkDim, marginBottom: 5 }}>{f.label}</div>
            <div style={{ padding: '9px 14px', borderRadius: 10, background: C.field, border: `2px solid ${err ? alpha(bad, 0.3 + 0.7 * fail) : C.border}`, fontFamily: FONT, fontSize: 24, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.value}</div>
            {err ? <div style={{ marginTop: 5, fontFamily: FONT, fontWeight: 600, fontSize: 21, color: bad, opacity: fail }}>{f.error}</div> : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The services a deployed app gets, as tiles inside a dashed boundary that draws itself on
 * from `boundaryAt`. Each tile lights up on its cue.
 */
export function ServiceTiles({ tiles, y, boundaryAt, boundaryLabel, until, extra }: { tiles: ReadonlyArray<{ icon: IconName; label: string; sub: string; at: number }>; y: number; boundaryAt: number; boundaryLabel: ReactNode; until?: number; extra?: { text: ReactNode; at: number } }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  if (until !== undefined && frame > until + 12) return null;
  const out = until === undefined ? 1 : 1 - ramp(frame, until, 12, ease.in);
  const w = 300;
  const gap = 34;
  const left = 960 - (tiles.length * w + (tiles.length - 1) * gap) / 2;
  const draw = ramp(frame, boundaryAt, 26, ease.inOut);
  const box = { x: left - 70, y: y - 190, w: tiles.length * w + (tiles.length - 1) * gap + 140, h: 430 };
  const label = frame < boundaryAt ? 0 : pop(frame, fps, boundaryAt + 6, 12, 0.6);
  const more = extra && frame >= extra.at ? pop(frame, fps, extra.at, 12, 0.6) : 0;
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: out }}>
      {draw > 0 ? (
        <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0 }}>
          <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={36} fill={alpha(C.accent2, 0.05 * draw)} stroke={C.accent2} strokeWidth={4} strokeDasharray="18 12" pathLength={1000} style={{ strokeDashoffset: 0 }} opacity={draw} />
        </svg>
      ) : null}
      {draw > 0 ? (
        <div style={{ position: 'absolute', left: box.x + 40, top: box.y - 26, padding: '8px 22px', borderRadius: 999, background: C.chip.bg, border: `2px solid ${C.accent2}`, fontFamily: FONT, fontWeight: 650, fontSize: 28, color: C.chip.text, whiteSpace: 'nowrap', transform: `scale(${label})`, transformOrigin: '0% 50%' }}>{boundaryLabel}</div>
      ) : null}
      {tiles.map((t, i) => {
        const p = frame < t.at ? 0 : pop(frame, fps, t.at, 11, 0.6);
        return (
          <div key={t.label} style={{ position: 'absolute', left: left + i * (w + gap), top: y - 130, width: w, height: 260, borderRadius: 24, background: C.panel.tile, border: `2px solid ${alpha(C.accent, 0.3 + 0.5 * Math.min(1, p))}`, boxShadow: `${C.shadow.tile}, ${C.glow(alpha(C.accent, 0.3 * Math.min(1, p)), 30)}`, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, opacity: Math.min(1, p * 1.5), transform: `translateY(${(1 - p) * 50}px) scale(${0.8 + 0.2 * p})` }}>
            <Icon name={t.icon} color={C.accent} size={72} />
            <div style={{ fontFamily: FONT, fontWeight: 750, fontSize: 38, color: C.ink }}>{t.label}</div>
            <div style={{ fontFamily: FONT, fontSize: 24, color: C.inkDim, textAlign: 'center', padding: '0 14px' }}>{t.sub}</div>
          </div>
        );
      })}
      {extra ? (
        <div style={{ position: 'absolute', left: 0, right: 0, top: box.y + box.h + 36, display: 'flex', justifyContent: 'center', opacity: Math.min(1, more * 1.4), transform: `translateY(${(1 - more) * 20}px)` }}>
          <span style={{ padding: '10px 26px', borderRadius: 999, background: C.chip.bg, border: `2px dashed ${C.border}`, fontFamily: FONT, fontSize: 28, color: C.inkDim }}>{extra.text}</span>
        </div>
      ) : null}
    </div>
  );
}
