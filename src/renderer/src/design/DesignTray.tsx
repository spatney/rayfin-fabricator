import type { DesignItem } from '@shared/design'
import { CloseIcon, DesignIcon, PaletteIcon, SparkleIcon } from '../components/icons'
import { itemSummary, itemTitle } from './prompt'
import './design.css'

import type { JSX } from 'react'

function KindIcon({ item }: { item: DesignItem }): JSX.Element {
  if (item.kind === 'theme') return <PaletteIcon className="design-chip-ico" />
  if (item.kind === 'suggestion') return <SparkleIcon className="design-chip-ico" />
  return <DesignIcon className="design-chip-ico" />
}

/**
 * The Design queue in the chat composer: one numbered chip per change (click to
 * show it in the preview, × to drop it). Sent with the next message.
 */
export function DesignTray({
  items,
  sending = false,
  waiting = false,
  onRemove,
  onFocus,
  onClear
}: {
  items: DesignItem[]
  /** The changes are being captured for sending. */
  sending?: boolean
  /** A turn is running; the changes go out with the next message after it. */
  waiting?: boolean
  onRemove?: (id: string) => void
  onFocus?: (id: string) => void
  onClear?: () => void
}): JSX.Element | null {
  if (items.length === 0) return null
  const n = items.length
  const count = `${n} design change${n === 1 ? '' : 's'}`
  return (
    <div className="design-tray" role="group" aria-label="Design changes to send">
      <div className="design-tray-head">
        <DesignIcon className="design-tray-ico" />
        <span className="design-tray-title">
          {sending
            ? 'Capturing your changes…'
            : waiting
              ? `${count} · send when Copilot finishes`
              : `${count} · sent with your message`}
        </span>
        {onClear && !sending && (
          <button type="button" className="design-tray-clear" onClick={onClear}>
            Clear
          </button>
        )}
      </div>
      <ul className="design-tray-list">
        {items.map((item, i) => {
          const title = itemTitle(item)
          const summary = itemSummary(item)
          return (
            <li key={item.id} className={`design-chip${item.missing ? ' design-chip--missing' : ''}`}>
              <button
                type="button"
                className="design-chip-main"
                onClick={() => onFocus?.(item.id)}
                disabled={sending || !onFocus}
                title={`${title} — ${summary}${item.missing ? '\n(Not on the page shown right now)' : ''}\nClick to show it in the preview`}
              >
                <span className="design-chip-n">{i + 1}</span>
                <KindIcon item={item} />
                <span className="design-chip-text">
                  <span className="design-chip-label">{title}</span>
                  <span className="design-chip-summary">{summary}</span>
                </span>
              </button>
              {onRemove && !sending && (
                <button
                  type="button"
                  className="design-chip-x"
                  onClick={() => onRemove(item.id)}
                  aria-label={`Remove change ${i + 1}: ${title}`}
                  title="Remove this change"
                >
                  <CloseIcon />
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
