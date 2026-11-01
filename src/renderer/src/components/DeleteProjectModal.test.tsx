import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { StudioProject } from '@shared/ipc'
import { OverlayProvider } from '../overlay'
import DeleteProjectModal from './DeleteProjectModal'
import { makeProject } from '../../test/harness'

function renderModal(project: StudioProject): {
  onConfirm: ReturnType<typeof vi.fn>
  onClose: ReturnType<typeof vi.fn>
} {
  const onConfirm = vi.fn()
  const onClose = vi.fn()
  render(
    <OverlayProvider>
      <DeleteProjectModal project={project} onConfirm={onConfirm} onClose={onClose} />
    </OverlayProvider>
  )
  return { onConfirm, onClose }
}

afterEach(() => cleanup())

describe('DeleteProjectModal', () => {
  it('trashes the folder and, by default, deletes the published app, with no name to type', () => {
    const project = makeProject('p1', { name: 'Sales', workspaceName: 'fabcon' })
    const { onConfirm, onClose } = renderModal(project)

    expect(screen.getByRole('heading', { name: 'Remove project' })).toBeTruthy()
    const folder = screen.getByRole('checkbox', {
      name: 'Local project folder'
    }) as HTMLInputElement
    expect(folder.checked).toBe(true)
    expect(folder.disabled).toBe(true)
    const app = screen.getByRole('checkbox', { name: 'Published Fabric app' }) as HTMLInputElement
    expect(app.checked).toBe(true)
    expect(screen.getByText(/Delete Sales and all app data in fabcon/)).toBeTruthy()
    expect(screen.getByText('This cannot be undone.')).toBeTruthy()
    expect(screen.getByText('Your Fabric workspace will be kept.')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Trash folder & delete app' }))

    expect(onConfirm).toHaveBeenCalledWith(project, { deleteApp: true })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps the published app when its box is cleared', () => {
    const project = makeProject('p1')
    const { onConfirm } = renderModal(project)

    fireEvent.click(screen.getByRole('checkbox', { name: 'Published Fabric app' }))

    expect(screen.getByText('The published app and its data stay in Fabric.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Move folder to trash' }))
    expect(onConfirm).toHaveBeenCalledWith(project, { deleteApp: false })
  })

  it('makes clear that an unpublished project only moves its local folder to trash', () => {
    const project = makeProject('p1', { lastDeploy: undefined })
    const { onConfirm } = renderModal(project)

    expect(screen.queryByRole('checkbox', { name: 'Published Fabric app' })).toBeNull()
    expect(screen.getByText(/No published Fabric app is linked to this project/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Move folder to trash' }))
    expect(onConfirm).toHaveBeenCalledWith(project, { deleteApp: false })
  })
})
