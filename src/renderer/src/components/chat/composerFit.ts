import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { flushSync } from 'react-dom'

/**
 * What fits in the composer's bottom row. The model's name matters most, then the
 * plugins' names, then the hint: each gives way before the next.
 */
export interface ComposerFit {
  /** The model's name, rather than only its logo. */
  model: boolean
  /** The plugins' names, rather than how many are on. */
  names: boolean
  /** "Enter to send". */
  hint: boolean
}

const EVERYTHING: ComposerFit = { model: true, names: true, hint: true }

/** The least of the model's name worth showing, ending in "…", in CSS px. */
const MODEL_NAME_MIN = 64

/** The row's class for `fit`: what it hides. */
export function composerActionsClass(fit: ComposerFit): string {
  return `composer-actions${fit.hint ? '' : ' composer-actions--no-hint'}${fit.model ? '' : ' composer-actions--no-model'}`
}

/** What `read` finds with these inline styles set, which are then put back. */
function measured(
  changes: readonly (readonly [HTMLElement | null, string, string])[],
  read: () => number
): number {
  const kept = changes.flatMap(([el, property, value]) => {
    if (!el) return []
    const old = el.style.getPropertyValue(property)
    el.style.setProperty(property, value)
    return [[el, property, old] as const]
  })
  const value = read()
  for (const [el, property, old] of kept) el.style.setProperty(property, old)
  return value
}

/**
 * What fits in the composer's bottom row (.composer-actions): the "+" menu, the
 * plugins and the model on the left; the hint and the send buttons on the right.
 * Worked out the same whatever the row shows now, so showing it never changes the
 * answer: the plugins' names are measured on their unseen copy while the trigger
 * counts them, the hint while it stands out of the row, and the model unsqueezed,
 * with and without its name. Boxes are in viewport px, zoomed with the app;
 * styles are scaled to match.
 */
export function composerFit(row: HTMLElement): ComposerFit {
  const left = row.querySelector<HTMLElement>('.composer-left')
  const right = row.querySelector<HTMLElement>('.composer-right')
  const model = left?.querySelector<HTMLElement>('.model-picker')
  const trigger = left?.querySelector<HTMLElement>('.plugins-menu > button')
  const rowBox = row.getBoundingClientRect()
  if (!left || !right || !model || !trigger || rowBox.width === 0) return EVERYTHING
  const rowStyle = getComputedStyle(row)
  const css = rowBox.width / (parseFloat(rowStyle.width) || rowBox.width)
  const px = (value: string): number => (parseFloat(value) || 0) * css
  const width = (el: HTMLElement) => (): number => el.getBoundingClientRect().width

  // The plugins, named and counted.
  const triggerWidth = trigger.getBoundingClientRect().width
  const ghost = left.querySelector<HTMLElement>('.plugins-menu > .pl-pill-ghost')
  const named = trigger.querySelector<HTMLElement>('.pl-pill-label')
  const namedWidth = ghost ? ghost.getBoundingClientRect().width : triggerWidth
  const countedWidth = named
    ? measured(
        [
          [named, 'display', 'none'],
          [trigger.querySelector<HTMLElement>('.pl-pill-count'), 'display', 'inline-block']
        ],
        width(trigger)
      )
    : triggerWidth

  // The model unsqueezed, with its name and with only its logo.
  const box = model.getBoundingClientRect()
  const name = model.querySelector<HTMLElement>('.composer-pill-label--model')
  const modelWhole = measured(
    [
      [model, 'flex-shrink', '0'],
      [name, 'display', 'block']
    ],
    width(model)
  )
  const modelBare = name
    ? measured(
        [
          [model, 'flex-shrink', '0'],
          [name, 'display', 'none']
        ],
        width(model)
      )
    : modelWhole
  // The "+" menu and the gaps: the rest of the left as it is now.
  const others = box.right - rowBox.left - triggerWidth - box.width

  // The send buttons, and the room the hint takes beside them.
  const hint = right.querySelector<HTMLElement>('.composer-hint')
  const hintStyle = hint ? getComputedStyle(hint) : null
  const hintRoom =
    hint && hintStyle && hintStyle.display !== 'none'
      ? hint.getBoundingClientRect().width +
        px(hintStyle.marginRight) +
        px(getComputedStyle(right).columnGap)
      : 0
  const buttons =
    right.getBoundingClientRect().width - (hintStyle?.position === 'absolute' ? 0 : hintRoom)

  // A hair over, for rounding: any less and the model's name would end in "…".
  const room = rowBox.width - px(rowStyle.columnGap) + 0.05
  const withNames = others + namedWidth + modelWhole + buttons
  const names = withNames <= room
  const someName = Math.min(modelWhole - modelBare, MODEL_NAME_MIN * css)
  return {
    model: names || others + countedWidth + modelBare + someName + buttons <= room,
    names,
    hint: names && withNames + hintRoom <= room
  }
}

/**
 * What fits in the composer's bottom row, worked out before paint as the row
 * resizes, its fonts arrive, or what it shows changes: plugins turned on, another
 * model, the send buttons while the assistant works.
 */
export function useComposerFit(rowRef: RefObject<HTMLElement | null>): ComposerFit {
  const [fit, setFit] = useState(EVERYTHING)
  const fitRef = useRef(EVERYTHING)

  useLayoutEffect(() => {
    const row = rowRef.current
    if (!row) return
    let live = true
    const changed = new MutationObserver(() => check(true))
    function check(sync: boolean): void {
      if (!live || !row) return
      const next = composerFit(row)
      const now = fitRef.current
      if (next.model === now.model && next.names === now.names && next.hint === now.hint) return
      fitRef.current = next
      if (sync) {
        flushSync(() => setFit(next))
        // The row's own change measures the same; don't check it again.
        changed.takeRecords()
      } else setFit(next)
    }
    check(false)
    changed.observe(row, { subtree: true, childList: true, characterData: true })
    const resized =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => check(true))
    resized?.observe(row)
    const fonts = 'fonts' in document ? document.fonts : null
    const loaded = (): void => check(true)
    fonts?.addEventListener('loadingdone', loaded)
    void fonts?.ready.then(loaded)
    return () => {
      live = false
      changed.disconnect()
      resized?.disconnect()
      fonts?.removeEventListener('loadingdone', loaded)
    }
  }, [rowRef])

  return fit
}
