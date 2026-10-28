import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ActionPanel, type PanelAction } from './ActionPanel'

const action = (id: string, title: string): PanelAction => ({
  id,
  title,
  icon: 'zap',
  run: vi.fn()
})
const box = (): HTMLElement => screen.getByRole('combobox', { name: 'Search for actions' })

afterEach(() => {
  cleanup()
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView
})

describe('Actions', () => {
  it('keeps the action you chose when others come and go, and never hands it to another', () => {
    const open = action('open-help', 'Open in Help')
    const stop = action('stop', 'Stop answering')
    const startOver = action('new', 'New conversation')
    const { rerender } = render(
      <ActionPanel title="Help" sections={[{ actions: [open, stop] }]} onClose={vi.fn()} />
    )
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    expect(
      screen.getByRole('option', { name: /Stop answering/ }).getAttribute('aria-selected')
    ).toBe('true')

    // The answer finishes before Enter: Stop answering goes, and starting over joins the list.
    rerender(
      <ActionPanel
        title="Help"
        sections={[{ actions: [open] }, { actions: [startOver] }]}
        onClose={vi.fn()}
      />
    )
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(open.run).toHaveBeenCalled()
    expect(startOver.run).not.toHaveBeenCalled()
  })

  it('keeps the action chosen with the keyboard in sight, but not the one under the pointer', () => {
    const scrollIntoView = vi.fn()
    HTMLElement.prototype.scrollIntoView = scrollIntoView
    const actions = Array.from({ length: 8 }, (_, i) => action(`a${i}`, `Action ${i + 1}`))
    render(<ActionPanel title="Docs" sections={[{ actions }]} onClose={vi.fn()} />)

    fireEvent.keyDown(box(), { key: 'ArrowUp' })
    const { contexts } = scrollIntoView.mock
    expect(contexts[contexts.length - 1]).toBe(screen.getByRole('option', { name: /Action 8/ }))

    const calls = scrollIntoView.mock.calls.length
    fireEvent.pointerMove(screen.getByRole('option', { name: /Action 3/ }))
    expect(scrollIntoView.mock.calls.length).toBe(calls)
  })
})
