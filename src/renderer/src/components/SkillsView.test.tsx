import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { SkillInfo, StudioProject } from '@shared/ipc'
import { OverlayProvider } from '../overlay'
import SkillsView from './SkillsView'

/**
 * SkillsView surfaces custom skills in two distinct sections: the reusable
 * "Your skill library" (library skills, editable/deletable) and "Added in this
 * app" (project-local skills, promotable to the library). These guard that the
 * sections + their affordances render and call the right window.api methods.
 */

const BASE_SKILL: SkillInfo = {
  id: 'rayfin',
  title: 'Rayfin essentials',
  description: 'core',
  icon: '◆',
  base: true,
  active: true
}
const LIBRARY_SKILL: SkillInfo = {
  id: 'brand',
  title: 'Brand',
  description: 'Our brand',
  icon: '🎨',
  base: false,
  active: false,
  custom: true,
  library: true
}
const APP_SKILL: SkillInfo = {
  id: 'local-thing',
  title: 'Local Thing',
  description: 'app only',
  icon: '🧩',
  base: false,
  active: true,
  custom: true
}

function installApi(list: SkillInfo[]): {
  skills: { list: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> }
  customSkills: { promote: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }
} {
  const api = {
    skills: {
      list: vi.fn(() => Promise.resolve(list)),
      set: vi.fn(() => Promise.resolve({ ok: true, skills: list })),
      source: vi.fn(() => Promise.resolve({ ok: true, installed: true, content: 'x' }))
    },
    customSkills: {
      list: vi.fn(() => Promise.resolve([])),
      promote: vi.fn(() => Promise.resolve({ ok: true, id: 'local-thing', library: [] })),
      remove: vi.fn(() => Promise.resolve({ ok: true, id: 'brand', library: [] }))
    }
  }
  ;(window as unknown as { api: unknown }).api = api
  return api as unknown as ReturnType<typeof installApi>
}

async function renderView(): Promise<void> {
  await act(async () => {
    render(
      <OverlayProvider>
        <SkillsView project={{ id: 'p1' } as unknown as StudioProject} onChanged={() => {}} />
      </OverlayProvider>
    )
  })
}

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('SkillsView custom-skill sections', () => {
  beforeEach(() => {
    installApi([BASE_SKILL, LIBRARY_SKILL, APP_SKILL])
  })

  it('renders a dedicated "Your skill library" section with Edit/Delete, and "Added in this app" with Save to library', async () => {
    await renderView()

    expect(await screen.findByText('Your skill library')).toBeTruthy()
    expect(screen.getByText('Added in this app')).toBeTruthy()

    // Library skill card has Edit + Delete affordances.
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy()

    // Project-local skill can be promoted into the library.
    expect(screen.getByRole('button', { name: 'Save to library' })).toBeTruthy()

    // And the header entry point to add a custom skill is present.
    expect(screen.getByRole('button', { name: '+ Add custom skill' })).toBeTruthy()
  })

  it('promotes a project-local skill via customSkills.promote and reloads', async () => {
    const api = installApi([BASE_SKILL, LIBRARY_SKILL, APP_SKILL])
    await renderView()
    await screen.findByText('Added in this app')

    fireEvent.click(screen.getByRole('button', { name: 'Save to library' }))

    await waitFor(() => expect(api.customSkills.promote).toHaveBeenCalledWith('p1', 'local-thing'))
    // Reloaded the project list (once on mount, once after promote).
    await waitFor(() => expect(api.skills.list).toHaveBeenCalledTimes(2))
  })

  it('deletes a library skill through the confirm dialog', async () => {
    const api = installApi([BASE_SKILL, LIBRARY_SKILL, APP_SKILL])
    await renderView()
    await screen.findByText('Your skill library')

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(api.customSkills.remove).toHaveBeenCalledWith('brand'))
  })

  it('hides the library section when there are no library skills, keeping the add entry point', async () => {
    installApi([BASE_SKILL])
    await renderView()

    expect(await screen.findByRole('button', { name: '+ Add custom skill' })).toBeTruthy()
    expect(screen.queryByText('Your skill library')).toBeNull()
    expect(screen.queryByText('Added in this app')).toBeNull()
  })
})
