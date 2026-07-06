/**
 * The Fabricator brand mark, drawn as inline SVG so it stays crisp at any size and
 * carries a fixed identity colour. The tiles + brackets share one continuous
 * blue→cyan→green gradient (inspired by the Microsoft Edge mark): saturated
 * mid-tones that read well on both light and dark backgrounds — unlike the old
 * teal + near-white two-tone, whose grey washed out on light surfaces.
 *
 * Geometry is sampled from the original logo (428×424) and exported so the animated
 * SplashScreen build-up can reuse the exact same tiles/brackets and gradient.
 */
import { useId } from 'react'

export const MARK_VIEWBOX = '0 0 428 424'
export const MARK_TILE_RX = 16
export const MARK_BRACKET_RX = 5

/** Blue→cyan→green gradient stops (Edge-style). Works on light and dark. */
export const MARK_GRADIENT_STOPS: ReadonlyArray<{ offset: string; color: string }> = [
  { offset: '0%', color: '#1183dd' },
  { offset: '52%', color: '#15a4d3' },
  { offset: '100%', color: '#41c795' }
]
/** Gradient axis, in viewBox user space, spanning the mark's bounding box. */
export const MARK_GRADIENT_LINE = { x1: 40, y1: 40, x2: 412, y2: 418 }

export interface MarkTile {
  cls: string
  x: number
  y: number
  w: number
  h: number
}

export interface MarkBracket {
  cls: string
  rects: Array<[number, number, number, number]>
}

export const MARK_TILES: MarkTile[] = [
  { cls: 'tile--topbar', x: 164, y: 38, w: 251, h: 98 },
  { cls: 'tile--stem', x: 40, y: 38, w: 118, h: 218 },
  { cls: 'tile--mid', x: 164, y: 156, w: 193, h: 100 },
  { cls: 'tile--botleft', x: 40, y: 262, w: 117, h: 158 },
  { cls: 'tile--square', x: 164, y: 262, w: 91, h: 97 }
]

export const MARK_BRACKETS: MarkBracket[] = [
  {
    cls: 'bracket--tl',
    rects: [
      [3, 2, 54, 15],
      [3, 2, 15, 53]
    ]
  },
  {
    cls: 'bracket--br',
    rects: [
      [372, 369, 52, 15],
      [409, 330, 15, 54]
    ]
  }
]

/** The mark's shared gradient. Give each instance a unique id so multiple marks on
 *  one page don't collide. `gradientUnits=userSpaceOnUse` makes the gradient flow
 *  continuously across all tiles rather than restarting inside each one. */
export function MarkGradient({ id }: { id: string }): JSX.Element {
  return (
    <linearGradient
      id={id}
      gradientUnits="userSpaceOnUse"
      x1={MARK_GRADIENT_LINE.x1}
      y1={MARK_GRADIENT_LINE.y1}
      x2={MARK_GRADIENT_LINE.x2}
      y2={MARK_GRADIENT_LINE.y2}
    >
      {MARK_GRADIENT_STOPS.map((s) => (
        <stop key={s.offset} offset={s.offset} stopColor={s.color} />
      ))}
    </linearGradient>
  )
}

interface FabricatorMarkProps {
  /** Sizing/positioning class(es). Sizing lives in main.css (e.g. .brand-mark). */
  className?: string
  /** Accessible label; when omitted the mark is decorative (aria-hidden). */
  title?: string
}

/** Static Fabricator mark. Sizing comes from the passed className (see main.css). */
export function FabricatorMark({ className, title }: FabricatorMarkProps): JSX.Element {
  // useId can contain ':' — strip it so the fragment reference is a clean token.
  const gid = 'fabmark-' + useId().replace(/:/g, '')
  const fill = `url(#${gid})`
  return (
    <svg
      className={className ? `fab-mark ${className}` : 'fab-mark'}
      viewBox={MARK_VIEWBOX}
      xmlns="http://www.w3.org/2000/svg"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      <defs>
        <MarkGradient id={gid} />
      </defs>
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
    </svg>
  )
}

export default FabricatorMark
