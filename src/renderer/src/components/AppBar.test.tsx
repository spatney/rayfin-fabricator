import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { TeamWorkspace } from '@shared/ipc'
import { OverlayProvider, usePreviewSuppressed } from '../overlay'
import { makeProject } from '../../test/harness'
import { ProjectSwitcher } from './AppBar'

type Props = ComponentProps<typeof ProjectSwitcher>

const current = makeProject('current', { name: 'Tpm board', path: 'C:\\Users\\amy\\RayfinProjects\\tpm-board' })

function makeProps(overrides: Partial<Props> = {}): Props {
  return {
    project: current,
    projects: [
      current,
      makeProject('notes', { name: 'Notes', path: 'C:\\Users\\amy\\RayfinProjects\\notes' }),
      makeProject('sales', { name: 'Sales', path: 'D:\\work\\sales' })
    ],
    onSelect: vi.fn(),
    onShowAll: vi.fn(),
    ...overrides
  }
}

function PreviewProbe(): JSX.Element {
  return <output aria-label="preview">{usePreviewSuppressed() ? 'hidden' : 'shown'}</output>
}

function renderSwitcher(overrides: Partial<Props> = {}): Props {
  const props = makeProps(overrides)
  render(
    <OverlayProvider>
      <button>Elsewhere</button>
      <ProjectSwitcher {...props} />
      <PreviewProbe />
    </OverlayProvider>
  )
  return props
}

const trigger = (): HTMLButtonElement =>
  screen.getByRole('button', { name: 'Tpm board — Switch projects' }) as HTMLButtonElement
const item = (name: string): HTMLButtonElement =>
  screen.getByRole('menuitem', { name }) as HTMLButtonElement
const itemNames = (): string[] =>
  within(screen.getByRole('menu', { name: 'Switch projects' }))
    .getAllByRole('menuitem')
    .map((el) => el.getAttribute('aria-label') ?? el.textContent ?? '')

/** Flush the open menu's deferred initial focus. */
async function frame(): Promise<void> {
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
}

afterEach(cleanup)

describe('ProjectSwitcher', () => {
  it('opens a menu of the other recent projects, most recent first', async () => {
    renderSwitcher()
    expect(trigger().textContent).toBe('TTpm board')
    expect(trigger().title).toBe('C:\\Users\\amy\\RayfinProjects\\tpm-board\nSwitch projects')
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.click(trigger())
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Recent projects')).toBeTruthy()
    expect(itemNames()).toEqual(['Notes', 'Sales', 'All projects'])
    expect(item('Notes').textContent).toBe('NNotes~\\RayfinProjects\\notes')
    expect(item('Notes').title).toBe('C:\\Users\\amy\\RayfinProjects\\notes')
    expect(item('Sales').textContent).toContain('D:\\work\\sales')
    await frame()
    expect(document.activeElement).toBe(item('Notes'))
  })

  it('switches to the picked project and keeps focus on the switcher', () => {
    const props = renderSwitcher()
    fireEvent.click(trigger())
    fireEvent.click(item('Sales'))
    expect(props.onSelect).toHaveBeenCalledTimes(1)
    expect(props.onSelect).toHaveBeenCalledWith(props.projects[2])
    expect(props.onShowAll).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })

  it('shows every project on Home from All projects', () => {
    const props = renderSwitcher()
    fireEvent.click(trigger())
    fireEvent.click(item('All projects'))
    expect(props.onShowAll).toHaveBeenCalledTimes(1)
    expect(props.onSelect).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('lists at most six projects and leaves missing folders to Home', () => {
    const others = Array.from({ length: 8 }, (_, i) =>
      makeProject(`p${i}`, { name: `App ${i}`, missing: i === 1 })
    )
    renderSwitcher({ projects: [others[0], current, ...others.slice(1)] })
    fireEvent.click(trigger())
    expect(itemNames()).toEqual(['App 0', 'App 2', 'App 3', 'App 4', 'App 5', 'App 6', 'All projects'])
  })

  it('names a team app by its workspace instead of its folder', () => {
    const workspace = { id: 'ws1', name: 'Contoso team' } as TeamWorkspace
    const teamApp = makeProject('team', {
      name: 'Expenses',
      path: 'C:\\Users\\amy\\.fabricator\\teams\\ws1\\expenses',
      team: { workspaceId: 'ws1', folder: 'expenses', worktree: 'C:\\worktrees\\expenses' }
    })
    renderSwitcher({ projects: [current, teamApp], teamWorkspaces: [workspace] })
    fireEvent.click(trigger())
    expect(item('Expenses').textContent).toBe('EExpensesContoso team')
  })

  it('offers only All projects when no other project can be opened', async () => {
    renderSwitcher({ projects: [current, makeProject('gone', { missing: true })] })
    fireEvent.click(trigger())
    expect(screen.getByText('No other recent projects')).toBeTruthy()
    expect(screen.queryByText('Recent projects')).toBeNull()
    expect(screen.queryByRole('separator')).toBeNull()
    expect(itemNames()).toEqual(['All projects'])
    await frame()
    expect(document.activeElement).toBe(item('All projects'))
  })

  it('moves between items with the arrow keys', async () => {
    renderSwitcher()
    fireEvent.click(trigger())
    await frame()
    fireEvent.keyDown(item('Notes'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(item('Sales'))
    fireEvent.keyDown(item('Sales'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(item('All projects'))
    fireEvent.keyDown(item('All projects'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(item('Notes'))
    fireEvent.keyDown(item('Notes'), { key: 'End' })
    expect(document.activeElement).toBe(item('All projects'))
  })

  it('closes on Escape (returning focus), outside presses, and Tab', async () => {
    renderSwitcher()
    fireEvent.click(trigger())
    await frame()
    fireEvent.keyDown(item('Notes'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger())

    fireEvent.click(trigger())
    fireEvent.pointerDown(screen.getByRole('menu'))
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Elsewhere' }))
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.click(trigger())
    fireEvent.keyDown(trigger(), { key: 'Tab' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('hides the native preview only while the menu is open', () => {
    renderSwitcher()
    const preview = screen.getByLabelText('preview')
    expect(preview.textContent).toBe('shown')
    fireEvent.click(trigger())
    expect(preview.textContent).toBe('hidden')
    fireEvent.click(trigger())
    expect(preview.textContent).toBe('shown')
  })
})
