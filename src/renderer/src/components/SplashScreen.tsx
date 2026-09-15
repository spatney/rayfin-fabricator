// The Fabricator mark is a set of rounded-rect tiles that form an "F". We recreate
// it as inline SVG (one element per tile) so each block can glide itself into place — a
// slick "the logo builds itself" splash. The tile/bracket geometry + blue→cyan→green
// gradient are shared with the static <FabricatorMark> so the mark matches exactly.
import { useId } from 'react'
import {
  MARK_BRACKET_RX,
  MARK_BRACKETS,
  MARK_TILE_RX,
  MARK_TILES,
  MARK_VIEWBOX,
  MarkGradient
} from './FabricatorMark'

function BuildingLogo(): JSX.Element {
  const gid = 'splash-mark-' + useId().replace(/:/g, '')
  const fill = `url(#${gid})`
  return (
    <svg
      className="splash-logo"
      viewBox={MARK_VIEWBOX}
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <MarkGradient id={gid} />
        <linearGradient id="splash-sheen-grad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.65" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <clipPath id="splash-logo-clip">
          {MARK_TILES.map((t) => (
            <rect key={t.cls} x={t.x} y={t.y} width={t.w} height={t.h} rx={MARK_TILE_RX} />
          ))}
          {MARK_BRACKETS.flatMap((b) =>
            b.rects.map((r, i) => (
              <rect key={`${b.cls}-${i}`} x={r[0]} y={r[1]} width={r[2]} height={r[3]} rx={MARK_BRACKET_RX} />
            ))
          )}
        </clipPath>
      </defs>

      <g className="splash-logo-inner">
        {MARK_TILES.map((t) => (
          <rect
            key={t.cls}
            className={`tile ${t.cls}`}
            x={t.x}
            y={t.y}
            width={t.w}
            height={t.h}
            rx={MARK_TILE_RX}
            fill={fill}
          />
        ))}
        {MARK_BRACKETS.map((b) => (
          <g key={b.cls} className={`tile bracket ${b.cls}`} fill={fill}>
            {b.rects.map((r, i) => (
              <rect key={i} x={r[0]} y={r[1]} width={r[2]} height={r[3]} rx={MARK_BRACKET_RX} />
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
