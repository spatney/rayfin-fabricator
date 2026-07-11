import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import HomeView from './HomeView'
import { makeProject } from '../../test/harness'

function baseProps(): ComponentProps<typeof HomeView> {
  return {
    projects: [],
    activeId: null,
    workspaceRoot: 'C:/workspace',
    opening: false,
    onSelect: vi.fn(),
    onManageProject: vi.fn(),
    onNewProject: vi.fn(),
    onOpenExisting: vi.fn(),
    onCloneFromGitHub: vi.fn(),
    onChangeWorkspaceRoot: vi.fn()
  }
}

afterEach(() => cleanup())

describe('HomeView project launcher', () => {
  it('routes each direct quick-start action without hiding folder or GitHub options in a menu', () => {
    const props = baseProps()
    render(<HomeView {...props} />)

    fireEvent.click(screen.getByRole('button', { name: /new project/i }))
    fireEvent.click(screen.getByRole('button', { name: /open folder/i }))
    fireEvent.click(screen.getByRole('button', { name: /clone from github/i }))

    expect(props.onNewProject).toHaveBeenCalledTimes(1)
    expect(props.onOpenExisting).toHaveBeenCalledTimes(1)
    expect(props.onCloneFromGitHub).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: /open existing/i })).toBeNull()
    expect(document.querySelectorAll('.home-action-icon > svg')).toHaveLength(3)
  })

  it('uses separate native controls to open and manage a recent project', () => {
    const props = baseProps()
    const project = makeProject('p1', { name: 'Sales' })
    props.projects = [project]
    render(<HomeView {...props} />)

    const open = screen.getByRole('button', { name: 'Open Sales' })
    expect(open.tagName).toBe('BUTTON')
    fireEvent.click(open)
    fireEvent.click(screen.getByRole('button', { name: 'Manage Sales' }))

    expect(props.onSelect).toHaveBeenCalledWith(project)
    expect(props.onManageProject).toHaveBeenCalledWith(project)
  })

  it('keeps the workspace location actionable', () => {
    const props = baseProps()
    render(<HomeView {...props} />)

    expect(screen.getByText('C:/workspace')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Change folder' }))

    expect(props.onChangeWorkspaceRoot).toHaveBeenCalledTimes(1)
  })
})
