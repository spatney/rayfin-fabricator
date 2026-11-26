import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type {
  McpCheckResult,
  McpServer,
  McpServerInput,
  ToolMadeResult,
  ToolMakerEvent
} from '@shared/ipc'
import { invalidateCopilotModels } from '../../copilotModels'
import { invalidateMcpServers } from '../../mcpServers'
import McpServersModal from './McpServersModal'

const LEARN: McpServer = {
  id: 'microsoft-learn',
  name: 'Microsoft Learn',
  transport: 'http',
  url: 'https://learn.microsoft.com/api/mcp',
  headers: ['Authorization'],
  readOnly: false,
  addedAt: '2026-10-31T00:00:00Z'
}

let saved: McpServer[]
let api: {
  list: ReturnType<typeof vi.fn>
  save: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  check: ReturnType<typeof vi.fn>
}

function install(servers: McpServer[]): void {
  saved = servers
  api = {
    list: vi.fn(async () => saved),
    save: vi.fn(async (input: McpServerInput) => {
      const id = input.id ?? input.name.toLowerCase().replace(/\s+/g, '-')
      const server: McpServer = {
        id,
        name: input.name,
        transport: input.transport,
        command: input.command,
        args: input.args,
        url: input.url,
        env: input.env?.map((v) => v.name),
        headers: input.headers?.map((v) => v.name),
        readOnly: Boolean(input.readOnly),
        addedAt: 'now'
      }
      saved = [...saved.filter((s) => s.id !== id), server]
      return saved
    }),
    remove: vi.fn(async (id: string) => {
      saved = saved.filter((s) => s.id !== id)
      return saved
    }),
    check: vi.fn(async (): Promise<McpCheckResult> => ({
      status: 'connected',
      tools: [
        { name: 'microsoft_docs_search', description: 'Search Microsoft docs' },
        { name: 'microsoft_docs_fetch' }
      ]
    }))
  }
  ;(window as unknown as { api: unknown }).api = { mcp: api, openExternal: vi.fn() }
}

beforeEach(() => invalidateMcpServers())

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

const dialog = () => screen.getByRole('dialog')

