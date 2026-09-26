import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ChatToolCall } from '@shared/ipc'
import { makeProject } from '../../../test/harness'
import ChatPanel, { type UIChatMessage } from '../ChatPanel'

vi.mock('../../monaco', () => ({}))
vi.mock('@monaco-editor/react', () => ({ default: () => <textarea data-testid="plan-editor" /> }))

const ROOT = 'C:/projects/p1'

function installApi(): { send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(() => Promise.resolve({ ok: true, filesModified: [], ranDeploy: false }))
  ;(window as unknown as { api: unknown }).api = {
    onChatEvent: vi.fn(() => () => {}),
    onProcLog: vi.fn(() => () => {}),
    openExternal: vi.fn(),
    chat: {
      suggest: vi.fn(() => Promise.resolve({ ok: false, suggestions: [] })),
      cancelSuggest: vi.fn(() => Promise.resolve(true)),
      setOptions: vi.fn(() => Promise.resolve(undefined)),
      listModels: vi.fn(() => Promise.resolve([])),
      send,
      steer: vi.fn(() => Promise.resolve({ steered: true })),
      reset: vi.fn(() => Promise.resolve(undefined))
    },
    projects: {
      files: {
        tree: vi.fn(() =>
          Promise.resolve([
            {
              name: 'src',
              path: 'src',
              type: 'dir',
              children: [{ name: 'App.tsx', path: 'src/App.tsx', type: 'file' }]
            }
          ])
        )
      }
    },
    screenshot: { save: vi.fn(() => Promise.resolve('C:/tmp/shot.png')) }
  }
  return { send }
}

const tool = (id: string, name: string, extra: Partial<ChatToolCall> = {}): ChatToolCall => ({
  id,
  name,
  title: `${ROOT}/src/${id}.ts`,
  state: 'success',
  ...extra
})

const DIFF = [
  'diff --git a/C:/projects/p1/src/App.tsx b/C:/projects/p1/src/App.tsx',
  '--- a/C:/projects/p1/src/App.tsx',
  '+++ b/C:/projects/p1/src/App.tsx',
  '@@ -1,2 +1,3 @@',
  '-const title = "Hi"',
  '+const title = "Hello"',
  '+const theme = "dark"',
  ' export default title'
].join('\n')

function finishedTurn(extra: Partial<UIChatMessage> = {}): UIChatMessage[] {
  return [
    {
      id: 'u1',
      role: 'user',
      text: 'Make the title friendlier',
      tools: [],
      pending: false,
      createdAt: Date.UTC(2026, 0, 2, 15, 4)
    },
    {
      id: 'a1',
      role: 'assistant',
      text: 'I’ll check the page first.Done — the title now says Hello.',
      pending: false,
      elapsedMs: 83_000,
      createdAt: Date.UTC(2026, 0, 2, 15, 4),
      tools: [
        tool('view1', 'view', {
          title: `${ROOT}/src/App.tsx`,
          output: '1. const title = "Hi"\n2. export default title\n3. '
        }),
        tool('edit1', 'edit', {
          title: `${ROOT}/src/App.tsx`,
          paths: [`${ROOT}/src/App.tsx`],
          diff: DIFF,
          added: 2,
          removed: 1
        })
      ],
      segments: [
        { kind: 'text', text: 'I’ll check the page first.' },
        { kind: 'tool', id: 'view1' },
        { kind: 'tool', id: 'edit1' },
        { kind: 'text', text: 'Done — the title now says Hello.' }
      ],
      ...extra
    }
  ]
}

function Harness({
  initial,
  onOpen
}: {
  initial: UIChatMessage[]
  onOpen?: (ref: string) => void
}): JSX.Element {
  const [messages, setMessages] = useState(initial)
  return (
    <ChatPanel
      project={makeProject('p1')}
      messages={messages}
      onChange={(update) => setMessages(update)}
      onOpenMention={onOpen}
      draft=""
    />
  )
}

let raf: typeof globalThis.requestAnimationFrame | undefined
beforeEach(() => {
  localStorage.clear()
  if (!globalThis.requestAnimationFrame) {
    raf = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
      setTimeout(() => cb(Date.now()), 0) as unknown as number) as typeof requestAnimationFrame
    globalThis.cancelAnimationFrame = ((id: number) =>
      clearTimeout(id)) as typeof cancelAnimationFrame
  }
})
afterEach(() => {
  cleanup()
  if (raf) globalThis.requestAnimationFrame = raf
  delete (window as unknown as { api?: unknown }).api
})

