import { useMemo, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

describe('ChatPanel proactive diagnostics', () => {
  it('steers an interrupting outbound prompt into a running turn', async () => {
    const send = vi.fn(() => new Promise(() => {}))
    const steer = vi.fn(() => Promise.resolve({ steered: true }))
    const api = (window as unknown as { api: { chat: Record<string, unknown> } }).api
    api.chat.send = send
    api.chat.steer = steer

    const project = makeProject('p1')
    const { rerender } = render(
      <ChatPanel
        project={project}
        messages={[]}
        onChange={() => {}}
        outbound={{ id: 'initial', display: 'start', prompt: 'start work' }}
      />
    )
    await waitFor(() => expect(send).toHaveBeenCalled())

    rerender(
      <ChatPanel
        project={project}
        messages={[]}
        onChange={() => {}}
        outbound={{
          id: 'diagnostic',
          display: 'Runtime error detected',
          prompt: 'inspect and repair the live error',
          interrupt: true
        }}
      />
    )

    await waitFor(() =>
      expect(steer).toHaveBeenCalledWith('p1', 'inspect and repair the live error', [])
    )
    expect(screen.queryByDisplayValue('inspect and repair the live error')).toBeNull()
  })
})

/**
 * Guards issue #13: on a long prompt the caret drifted from the typed text
 * ("typing occurs below the cursor line") because the transparent textarea and
 * the `.composer-highlight` overlay scrolled independently and were reconciled
 * only by the textarea's `onScroll`. The composer now shares a single scrollport
 * (`.composer-input-sizer`) so the two layers can never desync; because the
 * textarea can no longer scroll internally, ChatPanel scrolls that shared
 * scrollport itself to keep the caret visible.
 *
 * jsdom performs no layout, so real scroll geometry is faked: the scrollport is
 * made to overflow and the caret's measured rect is stubbed below the viewport.
 */
describe('ChatPanel composer scrollport (issue #13)', () => {
  const rect = (top: number, bottom: number): DOMRect =>
    ({
      top,
      bottom,
      left: 0,
      right: 0,
      width: 1,
      height: bottom - top,
      x: 0,
      y: top,
      toJSON: () => ({})
    }) as DOMRect

  it('renders the textarea and highlight overlay inside one shared scrollport', async () => {
    await act(async () => {
      render(
        <ChatPanel project={makeProject('p1')} messages={[]} onChange={() => {}} draft="" />
      )
    })
    const sizer = document.querySelector('.composer-input-sizer')
    const textarea = document.querySelector('.composer-input')
    const highlight = document.querySelector('.composer-highlight')
    expect(sizer).not.toBeNull()
    expect(textarea).not.toBeNull()
    expect(highlight).not.toBeNull()
    // Both visible layers live in the same scroll container — the invariant that
    // makes caret/text drift structurally impossible.
    expect(sizer?.contains(textarea)).toBe(true)
    expect(sizer?.contains(highlight)).toBe(true)
  })

  it('scrolls the shared scrollport to reveal the caret when a long prompt overflows', async () => {
    const longPrompt = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n')
    await act(async () => {
      render(
        <ChatPanel
          project={makeProject('p1')}
          messages={[]}
          onChange={() => {}}
          draft={longPrompt}
        />
      )
    })
    const ta = screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement
    const sizer = document.querySelector('.composer-input-sizer') as HTMLElement

    // Drain the reveal frame queued on mount (it early-returns with no layout),
    // so the only trigger left is re-entering the field below.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })

    // Fake an overflowing scrollport whose visible band is 100px tall.
    Object.defineProperty(sizer, 'clientHeight', { value: 100, configurable: true })
    Object.defineProperty(sizer, 'scrollHeight', { value: 400, configurable: true })
    sizer.getBoundingClientRect = () => rect(0, 100)
    // jsdom's Range has no getBoundingClientRect; report the caret ~380px down in
    // content space (below the visible band) so the reveal has to scroll.
    const proto = Range.prototype as unknown as { getBoundingClientRect?: () => DOMRect }
    const origRangeRect = proto.getBoundingClientRect
    proto.getBoundingClientRect = () => rect(380 - sizer.scrollTop, 396 - sizer.scrollTop)

    sizer.scrollTop = 0
    ta.setSelectionRange(longPrompt.length, longPrompt.length)
    // Re-enter the field (the issue's repro) and let the queued frame run.
    await act(async () => {
      fireEvent.focus(ta)
      await new Promise((r) => setTimeout(r, 50))
    })

    // Scrolled so the caret's bottom (396) sits at the viewport bottom: 396 - 100.
    expect(sizer.scrollTop).toBe(296)
    proto.getBoundingClientRect = origRangeRect
  })
})
