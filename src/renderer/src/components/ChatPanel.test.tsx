import { useMemo, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeProject } from '../../test/harness'
import ChatPanel from './ChatPanel'

/**
 * Guards issue #9: a typed-but-unsent prompt must survive ChatPanel unmounting.
 * The Build view renders ChatPanel only while `viewMode === 'build'`, so switching
 * to the Code tab tears the panel down; the composer draft is therefore lifted to
 * the parent (keyed by project) and re-seeded on remount. These tests exercise that
 * contract through a small parent harness that mirrors Workbench's draft plumbing.
 */

const PLACEHOLDER = /Message Fabricator about/i

/** Minimal `window.api` surface ChatPanel touches on mount / while typing. */
function installApi(): void {
  ;(window as unknown as { api: unknown }).api = {
    onChatEvent: vi.fn(() => () => {}),
    chat: {
      suggest: vi.fn(() => Promise.resolve({ ok: false, suggestions: [] })),
      cancelSuggest: vi.fn(() => Promise.resolve(true)),
      setOptions: vi.fn(() => Promise.resolve(undefined)),
      listModels: vi.fn(() => Promise.resolve([]))
    },
    projects: { files: { tree: vi.fn(() => Promise.resolve({ path: '', name: '', children: [] })) } },
    screenshot: { save: vi.fn(() => Promise.resolve('C:/tmp/shot.png')) }
  }
}

/**
 * Mirrors how Workbench keeps a per-project composer draft and conditionally
 * mounts ChatPanel. `onCode` flips the panel off (Code tab) and back (Build tab).
 */
function Harness({ initialDraft = '' }: { initialDraft?: string }): JSX.Element {
  const [drafts, setDrafts] = useState<Record<string, string>>(
    initialDraft ? { p1: initialDraft } : {}
  )
  const [onCode, setOnCode] = useState(false)
  const project = useMemo(() => makeProject('p1'), [])
  return (
    <div>
      <button type="button" onClick={() => setOnCode((v) => !v)}>
        toggle-tab
      </button>
      {!onCode && (
        <ChatPanel
          project={project}
          messages={[]}
          onChange={() => {}}
          draft={drafts.p1 ?? ''}
          onDraftChange={(value) => setDrafts((all) => ({ ...all, p1: value }))}
        />
      )}
    </div>
  )
}

async function toggleTab(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByText('toggle-tab'))
  })
}

let raf: typeof globalThis.requestAnimationFrame | undefined
let cancelRaf: typeof globalThis.cancelAnimationFrame | undefined

beforeEach(() => {
  installApi()
  // jsdom may not expose rAF; ChatPanel's scroll/flush effects rely on it.
  if (!globalThis.requestAnimationFrame) {
    raf = globalThis.requestAnimationFrame
    cancelRaf = globalThis.cancelAnimationFrame
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
      setTimeout(() => cb(Date.now()), 0) as unknown as number) as typeof requestAnimationFrame
    globalThis.cancelAnimationFrame = ((id: number) =>
      clearTimeout(id)) as typeof cancelAnimationFrame
  }
})

afterEach(() => {
  cleanup()
  if (raf) {
    globalThis.requestAnimationFrame = raf
    globalThis.cancelAnimationFrame = cancelRaf as typeof cancelAnimationFrame
    raf = undefined
    cancelRaf = undefined
  }
  delete (window as unknown as { api?: unknown }).api
})

describe('ChatPanel composer draft', () => {
  it('preserves a typed-but-unsent prompt when navigating to Code and back (issue #9)', async () => {
    render(<Harness />)

    const ta = screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement
    await act(async () => {
      fireEvent.change(ta, { target: { value: 'build me a sales dashboard' } })
    })
    expect(ta.value).toBe('build me a sales dashboard')

    // Switch to the Code tab — ChatPanel unmounts.
    await toggleTab()
    expect(screen.queryByPlaceholderText(PLACEHOLDER)).toBeNull()

    // Return to Build — ChatPanel remounts and must restore the draft.
    await toggleTab()
    const restored = screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement
    expect(restored.value).toBe('build me a sales dashboard')
  })

  it('seeds the composer from the persisted draft on first mount', async () => {
    await act(async () => {
      render(<Harness initialDraft="a prompt I left earlier" />)
    })
    const ta = screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement
    expect(ta.value).toBe('a prompt I left earlier')
  })

  it('starts empty when there is no persisted draft', async () => {
    await act(async () => {
      render(<Harness />)
    })
    const ta = screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement
    expect(ta.value).toBe('')
  })
})
