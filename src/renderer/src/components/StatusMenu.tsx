import type { SelectHTMLAttributes, JSX } from 'react'
import { Codicon } from './icons'

/**
 * A status-bar menu: a native select drawn as quiet text with a chevron, so it
 * keeps the platform's keyboard and screen-reader behaviour but reads like the
 * bar's other items.
 */
export default function StatusMenu(props: SelectHTMLAttributes<HTMLSelectElement>): JSX.Element {
  return (
    <span className="statusbar-menu">
      <select {...props} />
      <Codicon name="chevron-down" className="statusbar-ico statusbar-menu-chevron" />
    </span>
  )
}
