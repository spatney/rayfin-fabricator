// The Fabricator mark is a set of rounded-rect tiles that form an "F". We recreate
// it as inline SVG (one element per tile) so each block can glide itself into place — a
// slick "the logo builds itself" splash. Geometry is sampled from assets/logo.png (428×424)
// so the assembled mark matches the real logo exactly.
const TEAL = '#76c2c5'
const GRAY = '#e3e4e0'
const TILE_RX = 16
const BRACKET_RX = 5

type Tile = { cls: string; x: number; y: number; w: number; h: number; fill: string }
type Bracket = { cls: string; rects: Array<[number, number, number, number]> }

const TILES: Tile[] = [
  { cls: 'tile--topbar', x: 164, y: 38, w: 251, h: 98, fill: TEAL },
  { cls: 'tile--stem', x: 40, y: 38, w: 118, h: 218, fill: TEAL },
  { cls: 'tile--mid', x: 164, y: 156, w: 193, h: 100, fill: GRAY },
  { cls: 'tile--botleft', x: 40, y: 262, w: 117, h: 158, fill: GRAY },
  { cls: 'tile--square', x: 164, y: 262, w: 91, h: 97, fill: TEAL }
]

const BRACKETS: Bracket[] = [
  { cls: 'bracket--tl', rects: [[3, 2, 54, 15], [3, 2, 15, 53]] },
  { cls: 'bracket--br', rects: [[372, 369, 52, 15], [409, 330, 15, 54]] }
]

function BuildingLogo(): JSX.Element {
  return (
    <svg
      className="splash-logo"
      viewBox="0 0 428 424"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="splash-sheen-grad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.65" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <clipPath id="splash-logo-clip">
          {TILES.map((t) => (
            <rect key={t.cls} x={t.x} y={t.y} width={t.w} height={t.h} rx={TILE_RX} />
          ))}
          {BRACKETS.flatMap((b) =>
            b.rects.map((r, i) => (
              <rect key={`${b.cls}-${i}`} x={r[0]} y={r[1]} width={r[2]} height={r[3]} rx={BRACKET_RX} />
            ))
          )}
        </clipPath>
      </defs>

      <g className="splash-logo-inner">
        {TILES.map((t) => (
          <rect
            key={t.cls}
            className={`tile ${t.cls}`}
            x={t.x}
            y={t.y}
            width={t.w}
            height={t.h}
            rx={TILE_RX}
            fill={t.fill}
          />
        ))}
        {BRACKETS.map((b) => (
          <g key={b.cls} className={`tile bracket ${b.cls}`} fill={TEAL}>
            {b.rects.map((r, i) => (
              <rect key={i} x={r[0]} y={r[1]} width={r[2]} height={r[3]} rx={BRACKET_RX} />
            ))}
          </g>
        ))}
      </g>

      {/* A soft highlight that sweeps across the assembled mark, clipped to its shape. */}
      <g clipPath="url(#splash-logo-clip)">
        <rect className="splash-sheen" x="0" y="0" width="150" height="424" fill="url(#splash-sheen-grad)" />
      </g>
    </svg>
  )
}

export default function SplashScreen(): JSX.Element {
  return (
    <div className="splash">
      <div className="splash-hero">
        <div className="splash-stage">
          <BuildingLogo />
        </div>
        <div className="splash-wordmark">
          <span className="splash-word">Fabricator</span>
          <span className="splash-sub">Setting up your workspace…</span>
        </div>
      </div>
      <div className="splash-progress" aria-hidden="true">
        <span />
      </div>
    </div>
  )
}