describe('chat transcript', () => {
  it('folds a finished turn’s steps into one collapsed log above the answer', async () => {
    installApi()
    render(<Harness initial={finishedTurn()} />)
    const head = screen.getByRole('button', {
      name: /^Worked for 1m 23s, 2 steps, Read 1 file, Made 1 edit$/
    })
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('.step')).toBeNull()
    expect(screen.getByText('Done — the title now says Hello.')).toBeTruthy()
    // Narration is folded away with the steps, not shown as the answer.
    expect(screen.queryByText('I’ll check the page first.')).toBeNull()

    await act(async () => fireEvent.click(head))
    expect(head.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('I’ll check the page first.')).toBeTruthy()
    expect(document.querySelectorAll('.step')).toHaveLength(2)
    expect(document.querySelector('.step-line[title="Edited src/App.tsx"]')).toBeTruthy()
  })

  it('opens a step to show its diff, with line numbers and +/− counts', async () => {
    installApi()
    render(<Harness initial={finishedTurn()} />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /^Worked for/ })))
    await act(async () =>
      fireEvent.click(document.querySelector('.step-line[title="Edited src/App.tsx"]')!)
    )
    const diff = document.querySelector('.diff')
    expect(diff).toBeTruthy()
    expect(diff?.querySelectorAll('.diff-row--add')).toHaveLength(2)
    expect(diff?.querySelectorAll('.diff-row--del')).toHaveLength(1)
    expect(diff?.querySelector('.diff-file-head')?.textContent).toContain('+2')
  })

  it('keeps a live log open with the running step’s latest output', () => {
    installApi()
    const live: UIChatMessage = {
      id: 'a1',
      turnId: 't1',
      role: 'assistant',
      text: '',
      pending: true,
      startedAt: Date.now(),
      tools: [
        tool('run1', 'powershell', {
          title: 'Build the app',
          state: 'running',
          command: 'npm run build',
          output: 'vite building…\n✓ 42 modules'
        })
      ],
      segments: [{ kind: 'tool', id: 'run1' }]
    }
    render(
      <Harness
        initial={[{ id: 'u1', role: 'user', text: 'Build it', tools: [], pending: false }, live]}
      />
    )
    expect(document.querySelector('.worklog--live')).toBeTruthy()
    expect(
      screen.getByRole('button', { name: /^Working, 1 step/ }).getAttribute('aria-expanded')
    ).toBe('true')
    expect(document.querySelector('.step-tail')?.textContent).toContain('✓ 42 modules')
    expect(screen.getByText('Running a command…')).toBeTruthy()
  })

  it('shows files the turn changed as chips that open the Code tab', async () => {
    installApi()
    const onOpen = vi.fn()
    render(<Harness initial={finishedTurn()} onOpen={onOpen} />)
    const chip = screen.getByTitle('Edited src/App.tsx — open in the Code tab')
    expect(chip.textContent).toContain('+2')
    await act(async () => fireEvent.click(chip))
    expect(onOpen).toHaveBeenCalledWith('src/App.tsx')
  })

  it('never shows ask_user as a step, and shows an answered question as a compact exchange', async () => {
    installApi()
    const messages = finishedTurn({
      tools: [tool('ask', 'ask_user', { title: 'Which theme?' }), tool('view1', 'view')],
      segments: [
        { kind: 'tool', id: 'ask' },
        { kind: 'question', id: 'ask' },
        { kind: 'tool', id: 'view1' },
        { kind: 'text', text: 'Using dark.' }
      ],
      questions: [
        {
          id: 'ask',
          question: 'Which theme?',
          choices: ['Dark (Recommended)', 'Light'],
          allowFreeform: false,
          state: 'answered',
          answer: 'Dark (Recommended)'
        }
      ]
    })
    render(<Harness initial={messages} />)
    expect(screen.queryByText('Fabricator needs your input')).toBeNull()
    expect(document.querySelector('.chat-plan-question-reply')?.textContent).toBe('Dark')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /^Worked/ })))
    expect(document.querySelectorAll('.step')).toHaveLength(1)
  })

  it('offers Try again on the latest answer and re-sends the prompt as a fresh attempt', async () => {
    const { send } = installApi()
    render(<Harness initial={finishedTurn()} />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Try again' })))
    expect(send).toHaveBeenCalledTimes(1)
    const call = send.mock.calls[0] as unknown[]
    const prompt = String(call[2])
    expect(prompt).toContain('try that again')
    expect(prompt).toContain('Make the title friendlier')
    // The new user bubble shows the original words, not the preface.
    expect(screen.getAllByText('Make the title friendlier')).toHaveLength(2)
  })

  it('stamps messages with their time', () => {
    installApi()
    render(<Harness initial={finishedTurn()} />)
    const times = document.querySelectorAll('time')
    expect(times.length).toBeGreaterThanOrEqual(2)
    expect(times[0].getAttribute('dateTime')).toBe(
      new Date(Date.UTC(2026, 0, 2, 15, 4)).toISOString()
    )
  })

  it('turns file paths in an answer into links to the Code tab', async () => {
    installApi()
    const onOpen = vi.fn()
    const messages = finishedTurn({
      tools: [],
      segments: [{ kind: 'text', text: 'The title lives in `src/App.tsx`; run `npm run build`.' }]
    })
    render(<Harness initial={messages} onOpen={onOpen} />)
    const link = await screen.findByRole('button', { name: 'src/App.tsx' })
    await act(async () => fireEvent.click(link))
    expect(onOpen).toHaveBeenCalledWith('src/App.tsx')
    expect(screen.queryByRole('button', { name: 'npm run build' })).toBeNull()
  })

  it('asks before starting a new chat', async () => {
    installApi()
    render(<Harness initial={finishedTurn()} />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /New chat/ })))
    expect(screen.getByRole('dialog').textContent).toContain('Start a new chat?')
    const api = (window as unknown as { api: { chat: { reset: ReturnType<typeof vi.fn> } } }).api
    expect(api.chat.reset).not.toHaveBeenCalled()
    await act(async () =>
      fireEvent.click(screen.getAllByRole('button', { name: 'New chat' }).pop()!)
    )
    expect(api.chat.reset).toHaveBeenCalledWith('p1')
  })
})
