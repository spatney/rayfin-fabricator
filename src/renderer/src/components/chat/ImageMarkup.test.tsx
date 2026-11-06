import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImageMarkup } from './ImageMarkup'
import { flatten } from './markup'

// jsdom decodes no pictures and has no canvas: the picture is 800 × 600, and a
// stand-in flattens what's drawn.
vi.mock('./images', () => ({
  loadImage: vi.fn(async (src: string) => ({ src, naturalWidth: 800, naturalHeight: 600 }))
}))
vi.mock('./markup', async (original) => ({
  ...(await original<typeof import('./markup')>()),
  flatten: vi.fn(() => 'data:image/png;base64,DRAWN')
}))

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  // The stage has room for the picture at its own size (inside a 20px inset).
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
    return this.classList.contains('markup-stage') ? 840 : 0
  })
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
    return this.classList.contains('markup-stage') ? 640 : 0
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function open(): { onDone: ReturnType<typeof vi.fn>; onCancel: ReturnType<typeof vi.fn> } {
  const onDone = vi.fn()
  const onCancel = vi.fn()
  render(
    <ImageMarkup
      src="data:copy"
      loadFull={async () => 'data:full'}
      label="Screenshot"
      onDone={onDone}
      onCancel={onCancel}
    />
  )
  return { onDone, onCancel }
}

/** The drawing area, shown 800 × 600 at (100, 50). */
async function ink(): Promise<HTMLCanvasElement> {
  const canvas = (await screen.findByLabelText(/^Drawing area/)) as HTMLCanvasElement
  canvas.getBoundingClientRect = () =>
    ({
      left: 100,
      top: 50,
      right: 900,
      bottom: 650,
      width: 800,
      height: 600,
      x: 100,
      y: 50,
      toJSON() {}
    }) as DOMRect
  return canvas
}

function drag(target: Element, from: [number, number], to: [number, number]): void {
  act(() => {
    target.dispatchEvent(
      new MouseEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: from[0],
        clientY: from[1]
      })
    )
    target.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: to[0], clientY: to[1] })
    )
    target.dispatchEvent(
      new MouseEvent('pointerup', { bubbles: true, clientX: to[0], clientY: to[1] })
    )
  })
}

function key(init: KeyboardEventInit): void {
  act(() => {
    fireEvent.keyDown(window, init)
  })
}

describe('ImageMarkup', () => {
  it('draws on the full-size picture with the chosen tool and color, with undo and redo', async () => {
    const { onDone } = open()
    const canvas = await ink()
    expect(screen.getByRole('img', { name: 'Screenshot' }).getAttribute('src')).toBe('data:full')

    key({ key: 'a' })
    key({ key: '2' })
    expect(screen.getByRole('button', { name: 'Arrow' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Yellow' }).getAttribute('aria-pressed')).toBe('true')
    drag(canvas, [150, 100], [350, 200])
    const undoButton = screen.getByRole<HTMLButtonElement>('button', { name: 'Undo' })
    expect(undoButton.disabled).toBe(false)
    key({ key: 'z', ctrlKey: true })
    expect(undoButton.disabled).toBe(true)
    key({ key: 'z', ctrlKey: true, shiftKey: true })
    expect(undoButton.disabled).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onDone).toHaveBeenCalledWith('data:image/png;base64,DRAWN')
    const [, width, height, marks] = vi.mocked(flatten).mock.lastCall!
    expect([width, height]).toEqual([800, 600])
    expect(marks).toEqual([
      {
        tool: 'arrow',
        color: '#ffcc00',
        width: 4,
        points: [
          [50, 50],
          [250, 150]
        ]
      }
    ])
  })

  it('asks for a second Escape before it throws a drawing away', async () => {
    const { onCancel } = open()
    drag(await ink(), [150, 100], [250, 160])
    key({ key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toBe('Press Esc again to throw the drawing away')
    key({ key: 'Escape' })
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('gives nothing back when nothing was drawn, and closes on one Escape', async () => {
    const { onDone, onCancel } = open()
    await ink()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onDone).toHaveBeenCalledWith(null)
    key({ key: 'Escape' })
    expect(onCancel).toHaveBeenCalledOnce()
  })
})
