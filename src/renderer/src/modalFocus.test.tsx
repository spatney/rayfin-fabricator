import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useModalFocus } from './modalFocus'

/**
 * Guards the shared modal focus manager: opening a dialog focuses its first
 * control, Tab / Shift+Tab cycle within the dialog, and closing it restores focus
 * to whatever opened it.
 */

/** The dialog itself — mounts/unmounts with `open`, mirroring how the real modal
 *  components are conditionally rendered by their parent. */
function Dialog({ onClose }: { onClose: () => void }): JSX.Element {
  const dialogRef = useModalFocus<HTMLDivElement>()
  return (
    <div role="dialog" ref={dialogRef}>
      <button>first</button>
      <button>second</button>
      <button onClick={onClose}>close</button>
    </div>
  )
}

/** A trigger button that mounts the dialog using the hook. */
function Harness(): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button onClick={() => setOpen(true)}>open</button>
      {open && <Dialog onClose={() => setOpen(false)} />}
    </div>
  )
}

afterEach(() => cleanup())

describe('useModalFocus', () => {
  it('focuses the first control, traps Tab, and restores focus on close', async () => {
    render(<Harness />)
    const opener = screen.getByText('open')
    opener.focus()
    expect(document.activeElement).toBe(opener)

    await act(async () => {
      fireEvent.click(opener)
    })

    // Initial focus lands on the first focusable control in the dialog.
    const first = screen.getByText('first')
    const second = screen.getByText('second')
    const close = screen.getByText('close')
    expect(document.activeElement).toBe(first)

    // Tab from the last control wraps back to the first.
    close.focus()
    fireEvent.keyDown(close, { key: 'Tab' })
    expect(document.activeElement).toBe(first)

    // Shift+Tab from the first control wraps to the last.
    first.focus()
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(close)

    // A Tab in the middle is left to the browser (focus unchanged by the trap).
    second.focus()
    fireEvent.keyDown(second, { key: 'Tab' })
    expect(document.activeElement).toBe(second)

    // Closing the dialog returns focus to the trigger that opened it.
    await act(async () => {
      fireEvent.click(close)
    })
    expect(document.activeElement).toBe(opener)
  })
})
