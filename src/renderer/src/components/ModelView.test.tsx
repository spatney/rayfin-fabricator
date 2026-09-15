import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import ModelView from './ModelView'
import { makeProject } from '../../test/harness'

/**
 * ModelView renders a project's data model as an interactive entity-relationship
 * diagram. These tests mock the `window.api.projects.files.read` bridge with an
 * in-memory schema and exercise the UX behaviours we care about protecting:
 * rendering, richer field/permission detail, search dimming, focus isolation,
 * collapse, and the Copilot hand-off actions.
 */

const SCHEMA = `
import { entity, uuid, text, set, many, authenticated, anonymous } from '@microsoft/rayfin-core'

@entity()
@authenticated('*', { policy: (q) => q.where() })
export class User {
  @uuid() id!: string
  @text({ min: 2, max: 80 }) name!: string
  @many(() => Post) posts!: Post[]
}

@entity()
@anonymous('read')
export class Post {
  @uuid() id!: string
  @text() title!: string
  @set({ enum: ['draft', 'published', 'archived'] }) status!: string
  @text({ optional: true }) body?: string
  user_id!: string
}

@entity()
@authenticated('*', { policy: (q) => q.where() })
export class Tag {
  @uuid() id!: string
  @text() label!: string
}

export const schema = [User, Post, Tag]
`

function installFiles(files: Record<string, string>): ReturnType<typeof vi.fn> {
  const read = vi.fn(async (_id: string, path: string) => {
    if (path in files) return { content: files[path] }
    return { content: undefined }
  })
  ;(window as unknown as { api: unknown }).api = { projects: { files: { read } } }
  return read
}

function cardOf(name: string): HTMLElement {
  const nameEl = [...document.querySelectorAll('.model-card-name')].find((b) =>
    b.textContent?.trim().startsWith(name)
  )
  const card = nameEl?.closest('.model-card')
  if (!card) throw new Error(`No card for ${name}`)
  return card as HTMLElement
}

async function renderLoaded(
  onOpenFile = vi.fn(),
  onSendToChat = vi.fn()
): Promise<{ onOpenFile: typeof onOpenFile; onSendToChat: typeof onSendToChat }> {
  render(
    <ModelView
      project={makeProject('p1')}
      refreshKey={0}
      onOpenFile={onOpenFile}
      onSendToChat={onSendToChat}
    />
  )
  await screen.findByText('Data model')
  return { onOpenFile, onSendToChat }
}

beforeEach(() => {
  installFiles({ 'rayfin/data/schema.ts': SCHEMA })
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  delete (window as unknown as { api?: unknown }).api
})

describe('ModelView', () => {
  it('renders each entity with an accurate entity/relationship count', async () => {
    await renderLoaded()
    expect(cardOf('User')).toBeTruthy()
    expect(cardOf('Post')).toBeTruthy()
    expect(cardOf('Tag')).toBeTruthy()
    const subtitle = document.querySelector('.model-subtitle')?.textContent ?? ''
    expect(subtitle).toContain('3 entities')
    // User.posts + Post.user_id collapse into ONE undirected relationship; Tag is
    // disconnected — so a single edge is drawn.
    expect(subtitle).toContain('1 relationship')
    expect(document.querySelectorAll('.model-edge').length).toBe(1)
  })

  it('fits the initial layout before paint instead of scheduling a second-frame camera jump', async () => {
    const originalRaf = globalThis.requestAnimationFrame
    const raf = vi.fn(() => 1)
    globalThis.requestAnimationFrame = raf as typeof requestAnimationFrame
    try {
      await renderLoaded()

      expect(raf).not.toHaveBeenCalled()
    } finally {
      globalThis.requestAnimationFrame = originalRaf
    }
  })

  it('marks access level via the header dot and only offers Harden on loose access', async () => {
    await renderLoaded()
    const user = cardOf('User')
    const post = cardOf('Post')
    // Access level is conveyed by a labelled tone dot in the header, not a text badge.
    expect(within(user).getByLabelText('Row-scoped policy')).toBeTruthy()
    expect(within(post).getByLabelText('Public')).toBeTruthy()
    // Row-scoped (policy) User: no Harden. Public Post: Harden offered.
    expect(within(user).queryByText('Harden')).toBeNull()
    expect(within(post).getByText('Harden')).toBeTruthy()
    // Per-role permission breakdown is still surfaced on each card.
    expect(within(user).getByText('authenticated')).toBeTruthy()
    expect(within(post).getByText('anonymous')).toBeTruthy()
  })

  it('dims entities that do not match the search query', async () => {
    await renderLoaded()
    fireEvent.change(screen.getByPlaceholderText('Search entities & fields'), {
      target: { value: 'title' }
    })
    // Only Post has a `title` field.
    expect(cardOf('Post').classList.contains('model-card--dim')).toBe(false)
    expect(cardOf('User').classList.contains('model-card--dim')).toBe(true)
    expect(cardOf('Tag').classList.contains('model-card--dim')).toBe(true)
  })

  it('isolates an entity and its neighbours when focused', async () => {
    await renderLoaded()
    fireEvent.click(within(cardOf('User')).getByText('Focus'))
    // User + its neighbour Post remain; the disconnected Tag is hidden.
    expect(cardOf('User')).toBeTruthy()
    expect(cardOf('Post')).toBeTruthy()
    expect(
      [...document.querySelectorAll('.model-card-name')].some((b) =>
        b.textContent?.trim().startsWith('Tag')
      )
    ).toBe(false)
    expect(screen.getByText(/Focusing User/)).toBeTruthy()
  })

  it('collapses fields to a summary via the toolbar toggle', async () => {
    await renderLoaded()
    expect(cardOf('Post').querySelector('.model-fields')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }))
    // Field rows are hidden; a summary line replaces them.
    expect(document.querySelector('.model-fields')).toBeNull()
    expect(screen.getAllByText(/field/).length).toBeGreaterThan(0)
    expect(screen.queryByText('title')).toBeNull()
  })

  it('hands entity-scoped prompts to chat and opens the source file', async () => {
    const { onOpenFile, onSendToChat } = await renderLoaded()
    const user = cardOf('User')
    fireEvent.click(within(cardOf('Post')).getByText('Harden'))
    expect(onSendToChat).toHaveBeenCalledWith(
      'Harden access on Post',
      expect.stringContaining('tighten its access')
    )
    fireEvent.click(within(user).getByText('Open'))
    expect(onOpenFile).toHaveBeenCalledWith('rayfin/data/schema.ts')
  })

  it('shows a no-model empty state that offers to scaffold one', async () => {
    installFiles({})
    const onSendToChat = vi.fn()
    render(
      <ModelView
        project={makeProject('p2')}
        refreshKey={0}
        onOpenFile={vi.fn()}
        onSendToChat={onSendToChat}
      />
    )
    await screen.findByText('No data model yet')
    fireEvent.click(screen.getByText('Add a data model with Copilot'))
    expect(onSendToChat).toHaveBeenCalledWith(
      'Add a data model',
      expect.stringContaining('no data model yet'),
      true
    )
  })
})
