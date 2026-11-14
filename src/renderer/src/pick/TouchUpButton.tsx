import { useEffect, useId, useRef, useState, type CSSProperties, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { PickIcon } from '../components/icons'
import { translator, useTranslation } from '../i18n'
import { isMac } from '../platform'
import './pick.css'

/** How long the pointer rests on the button before its shortcuts show. */
const TIP_DELAY_MS = 350

/** What the switch is called, in English; {@link touchUpLabel} in the interface's language. */
export const LABEL = 'Point & Edit'

/** What the switch is called on screen: what you do with it. */
export function touchUpLabel(): string {
  return translator('app')('touchUp.label')
}

/**
 * Where the shortcuts show: one row beside the button, centred on the toolbar.
 * Below it the preview's native surface would cover them, and above it there's
 * only the app bar. Offsets are divided by the interface zoom, which zooms them
 * again (see `applyUiScale`).
 */
function besideStyle(rect: DOMRect): CSSProperties {
  const zoom = Number(document.documentElement.style.zoom) || 1
  return {
    top: (rect.top + rect.height / 2) / zoom,
    right: (window.innerWidth - rect.left + 8) / zoom,
    maxWidth: Math.max(160, rect.left - 16) / zoom
  }
}

/**
 * The preview toolbar's Point & Edit switch (Touch Up in the code), a control
 * of its own. Resting on it shows its shortcuts as keycaps, in a row beside it.
 */
export function TouchUpButton({
  on,
  count,
  disabled,
  disabledReason,
  onToggle
}: {
  on: boolean
  /** Elements picked and waiting in the composer. */
  count: number
  disabled: boolean
  /** Why it's off right now, shown in place of the shortcuts. */
  disabledReason?: string
  onToggle: () => void
}): JSX.Element {
  const { t } = useTranslation('app')
  const ref = useRef<HTMLSpanElement>(null)
  const timer = useRef(0)
  const [tip, setTip] = useState<CSSProperties | null>(null)
  const tipId = useId()
  const mac = isMac()
  const label = t('touchUp.label')
  const shortcut = mac ? ['⌘', '⇧', 'C'] : [t('keys.ctrl'), t('touchUp.shiftKey'), 'C']

  useEffect(() => () => window.clearTimeout(timer.current), [])
  // Toggling hides the shortcuts: they've done their job.
  useEffect(() => setTip(null), [on])

  const show = (delay = TIP_DELAY_MS): void => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const rect = ref.current?.getBoundingClientRect()
      if (rect) setTip(besideStyle(rect))
    }, delay)
  }
  const hide = (): void => {
    window.clearTimeout(timer.current)
    setTip(null)
  }

  return (
    <span
      ref={ref}
      className="seg seg--toolbar pick-seg"
      onMouseEnter={() => show()}
      onMouseLeave={hide}
    >
      <button
        type="button"
        className={`seg-btn pick-btn${on ? ' seg-btn--on' : ''}`}
        aria-label={count > 0 ? t('touchUp.labelPicked', { label, count }) : label}
        aria-pressed={on}
        aria-keyshortcuts={mac ? 'Meta+Shift+C' : 'Control+Shift+C'}
        aria-describedby={tip ? tipId : undefined}
        disabled={disabled}
        onClick={() => {
          hide()
          onToggle()
        }}
        onFocus={(event) => {
          if (event.currentTarget.matches(':focus-visible')) show(0)
        }}
        onBlur={hide}
      >
        <PickIcon />
        <span className="seg-btn-label">{label}</span>
        {count > 0 && (
          <span className="pick-btn-count" aria-hidden="true">
            {count}
          </span>
        )}
      </button>
      {tip &&
        createPortal(
          <div className="pick-tip" role="tooltip" id={tipId} style={tip}>
            {disabled && disabledReason ? (
              <span className="pick-tip-reason">{disabledReason}</span>
            ) : (
              <>
                <span className="pick-tip-item">
                  {on ? t('touchUp.turnOff') : t('touchUp.turnOn')}
                  <span className="pick-keys">
                    {shortcut.map((key) => (
                      <kbd key={key}>{key}</kbd>
                    ))}
                  </span>
                </span>
                <span className="pick-tip-sep" aria-hidden="true" />
                <span className="pick-tip-item">
                  {t('touchUp.clip')}
                  <span className="pick-keys">
                    <kbd>{mac ? '⇧' : t('touchUp.shiftKey')}</kbd>
                    <span className="pick-keys-plus">+</span>
                    <span className="pick-keys-click">{t('touchUp.drag')}</span>
                  </span>
                </span>
              </>
            )}
          </div>,
          document.body
        )}
    </span>
  )
}
