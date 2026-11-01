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
    onReviewRemoval: vi.fn(),
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
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(props.onRename).toHaveBeenCalledWith(props.project, 'Revenue'))
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('surfaces a rename failure instead of closing the management flow', async () => {
    const props = baseProps()
    props.onRename = vi.fn(() => Promise.resolve('That name is unavailable.'))
    renderModal(props)

    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Revenue' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect((await screen.findByRole('alert')).textContent).toContain('That name is unavailable.')
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('explains that recents cleanup leaves files alone and delegates only that action', () => {
    const props = baseProps()
    renderModal(props)

    expect(
      screen.getByText('Hide from your recent list. Files and the Fabric app stay intact.')
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove from recent projects' }))

    expect(props.onClose).toHaveBeenCalledTimes(1)
    expect(props.onRemoveFromList).toHaveBeenCalledWith(props.project)
    expect(props.onReviewRemoval).not.toHaveBeenCalled()
  })

  it('says removal trashes the folder and offers the published app before opening that flow', () => {
    const props = baseProps()
    renderModal(props)

    expect(screen.getByText(/choose whether to delete the published app too/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Review options' }))

    expect(props.onClose).toHaveBeenCalledTimes(1)
    expect(props.onReviewRemoval).toHaveBeenCalledWith(props.project)
    expect(props.onRemoveFromList).not.toHaveBeenCalled()
  })

  it('does not imply that an unpublished project has Fabric cleanup to perform', () => {
    const props = baseProps()
    props.project = makeProject('p1', { lastDeploy: undefined })
    renderModal(props)

    expect(screen.getByText(/No Fabric app is changed/)).toBeTruthy()
    expect(screen.getByText('Hide from your recent list. Files stay intact.')).toBeTruthy()
    expect(screen.queryByText(/published app/i)).toBeNull()
  })

  it('only offers to forget a project whose folder is gone', () => {
    const props = baseProps()
    props.project = makeProject('p1', { missing: true })
    props.onHandOff = vi.fn()
    renderModal(props)

    expect(screen.getByText(/can’t find this project on this computer/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove from recent projects' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Review options' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Create .zip' })).toBeNull()
  })

  it('opens Hand off project for a local project, saying what the .zip holds', () => {
    const props = baseProps()
    props.onHandOff = vi.fn()
    renderModal(props)

    expect(
      screen.getByText(/the code and where it’s published, so someone else can pick it up/)
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Create .zip' }))

    expect(props.onClose).toHaveBeenCalledTimes(1)
    expect(props.onHandOff).toHaveBeenCalledWith(props.project)
  })

  it('leaves a team app to its team workspace instead of a hand-off', () => {
    const props = baseProps()
    props.onHandOff = vi.fn()
    props.project = makeProject('p1', {
      team: { workspaceId: 'w1', folder: 'sales', worktree: 'C:/team/sales' }
    })
    renderModal(props)

    expect(screen.queryByRole('button', { name: 'Create .zip' })).toBeNull()
  })
})
