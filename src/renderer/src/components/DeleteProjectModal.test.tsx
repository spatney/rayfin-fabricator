import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { OverlayProvider } from '../overlay'
import DeleteProjectModal from './DeleteProjectModal'
import { makeProject } from '../../test/harness'

function installApi(): void {
  ;(window as unknown as { api: unknown }).api = {
    onDeleteProgress: vi.fn(() => () => {})
  }
}

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('DeleteProjectModal', () => {
  it('keeps permanent Fabric app cleanup off until the user explicitly toggles it on', () => {
    installApi()
    render(
      <OverlayProvider>
        <DeleteProjectModal
          project={makeProject('p1', { name: 'Sales' })}
          onRemoved={vi.fn()}
          onClose={vi.fn()}
        />
      </OverlayProvider>
    )

    expect(screen.getByRole('heading', { name: 'Remove project' })).toBeTruthy()
    expect(screen.getByText('Local project folder')).toBeTruthy()
    expect(
      screen.getByText(/Move it to your system trash. You can restore it from there/i)
    ).toBeTruthy()
    const toggle = screen.getByRole('checkbox', {
      name: /also permanently delete the deployed Fabric app/i
    }) as HTMLInputElement
    expect(toggle.checked).toBe(false)
    expect(screen.getByText(/Fabric workspace itself is not deleted/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Move folder to trash' })).toBeTruthy()

    fireEvent.click(toggle)

    expect(toggle.checked).toBe(true)
    expect(
      screen.getByRole('button', { name: 'Move folder to trash and delete Fabric app' })
    ).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Delete project?' })).toBeNull()
  })

  it('makes clear that an undeployed project only moves its local folder to trash', () => {
    installApi()
    render(
      <OverlayProvider>
        <DeleteProjectModal
          project={makeProject('p1', { lastDeploy: undefined })}
          onRemoved={vi.fn()}
          onClose={vi.fn()}
        />
      </OverlayProvider>
    )

    expect(screen.getByText(/No deployed Fabric app is linked to this project/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Move folder to trash' })).toBeTruthy()
  })
})