describe('McpServersModal', () => {
  it('offers Microsoft Learn to try, saves it, and checks it straight away', async () => {
    install([])
    const onChanged = vi.fn()
    render(<McpServersModal onClose={() => {}} onChanged={onChanged} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add Microsoft Learn' }))
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Microsoft Learn')
    expect((screen.getByLabelText('URL') as HTMLInputElement).value).toBe(
      'https://learn.microsoft.com/api/mcp'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.check).toHaveBeenCalledWith('microsoft-learn'))
    expect(api.save).toHaveBeenCalledWith({
      id: undefined,
      name: 'Microsoft Learn',
      transport: 'http',
      url: 'https://learn.microsoft.com/api/mcp',
      headers: [],
      readOnly: false
    })
    expect(onChanged).toHaveBeenCalled()
    const card = await screen.findByRole('region', { name: 'Microsoft Learn' })
    expect(await within(card).findByText('It connected, and offers 2 tools:')).toBeTruthy()
    expect(within(card).getByText('microsoft_docs_search').getAttribute('title')).toBe(
      'Search Microsoft docs'
    )
    expect(within(card).getByRole('img', { name: 'Connected' })).toBeTruthy()
  })

  it('fills in a pasted configuration, and asks for the keys it left as placeholders', async () => {
    install([])
    render(<McpServersModal adding onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Paste a configuration…' }))
    fireEvent.change(screen.getByLabelText('Configuration'), {
      target: {
        value: `{ "mcpServers": {
          "mcp-server-chart": { "command": "npx", "args": ["-y", "@antv/mcp-server-chart"], "env": { "API_KEY": "<YOUR_KEY>" } },
          "learn": { "url": "https://learn.microsoft.com/api/mcp" }
        } }`
      }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Fill in' }))
    expect(screen.getByText('It has 2 servers. Choose the one to add:')).toBeTruthy()
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Chart')
    expect((screen.getByLabelText('Command') as HTMLInputElement).value).toBe(
      'npx -y @antv/mcp-server-chart'
    )
    const key = screen.getByLabelText('Value of API_KEY') as HTMLInputElement
    expect(key.type).toBe('password')
    expect(key.value).toBe('')

    api.save.mockRejectedValueOnce('Enter a value for API_KEY.')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Enter a value for API_KEY.'
    )
    fireEvent.change(key, { target: { value: 'k3y' } })
    fireEvent.click(screen.getByLabelText(/Only tools that read/))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(api.save).toHaveBeenLastCalledWith({
        id: undefined,
        name: 'Chart',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@antv/mcp-server-chart'],
        env: [{ name: 'API_KEY', value: 'k3y' }],
        readOnly: true
      })
    )
    expect(await screen.findByRole('region', { name: 'Chart' })).toBeTruthy()
  })

  it('keeps a saved value unless it’s changed, and never shows it', async () => {
    install([LEARN])
    render(<McpServersModal onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Microsoft Learn' }))
    const form = screen.getByRole('form', { name: 'Edit Microsoft Learn' })
    expect(within(form).getByText('Authorization')).toBeTruthy()
    expect(within(form).getByText('Saved')).toBeTruthy()
    expect(within(form).queryByLabelText('Value of Authorization')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(api.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: 'microsoft-learn', headers: [{ name: 'Authorization' }] })
      )
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Edit Microsoft Learn' }))
    fireEvent.click(screen.getByRole('button', { name: 'Change the value of Authorization' }))
    fireEvent.change(screen.getByLabelText('Value of Authorization'), {
      target: { value: 'Bearer new' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(api.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ headers: [{ name: 'Authorization', value: 'Bearer new' }] })
      )
    )
  })

  it('says why a server didn’t connect, and removes one only after asking', async () => {
    install([LEARN])
    api.check.mockResolvedValueOnce({
      status: 'failed',
      error: 'It couldn’t connect (401 Unauthorized).'
    })
    const onChanged = vi.fn()
    render(<McpServersModal onClose={() => {}} onChanged={onChanged} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Check Microsoft Learn' }))
    const card = screen.getByRole('region', { name: 'Microsoft Learn' })
    expect(await within(card).findByText('Didn’t connect')).toBeTruthy()
    expect(within(card).getByRole('alert').textContent).toBe(
      'It couldn’t connect (401 Unauthorized).'
    )

    fireEvent.click(within(card).getByRole('button', { name: 'Remove Microsoft Learn' }))
    expect(api.remove).not.toHaveBeenCalled()
    expect(
      within(card).getByText('Remove Microsoft Learn? Chats that have it on stop using it.')
    ).toBeTruthy()
    fireEvent.click(within(card).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('microsoft-learn'))
    expect(await screen.findByRole('button', { name: 'Add Microsoft Learn' })).toBeTruthy()
    expect(onChanged).toHaveBeenCalled()
  })

  it('leaves the form with Escape before it closes', async () => {
    install([LEARN])
    const onClose = vi.fn()
    render(<McpServersModal onClose={onClose} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Microsoft Learn' }))
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(within(dialog()).queryByRole('form')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(onClose).toHaveBeenCalledOnce()
  })
})

describe('McpServersModal making tools, opened from chat', () => {
  it('opens on the tool maker only while its experiment is on', async () => {
    installTools([])
    const { unmount } = render(<McpServersModal making makeTools onClose={() => {}} />)
    expect(screen.getByRole('form', { name: 'Make a tool with Copilot' })).toBeTruthy()
    unmount()
    render(<McpServersModal making onClose={() => {}} />)
    expect(screen.queryByRole('form', { name: 'Make a tool with Copilot' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'MCP servers' })).toBeTruthy()
  })
})

const IMAGES: McpServer = {
  id: 'image-maker',
  name: 'Image maker',
  transport: 'stdio',
  env: ['OPENAI_API_KEY'],
  providerKeys: { OPENAI_API_KEY: 'openai' },
  readOnly: false,
  addedAt: '2026-11-25T00:00:00Z',
  made: {
    summary: 'Makes images with OpenAI’s gpt-image-1',
    requests: ['Make images with gpt-image-1.'],
    updatedAt: '2026-11-25T00:00:00Z'
  }
}

let tools: Record<string, ReturnType<typeof vi.fn>>

/** The MCP servers API, plus the tool maker's and your model providers'. */
function installTools(servers: McpServer[]): void {
  install(servers)
  invalidateCopilotModels()
  tools = {
    make: vi.fn(),
    change: vi.fn(),
    cancel: vi.fn(async () => true),
    code: vi.fn(async () => ({ code: "import { serve } from './kit.mjs'\n", path: 'server.mjs' })),
    undo: vi.fn(async () => saved),
    reveal: vi.fn(async () => {}),
    specs: vi.fn(async () => []),
    try: vi.fn(),
    export: vi.fn(async () => 'C:\\Users\\me\\image-maker.fabricator-tool.json'),
    pickImport: vi.fn(async () => null),
    import: vi.fn()
  }
  const status = {
    supported: true,
    store: 'Windows Credential Manager',
    ownModels: false,
    providers: [
      { id: 'openai', name: 'OpenAI', endpoint: 'fixed', hasKey: true },
      { id: 'anthropic', name: 'Anthropic', endpoint: 'fixed', hasKey: false },
      { id: 'ollama', name: 'Ollama', endpoint: 'local', hasKey: false }
    ]
  }
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    mcp: api,
    toolMaker: tools,
    byok: { status: vi.fn(async () => status) },
    chat: {
      listModels: vi.fn(async () => []),
      autoTiers: vi.fn(async () => null),
      setPlugin: vi.fn(async () => [])
    },
    openExternal: vi.fn()
  }
}

/** What Copilot made: the tool among the servers, checked. */
function madeResult(server: McpServer, extra: Partial<ToolMadeResult> = {}): ToolMadeResult {
  saved = [...saved.filter((s) => s.id !== server.id), server]
  return {
    servers: saved,
    id: server.id,
    tools: [{ name: 'make_image', description: 'Make an image and save it in the app.' }],
    message: 'I made **Image maker**: chat can call `make_image`.',
    ...extra
  }
}

describe('McpServersModal tools made with Copilot', () => {
  it('offers to make, try and share tools only while its experiment is on', async () => {
    installTools([IMAGES])
    const { unmount } = render(<McpServersModal onClose={() => {}} />)
    const card = await screen.findByRole('region', { name: 'Image maker' })
    expect(within(card).getByText('Made with Copilot')).toBeTruthy()
    expect(within(card).getByText('Makes images with OpenAI’s gpt-image-1')).toBeTruthy()
    expect(within(card).queryByRole('button', { name: 'Try Image maker' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Make a tool with Copilot/ })).toBeNull()
    unmount()

    render(<McpServersModal makeTools onClose={() => {}} />)
    const tool = await screen.findByRole('region', { name: 'Image maker' })
    for (const name of [
      'Try Image maker',
      'Change Image maker with Copilot',
      'Code of Image maker',
      'Export Image maker to share it'
    ]) {
      expect(within(tool).getByRole('button', { name })).toBeTruthy()
    }
    fireEvent.click(within(tool).getByRole('button', { name: 'Export Image maker to share it' }))
    expect(
      await within(tool).findByText(
        'Exported to C:\\Users\\me\\image-maker.fabricator-tool.json. The file holds no keys.'
      )
    ).toBeTruthy()
    expect(tools.export).toHaveBeenCalledWith('image-maker')
  })

  it('makes a tool with a model provider’s key, shows what Copilot does, and asks for the keys it lacks', async () => {
    installTools([])
    const made: McpServer = { ...IMAGES }
    tools.make.mockImplementation(
      async (
        _run: string,
        _input: unknown,
        _choice: unknown,
        onEvent: (event: ToolMakerEvent) => void
      ) => {
        onEvent({ kind: 'reading', url: 'https://platform.openai.com/docs/api-reference/images' })
        // Read again, with another query: shown once.
        onEvent({
          kind: 'reading',
          url: 'https://platform.openai.com/docs/api-reference/images?lang=node'
        })
        onEvent({ kind: 'checking' })
        onEvent({ kind: 'failed', error: 'The tool stopped: SyntaxError: Unexpected token' })
        onEvent({ kind: 'checking' })
        onEvent({ kind: 'works', tools: ['make_image'] })
        return madeResult(made, { missingKeys: ['STABILITY_KEY'] })
      }
    )
    const onChanged = vi.fn()
    render(<McpServersModal makeTools onClose={() => {}} onChanged={onChanged} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Make a tool with Copilot' }))
    const form = screen.getByRole('form', { name: 'Make a tool with Copilot' })
    fireEvent.change(within(form).getByLabelText(/^Name/), { target: { value: 'Image maker' } })
    fireEvent.change(within(form).getByLabelText('What should it do?'), {
      target: { value: 'Make images with gpt-image-1, saved in public/images.' }
    })
    // Only providers with a saved key are offered, in a menu.
    fireEvent.click(
      await within(form).findByRole('button', { name: 'Use a key from Model providers' })
    )
    const menu = screen.getByRole('menu', {
      name: 'Add a variable that gets a key you saved in Model providers'
    })
    expect(within(menu).queryByText('Your Anthropic key')).toBeNull()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Your OpenAI key' }))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(within(form).getByText('Your OpenAI key')).toBeTruthy()
    expect((within(form).getByLabelText('variable name') as HTMLInputElement).value).toBe(
      'OPENAI_API_KEY'
    )
    // Its one key used, the menu's button goes.
    expect(
      within(form).queryByRole('button', { name: 'Use a key from Model providers' })
    ).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Make tool' }))

    expect(await screen.findByText('Made Image maker')).toBeTruthy()
    expect(tools.make).toHaveBeenCalledWith(
      expect.any(String),
      {
        name: 'Image maker',
        request: 'Make images with gpt-image-1, saved in public/images.',
        env: [{ name: 'OPENAI_API_KEY', provider: 'openai' }]
      },
      {},
      expect.any(Function)
    )
    // Each check's outcome takes the place of "Checking that it starts…".
    fireEvent.click(screen.getByText('What Copilot did (3 steps)'))
    const steps = screen.getByRole('list', { name: 'What Copilot did' })
    expect(
      within(steps).getByText('Read platform.openai.com/docs/api-reference/images')
    ).toBeTruthy()
    expect(within(steps).getByText('It didn’t start. Copilot is fixing it.')).toBeTruthy()
    expect(within(steps).getByText('The tool stopped: SyntaxError: Unexpected token')).toBeTruthy()
    expect(within(steps).getByText('It starts, and offers make_image')).toBeTruthy()
    expect(within(steps).queryByText('Checking that it starts…')).toBeNull()
    expect(screen.getByText('make_image', { selector: '.mcp-tool' })).toBeTruthy()
    expect(onChanged).toHaveBeenCalled()

    expect(screen.getByText('Its code reads STABILITY_KEY, which it doesn’t get yet.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add keys' }))
    const edit = screen.getByRole('form', { name: 'Edit Image maker' })
    // A made tool has no command to change, and keeps its provider's key.
    expect(within(edit).queryByText('Starts with')).toBeNull()
    expect(within(edit).getByText('Your OpenAI key')).toBeTruthy()
    fireEvent.change(within(edit).getByLabelText('Value of STABILITY_KEY'), {
      target: { value: 'sk-stab' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(api.save).toHaveBeenLastCalledWith({
        id: 'image-maker',
        name: 'Image maker',
        transport: 'stdio',
        env: [
          { name: 'OPENAI_API_KEY', provider: 'openai' },
          { name: 'STABILITY_KEY', value: 'sk-stab' }
        ],
        readOnly: false
      })
    )
  })

  it('says why Copilot couldn’t make a tool, and tries again', async () => {
    installTools([])
    tools.make
      .mockRejectedValueOnce('Copilot couldn’t make a tool that starts. The tool stopped.')
      .mockImplementationOnce(async () => madeResult({ ...IMAGES }))
    render(<McpServersModal makeTools onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Make a tool with Copilot' }))
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Image maker' } })
    fireEvent.change(screen.getByLabelText('What should it do?'), {
      target: { value: 'Make images.' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Make tool' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Copilot couldn’t make a tool that starts. The tool stopped.'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Made Image maker')).toBeTruthy()
    expect(tools.make).toHaveBeenCalledTimes(2)
  })

  it('changes a tool it made, from what should change, and undoes the change', async () => {
    installTools([IMAGES])
    tools.change.mockImplementation(async () => madeResult({ ...IMAGES }))
    render(
      <McpServersModal
        makeTools
        chat={{ projectId: 'p1', plugins: ['mcp:image-maker'] }}
        onClose={() => {}}
      />
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Change Image maker with Copilot' }))
    const form = screen.getByRole('form', { name: 'Change Image maker' })
    expect(within(form).queryByLabelText(/^Name/)).toBeNull()
    expect(within(form).getByText('What you asked for before (1)')).toBeTruthy()
    fireEvent.change(within(form).getByLabelText('What should change?'), {
      target: { value: 'Let chat pick the size.' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Change tool' }))
    expect(await screen.findByText('Changed Image maker')).toBeTruthy()
    expect(tools.change).toHaveBeenCalledWith(
      expect.any(String),
      'image-maker',
      'Let chat pick the size.',
      {},
      expect.any(Function)
    )
    // It's on in the chat beside the dialog already.
    expect(screen.queryByRole('button', { name: 'Use in this chat' })).toBeNull()
    expect(
      screen.getByText('It’s on in this chat, which uses it as it is now from the next message.')
    ).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Undo change' }))
    expect(await screen.findByText('Image maker is back to how it was')).toBeTruthy()
    expect(tools.undo).toHaveBeenCalledWith('image-maker')
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await screen.findByRole('region', { name: 'Image maker' })
    // Checked again, as it is now.
    await waitFor(() => expect(api.check).toHaveBeenCalledWith('image-maker'))
  })

  it('starts from an idea, lets Copilot name the tool, and turns it on in this chat', async () => {
    installTools([])
    vi.mocked(window.api.chat.listModels).mockResolvedValue([
      { id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra', supportedReasoningEfforts: [] }
    ])
    let finish: (result: ToolMadeResult) => void = () => {}
    let emit: (event: ToolMakerEvent) => void = () => {}
    tools.make.mockImplementation(
      (_run: string, _input: unknown, _choice: unknown, onEvent: (e: ToolMakerEvent) => void) =>
        new Promise<ToolMadeResult>((resolve) => {
          emit = (event) => act(() => onEvent(event))
          finish = resolve
        })
    )
    const onClose = vi.fn()
    const onChanged = vi.fn()
    render(
      <McpServersModal
        making
        makeTools
        chat={{ projectId: 'p1', plugins: [] }}
        onClose={onClose}
        onChanged={onChanged}
      />
    )
    const form = screen.getByRole('form', { name: 'Make a tool with Copilot' })
    const ideas = within(form).getByRole('group', { name: 'Start from an idea:' })
    // The key it needs comes from Model providers, once they're read.
    await waitFor(() => expect(window.api.byok.status).toHaveBeenCalled())
    fireEvent.click(within(ideas).getByRole('button', { name: 'Make images' }))
    const request = within(form).getByLabelText('What should it do?') as HTMLTextAreaElement
    expect(request.value).toBe(
      'Make an image from a description with OpenAI’s latest image model, and save it as a PNG in the app’s public/images folder.'
    )
    expect(within(form).queryByRole('group', { name: 'Start from an idea:' })).toBeNull()
    expect(within(form).getByText('Your OpenAI key')).toBeTruthy()

    // Ctrl+Enter makes it, without a name.
    fireEvent.keyDown(request, { key: 'Enter', ctrlKey: true })
    expect(await screen.findByText('Starting Copilot…')).toBeTruthy()
    expect(screen.getByText('0:00')).toBeTruthy()
    expect(tools.make).toHaveBeenCalledWith(
      expect.any(String),
      { name: '', request: request.value, env: [{ name: 'OPENAI_API_KEY', provider: 'openai' }] },
      {},
      expect.any(Function)
    )
    const track = screen.getByRole('list', { name: 'Progress' })
    const now = (): string | null | undefined =>
      track.querySelector('[aria-current="step"] .mcp-stage-label')?.firstChild?.textContent
    // While Copilot starts, the dialog shows what it was asked for.
    expect(now()).toBe('Plan')
    expect(within(screen.getByRole('region', { name: 'Your request' })).getByText(request.value))

    // What Copilot does shows as it does it: the model, its words, the pages it reads…
    emit({ kind: 'started', model: 'gpt-6.1-terra' })
    emit({ kind: 'saying', text: 'I’ll check **OpenAI’s** image docs first.' })
    expect(screen.getByText('Copilot is planning the tool…')).toBeTruthy()
    expect(within(track).getByText('GPT-6.1 Terra')).toBeTruthy()
    expect(screen.getByText('I’ll check OpenAI’s image docs first.')).toBeTruthy()
    emit({ kind: 'reading', url: 'https://platform.openai.com/docs/guides/images' })
    expect(screen.getByText('Copilot is reading the docs…')).toBeTruthy()
    expect(now()).toBe('Read docs')
    const pages = screen.getByRole('region', { name: 'Reading the docs' })
    expect(within(pages).getByText('platform.openai.com/docs/guides/images')).toBeTruthy()

    // …the code as it writes it…
    emit({ kind: 'writing', code: "import { serve } from './kit.mjs'\nserve({" })
    expect(screen.getByText('Copilot is writing the code…')).toBeTruthy()
    expect(now()).toBe('Write code')
    const code = screen.getByRole('region', { name: 'The tool’s code, 2 lines' })
    expect(code.textContent).toContain("import { serve } from './kit.mjs'")
    expect(code.querySelector('.mcp-caret')).toBeTruthy()

    // …and how its check went.
    emit({ kind: 'checking' })
    expect(screen.getAllByText('Checking that it starts…').length).toBeGreaterThan(0)
    expect(now()).toBe('Check')
    emit({ kind: 'works', tools: ['make_image'] })
    expect(within(code).getByText('It starts, and offers make_image')).toBeTruthy()
    expect(screen.getByText('Copilot is finishing up…')).toBeTruthy()
    expect(code.querySelector('.mcp-caret')).toBeNull()

    await act(async () => finish(madeResult({ ...IMAGES })))
    expect(await screen.findByText('Made Image maker')).toBeTruthy()
    // The track stays, as a record of the run.
    expect(within(track).getByText('Works')).toBeTruthy()
    expect(within(track).getByText('1 page')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Use in this chat' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(window.api.chat.setPlugin).toHaveBeenCalledWith('p1', 'mcp:image-maker', true)
    expect(onChanged).toHaveBeenCalled()
  })

  it('asks before closing while Copilot works', async () => {
    installTools([])
    tools.make.mockImplementation(() => new Promise(() => {}))
    const onClose = vi.fn()
    render(<McpServersModal making makeTools onClose={onClose} />)
    fireEvent.change(screen.getByLabelText('What should it do?'), {
      target: { value: 'Make images.' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Make tool' }))
    await screen.findByText('Starting Copilot…')
    fireEvent.click(screen.getByRole('button', { name: 'Close MCP servers' }))
    expect(screen.getByText('Copilot is still working. Stop it and close?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Keep working' }))
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Stop and close' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('tries a tool with a form made from its arguments, and shows what it returned and saved', async () => {
    installTools([IMAGES])
    tools.specs.mockResolvedValue([
      {
        name: 'make_image',
        description: 'Make an image and save it in the app.',
        readOnly: false,
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'What the image shows.' },
            size: { type: 'string', enum: ['1024x1024', '1536x1024'] },
            count: { type: 'integer' },
            transparent: { type: 'boolean' }
          },
          required: ['prompt']
        }
      }
    ])
    tools.try.mockResolvedValue({
      isError: false,
      content: [{ type: 'text', text: 'Saved public/images/lighthouse.png' }],
      files: [
        {
          path: 'public/images/lighthouse.png',
          size: 2048,
          image: 'data:image/png;base64,iVBORw0KGgo='
        }
      ],
      folder: 'C:\\tools\\image-maker\\try',
      ms: 1500
    })
    render(<McpServersModal makeTools onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Try Image maker' }))
    const form = await screen.findByRole('form', { name: 'Try Image maker' })
    expect(within(form).getByText('Make an image and save it in the app.')).toBeTruthy()
    fireEvent.change(within(form).getByLabelText(/prompt/), { target: { value: 'A lighthouse' } })
    fireEvent.change(within(form).getByLabelText(/size/), { target: { value: '1536x1024' } })
    fireEvent.change(within(form).getByLabelText(/count/), { target: { value: '2.5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect((await screen.findByRole('alert')).textContent).toBe('count isn’t a value it takes.')
    fireEvent.change(within(form).getByLabelText(/count/), { target: { value: '2' } })
    fireEvent.click(within(form).getByLabelText(/transparent/))
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))

    const result = await screen.findByRole('region', { name: 'What it returned' })
    expect(tools.try).toHaveBeenCalledWith(expect.any(String), 'image-maker', 'make_image', {
      prompt: 'A lighthouse',
      size: '1536x1024',
      count: 2,
      transparent: true
    })
    expect(within(result).getByText('It worked in 1.5 s.')).toBeTruthy()
    expect(within(result).getByText('Saved public/images/lighthouse.png')).toBeTruthy()
    expect(within(result).getByRole('img', { name: 'public/images/lighthouse.png' })).toBeTruthy()

    // Tried again, it starts from what it was last tried with.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Try Image maker' }))
    const again = await screen.findByRole('form', { name: 'Try Image maker' })
    expect((within(again).getByLabelText(/prompt/) as HTMLTextAreaElement).value).toBe(
      'A lighthouse'
    )
    expect((within(again).getByLabelText(/size/) as HTMLSelectElement).value).toBe('1536x1024')
  })

  it('shows a tool’s code and what it was asked to do', async () => {
    installTools([IMAGES])
    render(<McpServersModal makeTools onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Code of Image maker' }))
    expect(await screen.findByLabelText('The tool’s code')).toBeTruthy()
    expect(screen.getByText('Make images with gpt-image-1.')).toBeTruthy()
    // Without a change to undo, there's only its code.
    expect(screen.queryByRole('tab', { name: 'Last change' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open folder' }))
    expect(tools.reveal).toHaveBeenCalledWith('image-maker', 'code')
  })

  it('shows a tool’s last change, and undoes it once you confirm', async () => {
    const changed: McpServer = {
      ...IMAGES,
      made: { ...IMAGES.made!, requests: ['Make images.', 'Let chat pick the size.'] }
    }
    installTools([changed])
    tools.code.mockResolvedValue({
      code: "import { serve } from './kit.mjs'\nconst size = args.size ?? '1024x1024'\nserve({})\n",
      previous: "import { serve } from './kit.mjs'\nconst size = '1024x1024'\nserve({})\n",
      path: 'server.mjs'
    })
    const onChanged = vi.fn()
    render(<McpServersModal makeTools onClose={() => {}} onChanged={onChanged} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Code of Image maker' }))
    fireEvent.click(await screen.findByRole('tab', { name: 'Last change' }))
    const change = screen.getByRole('tabpanel', { name: 'Last change' })
    expect(within(change).getByText('Let chat pick the size.')).toBeTruthy()
    expect(change.querySelector('.diff-row--del')?.textContent).toContain(
      "const size = '1024x1024'"
    )
    expect(change.querySelector('.diff-row--add')?.textContent).toContain(
      "const size = args.size ?? '1024x1024'"
    )

    fireEvent.click(within(change).getByRole('button', { name: 'Undo change' }))
    expect(
      within(change).getByText(
        'Undo the last change? Image maker goes back to how it was before it, and the change is gone.'
      )
    ).toBeTruthy()
    expect(tools.undo).not.toHaveBeenCalled()
    fireEvent.click(within(change).getByRole('button', { name: 'Undo change' }))
    const card = await screen.findByRole('region', { name: 'Image maker' })
    expect(tools.undo).toHaveBeenCalledWith('image-maker')
    expect(within(card).getByText('Undid the last change.')).toBeTruthy()
    expect(onChanged).toHaveBeenCalled()
  })

  it('adds a shared tool once you’ve reviewed it, with your own keys', async () => {
    installTools([])
    tools.pickImport.mockResolvedValue({
      path: 'C:\\Downloads\\image-maker.fabricator-tool.json',
      digest: 'abc123',
      name: 'Image maker',
      summary: 'Makes images with OpenAI’s gpt-image-1',
      requests: ['Make images.'],
      keys: [{ name: 'OPENAI_API_KEY', provider: 'openai' }, { name: 'WATERMARK' }],
      readOnly: false,
      code: "import { serve } from './kit.mjs'\n"
    })
    tools.import.mockImplementation(async () => madeResult({ ...IMAGES }))
    render(<McpServersModal makeTools onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add a shared tool…' }))
    const form = await screen.findByRole('form', { name: 'Add a shared tool' })
    expect(within(form).getByText('Makes images with OpenAI’s gpt-image-1')).toBeTruthy()
    expect(within(form).getByLabelText('Its code')).toBeTruthy()
    expect(within(form).getByText('Your OpenAI key')).toBeTruthy()
    fireEvent.change(within(form).getByLabelText('Value of WATERMARK'), {
      target: { value: 'Contoso' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add tool' }))
    await waitFor(() =>
      expect(tools.import).toHaveBeenCalledWith({
        path: 'C:\\Downloads\\image-maker.fabricator-tool.json',
        digest: 'abc123',
        name: 'Image maker',
        env: [
          { name: 'OPENAI_API_KEY', provider: 'openai' },
          { name: 'WATERMARK', value: 'Contoso' }
        ],
        readOnly: false
      })
    )
    const card = await screen.findByRole('region', { name: 'Image maker' })
    expect(within(card).getByText('It connected, and offers 1 tool:')).toBeTruthy()
  })
})
