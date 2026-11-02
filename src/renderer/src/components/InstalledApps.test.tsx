import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AppActionResult, InstalledApp } from '@shared/ipc'
import InstalledApps from './InstalledApps'

const SALES: InstalledApp = {
  key: 'sales-1a2b3c4d',
  name: 'Sales',
  version: '1.2.0',
  from: 'amy@contoso.com',
  installedAt: '2026-10-04T10:00:00.000Z',
  updatedAt: '2026-10-04T10:00:00.000Z',
  icon: 'data:image/png;base64,AAAA',
  open: true
}

const NOTES: InstalledApp = {
  ...SALES,
  key: 'notes-9f8e7d6c',
  name: 'Notes',
  from: undefined,
  version: undefined,
  icon: undefined,
  open: false
}

afterEach(() => cleanup())

describe('InstalledApps', () => {
  it('shows nothing until an app is installed', () => {
    const { container } = render(<InstalledApps apps={[]} onOpen={vi.fn()} onRemove={vi.fn()} />)
    expect(container.innerHTML).toBe('')
  })

  it('opens an installed app, and removes one after asking', async () => {
    const onOpen = vi.fn()
    let finish: ((result: AppActionResult) => void) | null = null
    const onRemove = vi.fn(() => new Promise<AppActionResult>((resolve) => (finish = resolve)))
    render(<InstalledApps apps={[SALES, NOTES]} onOpen={onOpen} onRemove={onRemove} />)

    expect(screen.getByRole('heading', { name: 'Installed apps' })).toBeTruthy()
    expect(screen.getByText('2 apps')).toBeTruthy()
    expect(screen.getByText('From amy@contoso.com · Version 1.2.0')).toBeTruthy()
    expect(screen.getByText('Installed from a .rayfin file')).toBeTruthy()
    expect(screen.getAllByText('Open')).toHaveLength(1)
    expect(document.querySelector('img.app-icon')?.getAttribute('src')).toBe(SALES.icon)
    expect(document.querySelector('.app-icon--tile')?.textContent).toBe('N')

    fireEvent.click(screen.getByRole('button', { name: 'Open Notes' }))
    expect(onOpen).toHaveBeenCalledWith('notes-9f8e7d6c')

    fireEvent.click(screen.getByRole('button', { name: 'Remove Notes' }))
    expect(screen.getByText('Remove it and its data?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }))
    expect(onRemove).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Remove Notes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(onRemove).toHaveBeenCalledWith('notes-9f8e7d6c')
    expect(screen.getByRole('button', { name: 'Removing…' })).toBeTruthy()
    await act(async () =>
      finish?.({ ok: false, code: 'remove-failed', error: 'Couldn’t delete Notes: in use' })
    )
    expect(screen.getByRole('alert').textContent).toBe('Couldn’t delete Notes: in use')
  })
})
