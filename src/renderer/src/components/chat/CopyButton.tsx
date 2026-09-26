import { useEffect, useRef, useState } from 'react'
import { Codicon } from '../icons'
import { CopyIcon } from './icons'

/** Clipboard button with brief "Copied" feedback. `compact` shows only the icon. */
export function CopyButton({
  text,
  className,
  title = 'Copy message',
  compact = false
}: {
  text: string
  className?: string
  title?: string
  compact?: boolean
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current)
    },
    []
  )
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      if (timer.current != null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 1200)
    } catch {
      /* clipboard unavailable — ignore */
    }
  }
  return (
    <button
      type="button"
      className={`copy-btn${compact ? ' copy-btn--compact' : ''}${className ? ` ${className}` : ''}${copied ? ' copy-btn--done' : ''}`}
      onClick={copy}
      title={copied ? 'Copied' : title}
      aria-label={title}
    >
      {copied ? (
        <span className="copy-btn-check" aria-hidden="true">
          <Codicon name="check" />
        </span>
      ) : (
        <CopyIcon />
      )}
      {!compact && <span className="copy-btn-label">{copied ? 'Copied' : 'Copy'}</span>}
    </button>
  )
}
