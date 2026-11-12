import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CUSTOM_INSTRUCTIONS_MAX } from '@shared/ipc'
import CustomInstructionsModal from './CustomInstructionsModal'

function renderModal(instructions?: string) {
  const onSave = vi.fn()
  const onClose = vi.fn()
  render(<CustomInstructionsModal instructions={instructions} onSave={onSave} onClose={onClose} />)
  const box = screen.getByRole('textbox', { name: 'Instructions' }) as HTMLTextAreaElement
  const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
  return { onSave, onClose, box, save }
}

afterEach(cleanup)

describe('CustomInstructionsModal', () => {
  it('starts from the saved instructions, and saves a change trimmed', () => {
    const { onSave, onClose, box, save } = renderModal('Use the system theme by default.')
    expect(box.value).toBe('Use the system theme by default.')
    expect(box.maxLength).toBe(CUSTOM_INSTRUCTIONS_MAX)
    expect(document.activeElement).toBe(box)
    // Nothing to save until the text changes, beyond spaces around it.
    expect(save.disabled).toBe(true)
    fireEvent.change(box, { target: { value: '  Use the system theme by default.\n' } })
    expect(save.disabled).toBe(true)

    fireEvent.change(box, {
      target: { value: 'Use the system theme by default.\nShow dates like 5 Mar 2026.\n\n' }
    })
    fireEvent.click(save)
    expect(onSave).toHaveBeenCalledWith(
      'Use the system theme by default.\nShow dates like 5 Mar 2026.'
    )
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('saves an emptied box, which clears them', () => {
    const { onSave, box, save } = renderModal('Use the system theme by default.')
    fireEvent.change(box, { target: { value: '   ' } })
    fireEvent.click(save)
    expect(onSave).toHaveBeenCalledWith('')
  })

  it('leaves them as they were on Cancel and Escape', () => {
    const { onSave, onClose, box } = renderModal()
    fireEvent.change(box, { target: { value: 'Use the system theme by default.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(onSave).not.toHaveBeenCalled()
  })
})
