import { Img, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { ease, pop, ramp } from '../anim';
import { FONT, useTheme } from '../theme';

/** The Fabricator mark and name, as on the docs site. */
export function Wordmark({ x, y, size = 120, from = 0, opacity = 1 }: { x: number; y: number; size?: number; from?: number; opacity?: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  if (frame < from) return null;
  const p = pop(frame, fps, from, 12, 0.7);
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        transform: `translate(-50%, -50%) scale(${0.6 + 0.4 * p})`,
        opacity: Math.min(1, p * 1.5) * opacity,
        display: 'flex',
        alignItems: 'center',
        gap: size * 0.28,
      }}
    >
      <Img src={staticFile('ui/fabricator-logo.png')} style={{ width: size * 1.05, height: size * 1.05, filter: C.shadow.logo }} />
      <span style={{ fontFamily: FONT, fontWeight: 800, fontSize: size, letterSpacing: '-0.035em', color: C.ink, textShadow: C.shadow.title }}>Fabricator</span>
    </div>
  );
}

/**
 * The sample app as a tile: what Ray carries to Fabric, and what the backend serves. Themed
 * like its screenshots, with its own mark: a receipt (Lucide's) on a blue rounded square.
 */
export function AppTile({ x, y, scale = 1, opacity = 1, live = false }: { x: number; y: number; scale?: number; opacity?: number; live?: boolean }): JSX.Element {
  const C = useTheme();
  const app = C.sampleApp;
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        transform: `translate(-50%, -50%) scale(${scale})`,
        opacity,
        display: 'flex',
        alignItems: 'center',
        gap: 18,
        padding: '18px 26px 18px 18px',
        borderRadius: 20,
        background: app.bg,
        boxShadow: C.shadow.sampleApp,
        fontFamily: FONT,
        whiteSpace: 'nowrap',
      }}
    >
      <div style={{ width: 64, height: 64, borderRadius: 14, background: app.mark, display: 'grid', placeItems: 'center' }}>
        <svg width="35" height="35" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" />
          <path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" />
          <path d="M12 17.5v-11" />
        </svg>
      </div>
      <div>
        <div style={{ fontSize: 30, fontWeight: 650, color: app.title }}>Contoso Expenses</div>
        <div style={{ fontSize: 20, color: live ? app.live : app.sub, display: 'flex', alignItems: 'center', gap: 8 }}>
          {live ? <span style={{ width: 10, height: 10, borderRadius: '50%', background: app.dot, display: 'inline-block' }} /> : null}
          {live ? 'Live in Microsoft Fabric' : 'Team expense tracker'}
        </div>
      </div>
    </div>
  );
}

/** A swirling portal labelled Microsoft Fabric: where Ray swims the app to. */
export function FabricPortal({ x, y, from, to }: { x: number; y: number; from: number; to: number }): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  if (frame < from || frame > to + 10) return null;
  const p = pop(frame, fps, from, 12, 0.7);
  const out = 1 - ramp(frame, to, 10, ease.in);
  const spin = frame * 2.2;
  return (
    <div style={{ position: 'absolute', left: x, top: y, transform: `translate(-50%, -50%) scale(${p * out})`, opacity: out }}>
      <div style={{ position: 'relative', width: 300, height: 300 }}>
        <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: C.portal }} />
        <svg width="300" height="300" viewBox="0 0 300 300" style={{ position: 'absolute', inset: 0, transform: `rotate(${spin}deg)` }}>
          <circle cx="150" cy="150" r="120" fill="none" stroke={C.accent} strokeWidth="6" strokeDasharray="40 22" strokeLinecap="round" />
          <circle cx="150" cy="150" r="92" fill="none" stroke={C.accent2} strokeWidth="4" strokeDasharray="18 16" strokeLinecap="round" transform="rotate(30 150 150)" />
        </svg>
        <div style={{ position: 'absolute', left: '50%', top: 322, transform: 'translateX(-50%)', textAlign: 'center', fontFamily: FONT, whiteSpace: 'nowrap' }}>
          <div style={{ fontSize: 40, fontWeight: 750, color: C.ink }}>Microsoft Fabric</div>
          <div style={{ fontSize: 24, color: C.inkDim }}>your workspace</div>
        </div>
      </div>
    </div>
  );
}

/** The closing card: mark, tagline and where to get it. Each part lands on its cue. */
export function EndCard({ start, copilotAt, downloadAt, dim = 0 }: { start: number; copilotAt: number; downloadAt: number; dim?: number }): JSX.Element {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const C = useTheme();
  const tag = pop(frame, fps, start + 8, 13, 0.7);
  const chips = pop(frame, fps, start + 16, 12, 0.6);
  const copilot = pop(frame, fps, copilotAt, 12, 0.6);
  const dl = pop(frame, fps, downloadAt, 11, 0.6);
  const note = ramp(frame, start + 24, 18);
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: 1 - dim * 0.55 }}>
      <Wordmark x={960} y={270} size={128} from={start} />
      <div style={{ position: 'absolute', left: 0, right: 0, top: 378, textAlign: 'center', fontFamily: FONT, fontSize: 60, fontWeight: 650, letterSpacing: '-0.02em', color: C.inkSoft, opacity: Math.min(1, tag * 1.4), transform: `translateY(${(1 - tag) * 30}px)` }}>
        Build Rayfin apps by chatting.
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 490, display: 'flex', justifyContent: 'center', gap: 22, opacity: Math.min(1, chips * 1.4), transform: `scale(${0.85 + 0.15 * chips})` }}>
        {['Chat to build', 'Preview it live', 'Ship to Microsoft Fabric'].map((label) => (
          <div key={label} style={{ padding: '12px 26px', borderRadius: 999, border: `2px solid ${C.tag.border}`, background: C.tag.bg, color: C.tag.text, fontFamily: FONT, fontSize: 30, fontWeight: 600 }}>
            {label}
          </div>
        ))}
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 600, textAlign: 'center', fontFamily: FONT, fontSize: 34, color: C.inkDim, opacity: Math.min(1, copilot * 1.4), transform: `translateY(${(1 - copilot) * 20}px)` }}>
        Runs on the <span style={{ color: C.ink, fontWeight: 650 }}>GitHub Copilot</span> account you already have
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 690, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18, opacity: Math.min(1, dl * 1.4), transform: `translateY(${(1 - dl) * 24}px) scale(${0.9 + 0.1 * dl})` }}>
        <div style={{ padding: '20px 46px', borderRadius: 16, background: `linear-gradient(100deg, ${C.brand}, ${C.accent})`, color: '#fff', fontFamily: FONT, fontSize: 40, fontWeight: 700, boxShadow: C.shadow.button }}>
          Download Fabricator · Windows &amp; macOS
        </div>
        <div style={{ fontFamily: FONT, fontSize: 32, color: C.inkDim }}>spatney.github.io/rayfin-fabricator</div>
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 34, textAlign: 'center', fontFamily: FONT, fontSize: 21, color: C.inkFaint, opacity: note }}>
        A personal project by Sachin Patney. Not a Microsoft product, and not affiliated with or endorsed by Microsoft.
      </div>
    </div>
  );
}
