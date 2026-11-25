import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

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

    expect(onConfirm).toHaveBeenCalledWith(project, { deleteApp: true, deleteSupporting: false })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps the published app when its box is cleared', () => {
    const project = makeProject('p1')
    const { onConfirm } = renderModal(project)

    fireEvent.click(screen.getByRole('checkbox', { name: 'Published Fabric app' }))

    expect(screen.getByText('The published app and its data stay in Fabric.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Move folder to trash' }))
    expect(onConfirm).toHaveBeenCalledWith(project, { deleteApp: false, deleteSupporting: false })
  })

  it('offers to delete the supporting items it created in Fabric, off until chosen', async () => {
    const list = vi.fn(() =>
      Promise.resolve({
        available: true,
        on: true,
        workspace: { id: 'w1', name: 'Contoso Apps' },
        items: [
          { key: 'a', folder: 'Retail.Lakehouse', name: 'Retail', type: 'Lakehouse', itemId: 'l1' },
          {
            key: 'b',
            folder: 'Sales.SemanticModel',
            name: 'Sales',
            type: 'SemanticModel',
            itemId: 'm1'
          },
          // Not created in Fabric: nothing to delete there.
          { key: 'c', folder: 'Draft.SemanticModel', name: 'Draft', type: 'SemanticModel' }
        ]
      })
    )
    vi.stubGlobal('api', { supportingItems: { list } })
    const project = makeProject('p1', { name: 'Sales', workspaceName: 'fabcon' })
    const { onConfirm } = renderModal(project)

    const supporting = (await screen.findByRole('checkbox', {
      name: 'Supporting items in Fabric'
    })) as HTMLInputElement
    expect(list).toHaveBeenCalledWith('p1')
    expect(supporting.checked).toBe(false)
    expect(
      screen.getByText(
        /Delete Retail \(Lakehouse\), Sales \(Semantic model\) from Contoso Apps: the semantic models/
      )
    ).toBeTruthy()
    expect(screen.getByText('Its supporting items stay in Fabric.')).toBeTruthy()

    fireEvent.click(supporting)
    await waitFor(() =>
      expect(screen.queryByText('Its supporting items stay in Fabric.')).toBeNull()
    )
    fireEvent.click(screen.getByRole('button', { name: 'Trash folder & delete in Fabric' }))
    expect(onConfirm).toHaveBeenCalledWith(project, { deleteApp: true, deleteSupporting: true })
  })

  it('makes clear that an unpublished project only moves its local folder to trash', () => {
    const project = makeProject('p1', { lastDeploy: undefined })
    const { onConfirm } = renderModal(project)

    expect(screen.queryByRole('checkbox', { name: 'Published Fabric app' })).toBeNull()
    expect(screen.getByText(/No published Fabric app is linked to this project/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Move folder to trash' }))
    expect(onConfirm).toHaveBeenCalledWith(project, { deleteApp: false, deleteSupporting: false })
  })
})
