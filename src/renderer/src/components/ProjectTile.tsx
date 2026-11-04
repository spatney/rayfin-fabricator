import type { CSSProperties, JSX } from 'react'
import { initials, markHue } from './gallery/model'

/**
 * A project's tile, 16:10: the picture of its app when Fabricator has drawn
 * one from the preview, else its letters on its hue. Home's rows and the
 * gallery's table use it.
 */
export function ProjectTile({
  name,
  thumbnail,
  className = ''
}: {
  name: string
  /** The project's thumbnail (`data:` URL), when it has one. */
  thumbnail?: string
  className?: string
}): JSX.Element {
  if (thumbnail) {
    return (
      <span className={`ptile ptile--image ${className}`.trim()} aria-hidden="true">
        <img className="ptile-img" src={thumbnail} alt="" draggable={false} />
      </span>
    )
  }
  return (
    <span
      className={`ptile ${className}`.trim()}
      aria-hidden="true"
      style={{ '--hue': markHue(name) } as CSSProperties}
    >
      {initials(name)}
    </span>
  )
}
