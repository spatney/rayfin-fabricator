import type { CSSProperties, JSX } from 'react'
import { initialOf, tileColor } from '../appIcon'

/** An app's icon, or a tile in its colour with its initial when it has none. */
export default function AppIcon({
  name,
  src,
  size
}: {
  name: string
  /** The icon, as a URL. */
  src?: string
  /** Its width and height in CSS pixels. */
  size: number
}): JSX.Element {
  const style = { '--app-icon-size': `${size}px` } as CSSProperties
  if (src) return <img className="app-icon" src={src} alt="" style={style} draggable={false} />
  return (
    <span
      className="app-icon app-icon--tile"
      aria-hidden="true"
      style={{ ...style, background: tileColor(name) }}
    >
      {initialOf(name)}
    </span>
  )
}
