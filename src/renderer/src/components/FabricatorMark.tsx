/**
 * The Fabricator brand mark, drawn as inline SVG so it stays crisp at any size and
 * adapts to the theme. The teal tiles use the fixed brand teal; the gray tiles read
 * the `--logo-gray` CSS variable (see :root / [data-theme='light'] in main.css) so
 * they show as a light neutral on the dark theme and a legible mid-gray on the light
 * theme — the old static logo.png's near-white gray washed out on light backgrounds.
 *
 * Geometry is sampled from the original logo (428×424) and exported so the animated
 * SplashScreen build-up can reuse the exact same tiles/brackets.
 */

export const MARK_VIEWBOX = '0 0 428 424'
/** Fixed brand teal (identity colour — same in both themes). */
export const MARK_TEAL = '#76c2c5'
/** Gray tiles reference this so they can adapt per theme. */
export const MARK_GRAY = 'var(--logo-gray)'
export const MARK_TILE_RX = 16
export const MARK_BRACKET_RX = 5

export type MarkFill = 'teal' | 'gray'

export interface MarkTile {
  cls: string
  x: number
  y: number
  w: number
  h: number
  fill: MarkFill
}

export interface MarkBracket {
  cls: string
  rects: Array<[number, number, number, number]>
}

export const MARK_TILES: MarkTile[] = [
  { cls: 'tile--topbar', x: 164, y: 38, w: 251, h: 98, fill: 'teal' },
  { cls: 'tile--stem', x: 40, y: 38, w: 118, h: 218, fill: 'teal' },
  { cls: 'tile--mid', x: 164, y: 156, w: 193, h: 100, fill: 'gray' },
  { cls: 'tile--botleft', x: 40, y: 262, w: 117, h: 158, fill: 'gray' },
  { cls: 'tile--square', x: 164, y: 262, w: 91, h: 97, fill: 'teal' }
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

/** Resolve a tile's logical fill to a paint value. */
export function markFill(fill: MarkFill): string {
  return fill === 'teal' ? MARK_TEAL : MARK_GRAY
}

interface FabricatorMarkProps {
  /** Sizing/positioning class(es). Sizing lives in main.css (e.g. .brand-mark). */
  className?: string
  /** Accessible label; when omitted the mark is decorative (aria-hidden). */
  title?: string
}

/** Static Fabricator mark. Sizing comes from the passed className (see main.css). */
export function FabricatorMark({ className, title }: FabricatorMarkProps): JSX.Element {
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
      {MARK_TILES.map((t) => (
        <rect
          key={t.cls}
          className={`tile ${t.cls}`}
          x={t.x}
          y={t.y}
          width={t.w}
          height={t.h}
          rx={MARK_TILE_RX}
          fill={markFill(t.fill)}
        />
      ))}
      {MARK_BRACKETS.map((b) => (
        <g key={b.cls} className={`tile bracket ${b.cls}`} fill={MARK_TEAL}>
          {b.rects.map((r, i) => (
            <rect key={i} x={r[0]} y={r[1]} width={r[2]} height={r[3]} rx={MARK_BRACKET_RX} />
          ))}
        </g>
      ))}
    </svg>
  )
}

export default FabricatorMark
