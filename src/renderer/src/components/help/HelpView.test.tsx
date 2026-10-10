import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { HelpAnswer, HelpEventEnvelope, HelpGrounding } from '@shared/ipc'
import { HelpView } from './HelpView'
import { ToastProvider } from '../../toast'
import { MascotContext } from '../mascot/context'

/** Push a streamed event to the subscriber the view registered. */
let emit: (envelope: HelpEventEnvelope) => void = () => {}

const ready: HelpGrounding = {
  sourceReady: true,
  docsReady: true,
  pinned: true,
  reference: 'v1.10.0'
}

const ask = vi.fn<(input: { askId: string }) => Promise<HelpAnswer>>()
const cancel = vi.fn(() => Promise.resolve(true))
const prepare = vi.fn<(force?: boolean) => Promise<HelpGrounding>>(() => Promise.resolve(ready))
const grounding = vi.fn<() => Promise<HelpGrounding>>(() => Promise.resolve(ready))
const loadHistory = vi.fn<() => Promise<{ savedAt: string; data: unknown } | null>>(() =>
  Promise.resolve(null)
)
const saveHistory = vi.fn<(data: unknown) => Promise<void>>(() => Promise.resolve())
const clearHistory = vi.fn(() => Promise.resolve())

function setup(overrides: Partial<Parameters<typeof HelpView>[0]> = {}): void {
  render(
    <ToastProvider>
      <HelpView
        onClose={vi.fn()}
        onAction={vi.fn()}
        onReportIssue={vi.fn()}
        appVersion="1.10.0"
        {...overrides}
      />
    </ToastProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  ask.mockImplementation(() => new Promise(() => {}))
  loadHistory.mockImplementation(() => Promise.resolve(null))
  saveHistory.mockImplementation(() => Promise.resolve())
  clearHistory.mockImplementation(() => Promise.resolve())
  ;(window as unknown as { api: unknown }).api = {
    help: {
      grounding,
      prepare,
      ask,
      cancel,
      pickPaths: vi.fn(() => Promise.resolve([])),
      loadHistory,
      saveHistory,
      clearHistory,
      onEvent: (cb: (envelope: HelpEventEnvelope) => void) => {
        emit = cb
        return () => {}
      }
    },
    openExternal: vi.fn(),
    diagnostics: { record: vi.fn(() => Promise.resolve()) }
  }
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('opening Help', () => {
  it('offers starter questions before anything is asked', async () => {
    setup()
    expect(await screen.findByText('Why did my last deploy fail?')).toBeTruthy()
  })

  it('shows the pinned source reference so the user knows it matches their build', async () => {
    setup()
    expect(await screen.findByText('v1.10.0')).toBeTruthy()
  })

  it('downloads the grounding when it is missing', async () => {
    grounding.mockResolvedValueOnce({ sourceReady: false, docsReady: false, pinned: false })
    setup()
    await waitFor(() => expect(prepare).toHaveBeenCalledWith(false))
  })

  it('does not re-download grounding that is already cached', async () => {
    setup()
    await screen.findByText('v1.10.0')
    expect(prepare).not.toHaveBeenCalled()
  })

  it('names the project it will answer about', async () => {
    setup({ projectName: 'Contoso Expenses' })
    expect(await screen.findByText('Contoso Expenses')).toBeTruthy()
  })

  it('is hosted by Ray, who greets the user', async () => {
    setup()
    expect(await screen.findByRole('button', { name: /Ray, the Fabricator stingray/ })).toBeTruthy()
    expect(screen.getByRole('heading', { name: /I’m Ray\.$/ })).toBeTruthy()
  })

  it('keeps the same page, hosted by the mark, when Ray is turned off', async () => {
    render(
      <ToastProvider>
        <MascotContext.Provider value={false}>
          <HelpView onClose={vi.fn()} onAction={vi.fn()} onReportIssue={vi.fn()} />
        </MascotContext.Provider>
      </ToastProvider>
    )
    expect(await screen.findByRole('heading', { name: 'fabricator help' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Ray/ })).toBeNull()
    expect(screen.getByText('Why did my last deploy fail?')).toBeTruthy()
  })
})

describe('asking a question', () => {
  it('sends the question and echoes it in the transcript', async () => {
    setup({ projectId: 'proj-1' })
    const input = await screen.findByLabelText('Ask Help')
    fireEvent.change(input, { target: { value: 'why did my deploy fail?' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(await screen.findByText('why did my deploy fail?')).toBeTruthy()
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ question: 'why did my deploy fail?', projectId: 'proj-1' })
    )
  })

  it('keeps a Shift+Enter line break instead of sending', async () => {
    setup()
    const input = await screen.findByLabelText('Ask Help')
    fireEvent.change(input, { target: { value: 'line one' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(ask).not.toHaveBeenCalled()
  })

  it('streams the answer as deltas arrive', async () => {
    setup()
    const input = await screen.findByLabelText('Ask Help')
    fireEvent.change(input, { target: { value: 'what broke?' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await screen.findByText('what broke?')

    const askId = ask.mock.calls[0][0].askId
    emit({ askId, event: { type: 'delta', text: 'Your workspace ' } })
    emit({ askId, event: { type: 'delta', text: 'is not selected.' } })

    expect(await screen.findByText(/Your workspace is not selected\./)).toBeTruthy()
  })

  it('ignores events from a question that is no longer live', async () => {
    setup()
    const input = await screen.findByLabelText('Ask Help')
    fireEvent.change(input, { target: { value: 'what broke?' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await screen.findByText('what broke?')

    emit({ askId: 'some-other-ask', event: { type: 'delta', text: 'leaked text' } })
    expect(screen.queryByText(/leaked text/)).toBeNull()
  })

  it('offers the actions the assistant reported', async () => {
    const onAction = vi.fn()
    setup({ onAction })
    const input = await screen.findByLabelText('Ask Help')
    fireEvent.change(input, { target: { value: 'fix my sign-in' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await screen.findByText('fix my sign-in')

    const askId = ask.mock.calls[0][0].askId
    emit({ askId, event: { type: 'delta', text: 'Refresh your sign-in.' } })
    emit({
      askId,
      event: {
        type: 'action',
        action: { id: 'refresh-fabric-auth', label: 'Refresh Fabric sign-in' }
      }
    })

    fireEvent.click(await screen.findByText('Refresh Fabric sign-in'))
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'refresh-fabric-auth' })
    )
  })

  it('offers a button to open a project by name', async () => {
    const onAction = vi.fn()
    setup({ onAction })
    const input = await screen.findByLabelText('Ask Help')
    fireEvent.change(input, { target: { value: 'open my expenses app' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await screen.findByText('open my expenses app')

    const askId = ask.mock.calls[0][0].askId
    emit({ askId, event: { type: 'delta', text: 'That one is called Contoso Expenses.' } })
    emit({
      askId,
      event: {
        type: 'action',
        action: { id: 'open-project', label: 'Open Contoso Expenses', target: 'p-42' }
      }
    })

    fireEvent.click(await screen.findByText('Open Contoso Expenses'))
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'open-project', target: 'p-42' })
    )
  })

  it('shows a drafted bug report and reports it on request', async () => {
    const onReportIssue = vi.fn()
    setup({ onReportIssue })
    const input = await screen.findByLabelText('Ask Help')
    fireEvent.change(input, { target: { value: 'report this for me' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await screen.findByText('report this for me')

    const askId = ask.mock.calls[0][0].askId
    const issue = {
      kind: 'bug' as const,
      title: "Deploy fails with 'Tenant not authorized for cluster'",
      body: '### What happened\n\nEvery deploy fails.'
    }
    emit({ askId, event: { type: 'delta', text: 'This looks like a bug in Fabricator.' } })
    emit({ askId, event: { type: 'issue', issue } })

    expect(await screen.findByText(issue.title)).toBeTruthy()
    // The body stays hidden until the user asks to review it.
    expect(screen.queryByText(/Every deploy fails/)).toBeNull()
    fireEvent.click(screen.getByText('Review it first'))
    expect(await screen.findByText(/Every deploy fails/)).toBeTruthy()

    fireEvent.click(screen.getByText('Report this on GitHub'))
    expect(onReportIssue).toHaveBeenCalledWith(expect.objectContaining({ title: issue.title }))
  })

  it('opens a citation in the browser', async () => {
    setup()
    const input = await screen.findByLabelText('Ask Help')
    fireEvent.change(input, { target: { value: 'how do I deploy?' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await screen.findByText('how do I deploy?')

    const askId = ask.mock.calls[0][0].askId
    emit({
      askId,
      event: {
        type: 'citation',
        citation: {
          title: 'Deploy to Microsoft Fabric',
          url: 'https://spatney.github.io/rayfin-fabricator/docs/ship/deploy'
        }
      }
    })

    fireEvent.click(await screen.findByText('Deploy to Microsoft Fabric'))
    expect(window.api.openExternal).toHaveBeenCalledWith(
      'https://spatney.github.io/rayfin-fabricator/docs/ship/deploy'
    )
  })

  it('shows a failure instead of leaving the question hanging', async () => {
    ask.mockRejectedValueOnce(new Error('Help could not reach Copilot.'))
    setup()
    const input = await screen.findByLabelText('Ask Help')
    fireEvent.change(input, { target: { value: 'anything' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(await screen.findByText('Help could not reach Copilot.')).toBeTruthy()
  })

  it('treats a user stop as stopped, not as an error', async () => {
    ask.mockRejectedValueOnce(new Error('Stopped.'))
    setup()
    const input = await screen.findByLabelText('Ask Help')
    fireEvent.change(input, { target: { value: 'anything' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(await screen.findByText('Stopped.')).toBeTruthy()
  })
})

describe('keeping the conversation', () => {
  const earlier = [
    {
      id: 'ask-old',
      question: 'why did my deploy fail?',
      answer: 'No workspace was selected.',
      attachments: [],
      tools: [],
      actions: [],
      citations: [],
      status: 'done'
    }
  ]

  it('picks the thread up where it was left', async () => {
    loadHistory.mockResolvedValueOnce({ savedAt: new Date().toISOString(), data: earlier })
    setup()
    expect(await screen.findByText('why did my deploy fail?')).toBeTruthy()
    expect(await screen.findByText('No workspace was selected.')).toBeTruthy()
    expect(screen.getByText(/Picking up where you left off/)).toBeTruthy()
  })

  it('shows the welcome screen when there is nothing to resume', async () => {
    setup()
    expect(await screen.findByText('Why did my last deploy fail?')).toBeTruthy()
    expect(screen.queryByText(/Picking up where you left off/)).toBeNull()
  })

  it('starts fresh when the user asks for a new conversation', async () => {
    loadHistory.mockResolvedValueOnce({ savedAt: new Date().toISOString(), data: earlier })
    setup()
    await screen.findByText('why did my deploy fail?')

    fireEvent.click(screen.getByText('New'))

    expect(clearHistory).toHaveBeenCalled()
    expect(screen.queryByText('why did my deploy fail?')).toBeNull()
    // Back to the starter questions.
    expect(await screen.findByText('Why did my last deploy fail?')).toBeTruthy()
  })

  it('offers no New button on an empty conversation', async () => {
    setup()
    await screen.findByText('Why did my last deploy fail?')
    expect(screen.queryByText('New')).toBeNull()
  })

  it('saves the thread once a turn settles', async () => {
    ask.mockResolvedValueOnce({ text: 'Because no workspace is selected.', actions: [], citations: [], elapsedMs: 10 })
    setup()
    const input = await screen.findByLabelText('Ask Help')
    fireEvent.change(input, { target: { value: 'what broke?' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await screen.findByText(/Because no workspace is selected/)
    await waitFor(() => expect(saveHistory).toHaveBeenCalled())
    const saved = saveHistory.mock.calls.at(-1)?.[0] as Array<{ question: string }> | undefined
    expect(saved?.[0].question).toBe('what broke?')
  })

  it('survives a conversation it cannot read', async () => {
    loadHistory.mockRejectedValueOnce(new Error('disk gone'))
    setup()
    expect(await screen.findByText('Why did my last deploy fail?')).toBeTruthy()
  })
})

describe('closing', () => {
  it('closes on Escape when idle', async () => {
    const onClose = vi.fn()
    setup({ onClose })
    await screen.findByText('Why did my last deploy fail?')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('stops the answer on Escape instead of closing while it is working', async () => {
    const onClose = vi.fn()
    setup({ onClose })
    const input = await screen.findByLabelText('Ask Help')
    fireEvent.change(input, { target: { value: 'working on it' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await screen.findByText('working on it')

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(cancel).toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})
