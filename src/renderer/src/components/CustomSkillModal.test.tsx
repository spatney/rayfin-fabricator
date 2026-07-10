import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { OverlayProvider } from '../overlay'

// Monaco doesn't run under jsdom — swap the editor for a plain textarea and stub the
// local Monaco bootstrap side-effect so we can drive the SKILL.md content directly.
vi.mock('../monaco', () => ({}))
vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange }: { value: string; onChange?: (v: string | undefined) => void }) => (
    <textarea
      data-testid="skill-editor"
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
    />
  )
}))

// Imported after the mocks so the component picks up the stubbed editor
// (vitest hoists vi.mock above imports).
import CustomSkillModal from './CustomSkillModal'

interface Api {
  customSkills: {
    save: ReturnType<typeof vi.fn>
    pickFolderPreview: ReturnType<typeof vi.fn>
    pickFilePreview: ReturnType<typeof vi.fn>
    addFromPath: ReturnType<typeof vi.fn>
    source: ReturnType<typeof vi.fn>
  }
}

function installApi(): Api {
  const api: Api = {
    customSkills: {
      save: vi.fn(() => Promise.resolve({ ok: true, id: 'my-skill', library: [] })),
      pickFolderPreview: vi.fn(() =>
        Promise.resolve({
          ok: true,
          cancelled: false,
          sourcePath: 'C:/tmp/skill',
          content: '---\nname: brand\ndescription: d\n---\n# Brand',
          title: 'Brand',
          description: 'Our brand',
          icon: '🎨',
          referenceCount: 2
        })
      ),
      pickFilePreview: vi.fn(() =>
        Promise.resolve({ ok: false, cancelled: true, referenceCount: 0 })
      ),
      addFromPath: vi.fn(() => Promise.resolve({ ok: true, id: 'brand', library: [] })),
      source: vi.fn(() =>
        Promise.resolve({
          ok: true,
          installed: true,
          content: '---\nname: e\ndescription: d\n---\n# E'
        })
      )
    }
  }
  ;(window as unknown as { api: unknown }).api = api
  return api
}

async function renderModal(props: Record<string, unknown> = {}): Promise<void> {
  await act(async () => {
    render(
      <OverlayProvider>
        <CustomSkillModal projectId="p1" onClose={() => {}} onSaved={() => {}} {...props} />
      </OverlayProvider>
    )
  })
}

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('CustomSkillModal', () => {
  it('adds to the current app only by default (library checkbox off)', async () => {
    const api = installApi()
    await renderModal()

    // The library option is present and unchecked by default.
    const checkbox = screen.getByRole('checkbox', { name: /save to my skill library/i })
    expect((checkbox as HTMLInputElement).checked).toBe(false)

    fireEvent.change(screen.getByPlaceholderText('e.g. Our brand style'), {
      target: { value: 'My Skill' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add skill' }))

    await waitFor(() => expect(api.customSkills.save).toHaveBeenCalledTimes(1))
    const [input, projectId, toLibrary] = api.customSkills.save.mock.calls[0]
    expect(projectId).toBe('p1')
    expect(toLibrary).toBe(false)
    expect(input.title).toBe('My Skill')
    expect(input.id).toBeUndefined()
    expect(input.content).toContain('name:')
  })

  it('saves to the library too when the checkbox is ticked', async () => {
    const api = installApi()
    await renderModal()

    fireEvent.change(screen.getByPlaceholderText('e.g. Our brand style'), {
      target: { value: 'My Skill' }
    })
    fireEvent.click(screen.getByRole('checkbox', { name: /save to my skill library/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Add skill' }))

    await waitFor(() => expect(api.customSkills.save).toHaveBeenCalledTimes(1))
    expect(api.customSkills.save.mock.calls[0][2]).toBe(true)
  })

  it('defaults the library checkbox on when opened from the library section', async () => {
    installApi()
    await renderModal({ defaultToLibrary: true })
    const checkbox = screen.getByRole('checkbox', { name: /save to my skill library/i })
    expect((checkbox as HTMLInputElement).checked).toBe(true)
  })

  it('previews a folder upload, then adds it on confirm (honouring the library flag)', async () => {
    const api = installApi()
    await renderModal()

    fireEvent.click(screen.getByRole('tab', { name: 'Upload' }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose a folder…' }))

    // The preview card appears before anything is installed.
    expect(await screen.findByText('Brand')).toBeTruthy()
    expect(screen.getByText(/Includes 2 reference files/i)).toBeTruthy()
    expect(api.customSkills.addFromPath).not.toHaveBeenCalled()

    // Confirm adds it from the previewed source path.
    fireEvent.click(screen.getByRole('button', { name: 'Add skill' }))
    await waitFor(() =>
      expect(api.customSkills.addFromPath).toHaveBeenCalledWith('p1', 'C:/tmp/skill', false)
    )
  })

  it('edits an existing library skill (no library checkbox, loads its SKILL.md)', async () => {
    const api = installApi()
    await renderModal({
      editing: { id: 'brand', title: 'Brand', description: 'Our brand', icon: '🎨' }
    })

    await waitFor(() => expect(api.customSkills.source).toHaveBeenCalledWith('brand'))
    // Editing a library skill doesn't offer the "save to library" choice.
    expect(screen.queryByRole('checkbox', { name: /save to my skill library/i })).toBeNull()
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy()
  })
})
