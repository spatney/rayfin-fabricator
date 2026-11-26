import { describe, expect, it } from 'vitest'
import { composerFit, type ComposerFit } from './composerFit'

/** Widths in the row, in px: the "+" menu and gaps, the plugins, the model, the right. */
const SIZES = {
  others: 26,
  named: 190,
  counted: 46,
  modelWhole: 202,
  modelBare: 54,
  buttons: 36,
  hint: 105
}

function box(el: HTMLElement, read: () => { left?: number; width: number }): void {
  el.getBoundingClientRect = () => {
    const { left = 0, width } = read()
    return {
      left,
      width,
      right: left + width,
      top: 0,
      bottom: 30,
      height: 30,
      x: left,
      y: 0
    } as DOMRect
  }
}

/** A composer row `width` px wide, laid out as it is while it shows `shows`. */
function row(width: number, shows: ComposerFit): HTMLElement {
  const el = document.createElement('div')
  el.className = 'composer-actions'
  el.innerHTML = `
    <div class="composer-left">
      <div class="composer-menu plugins-menu">
        <button class="composer-pill pl-pill${shows.names ? '' : ' pl-pill--compact'}">
          ${shows.names ? '<span class="pl-pill-label">Fabric IQ, OpenAI Images</span>' : ''}
          <span class="pl-pill-count">2</span>
        </button>
        ${shows.names ? '' : '<span class="composer-pill pl-pill pl-pill-ghost"></span>'}
      </div>
      <div class="composer-menu model-picker">
        <button><span class="composer-pill-label composer-pill-label--model">Claude Opus 4.5</span></button>
      </div>
    </div>
    <div class="composer-right"><span class="composer-hint"></span><button></button></div>`
  const find = (selector: string): HTMLElement => el.querySelector<HTMLElement>(selector)!
  const trigger = find('.plugins-menu > button')
  const label = trigger.querySelector<HTMLElement>('.pl-pill-label')
  const model = find('.model-picker')
  const name = find('.composer-pill-label--model')
  if (!shows.hint) find('.composer-hint').style.position = 'absolute'

  const triggerWidth = (): number =>
    label && label.style.display !== 'none' ? SIZES.named : SIZES.counted
  const right = SIZES.buttons + (shows.hint ? SIZES.hint : 0)
  const natural = (): number =>
    (name.style.display ? name.style.display !== 'none' : shows.model)
      ? SIZES.modelWhole
      : SIZES.modelBare
  // The model takes what's left, up to its whole width, unless it's kept from shrinking.
  const modelWidth = (): number =>
    model.style.flexShrink === '0'
      ? natural()
      : Math.max(0, Math.min(natural(), width - SIZES.others - triggerWidth() - right))

  box(el, () => ({ width }))
  box(trigger, () => ({ width: triggerWidth() }))
  if (!shows.names) box(find('.pl-pill-ghost'), () => ({ width: SIZES.named }))
  box(model, () => ({ left: SIZES.others + triggerWidth(), width: modelWidth() }))
  box(find('.composer-hint'), () => ({ width: SIZES.hint }))
  box(find('.composer-right'), () => ({ width: right }))
  return el
}

const SHOWING: ComposerFit[] = [
  { model: true, names: true, hint: true },
  { model: true, names: true, hint: false },
  { model: true, names: false, hint: false },
  { model: false, names: false, hint: false }
]

describe('composerFit', () => {
  it.each([
    [600, SHOWING[0]],
    [500, SHOWING[1]],
    [400, SHOWING[2]],
    [220, SHOWING[3]]
  ])(
    'at %ipx, gives way with the hint, then the plugins’ names, then the model’s name, whatever the row shows',
    (width, fit) => {
      for (const shows of SHOWING) expect(composerFit(row(width, shows))).toEqual(fit)
    }
  )

  it('shows part of the model’s name over only its logo, and puts back what it measured with', () => {
    // 64px of the name fits beside the counted plugins: 26 + 46 + 54 + 64 + 36.
    const el = row(226, SHOWING[3])
    expect(composerFit(el).model).toBe(true)
    expect(composerFit(row(225, SHOWING[2])).model).toBe(false)
    expect(el.querySelector<HTMLElement>('.model-picker')!.style.flexShrink).toBe('')
    expect(el.querySelector<HTMLElement>('.composer-pill-label--model')!.style.display).toBe('')
  })
})
