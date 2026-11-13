import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { RayfinVersionInfo } from '@shared/ipc'
import RayfinVersionControl from './RayfinVersionControl'

afterEach(cleanup)

const current: RayfinVersionInfo = {
  version: '1.36.2',
  latest: '1.36.2',
  upgradeAvailable: false,
  packages: [
    {
      name: '@microsoft/rayfin-cli',
      kind: 'cli',
      installed: '1.36.2',
      latest: '1.36.2',
      upgradable: false
    }
  ]
}

describe('RayfinVersionControl', () => {
  it('stays out of the status bar until there is an update', () => {
    const { container, rerender } = render(<RayfinVersionControl info={null} onUpdate={vi.fn()} />)
    expect(container.firstChild).toBeNull()

    rerender(<RayfinVersionControl info={current} onUpdate={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })

  it('offers the update when a newer release is out', () => {
    const onUpdate = vi.fn()
    const outdated: RayfinVersionInfo = {
      version: '1.35.1',
      latest: '1.36.2',
      upgradeAvailable: true,
      packages: [
        {
          name: '@microsoft/rayfin-cli',
          kind: 'cli',
          installed: '1.35.1',
          latest: '1.36.2',
          upgradable: true
        }
      ]
    }
    render(<RayfinVersionControl info={outdated} onUpdate={onUpdate} />)

    fireEvent.click(screen.getByRole('button', { name: /Rayfin v1\.35\.1/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Update with Copilot' }))
    expect(onUpdate).toHaveBeenCalledWith(outdated)
  })

  it('offers a newer release than the recommended one, saying why it needs care', () => {
    const onUpdate = vi.fn()
    const preview = { version: '2.0.0', isLatest: false, runsLocally: true }
    const { rerender } = render(
      <RayfinVersionControl info={current} newer={preview} onUpdate={onUpdate} />
    )
    const chip = screen.getByRole('button', { name: /Rayfin v1\.36\.2/ })
    expect(chip.textContent, 'no update badge for it').toBe('Rayfin v1.36.2')

    fireEvent.click(chip)
    expect(screen.getByText('Rayfin 2.0.0 is available')).toBeTruthy()
    expect(
      screen.getByText('It isn’t Rayfin’s latest release yet, so it might be unstable.')
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Update with Copilot' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Update to 2.0.0 with Copilot' }))
    expect(onUpdate).toHaveBeenCalledWith(current, preview)

    // Below the recommended update, when there's one too.
    const behind: RayfinVersionInfo = {
      ...current,
      version: '1.36.0',
      latest: '1.36.2',
      upgradeAvailable: true,
      packages: [{ ...current.packages[0], installed: '1.36.0', upgradable: true }]
    }
    rerender(<RayfinVersionControl info={behind} newer={preview} onUpdate={onUpdate} />)
    fireEvent.click(screen.getByRole('button', { name: /Rayfin v1\.36\.0/ }))
    expect(screen.getByRole('button', { name: 'Update with Copilot' })).toBeTruthy()
    expect(screen.getByText('Rayfin 2.0.0 is available too')).toBeTruthy()
  })
})
