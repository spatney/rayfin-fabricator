import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { OverlayProvider } from '../overlay'
import ManageProjectModal from './ManageProjectModal'
import { makeProject } from '../../test/harness'

function baseProps(): ComponentProps<typeof ManageProjectModal> {
  return {
    project: makeProject('p1', { name: 'Sales' }),
    onRename: vi.fn(() => Promise.resolve(null)),
    onRemoveFromList: vi.fn(),
    onMoveToTrash: vi.fn(),
    onClose: vi.fn()
  }
}

function renderModal(props: ComponentProps<typeof ManageProjectModal>): void {
  render(
    <OverlayProvider>
      <ManageProjectModal {...props} />
    </OverlayProvider>
  )
}

afterEach(() => cleanup())

describe('ManageProjectModal', () => {
  it('saves a trimmed name and closes after the rename succeeds', async () => {
    const props = baseProps()
    renderModal(props)

    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: '  Revenue  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }))

    await waitFor(() => expect(props.onRename).toHaveBeenCalledWith(props.project, 'Revenue'))
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('surfaces a rename failure instead of closing the management flow', async () => {
    const props = baseProps()
    props.onRename = vi.fn(() => Promise.resolve('That name is unavailable.'))
    renderModal(props)

    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Revenue' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }))

    expect((await screen.findByRole('alert')).textContent).toContain('That name is unavailable.')
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('explains that recents cleanup leaves files alone and delegates only that action', () => {
    const props = baseProps()
    renderModal(props)

    expect(screen.getByText(/without changing the local folder or any Fabric app/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove from recent projects' }))

    expect(props.onClose).toHaveBeenCalledTimes(1)
    expect(props.onRemoveFromList).toHaveBeenCalledWith(props.project)
    expect(props.onMoveToTrash).not.toHaveBeenCalled()
  })

  it('explains the separate local and deployed-app removal options before opening that flow', () => {
    const props = baseProps()
    renderModal(props)

    expect(screen.getByText(/two independent removal options/i)).toBeTruthy()
    expect(screen.getByText(/Fabric workspace is never deleted/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Review removal options...' }))

    expect(props.onClose).toHaveBeenCalledTimes(1)
    expect(props.onMoveToTrash).toHaveBeenCalledWith(props.project)
    expect(props.onRemoveFromList).not.toHaveBeenCalled()
  })

  it('does not imply that an undeployed project has Fabric cleanup to perform', () => {
    const props = baseProps()
    props.project = makeProject('p1', { lastDeploy: undefined })
    renderModal(props)

    expect(screen.getByText(/no Fabric app will be changed/i)).toBeTruthy()
    expect(screen.queryByText(/two independent removal options/i)).toBeNull()
  })
})
