import type { CSSProperties, JSX } from 'react'
import { Codicon } from '../icons'
import { Ray } from '../mascot/Ray'
import { hueOf } from '../team/map/parts'
import type { Range } from './rank'
import type { ItemIcon } from './model'

/** A result's icon on its tile: a project's initial, a tinted codicon, or Ray. */
export function Icon({ icon, small }: { icon: ItemIcon; small?: boolean }): JSX.Element {
  const className = `sl-ico${small ? ' sl-ico--sm' : ''}`
  if (icon.kind === 'mark') {
    return (
      <span
        className={`${className} sl-ico--mark`}
        style={{ '--hue': hueOf(icon.name) } as CSSProperties}
        aria-hidden="true"
      >
        {icon.name.trim()[0]?.toUpperCase() ?? '?'}
      </span>
    )
  }
  if (icon.kind === 'ray') {
    return (
      <span className={`${className} sl-ico--ray`} aria-hidden="true">
        <Ray mood="idle" blink={false} />
      </span>
    )
  }
  const tinted = icon.hue !== undefined
  return (
    <span
      className={`${className}${tinted ? ' sl-ico--hue' : ''}`}
      style={tinted ? ({ '--hue': icon.hue } as CSSProperties) : undefined}
      aria-hidden="true"
    >
      <Codicon name={icon.name} />
    </span>
  )
}

/** The title, with what matched the query in bold. */
export function Highlight({ text, ranges }: { text: string; ranges: Range[] }): JSX.Element {
  if (ranges.length === 0) return <>{text}</>
  const parts: (string | JSX.Element)[] = []
  let at = 0
  for (const [start, end] of ranges) {
    if (start > at) parts.push(text.slice(at, start))
    parts.push(<mark key={start}>{text.slice(start, end)}</mark>)
    at = end
  }
  if (at < text.length) parts.push(text.slice(at))
  return <>{parts}</>
}

export function Keys({ keys }: { keys: string[] }): JSX.Element {
  return (
    <span className="sl-keys" aria-hidden="true">
      {keys.map((key) => (
        <kbd key={key}>{key}</kbd>
      ))}
    </span>
  )
}
