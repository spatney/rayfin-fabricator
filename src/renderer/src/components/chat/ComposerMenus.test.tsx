import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { AddMenu } from './ComposerMenus'

afterEach(cleanup)

function renderMenu(over: { imageNote?: string } = {}) {
  const handlers = { onImage: vi.fn(), onConnectData: vi.fn(), onReferenceFile: vi.fn() }
  render(<AddMenu locked={false} attaching={false} imageNote={over.imageNote} {...handlers} />)
  const open = (): HTMLElement => {
    fireEvent.click(screen.getByRole('button', { name: 'Add images, files or data' }))
    return screen.getByRole('menu', { name: 'Add' })
  }
  return { ...handlers, open }
}

describe('AddMenu', () => {
  it('opens the kinds of Fabric data beside the menu, each opening the data picker on its kind', () => {
    const { open, onConnectData } = renderMenu()
    const menu = open()
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['ImageOr paste', 'File@', 'Fabric data'])

    fireEvent.click(within(menu).getByRole('menuitem', { name: /Fabric data/ }))
    const kinds = screen.getByRole('menu', { name: 'Fabric data' })
    expect(within(kinds).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Semantic modelDAX',
      'WarehouseRead & write',
      'SQL databaseRead & write',
      'LakehouseRead-only',
      'Browse all Fabric data…'
    ])
    fireEvent.click(within(kinds).getByRole('menuitem', { name: /Warehouse/ }))
    expect(onConnectData).toHaveBeenLastCalledWith('warehouse')
    expect(screen.queryByRole('menu')).toBeNull()

    // From the keyboard: → opens the list, ← closes it.
    fireEvent.keyDown(within(open()).getByRole('menuitem', { name: /Fabric data/ }), { key: 'ArrowRight' })
    const list = screen.getByRole('menu', { name: 'Fabric data' })
    fireEvent.keyDown(within(list).getByRole('menuitem', { name: /Lakehouse/ }), { key: 'ArrowLeft' })
    expect(screen.queryByRole('menu', { name: 'Fabric data' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: /Fabric data/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Browse all Fabric data…' }))
    expect(onConnectData).toHaveBeenLastCalledWith()
  })

  it('says why images can’t be added, and references a file', () => {
    const { open, onImage, onReferenceFile } = renderMenu({ imageNote: 'o3-mini can’t read images' })
    const menu = open()
    const image = within(menu).getByRole('menuitem', { name: /Image/ }) as HTMLButtonElement
    expect(image.disabled).toBe(true)
    expect(image.textContent).toContain('o3-mini can’t read images')
    fireEvent.click(image)
    expect(onImage).not.toHaveBeenCalled()
    fireEvent.click(within(menu).getByRole('menuitem', { name: /File/ }))
    expect(onReferenceFile).toHaveBeenCalledTimes(1)
  })
})
